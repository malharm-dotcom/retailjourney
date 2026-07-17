// Live reader for the distribution rulebook — SNITCH_DB.MAPLEMONK.DISTRIBUTION_RULEBOOK,
// the maintained source behind distribution_analytics' baked per-order targets.
// View-only: the Rulebook tab reads a chosen monthly snapshot straight from
// here; nothing writes back. Its stale twin DISTRIBUTION_RULE_BOOK and the raw
// Airbyte sheets (FINAL_SOUTHRULEBOOK / NORTH_RULE_MERCH) are deliberately not
// read — this consolidated table is the sole authority.
//
// Grain: one row per STORE_NAME × WH ('North WH' | 'South WH') × UPLOAD_DATE.
// Order type is columnar (FRESH_* / RPL_* families) — rulebook-map.ts flattens
// it into the app's per-store × order-type row shape.

import { querySnowflake } from "./snowflake";

const RULEBOOK_TABLE = "SNITCH_DB.MAPLEMONK.DISTRIBUTION_RULEBOOK";

/** One raw rulebook row (only the columns the view + QC inheritance consume).
 *  Days/cutoffs are wall-clock strings like "Friday 9 AM"; nulls are common. */
export interface RulebookSourceRow {
  UPLOAD_DATE: string;
  WH: string | null;
  STORE_NAME: string | null;
  STORE_TYPE: string | null;
  CITY: string | null;
  PINCODE: number | null;
  LANE_CLASSIFICATION: string | null;
  ZONE: string | null;
  BEST_TAT: number | null;
  BEST_COURIER_PARTNER: string | null;
  FRESH_ORDER_CUTOFF: string | null;
  FRESH_TAT: string | null;
  FRESH_HANDOVER_DAY: string | null;
  FRESH_DELIVERY_DAY: string | null;
  RPL_ORDER_CUTOFF: string | null;
  RPL_TAT: string | null;
  RPL_HANDOVER_DAY: string | null;
  RPL_DELIVERY_DAY: string | null;
}

const SNAPSHOT_COLUMNS = `
  UPLOAD_DATE, WH, STORE_NAME, STORE_TYPE, CITY, PINCODE,
  LANE_CLASSIFICATION, ZONE, BEST_TAT, BEST_COURIER_PARTNER,
  FRESH_ORDER_CUTOFF, FRESH_TAT, FRESH_HANDOVER_DAY, FRESH_DELIVERY_DAY,
  RPL_ORDER_CUTOFF, RPL_TAT, RPL_HANDOVER_DAY, RPL_DELIVERY_DAY`;

/** The monthly versions available, newest first (the UPLOAD_DATE snapshots —
 *  discrete republish dates, not a fixed cadence). */
export async function listRulebookSnapshots(): Promise<string[]> {
  const rows = await querySnowflake<{ UPLOAD_DATE: string }>(
    `SELECT DISTINCT UPLOAD_DATE FROM ${RULEBOOK_TABLE} ORDER BY UPLOAD_DATE DESC`,
  );
  return rows.map((r) => r.UPLOAD_DATE).filter(Boolean);
}

export interface RulebookSnapshot {
  /** Snapshots available for the version selector, newest first. */
  snapshots: string[];
  /** The snapshot actually read (the requested one, or the latest). */
  uploadDate: string | null;
  rows: RulebookSourceRow[];
}

/**
 * Read one snapshot of the rulebook. `uploadDate` picks a version; omitted or
 * unknown falls back to the latest. Returns empty (never throws for "no data")
 * when the table has no rows so the tab can render an empty state.
 */
export async function readRulebookSnapshot(uploadDate?: string): Promise<RulebookSnapshot> {
  const snapshots = await listRulebookSnapshots();
  if (snapshots.length === 0) return { snapshots, uploadDate: null, rows: [] };
  const chosen = uploadDate && snapshots.includes(uploadDate) ? uploadDate : snapshots[0];
  const rows = await querySnowflake<RulebookSourceRow>(
    `SELECT${SNAPSHOT_COLUMNS} FROM ${RULEBOOK_TABLE}
     WHERE UPLOAD_DATE = '${chosen}'
     ORDER BY STORE_NAME, WH`,
  );
  return { snapshots, uploadDate: chosen, rows };
}
