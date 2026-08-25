// The Daily Plan — the in-app copy of the "WH Processing Emailer" (n8n, 08:27
// IST), which mails the South and North WH teams two work lists every morning.
//
// THIS IS A MIRROR, NOT A REDESIGN. The two statements below are the emailer's
// PROCESSING and HANDOVER queries transcribed verbatim; the ONLY edit is the
// warehouse IN-list, which is narrowed from the emailer's fixed three to the
// viewer's session entitlements. Window math, boundary offsets, column
// expressions, aliases and ORDER BY are untouched, so for the same run moment
// this view returns the same rows the email lists.
//
// Do not "fix" anything here. If a window looks wrong, it is wrong in n8n and
// must be fixed there first — the whole value of this file is that the app and
// the email cannot disagree.
//
// KNOWN AND DELIBERATE — the limits CTE's names do not match its offsets:
//   today_5am    = DATE_TRUNC(day, CURRENT_DATE) + 1 day + 5 hours  → TOMORROW 05:00
//   tomorrow_5am = DATE_TRUNC(day, CURRENT_DATE) + 2 days + 5 hours → DAY AFTER 05:00
// So the PROCESSING window is a day ahead of what the variable names suggest,
// and HANDOVER_DATE = CURRENT_DATE + 1 is tomorrow. This is intentional — the
// timestamps are shaped to fit the n8n tool — so it is reproduced exactly
// rather than corrected. Change it in n8n first, never here.
//
// The read path is the R1 one: querySnowflake() on an Asia/Kolkata session with
// DATE/TIMESTAMP fetched as strings. Read-only; nothing here writes.

import { unstable_cache } from "next/cache";
import { entitledFacilities } from "./rbac";
import { ntzValue, querySnowflake } from "./snowflake";
import { FACILITIES, type Facility, type User } from "./types";

/** The emailer's source. Fully qualified for the same reason SPINE_TABLE and
 *  REPORT_TABLE are — a mis-set SNOWFLAKE_SCHEMA must not silently repoint it. */
export const PLAN_TABLE = "snitch_db.maplemonk.distribution_analytics";

/** One row of either list. Column names are the emailer's aliases, not the
 *  table's — TAT is handover_deadline_ts and HANDOVER_DATE is derived. */
export interface PlanSourceRow {
  ORDER_DATE: string | null;
  ORDER_NAME: string | null;
  STORE: string | null;
  WAREHOUSE_NAME: string | null;
  ORDER_TYPE: string | null;
  QUANTITY: number | string | null;
  TAT: string | null;
  HANDOVER_DATE: string | null;
  MANIFESTED_TIMESTAMP: string | null;
  LANE_CLASSIFICATION: string | null;
  TRACKING_NUMBER: string | null;
  COURIER_PARTNER: string | null;
  FINAL_STATUS: string | null;
}

export interface PlanRow {
  orderDate?: string;
  orderName: string;
  store?: string;
  warehouse?: string;
  orderType?: string;
  quantity?: number;
  /** handover_deadline_ts — the WAREHOUSE's processing deadline, IST wall clock. */
  tat?: string;
  /** COALESCE(TO_DATE(pickup_tat), TO_DATE(handover_deadline_ts)) — the PICKUP
   *  day, which is a different thing from TAT and may fall on a different date. */
  handoverDate?: string;
  manifestedAt?: string;
  lane?: string;
  tracking?: string;
  courier?: string;
  finalStatus?: string;
  /** The emailer's rule, unchanged: a manifest stamp means the box left. */
  pickedUp: boolean;
}

export interface PlanSection {
  rows: PlanRow[];
  total: number;
  manifested: number;
  pending: number;
}

export interface DailyPlan {
  process: PlanSection;
  handover: PlanSection;
  /** Facilities actually queried — shown so the reader knows their own scope. */
  facilities: Facility[];
}

/**
 * The facility predicate, built from the SESSION user's entitlement list.
 *
 * NOT from the facility cookie and not from any request parameter. The emailer
 * splits South (WH1+WH2) from North (TAURU); the app's equivalent is "every
 * facility this user is entitled to", because resolveScope() collapses a
 * two-facility South supervisor down to ONE facility and would hide half their
 * work. A user with no explicit list gets all three — the emailer's own set.
 *
 * Values are re-filtered against the FACILITIES constant before they become SQL
 * text, so nothing but one of three known literals can ever reach the query.
 */
export function planFacilities(user: Pick<User, "role" | "facilities">): Facility[] {
  const entitled = new Set<string>(entitledFacilities(user));
  return FACILITIES.filter((f) => entitled.has(f));
}

const inList = (facilities: Facility[]) => facilities.map((f) => `'${f}'`).join(", ");

