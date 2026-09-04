// The Daily Plan — the warehouse's two work lists for TODAY: what must be
// processed, and what is being handed over to a courier.
//
// It began as a verbatim mirror of the "WH Processing Emailer" (n8n, 08:27
// IST). It is no longer that, by explicit decision, and differs in three ways
// that all make it a BROADER and more current list than the mail:
//
//  1. TODAY, not tomorrow. The emailer's `limits` CTE was named today_5am /
//     tomorrow_5am but built from CURRENT_DATE + 1 day / + 2 days, so both its
//     lists ran a full day ahead of their own names. The day offset is dropped
//     here: "to process" is the 05:00→05:00 operating day that starts today,
//     and "to handover" is today's pickups. The 05:00 boundary and the 24-hour
//     width are the emailer's and are kept.
//
//  2. THE SPINE, not distribution_analytics. That table filters out every
//     quick-commerce order at the SQL level (`order_name NOT ILIKE 'QC%'`) —
//     measured live, 0 QC orders in 30 days against the spine's 107. A work
//     list that silently drops a whole order class is worse than no list, so
//     this reads RETAIL_JOURNEY_SPINE, which the boards already run on.
//
//  3. PROCESSING TAT AND PICKUP TAT ARE SEPARATE. The emailer collapsed them
//     into one "TAT" plus a COALESCEd "HANDOVER_DATE". They are different
//     deadlines owned by different people — see WH_PROCESSING_TAT below.
//
// The emailer keeps running; this is the in-app list and it is deliberately
// not byte-identical to the mail any more.
//
// Read-only. Nothing here writes.

import { unstable_cache } from "next/cache";
import { entitledFacilities } from "./rbac";
import { SPINE_TABLE, ntzValue, querySnowflake } from "./snowflake";
import { FACILITIES, type Facility, type User } from "./types";

/**
 * The warehouse's own deadline — when the box must be packed and manifested.
 *
 * Normally the spine's HANDOVER_DEADLINE_TS, which carries the rulebook's
 * handover day and cutoff. The exception is an order with NO rulebook timeline
 * at all: no coverage AND no pickup target. Those (128 of the last 30 days'
 * orders, including all 107 QC / quick-commerce ones) get an explicit
 * fulfilment TAT of ORDER DATE + 2 DAYS at 18:00 so they surface in the list
 * instead of being invisible to the floor.
 *
 * Deliberately NOT applied to out-of-rulebook orders that DO have a pickup day
 * (173 in the same window): those already carry a real courier appointment and
 * their existing deadline stands. Malhar's call.
 *
 * NSO (New Store Opening) is excluded from the fallback entirely, ahead of both
 * branches. It has no rulebook timeline and no fulfilment TAT BY DEFINITION, so
 * the +2d fabrication would invent a deadline the floor is not working to and
 * put a store opening on a list beside orders that have real ones. With a NULL
 * processing TAT it drops out of this list and is worked from the Warehouse
 * queue, which needs no deadline. Also Malhar's call.
 *
 * The spine happens to compute the same +2d value for this group today, but it
 * is stated here rather than inherited — the spine's fallback is its own and
 * could move, and this list must not change shape when it does.
 */
const WH_PROCESSING_TAT = `CASE
    WHEN UPPER(ORDER_TYPE) = 'NSO' THEN NULL
    WHEN RULEBOOK_COVERED = FALSE AND PICKUP_TAT IS NULL
      THEN DATEADD(hour, 18, DATEADD(day, 2, TO_TIMESTAMP_NTZ(ORDER_DATE)))
    ELSE HANDOVER_DEADLINE_TS
  END`;

/** The day the courier collects. PICKUP_TAT is populated on every
 *  rulebook-covered order (measured: 0 nulls in 3,271); an order without one
 *  falls back to its processing day so it cannot drop out of the handover
 *  list entirely. */
const HANDOVER_DATE = `COALESCE(TO_DATE(PICKUP_TAT), TO_DATE(${WH_PROCESSING_TAT}))`;

/** The operating day, 05:00 to 05:00. The emailer's boundary, without its
 *  +1 day offset — see note 1 in the file header. */
