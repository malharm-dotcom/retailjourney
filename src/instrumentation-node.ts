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
  if (process.env.NODE_ENV !== "production") {
    // Scheduled syncs are a production concern only — a dev process firing
    // them is exactly the incident this guard exists to prevent.
    console.log("[sync] schedulers disabled outside production");
    return;
  }
  if (process.env.RETAILJOURNEY_DEPLOY_ENV !== "production") {
    // NODE_ENV=production is satisfied by `next start` on a laptop; the
    // deploy marker is set only in Coolify. A local production build never
    // starts schedulers — no interval-env blanking to remember.
    console.log("[sync] schedulers disabled — RETAILJOURNEY_DEPLOY_ENV is not 'production' (not a deployed environment)");
    return;
  }
  startSyncScheduler();
  startSnowflakeScheduler();
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
      if (!databaseConfigured()) return;
      const { snowflakeConfigured } = await import("./lib/snowflake");
      if (!snowflakeConfigured()) return;
      const { runSnowflakeSync } = await import("./lib/integrations/sync");
      const s = await runSnowflakeSync();
      console.log(
        `[sync] ${s.source}: ${s.ok ? "ok" : "FAILED"} fetched=${s.fetched} upserted=${s.upserted} conflicts=${s.conflicts} errors=${s.errors.length}`,
      );
    } catch (e) {
      // Never crash the scheduler — the failure lands in SyncRun/logs only.
      console.error("[sync] snowflake run failed:", e instanceof Error ? e.message : e);
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
      if (!databaseConfigured()) return; // nothing to sync into
      const { runAllSyncs } = await import("./lib/integrations/sync");
      const summaries = await runAllSyncs();
      for (const s of summaries) {
        console.log(
          `[sync] ${s.source}: ${s.ok ? "ok" : "FAILED"} fetched=${s.fetched} upserted=${s.upserted} conflicts=${s.conflicts} errors=${s.errors.length}`,
        );
      }
    } catch (e) {
      console.error("[sync] run failed:", e instanceof Error ? e.message : e);
    }
  };

  g.__retailjourneySyncTimer = setInterval(tick, minutes * 60 * 1000);
  console.log(`[sync] scheduler started — every ${minutes} min`);
  // First run shortly after boot (give the server a moment to settle).
  setTimeout(tick, 30 * 1000);
}
