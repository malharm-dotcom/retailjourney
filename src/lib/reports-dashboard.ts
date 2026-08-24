// At-a-glance Distribution 2.0 panels for the Reports desk.
//
// Every expression below is a PORT OF THE METABASE QUESTION SQL, not a
// reimplementation of it. That is the whole contract of these panels: they are
// the Distribution 2.0 dashboard rendered inside RetailJourney, so where the
// upstream definition is odd, this file is odd in exactly the same way. Do not
// "improve" a formula here — improve it in Metabase and port it back, or the
// two surfaces start disagreeing and neither can be trusted.
//
// WHY distribution_analytics AND NOT THE SPINE
// -------------------------------------------
// The app's order spine was deliberately repointed OFF distribution_analytics
// (see snowflake.ts) because that table gates out every order the rulebook does
// not cover — which is exactly the population the boards exist to make visible.
// That reasoning is unchanged and the boards still run on RETAIL_JOURNEY_SPINE.
//
// But these panels have the opposite requirement: they must equal Metabase, and
// Metabase reads distribution_analytics. The two tables are near-identical in
// shape and genuinely different in content — measured live, the same Metabase
// lane query returned 2,404 vs 2,472 boxes and 35.01% vs 33.60% on-time attempt
// for one lane, because the spine carries 564 out-of-rulebook rows that
// distribution_analytics drops. Reading the spine here would produce numbers
// that are arguably better and provably not the ones on the dashboard.
//
// So: the boards read the spine, these panels read distribution_analytics, and
// the panels say so on screen. A reader who notices the drill-down reports
// count more orders than the dashboard is seeing something real.

import { unstable_cache } from "next/cache";
import { querySnowflake } from "./snowflake";
import type { FacilityScope } from "./types";

/** The Metabase source. Fully qualified for the same reason SPINE_TABLE is —
 *  a mis-set SNOWFLAKE_SCHEMA must not silently repoint this at something else. */
export const REPORT_TABLE = "SNITCH_DB.MAPLEMONK.DISTRIBUTION_ANALYTICS";

// ---------------------------------------------------------------------------
// THE SLA DEFINITION, ported verbatim from the Distribution Journey SLAs
// question. Five metrics, and no two of them are built the same way:
//
//   Order SLA%     EARLY_CREATION and WITHIN_SLA both pass. Order grain.
//                  Denominator: orders with a non-null verdict.
//   WH Processing% pass = NOT LIKE 'BREACH%', so a leg still inside its window
//                  ('FUTURE SLA') counts as a PASS, not as pending. Order grain.
//   Pickup SLA%    same NOT-LIKE-BREACH% test, but AWB grain (TRACKING_NUMBER),
//                  denominator = AWBs with a non-null verdict.
//   Delivery SLA%  NOT LIKE '%BREACH%' (leading wildcard — upstream's, kept),
//                  AWB grain, denominator = ALL AWBs including those with no
//                  verdict at all. Different denominator from Pickup, one line
//                  above it. This asymmetry is upstream's and is deliberate here.
//   Perfect Order% NOT read off the PERFECT_ORDER_SLA column. It is recomputed
//                  as "all four legs strictly WITHIN_SLA" over ALL distinct
//                  orders — so an order with a null or future leg counts
//                  against it. That is why this reads ~8-37% and the
//                  PERFECT_ORDER_SLA column would have read ~85%.
//
// Used by BOTH the KPI tiles and the trend table, from this one constant, so a
// tile can never disagree with the column beneath it.
// ---------------------------------------------------------------------------
const SLA_METRICS = `
  100 * COUNT(DISTINCT CASE WHEN ORDER_PLACEMENT_SLA IN ('EARLY_CREATION', 'WITHIN_SLA')
              THEN ORDER_NAME END)
    / NULLIF(COUNT(DISTINCT CASE WHEN NOT ORDER_PLACEMENT_SLA IS NULL THEN ORDER_NAME END), 0)
    AS ORDER_PCT,
  100 * COUNT(DISTINCT CASE WHEN NOT HANDOVER_SLA LIKE 'BREACH%' THEN ORDER_NAME END)
    / NULLIF(COUNT(DISTINCT CASE WHEN NOT HANDOVER_SLA IS NULL THEN ORDER_NAME END), 0)
    AS WH_PCT,
  100 * COUNT(DISTINCT CASE WHEN NOT PICKUP_SLA LIKE 'BREACH%' THEN TRACKING_NUMBER END)
    / NULLIF(COUNT(DISTINCT CASE WHEN NOT PICKUP_SLA IS NULL THEN TRACKING_NUMBER END), 0)
    AS PICKUP_PCT,
  COUNT(DISTINCT CASE WHEN NOT DELIVERY_SLA LIKE '%BREACH%' THEN TRACKING_NUMBER END) * 100.0
    / NULLIF(COUNT(DISTINCT TRACKING_NUMBER), 0)
    AS DELIVERY_PCT,
  100 * COUNT(DISTINCT CASE WHEN ORDER_PLACEMENT_SLA IN ('WITHIN_SLA', 'EARLY_CREATION')
                             AND HANDOVER_SLA = 'WITHIN_SLA'
                             AND PICKUP_SLA = 'WITHIN_SLA'
                             AND DELIVERY_SLA = 'WITHIN_SLA'
              THEN ORDER_NAME END)
    / NULLIF(COUNT(DISTINCT ORDER_NAME), 0)
    AS PERFECT_PCT`;

