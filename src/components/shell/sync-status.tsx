// Shell-level sync freshness (server side): the two data sources have
// different cadences and different authority, so they get two separate
// labelled timestamps — a combined "last synced" would hide which one is
// stale. Timestamps come from real SyncRun rows, never a client clock;
// Snowflake has no row-level LAST_UPDATED, so freshness is GLOBAL per source.

import { databaseConfigured, prisma } from "@/lib/db";
import { fmtDateTime } from "@/lib/ist";
import { SyncStatusClient, type SourceStatus } from "./sync-status-client";

function cadenceMinutes(env: string | undefined, fallback: number): number {
  const n = Number(env ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function SyncStatus() {
  if (!databaseConfigured()) return null; // in-memory dev — nothing syncs

  const db = prisma();
  const [snowflake, eshipz] = await Promise.all([
    db.syncRun.findFirst({ where: { source: "SNOWFLAKE" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "ESHIPZ" }, orderBy: { startedAt: "desc" } }),
  ]);

  const build = (
    label: string,
    run: { startedAt: Date; finishedAt: Date | null; ok: boolean | null } | null,
    cadenceMin: number,
  ): SourceStatus => ({
    label,
    cadenceMin,
    atMs: run ? run.startedAt.getTime() : null,
    absolute: run ? fmtDateTime(run.startedAt.toISOString()) : "never",
    // ok=null with a finishedAt still pending counts as running; a run that
    // errored is failed regardless of age.
    failed: run ? run.ok === false : false,
  });

  const statuses: SourceStatus[] = [
    build("Snowflake", snowflake, cadenceMinutes(process.env.SNOWFLAKE_SYNC_INTERVAL_MINUTES, 60)),
    build("eShipz", eshipz, cadenceMinutes(process.env.SYNC_INTERVAL_MINUTES, 15)),
  ];

  return <SyncStatusClient statuses={statuses} />;
}
