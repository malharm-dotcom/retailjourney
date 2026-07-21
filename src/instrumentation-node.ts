// In-app sync scheduler (PRD §8: scheduled poll from an internal worker, NOT
// n8n). Node runtime only — imported from instrumentation.ts behind the
// NEXT_RUNTIME guard. Interval from SYNC_INTERVAL_MINUTES (default 15).
// Guarded on globalThis so dev HMR never stacks intervals. Failures are
// recorded in SyncRun rows and never crash the app (manual entry keeps working).

const g = globalThis as unknown as {
  __retailjourneySyncTimer?: ReturnType<typeof setInterval>;
  __retailjourneySnowflakeTimer?: ReturnType<typeof setInterval>;
};

const PROD_DB_HOST = "168.144.81.147";

/** Structural dev-isolation guard: a non-production process must never hold a
 *  connection string to the production database. (PowerShell's `$env:X=''`
 *  DELETES the variable, so "blank the vars before next dev" silently fails —
 *  this assert makes the failure loud instead of letting dev write to prod.)
 *  Override DATABASE_URL in .env.development.local for local work. */
function assertDevIsolation(): void {
  if (process.env.NODE_ENV === "production") return;
  if ((process.env.DATABASE_URL ?? "").includes(PROD_DB_HOST)) {
    const msg =
      `[boot] REFUSING TO START: NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} but DATABASE_URL points at the production host ${PROD_DB_HOST}. ` +
      `Local dev must never touch the production database. Create .env.development.local (see .env.development.local.example) — ` +
      `next dev loads it OVER .env.local, keeping prod credentials out of dev processes.`;
    console.error(msg);
    throw new Error(msg);
  }
}

/** Boot-time node setup: baseline reference data, then the sync scheduler. */
export function bootNode(): void {
  assertDevIsolation();
  void (async () => {
    try {
      const { ensureBaseline } = await import("./lib/baseline");
      await ensureBaseline();
    } catch (e) {
      console.error("[boot] baseline bootstrap failed:", e instanceof Error ? e.message : e);
    }
  })();
  // Every gate this boot evaluated, on one line, BEFORE any of them can return.
  // A disabled scheduler used to be indistinguishable from a healthy quiet one;
  // the operator must be able to read the verdict straight out of the logs.
  const nodeEnv = process.env.NODE_ENV ?? "(unset)";
  const deployEnv = process.env.RETAILJOURNEY_DEPLOY_ENV ?? "(absent)";
  console.log(
    `[boot] scheduler gate — NODE_ENV=${nodeEnv} RETAILJOURNEY_DEPLOY_ENV=${deployEnv} DATABASE_URL=${process.env.DATABASE_URL ? "set" : "(absent)"}`,
  );

  if (process.env.NODE_ENV !== "production") {
    // Scheduled syncs are a production concern only — a dev process firing
    // them is exactly the incident this guard exists to prevent.
    console.log("[sync] SCHEDULERS DISABLED — NODE_ENV is not 'production'. No syncs will run in this process.");
    return;
  }
  if (process.env.RETAILJOURNEY_DEPLOY_ENV !== "production") {
    // NODE_ENV=production is satisfied by `next start` on a laptop; the
    // deploy marker is set only in Coolify. A local production build never
    // starts schedulers — no interval-env blanking to remember.
    // NOTE: in a DEPLOYED container this branch is an OUTAGE, not a safeguard —
    // it silently stopped both pollers for three days in Jul 2026. No DB write
    // here on purpose: a local prod build must never touch the prod database.
    console.log(
      "[sync] SCHEDULERS DISABLED — RETAILJOURNEY_DEPLOY_ENV is not 'production' (not a deployed environment). " +
        "If you are seeing this in Coolify, the app environment is MISSING RETAILJOURNEY_DEPLOY_ENV=production and no syncs will ever run.",
    );
    return;
  }

  console.log("[sync] schedulers ARMED (deployed environment confirmed)");
  startSyncScheduler();
  startSnowflakeScheduler();
  void (async () => {
    try {
      const { recordSchedulerBoot } = await import("./lib/integrations/sync");
      await recordSchedulerBoot(
        `schedulers armed — eShipz ${process.env.SYNC_INTERVAL_MINUTES ?? 15}m, Snowflake ${process.env.SNOWFLAKE_SYNC_INTERVAL_MINUTES ?? 60}m`,
      );
    } catch (e) {
      console.error("[boot] scheduler boot marker failed:", e instanceof Error ? e.message : e);
    }
  })();
}