/** Trailing window every panel measures over, in days. Upstream uses 31 on all
 *  three questions (order timestamp, logistics-created timestamp, pick date). */
export const WINDOW_DAYS = 31;

/** The journey question's row filter: live-ish statuses only (a NULL status is
 *  an order with no AWB yet and is kept), the trailing order window, and a cap
 *  that drops delivery dates too far in the future to mean anything. */
const JOURNEY_WHERE = `(FINAL_STATUS IS NULL OR FINAL_STATUS IN
    ('DELIVERED', 'EXCEPTION', 'INFORECEIVED', 'INTRANSIT', 'OUTFORDELIVERY', 'PICKEDUP'))
  AND ORDER_TIMESTAMP >= DATEADD(day, -${WINDOW_DAYS}, CURRENT_DATE)
  AND ORDER_TIMESTAMP < CURRENT_DATE
  AND IDEAL_DELIVERY_DATE <= CURRENT_DATE + 10`;

// ---------------------------------------------------------------------------
// Tile thresholds. Uniform across all five until real per-metric SLA targets
// are supplied — a tile that colours against a made-up target is worse than one
// that colours against an openly generic one.
//
// NOTE these are generous relative to what the data actually does: Perfect
// Order% runs in the twenties by upstream's definition, so it will sit red
// permanently until a Perfect-Order-specific target is set.
// ---------------------------------------------------------------------------
export const KPI_GREEN = 95;
export const KPI_AMBER = 85;

export function kpiTone(pct: number | null): "done" | "handling" | "failed" | "pending" {
  if (pct == null) return "pending";
  if (pct >= KPI_GREEN) return "done";
  if (pct >= KPI_AMBER) return "handling";
  return "failed";
}

/** The five tiles, in dashboard order. Each reads one column of SLA_METRICS —
 *  the tiles ARE the trend table's totals row, which is why they cannot drift
 *  from it. */
const KPIS = [
  { key: "placement", label: "Order Placement SLA", col: "ORDER_PCT", icon: "clipboard-list-bold-duotone" },
  { key: "wh", label: "WH Processing SLA", col: "WH_PCT", icon: "box-bold-duotone" },
  { key: "pickup", label: "Pickup SLA", col: "PICKUP_PCT", icon: "delivery-bold-duotone" },
  { key: "delivery", label: "Delivery SLA", col: "DELIVERY_PCT", icon: "shop-bold-duotone" },
  { key: "perfect", label: "Perfect Order", col: "PERFECT_PCT", icon: "medal-ribbon-star-bold-duotone" },
] as const;

export interface KpiTile {
  key: string;
  label: string;
  icon: string;
  /** Percentage, or null when nothing in the window is applicable. */
  pct: number | null;
}

export interface TrendRow {
  idealDeliveryDate: string;
  totalOrders: number;
  orderPct: number | null;
  whPct: number | null;
  pickupPct: number | null;
  deliveryPct: number | null;
  perfectPct: number | null;
}

export interface CourierRow {
  courier: string;
  awbs: number;
  boxes: number;
  pickupPct: number | null;
  deliveryPct: number | null;
  breached: number;
  p2dAvg: number | null;
  p2dLe5Pct: number | null;
  onTimeAttemptPct: number | null;
}

export interface LaneRow {
  lane: string;
  warehouse: string;
  boxes: number;
  shipments: number;
  fasrPct: number | null;
  onTimeAttemptPct: number | null;
  onTimeDeliveryPct: number | null;
  p50: number | null;
  p90: number | null;
  perfectPct: number | null;
  deliveredPct: number | null;
}

export interface DashboardData {
  kpis: KpiTile[];
  /** Total distinct orders behind the tiles — the tiles' denominator, shown so
   *  a percentage is never read without knowing how much it rests on. */
  totalOrders: number;
  trend: TrendRow[];
  couriers: CourierRow[];
  lanes: LaneRow[];
  windowDays: number;
}