/** The emailer's PROCESSING query. Verbatim but for the IN-list. */
export function processingSql(facilities: Facility[]): string {
  return `WITH limits AS (
  SELECT
    DATEADD(hour, 5, DATEADD(day, 1, DATE_TRUNC('day', CURRENT_DATE))) AS today_5am,
    DATEADD(hour, 5, DATEADD(day, 2, DATE_TRUNC('day', CURRENT_DATE))) AS tomorrow_5am
)
SELECT
  'PROCESSING'                                              AS TABLE_TYPE,
  TO_DATE(order_timestamp)                                  AS ORDER_DATE,
  order_name                                                AS ORDER_NAME,
  store                                                     AS STORE,
  warehouse_name                                            AS WAREHOUSE_NAME,
  order_type                                                AS ORDER_TYPE,
  quantity                                                  AS QUANTITY,
  handover_deadline_ts                                      AS TAT,
  COALESCE(TO_DATE(pickup_tat), TO_DATE(handover_deadline_ts)) AS HANDOVER_DATE,
  manifested_timestamp                                      AS MANIFESTED_TIMESTAMP,
  lane_classification                                       AS LANE_CLASSIFICATION,
  tracking_number                                           AS TRACKING_NUMBER,
  courier_partner                                           AS COURIER_PARTNER,
  final_status                                              AS FINAL_STATUS
FROM ${PLAN_TABLE}
CROSS JOIN limits l
WHERE handover_deadline_ts IS NOT NULL
  AND handover_deadline_ts > l.today_5am
  AND handover_deadline_ts <= l.tomorrow_5am
  AND warehouse_name IN (${inList(facilities)})
ORDER BY TAT ASC, STORE ASC, ORDER_NAME ASC`;
}

/** The emailer's HANDOVER query. Verbatim but for the IN-list. */
export function handoverSql(facilities: Facility[]): string {
  return `WITH base AS (
  SELECT
    'HANDOVER'                                                AS TABLE_TYPE,
    TO_DATE(order_timestamp)                                  AS ORDER_DATE,
    order_name                                                AS ORDER_NAME,
    store                                                     AS STORE,
    warehouse_name                                            AS WAREHOUSE_NAME,
    order_type                                                AS ORDER_TYPE,
    quantity                                                  AS QUANTITY,
    handover_deadline_ts                                      AS TAT,
    COALESCE(TO_DATE(pickup_tat), TO_DATE(handover_deadline_ts)) AS HANDOVER_DATE,
    manifested_timestamp                                      AS MANIFESTED_TIMESTAMP,
    lane_classification                                       AS LANE_CLASSIFICATION,
    tracking_number                                           AS TRACKING_NUMBER,
    courier_partner                                           AS COURIER_PARTNER,
    final_status                                              AS FINAL_STATUS,
    target_handover_cutoff                                    AS TARGET_HANDOVER_CUTOFF
  FROM ${PLAN_TABLE}
  WHERE handover_deadline_ts IS NOT NULL
    AND warehouse_name IN (${inList(facilities)})
)
SELECT *
FROM base
WHERE HANDOVER_DATE = CURRENT_DATE + 1
ORDER BY TAT ASC, STORE ASC, ORDER_NAME ASC`;
}

const qty = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Snowflake hands a NULL NTZ back as the literal string "NULL" under
 *  `fetchAsString: ["Date"]`, so every value routes through ntzValue first —
 *  a raw truthiness test on MANIFESTED_TIMESTAMP would mark every row green. */
function toPlanRow(r: PlanSourceRow): PlanRow {
  const manifestedAt = ntzValue(r.MANIFESTED_TIMESTAMP);
  return {
    orderDate: ntzValue(r.ORDER_DATE),
    orderName: ntzValue(r.ORDER_NAME) ?? "—",
    store: ntzValue(r.STORE),
    warehouse: ntzValue(r.WAREHOUSE_NAME),
    orderType: ntzValue(r.ORDER_TYPE),
    quantity: qty(r.QUANTITY),
    tat: ntzValue(r.TAT),
    handoverDate: ntzValue(r.HANDOVER_DATE),
    manifestedAt,
    lane: ntzValue(r.LANE_CLASSIFICATION),
    tracking: ntzValue(r.TRACKING_NUMBER),
    courier: ntzValue(r.COURIER_PARTNER),
    finalStatus: ntzValue(r.FINAL_STATUS),
    pickedUp: manifestedAt !== undefined,
  };
}

/** Exported for the test: the "NULL"-string trap and the manifested rule are
 *  the two things here that fail silently rather than loudly. */
export function planSection(rows: PlanSourceRow[]): PlanSection {
  const mapped = rows.map(toPlanRow);
  const manifested = mapped.filter((r) => r.pickedUp).length;
  return { rows: mapped, total: mapped.length, manifested, pending: mapped.length - manifested };
}

/** The uncached read. Exported for scripts and diagnostics, which run outside a
 *  Next request context and so cannot call the cached wrapper. */
export async function fetchDailyPlan(facilities: Facility[]): Promise<DailyPlan> {
  if (facilities.length === 0) {
    const empty: PlanSection = { rows: [], total: 0, manifested: 0, pending: 0 };
    return { process: empty, handover: empty, facilities };
  }
  // Two statements, concurrently. The reader opens and destroys a connection per
  // call by design (snowflake.ts) — there is no pool to exhaust.
  const [processing, handover] = await Promise.all([
    querySnowflake<PlanSourceRow>(processingSql(facilities)),
    querySnowflake<PlanSourceRow>(handoverSql(facilities)),
  ]);
  return { process: planSection(processing), handover: planSection(handover), facilities };
}

/**
 * Cached per facility set for 60 seconds.
 *
 * Short on purpose, unlike the Reports panels' five minutes: this is a work
 * list, and someone who has just manifested an order will refresh expecting the
 * chip to have flipped. Sixty seconds still collapses a whole shift opening the
 * tab at 9am into one pair of queries.
 *
 * The key carries the facility set, so one team's list can never be served to
 * another team out of the cache.
 */
export function loadDailyPlan(facilities: Facility[]): Promise<DailyPlan> {
  const key = facilities.join(",");
  return unstable_cache(() => fetchDailyPlan(facilities), ["daily-plan", key], {
    revalidate: 60,
  })();
}