/** Hourly Snowflake distribution_analytics reader — its own cadence, kept
 *  separate from the 15-min eShipz poller slot. SNOWFLAKE_SYNC_INTERVAL_MINUTES
 *  overrides (default 60; <=0 disables). */
export function startSnowflakeScheduler(): void {
  if (g.__retailjourneySnowflakeTimer) return;

  const minutes = Number(process.env.SNOWFLAKE_SYNC_INTERVAL_MINUTES ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[sync] snowflake scheduler disabled (SNOWFLAKE_SYNC_INTERVAL_MINUTES <= 0)");
    return;
  }

  const tick = async () => {
    try {
      const { databaseConfigured } = await import("./lib/db");
      if (!databaseConfigured()) {
        console.error("[sync] snowflake tick skipped — DATABASE_URL absent (cannot record this)");
        return;
      }
      const { recordFailedRun, runSnowflakeSync } = await import("./lib/integrations/sync");
      const { snowflakeConfigured } = await import("./lib/snowflake");
      if (!snowflakeConfigured()) {
        // A skipped tick used to leave no trace at all — indistinguishable
        // from a healthy idle system. Record it as the failure it is.
        await recordFailedRun("SNOWFLAKE", "tick skipped — Snowflake is not configured (missing SNOWFLAKE_* env)");
        return;
      }
      const s = await runSnowflakeSync();
      console.log(
        `[sync] ${s.source}: ${s.ok ? "ok" : "FAILED"} fetched=${s.fetched} upserted=${s.upserted} conflicts=${s.conflicts} errors=${s.errors.length}`,
      );
    } catch (e) {
      // Never crash the scheduler — but never fail silently either: a throw
      // before startRun would otherwise leave no SyncRun row.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sync] snowflake run failed:", msg);
      try {
        const { recordFailedRun } = await import("./lib/integrations/sync");
        await recordFailedRun("SNOWFLAKE", msg);
      } catch {
        /* database unreachable — the log line above is all we have */
      }
    }
  };

  g.__retailjourneySnowflakeTimer = setInterval(tick, minutes * 60 * 1000);
  console.log(`[sync] snowflake scheduler started — every ${minutes} min`);
  // First run shortly after boot, offset from the eShipz poller first tick.
  setTimeout(tick, 60 * 1000);
}

export function startSyncScheduler(): void {
  if (g.__retailjourneySyncTimer) return;

  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[sync] scheduler disabled (SYNC_INTERVAL_MINUTES <= 0)");
    return;
  }

  const tick = async () => {
    try {
      const { databaseConfigured } = await import("./lib/db");
      if (!databaseConfigured()) {
        console.error("[sync] eShipz tick skipped — DATABASE_URL absent (cannot record this)");
        return;
      }
      const { recordFailedRun, runAllSyncs } = await import("./lib/integrations/sync");
      const summaries = await runAllSyncs();
      if (summaries.length === 0) {
        // No source ran: eShipz is unconfigured. Leave a red row rather than
        // letting the strip drift quietly stale.
        await recordFailedRun("ESHIPZ", "tick skipped — eShipz is not configured (missing ESHIPZ_API_TOKEN)");
        return;
      }
      for (const s of summaries) {
        console.log(
          `[sync] ${s.source}: ${s.ok ? "ok" : "FAILED"} fetched=${s.fetched} upserted=${s.upserted} conflicts=${s.conflicts} errors=${s.errors.length}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sync] run failed:", msg);
      try {
        const { recordFailedRun } = await import("./lib/integrations/sync");
        await recordFailedRun("ESHIPZ", msg);
      } catch {
        /* database unreachable — the log line above is all we have */
      }
    }
  };

  g.__retailjourneySyncTimer = setInterval(tick, minutes * 60 * 1000);
  console.log(`[sync] scheduler started — every ${minutes} min`);
  // First run shortly after boot (give the server a moment to settle).
  setTimeout(tick, 30 * 1000);
}