/** How many delivery dates the journey trend shows. Upstream returns the whole
 *  window; a panel wants the recent end of it. */
const TREND_DAYS = 14;

/**
 * The facility predicate, built from the SESSION's already-validated scope.
 *
 * `scope` is the FacilityScope union resolved by resolveScope() — it can only
 * ever be "ALL" or one of three literal facility names, so it is not
 * interpolated user input. `areaManager` comes off the User row and is escaped
 * regardless, because "it came from our own database" is exactly the assumption
 * that ages badly.
 *
 * There is deliberately no way to widen this from the client: the caller passes
 * the resolved scope, not a request parameter.
 */
export function scopeClause(scope: FacilityScope, areaManager?: string): string {
  const parts: string[] = [];
  if (scope !== "ALL") parts.push(`WAREHOUSE_NAME = '${scope}'`);
  if (areaManager) parts.push(`AREA_MANAGER = '${areaManager.replace(/'/g, "''")}'`);
  return parts.length ? parts.join(" AND ") : "1 = 1";
}

/** Snowflake hands numerics back as number | string | null depending on the
 *  column; every figure below routes through this so a "97.50" string never
 *  reaches a `.toFixed`. */
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number => Math.round(num(v) ?? 0);

/**
 * The uncached read. Exported because `loadDashboard` wraps it in
 * `unstable_cache`, which only works inside a Next request context — anything
 * outside one (a script, a diagnostic, a check that these queries still parse
 * against the live table) has to call this directly.
 */