const DAY_START = `DATEADD(hour, 5, DATE_TRUNC('day', CURRENT_DATE))`;
const DAY_END = `DATEADD(hour, 5, DATEADD(day, 1, DATE_TRUNC('day', CURRENT_DATE)))`;

/** One row of either list. */
export interface PlanSourceRow {
  ORDER_DATE: string | null;
  ORDER_NAME: string | null;
  STORE: string | null;
  WAREHOUSE_NAME: string | null;
  ORDER_TYPE: string | null;
  QUANTITY: number | string | null;
  WH_PROCESSING_TAT: string | null;
  PICKUP_TAT: string | null;
  HANDOVER_DATE: string | null;
  MANIFESTED_TIMESTAMP: string | null;
  LANE_CLASSIFICATION: string | null;
  TRACKING_NUMBER: string | null;
  COURIER_PARTNER: string | null;
  FINAL_STATUS: string | null;
  RULEBOOK_COVERED: boolean | string | null;
}

export interface PlanRow {
  orderDate?: string;
  orderName: string;
  store?: string;
  warehouse?: string;
  orderType?: string;
  quantity?: number;
  /** The WAREHOUSE's deadline: packed and manifested by this moment. */
  whProcessingTat?: string;
  /** The COURIER's deadline: collected by this moment. Absent on an order with
   *  no rulebook pickup target. */
  pickupTat?: string;
  /** Business date of the pickup — what the To-Handover list is keyed on. */
  handoverDate?: string;
  manifestedAt?: string;
  lane?: string;
  tracking?: string;
  courier?: string;
  finalStatus?: string;
  /** A manifest stamp means the box left the warehouse. */
  pickedUp: boolean;
  /** False = no rulebook timeline; its TAT is the derived order + 2 days. */
  onRulebook: boolean;
}

export interface PlanSection {
  rows: PlanRow[];
  total: number;
  manifested: number;
  pending: number;
  /** How many rows here are running on the derived +2d TAT rather than the
   *  rulebook. Surfaced so the floor knows the list includes them. */
  offRulebook: number;
}

export interface DailyPlan {
  process: PlanSection;
  handover: PlanSection;
  facilities: Facility[];
}

/**
 * The facility predicate, built from the SESSION user's entitlement list.
 *
 * NOT from the facility cookie and not from any request parameter:
 * resolveScope() collapses a two-facility South supervisor down to ONE
 * facility and would hide half their work. A user with no explicit list gets
 * all three. Values are re-filtered against FACILITIES before they become SQL
 * text, so only one of three known literals can ever reach the query.
 */
export function planFacilities(user: Pick<User, "role" | "facilities">): Facility[] {
  const entitled = new Set<string>(entitledFacilities(user));
  return FACILITIES.filter((f) => entitled.has(f));
}

const inList = (facilities: Facility[]) => facilities.map((f) => `'${f}'`).join(", ");

/**
 * Both lists come from one SELECT list so a column can never mean two things
 * across the two tables.
 *
 * QUALIFY collapses to order grain. The spine is documented at
 * (ORDER_NAME, SHIPMENT_BILL, TRACKING_NUMBER) child grain; it measures 1:1
 * with order names today (3,572 rows, 3,572 orders, 0 duplicated), but a split
 * consignment would print the same order twice on a work list, so it is pinned
 * rather than assumed.
 */
function selectFor(facilities: Facility[], where: string): string {
  return `SELECT
  ORDER_DATE                                AS ORDER_DATE,
  ORDER_NAME                                AS ORDER_NAME,
  STORE                                     AS STORE,
  WAREHOUSE_NAME                            AS WAREHOUSE_NAME,
  ORDER_TYPE                                AS ORDER_TYPE,
  QUANTITY                                  AS QUANTITY,
  ${WH_PROCESSING_TAT}                      AS WH_PROCESSING_TAT,
  PICKUP_TAT                                AS PICKUP_TAT,
  ${HANDOVER_DATE}                          AS HANDOVER_DATE,
  MANIFESTED_TIMESTAMP                      AS MANIFESTED_TIMESTAMP,
  LANE_CLASSIFICATION                       AS LANE_CLASSIFICATION,
  TRACKING_NUMBER                           AS TRACKING_NUMBER,
  COURIER_PARTNER                           AS COURIER_PARTNER,
  FINAL_STATUS                              AS FINAL_STATUS,
  RULEBOOK_COVERED                          AS RULEBOOK_COVERED
FROM ${SPINE_TABLE}
WHERE WAREHOUSE_NAME IN (${inList(facilities)})
  AND ${where}
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY ORDER_NAME
  ORDER BY MANIFESTED_TIMESTAMP DESC NULLS LAST, TRACKING_NUMBER NULLS LAST
) = 1
ORDER BY WH_PROCESSING_TAT ASC, STORE ASC, ORDER_NAME ASC`;
}

