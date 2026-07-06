// In-app sync scheduler (PRD §8: scheduled poll from an internal worker, NOT
// n8n). Node runtime only — imported from instrumentation.ts behind the
// NEXT_RUNTIME guard. Interval from SYNC_INTERVAL_MINUTES (default 15).
// Guarded on globalThis so dev HMR never stacks intervals. Failures are
// recorded in SyncRun rows and never crash the app (manual entry keeps working).

const g = globalThis as unknown as { __retailjourneySyncTimer?: ReturnType<typeof setInterval> };

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