export async function fetchDashboard(
  scope: FacilityScope,
  areaManager?: string,
): Promise<DashboardData> {
  const scoped = scopeClause(scope, areaManager);

  // Four statements, run concurrently. The Snowflake reader opens and destroys
  // a connection per call by design (see snowflake.ts) — there is no pool to
  // exhaust, and serialising them would just make the page four times slower.
  const [kpiRows, trendRows, courierRows, laneRows] = await Promise.all([
    // Tiles: the journey question with the date grouping removed. Verified
    // against the dashboard's own tiles — Order SLA% 53.22 and Perfect Order%
    // 23.84 over this window match the 53.26 / 23.3 the screenshots show.
    querySnowflake<Record<string, unknown>>(`
SELECT COUNT(DISTINCT ORDER_NAME) AS TOTAL_ORDERS, ${SLA_METRICS}
FROM ${REPORT_TABLE}
WHERE ${scoped} AND ${JOURNEY_WHERE}`),

    querySnowflake<Record<string, unknown>>(`
SELECT TO_CHAR(DATE_TRUNC('DAY', IDEAL_DELIVERY_DATE), 'YYYY-MM-DD') AS D,
       COUNT(DISTINCT ORDER_NAME) AS TOTAL_ORDERS, ${SLA_METRICS}
FROM ${REPORT_TABLE}
WHERE ${scoped} AND ${JOURNEY_WHERE}
GROUP BY 1 ORDER BY 1 DESC LIMIT ${TREND_DAYS}`),

    // Courier Partner Wise. Upstream also groups by ideal delivery date; this
    // panel drops that grouping and rolls the window up to one row per courier,
    // which is what "at a glance" means. Every cell is still the same
    // expression over the same window, so a courier's window-level figure is
    // exact — it is simply not the per-date row Metabase renders.
    querySnowflake<Record<string, unknown>>(`
SELECT COALESCE(COURIER_PARTNER, '—') AS COURIER,
       COUNT(DISTINCT TRACKING_NUMBER) AS AWBS,
       SUM(PACKAGE_COUNT) AS BOXES,
       COUNT(DISTINCT CASE WHEN NOT PICKUP_SLA LIKE 'BREACH%' THEN TRACKING_NUMBER END) * 100.0
         / NULLIF(COUNT(DISTINCT TRACKING_NUMBER), 0) AS PICKUP_PCT,
       COUNT(DISTINCT CASE WHEN NOT DELIVERY_SLA LIKE 'BREACH%' THEN TRACKING_NUMBER END) * 100.0
         / NULLIF(COUNT(DISTINCT TRACKING_NUMBER), 0) AS DELIVERY_PCT,
       -- Breached = missed its delivery SLA AND still has not arrived. A late
       -- delivery that eventually landed is not counted here.
       COUNT(DISTINCT CASE WHEN DELIVERY_SLA <> 'WITHIN_SLA'
                            AND LOGISTICS_DELIVERY_TIMESTAMP IS NULL
             THEN TRACKING_NUMBER END) AS BREACHED,
       -- AVG(DISTINCT ...) is upstream's, and it averages the DISTINCT span
       -- values rather than the spans themselves — a lane where 200 shipments
       -- took 3 days and one took 9 reads 6.0, not 3.03. Mirrored deliberately;
       -- fix it in Metabase first if it should change.
       AVG(DISTINCT CASE WHEN NOT TRACKING_NUMBER IS NULL
                          AND NOT TRACKING_PICK_DATE IS NULL
                          AND NOT LOGISTICS_DELIVERY_TIMESTAMP IS NULL
                     THEN DATEDIFF(DAY, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP) END)
         AS P2D_AVG,
       -- Denominator is every AWB, not just delivered ones, so a consignment
       -- still in flight counts against the courier. Upstream's choice.
       COUNT(DISTINCT CASE WHEN NOT TRACKING_PICK_DATE IS NULL
                            AND NOT LOGISTICS_DELIVERY_TIMESTAMP IS NULL
                            AND DATEDIFF(DAY, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP) <= 5
             THEN TRACKING_NUMBER END) * 100.0
         / NULLIF(COUNT(DISTINCT TRACKING_NUMBER), 0) AS P2D_LE5,
       COUNT(DISTINCT CASE WHEN DATEDIFF(DAY, IDEAL_DELIVERY_DATE, FIRST_OFD_DATE) <= 0
                            AND NOT TRACKING_PICK_DATE IS NULL
             THEN TRACKING_NUMBER END) * 100.0
         / NULLIF(COUNT(DISTINCT TRACKING_NUMBER), 0) AS ONTIME_ATTEMPT
FROM ${REPORT_TABLE}
WHERE ${scoped}
  AND (FINAL_STATUS IS NULL OR FINAL_STATUS IN
       ('DELIVERED', 'EXCEPTION', 'INFORECEIVED', 'INTRANSIT', 'OUTFORDELIVERY', 'PICKEDUP'))
  AND LOGISTICS_CREATED_TIMESTAMP >= DATEADD(day, -${WINDOW_DAYS}, CURRENT_DATE)
  AND LOGISTICS_CREATED_TIMESTAMP < CURRENT_DATE
  AND NOT TRACKING_PICK_DATE IS NULL
GROUP BY 1 ORDER BY 2 DESC`),

    // Lane-wise (North Star) — grouped exactly as upstream groups it, so these
    // rows are 1:1 with the Metabase table.
    querySnowflake<Record<string, unknown>>(`
SELECT COALESCE(LANE_CLASSIFICATION, '—') AS LANE,
       COALESCE(WAREHOUSE_NAME, '—') AS WH,
       SUM(PACKAGE_COUNT) AS BOXES,
       -- FASR: delivered on the SAME DAY it first went out for delivery. Note
       -- this reads 0% for any lane with no OFD scan at all (self-delivery
       -- lanes never get one) — that is an absence of evidence, not a failure.
       COALESCE(100.0 * COUNT(DISTINCT CASE WHEN FINAL_STATUS = 'DELIVERED'
                    AND NOT FIRST_OFD_DATE IS NULL
                    AND NOT LOGISTICS_DELIVERY_TIMESTAMP IS NULL
                    AND TO_DATE(FIRST_OFD_DATE) = TO_DATE(LOGISTICS_DELIVERY_TIMESTAMP)
              THEN TRACKING_NUMBER END)
         / NULLIF(COUNT(DISTINCT CASE WHEN FINAL_STATUS = 'DELIVERED' THEN TRACKING_NUMBER END), 0), 0)
         AS FASR,
       -- Both on-time columns measure against DELIVERY_TAT, the per-order
       -- deadline — not against IDEAL_DELIVERY_DATE.
       COALESCE(100.0 * COUNT(DISTINCT CASE WHEN FINAL_STATUS = 'DELIVERED'
                    AND NOT DELIVERY_TAT IS NULL
                    AND NOT COALESCE(FIRST_OFD_DATE, LOGISTICS_DELIVERY_TIMESTAMP) IS NULL
                    AND COALESCE(FIRST_OFD_DATE, LOGISTICS_DELIVERY_TIMESTAMP) <= DELIVERY_TAT
              THEN TRACKING_NUMBER END)
         / NULLIF(COUNT(DISTINCT CASE WHEN FINAL_STATUS = 'DELIVERED' THEN TRACKING_NUMBER END), 0), 0)
         AS ONTIME_ATTEMPT,
       COALESCE(100.0 * COUNT(DISTINCT CASE WHEN FINAL_STATUS = 'DELIVERED'
                    AND NOT LOGISTICS_DELIVERY_TIMESTAMP IS NULL
                    AND NOT DELIVERY_TAT IS NULL
                    AND LOGISTICS_DELIVERY_TIMESTAMP <= DELIVERY_TAT
              THEN TRACKING_NUMBER END)
         / NULLIF(COUNT(DISTINCT CASE WHEN FINAL_STATUS = 'DELIVERED' THEN TRACKING_NUMBER END), 0), 0)
         AS ONTIME_DELIVERY,
       PERCENTILE_CONT(0.5) WITHIN GROUP (
         ORDER BY DATEDIFF(DAY, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP)) AS P50,
       PERCENTILE_CONT(0.9) WITHIN GROUP (
         ORDER BY DATEDIFF(DAY, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP)) AS P90,
       100 * COUNT(DISTINCT CASE WHEN ORDER_PLACEMENT_SLA IN ('WITHIN_SLA', 'EARLY_CREATION')
                                  AND HANDOVER_SLA = 'WITHIN_SLA'
                                  AND PICKUP_SLA = 'WITHIN_SLA'
                                  AND DELIVERY_SLA = 'WITHIN_SLA'
             THEN ORDER_NAME END)
         / NULLIF(COUNT(DISTINCT ORDER_NAME), 0) AS PERFECT_PCT,
       COUNT(DISTINCT TRACKING_NUMBER) AS SHIPMENTS,
       SUM(CASE WHEN FINAL_STATUS IN ('DELIVERED') THEN 1 ELSE 0 END) * 100.0
         / NULLIF(COUNT(*), 0) AS DELIVERED_PCT
FROM ${REPORT_TABLE}
WHERE ${scoped}
  AND NOT IDEAL_DELIVERY_DATE IS NULL
  AND TRACKING_PICK_DATE >= CURRENT_DATE - ${WINDOW_DAYS}
GROUP BY 1, 2 ORDER BY 3 DESC`),
  ]);

  const totals = kpiRows[0] ?? {};
  return {
    windowDays: WINDOW_DAYS,
    totalOrders: int(totals.TOTAL_ORDERS),
    kpis: KPIS.map((k) => ({ key: k.key, label: k.label, icon: k.icon, pct: num(totals[k.col]) })),
    trend: trendRows.map((r) => ({
      idealDeliveryDate: String(r.D),
      totalOrders: int(r.TOTAL_ORDERS),
      orderPct: num(r.ORDER_PCT),
      whPct: num(r.WH_PCT),
      pickupPct: num(r.PICKUP_PCT),
      deliveryPct: num(r.DELIVERY_PCT),
      perfectPct: num(r.PERFECT_PCT),
    })),
    couriers: courierRows.map((r) => ({
      courier: String(r.COURIER),
      awbs: int(r.AWBS),
      boxes: int(r.BOXES),
      pickupPct: num(r.PICKUP_PCT),
      deliveryPct: num(r.DELIVERY_PCT),
      breached: int(r.BREACHED),
      p2dAvg: num(r.P2D_AVG),
      p2dLe5Pct: num(r.P2D_LE5),
      onTimeAttemptPct: num(r.ONTIME_ATTEMPT),
    })),
    lanes: laneRows.map((r) => ({
      lane: String(r.LANE),
      warehouse: String(r.WH),
      boxes: int(r.BOXES),
      shipments: int(r.SHIPMENTS),
      fasrPct: num(r.FASR),
      onTimeAttemptPct: num(r.ONTIME_ATTEMPT),
      onTimeDeliveryPct: num(r.ONTIME_DELIVERY),
      p50: num(r.P50),
      p90: num(r.P90),
      perfectPct: num(r.PERFECT_PCT),
      deliveredPct: num(r.DELIVERED_PCT),
    })),
  };
}

/**
 * Cached per (scope, area manager) for 5 minutes.
 *
 * The source only moves on its own upstream schedule, so a live read on every
 * page load would open four Snowflake connections to re-derive numbers that
 * cannot have changed. Five minutes is short enough that an operator refreshing
 * after a sync sees new figures within one coffee, and long enough that a team
 * all opening the tab at 9am costs one query set rather than forty.
 *
 * The cache key carries the scope, so one facility's numbers can never be
 * served to another facility's user out of the cache.
 */
export function loadDashboard(scope: FacilityScope, areaManager?: string): Promise<DashboardData> {
  const key = `${scope}|${areaManager ?? ""}`;
  return unstable_cache(() => fetchDashboard(scope, areaManager), ["reports-dashboard", key], {
    revalidate: 300,
  })();
}