/** Due for processing inside today's 05:00→05:00 operating day. */
export function processingSql(facilities: Facility[]): string {
  return selectFor(
    facilities,
    `${WH_PROCESSING_TAT} > ${DAY_START}
  AND ${WH_PROCESSING_TAT} <= ${DAY_END}`,
  );
}

/** Being collected today. */
export function handoverSql(facilities: Facility[]): string {
  return selectFor(facilities, `${HANDOVER_DATE} = CURRENT_DATE`);
}

const qty = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Snowflake returns booleans as true/false but a NULL as the string "NULL"
 *  under `fetchAsString: ["Date"]`; only an explicit false or "FALSE" means
 *  uncovered, and an unreadable value fails SAFE (treated as on-rulebook, so
 *  nothing is wrongly labelled as running on a derived deadline). */
const isOffRulebook = (v: unknown): boolean =>
  v === false || String(v ?? "").trim().toUpperCase() === "FALSE";

/** Snowflake hands a NULL NTZ back as the literal string "NULL", so every
 *  value routes through ntzValue first — a raw truthiness test on
 *  MANIFESTED_TIMESTAMP would mark every row picked up. */
function toPlanRow(r: PlanSourceRow): PlanRow {
  const manifestedAt = ntzValue(r.MANIFESTED_TIMESTAMP);
  return {
    orderDate: ntzValue(r.ORDER_DATE),
    orderName: ntzValue(r.ORDER_NAME) ?? "—",
    store: ntzValue(r.STORE),
    warehouse: ntzValue(r.WAREHOUSE_NAME),
    orderType: ntzValue(r.ORDER_TYPE),
    quantity: qty(r.QUANTITY),
    whProcessingTat: ntzValue(r.WH_PROCESSING_TAT),
    pickupTat: ntzValue(r.PICKUP_TAT),
    handoverDate: ntzValue(r.HANDOVER_DATE),
    manifestedAt,
    lane: ntzValue(r.LANE_CLASSIFICATION),
    tracking: ntzValue(r.TRACKING_NUMBER),
    courier: ntzValue(r.COURIER_PARTNER),
    finalStatus: ntzValue(r.FINAL_STATUS),
    pickedUp: manifestedAt !== undefined,
    onRulebook: !isOffRulebook(r.RULEBOOK_COVERED),
  };
}

/** Exported for the test: the "NULL"-string traps and the manifested rule are
 *  the things here that fail silently rather than loudly. */
export function planSection(rows: PlanSourceRow[]): PlanSection {
  const mapped = rows.map(toPlanRow);
  const manifested = mapped.filter((r) => r.pickedUp).length;
  return {
    rows: mapped,
    total: mapped.length,
    manifested,
    pending: mapped.length - manifested,
    offRulebook: mapped.filter((r) => !r.onRulebook).length,
  };
}

/** The uncached read. Exported for scripts and diagnostics, which run outside a
 *  Next request context and so cannot call the cached wrapper. */
export async function fetchDailyPlan(facilities: Facility[]): Promise<DailyPlan> {
  if (facilities.length === 0) {
    const empty: PlanSection = { rows: [], total: 0, manifested: 0, pending: 0, offRulebook: 0 };
    return { process: empty, handover: empty, facilities };
  }
  // Two statements, concurrently. The reader opens and destroys a connection
  // per call by design (snowflake.ts) — there is no pool to exhaust.
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
