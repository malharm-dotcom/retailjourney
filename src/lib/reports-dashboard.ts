// At-a-glance Distribution 2.0 panels for the Reports desk.
//
// These read RETAIL_JOURNEY_SPINE directly rather than the app's Postgres, and
// deliberately so. The app's own SLA engine (sla.ts) RECOMPUTES every verdict
// against actuals; the spine carries the verdict Metabase itself renders, baked
// per row. Computing app-side would give numbers that are defensible but
// different, and the whole point of these panels is that they reconcile 1:1
// with the Distribution 2.0 dashboard. So: same table, same columns, same
// verdict strings. The app-side path is not blocked (the dispatchedDate →
// anchor re-anchor is done, see reports.ts) — it is simply the wrong source for
// a must-match panel.

import { unstable_cache } from "next/cache";
import { querySnowflake, SPINE_TABLE } from "./snowflake";
import type { FacilityScope } from "./types";

// ---------------------------------------------------------------------------
// THE SLA DEFINITION. One block, on purpose.
//
// The spine's *_SLA columns speak this vocabulary:
//   WITHIN_SLA · BREACHED · FUTURE SLA · BREACHED-PENDING FOR PROCESS ·
//   BREACHED-PENDING FOR DELIVERY · EARLY_CREATION (placement only) · NULL
//
// Metabase's exact numerator/denominator has NOT been confirmed against its
// question SQL yet, so these are stated defaults, not verified parity:
//
//   pass       = WITHIN_SLA, plus EARLY_CREATION on the placement leg (an order
//                raised ahead of its cutoff is early, not late — and it is 47%
//                of all rows, so this single choice moves that tile by ~45pts).
//   denominator= every non-NULL verdict EXCEPT 'FUTURE SLA'. A leg whose clock
//                has not run out yet is not-yet-applicable, not a pass; scoring
//                it either way would flatter or punish the day it lands in.
//                Both BREACHED-PENDING values DO count, as fails — the deadline
//                has already passed on those.
//   grain      = spine rows, i.e. order+bill+AWB. Live spine is 6,422 rows over
//                6,419 orders so this is ~1:1 today; it stops being so on a
//                split-dispatch day, when the courier legs genuinely are per-AWB.
//
// When the Metabase SQL arrives, reconcile HERE and nowhere else — every panel
// below and every CSV download built on top routes through these two helpers.
// ---------------------------------------------------------------------------

const EXCLUDED_FROM_DENOMINATOR = "'FUTURE SLA'";

/** Pass values for a leg. Placement is the only one that admits EARLY_CREATION. */
const passSet = (col: string) =>
  col === "ORDER_PLACEMENT_SLA" ? "'WITHIN_SLA','EARLY_CREATION'" : "'WITHIN_SLA'";

/** SQL fragment: this leg's SLA% under the definition above. NULL when the day
 *  has no applicable rows at all — rendered as "—", never as 0%.
 *  Exported for the test that pins the definition. */
export const slaPct = (col: string) => `ROUND(100 * SUM(IFF(${col} IN (${passSet(col)}), 1, 0))
      / NULLIF(SUM(IFF(${col} IS NOT NULL AND ${col} <> ${EXCLUDED_FROM_DENOMINATOR}, 1, 0)), 0), 2)`;

/** Denominator count, so a tile can show how thin the day was. */
const slaN = (col: string) =>
  `SUM(IFF(${col} IS NOT NULL AND ${col} <> ${EXCLUDED_FROM_DENOMINATOR}, 1, 0))`;

// ---------------------------------------------------------------------------
// Tile thresholds. Uniform across all five until real per-metric SLA targets
// are supplied — a tile that colours against a made-up target is worse than one
// that colours against an openly generic one.
// ---------------------------------------------------------------------------
export const KPI_GREEN = 95;
export const KPI_AMBER = 85;

export function kpiTone(pct: number | null): "done" | "handling" | "failed" | "pending" {
  if (pct == null) return "pending";
  if (pct >= KPI_GREEN) return "done";
  if (pct >= KPI_AMBER) return "handling";
  return "failed";
}

// ---------------------------------------------------------------------------
// The five tiles. Each is FUNCTION-anchored — measured on the date its own
// event happened, not on the order's ideal delivery date. That is the whole
// distinction the Journey table below carries a caveat about.
//
// Each tile resolves its own "as-of" day: the most recent day BEFORE today that
// has at least one applicable row. It is not literally "yesterday" because
// IDEAL_DELIVERY_DATE carries no weekend rows — a literal-yesterday Perfect
// Order tile reads "—" every Sunday and Monday. The tile therefore always
// states the date it is actually showing.
// ---------------------------------------------------------------------------
const KPIS = [
  { key: "placement", label: "Order Placement SLA", col: "ORDER_PLACEMENT_SLA", anchor: "TO_DATE(ORDER_DATE)", icon: "clipboard-list-bold-duotone" },
  { key: "wh", label: "WH Processing SLA", col: "HANDOVER_SLA", anchor: "TO_DATE(MANIFESTED_TIMESTAMP)", icon: "box-bold-duotone" },
  { key: "pickup", label: "Pickup SLA", col: "PICKUP_SLA", anchor: "TO_DATE(TRACKING_PICK_DATE)", icon: "delivery-bold-duotone" },
  { key: "delivery", label: "Delivery SLA", col: "DELIVERY_SLA", anchor: "TO_DATE(LOGISTICS_DELIVERY_TIMESTAMP)", icon: "shop-bold-duotone" },
  { key: "perfect", label: "Perfect Order", col: "PERFECT_ORDER_SLA", anchor: "TO_DATE(IDEAL_DELIVERY_DATE)", icon: "medal-ribbon-star-bold-duotone" },
] as const;

export interface KpiTile {
  key: string;
  label: string;
  icon: string;
  /** Percentage, or null when the metric has no applicable row at all. */
  pct: number | null;
  /** The IST business date this tile is measured on. */
  asOf?: string;
  /** Denominator — how many rows the percentage rests on. */
  n: number;
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
  trend: TrendRow[];
  couriers: CourierRow[];
  lanes: LaneRow[];
  /** Trailing window, in days, that the courier and lane tables cover. */
  windowDays: number;
}

/** How far back the courier and lane rollups look. Both are rolled up over the
 *  window rather than broken out per delivery date: an at-a-glance panel wants
 *  one row per courier, not fourteen. */
const WINDOW_DAYS = 14;

/** How many delivery dates the journey trend shows. */
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
 *  column; every percentage below routes through this so a "97.50" string never
 *  reaches a `.toFixed`. */
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number => Math.round(num(v) ?? 0);

const KPI_ROW = (k: (typeof KPIS)[number], where: string) => `
SELECT '${k.key}' AS METRIC, TO_CHAR(ASOF, 'YYYY-MM-DD') AS ASOF, N, PCT FROM (
  SELECT ${k.anchor} AS ASOF, ${slaN(k.col)} AS N, ${slaPct(k.col)} AS PCT
  FROM ${SPINE_TABLE}
  WHERE ${where}
    AND ${k.anchor} IS NOT NULL
    AND ${k.anchor} < CURRENT_DATE
    AND ${k.col} IS NOT NULL AND ${k.col} <> ${EXCLUDED_FROM_DENOMINATOR}
  GROUP BY 1 ORDER BY 1 DESC LIMIT 1
)`;

/**
 * The uncached read. Exported because `loadDashboard` wraps it in
 * `unstable_cache`, which only works inside a Next request context — anything
 * outside one (a script, a diagnostic, a check that these queries still parse
 * against the live spine) has to call this directly.
 */
export async function fetchDashboard(
  scope: FacilityScope,
  areaManager?: string,
): Promise<DashboardData> {
  const where = scopeClause(scope, areaManager);
  const window = `${where}
    AND TO_DATE(IDEAL_DELIVERY_DATE) BETWEEN DATEADD(day, -${WINDOW_DAYS}, CURRENT_DATE)
                                         AND DATEADD(day, -1, CURRENT_DATE)`;

  // Four statements, run concurrently. The Snowflake reader opens and destroys
  // a connection per call by design (see snowflake.ts) — there is no pool to
  // exhaust, and serialising them would just make the page four times slower.
  const [kpiRows, trendRows, courierRows, laneRows] = await Promise.all([
    querySnowflake<{ METRIC: string; ASOF: string | null; N: unknown; PCT: unknown }>(
      KPIS.map((k) => KPI_ROW(k, where)).join("\nUNION ALL"),
    ),

    querySnowflake<Record<string, unknown>>(`
SELECT TO_CHAR(TO_DATE(IDEAL_DELIVERY_DATE), 'YYYY-MM-DD') AS D,
       COUNT(DISTINCT ORDER_NAME) AS TOTAL_ORDERS,
       ${slaPct("ORDER_PLACEMENT_SLA")} AS ORDER_PCT,
       ${slaPct("HANDOVER_SLA")} AS WH_PCT,
       ${slaPct("PICKUP_SLA")} AS PICKUP_PCT,
       ${slaPct("DELIVERY_SLA")} AS DELIVERY_PCT,
       ${slaPct("PERFECT_ORDER_SLA")} AS PERFECT_PCT
FROM ${SPINE_TABLE}
WHERE ${where} AND IDEAL_DELIVERY_DATE IS NOT NULL AND TO_DATE(IDEAL_DELIVERY_DATE) < CURRENT_DATE
GROUP BY 1 ORDER BY 1 DESC LIMIT ${TREND_DAYS}`),

    querySnowflake<Record<string, unknown>>(`
SELECT COALESCE(COURIER_PARTNER, '—') AS COURIER,
       COUNT(*) AS AWBS,
       COALESCE(SUM(PACKAGE_COUNT), 0) AS BOXES,
       ${slaPct("PICKUP_SLA")} AS PICKUP_PCT,
       ${slaPct("DELIVERY_SLA")} AS DELIVERY_PCT,
       SUM(IFF(DELIVERY_SLA LIKE 'BREACHED%', 1, 0)) AS BREACHED,
       ROUND(AVG(DATEDIFF(day, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP)), 2) AS P2D_AVG,
       -- Denominator is shipments that HAVE a pick→deliver span, not every AWB.
       -- AVG(IFF(...)) over the whole partition scores a NULL span as a miss,
       -- which quietly charges a courier for consignments still in flight.
       ROUND(100 * SUM(IFF(DATEDIFF(day, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP) <= 5, 1, 0))
             / NULLIF(COUNT(DATEDIFF(day, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP)), 0), 2) AS P2D_LE5,
       -- On-time attempt: the courier's FIRST out-for-delivery run landed on or
       -- before the ideal delivery date. Measured only over shipments that were
       -- actually attempted, so a consignment still sitting in a hub neither
       -- helps nor hurts the number.
       ROUND(100 * SUM(IFF(TO_DATE(FIRST_OFD_DATE) <= TO_DATE(IDEAL_DELIVERY_DATE), 1, 0))
             / NULLIF(COUNT(FIRST_OFD_DATE), 0), 2) AS ONTIME_ATTEMPT
FROM ${SPINE_TABLE}
WHERE ${window}
GROUP BY 1 ORDER BY 2 DESC`),

    querySnowflake<Record<string, unknown>>(`
SELECT COALESCE(LANE_CLASSIFICATION, '—') AS LANE,
       COALESCE(WAREHOUSE_NAME, '—') AS WH,
       COALESCE(SUM(PACKAGE_COUNT), 0) AS BOXES,
       COUNT(*) AS SHIPMENTS,
       -- FASR: delivered on the first attempt, over everything delivered.
       ROUND(100 * SUM(IFF(LOGISTICS_DELIVERY_TIMESTAMP IS NOT NULL
                           AND COALESCE(DELIVERY_ATTEMPTS, 1) <= 1, 1, 0))
             / NULLIF(COUNT(LOGISTICS_DELIVERY_TIMESTAMP), 0), 2) AS FASR,
       ROUND(100 * SUM(IFF(TO_DATE(FIRST_OFD_DATE) <= TO_DATE(IDEAL_DELIVERY_DATE), 1, 0))
             / NULLIF(COUNT(FIRST_OFD_DATE), 0), 2) AS ONTIME_ATTEMPT,
       ROUND(100 * SUM(IFF(TO_DATE(LOGISTICS_DELIVERY_TIMESTAMP) <= TO_DATE(IDEAL_DELIVERY_DATE), 1, 0))
             / NULLIF(COUNT(LOGISTICS_DELIVERY_TIMESTAMP), 0), 2) AS ONTIME_DELIVERY,
       MEDIAN(DATEDIFF(day, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP)) AS P50,
       PERCENTILE_CONT(0.9) WITHIN GROUP (
         ORDER BY DATEDIFF(day, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP)) AS P90,
       ${slaPct("PERFECT_ORDER_SLA")} AS PERFECT_PCT,
       ROUND(100 * COUNT(LOGISTICS_DELIVERY_TIMESTAMP) / NULLIF(COUNT(*), 0), 2) AS DELIVERED_PCT
FROM ${SPINE_TABLE}
WHERE ${window}
GROUP BY 1, 2 ORDER BY 4 DESC`),
  ]);

  const byKey = new Map(kpiRows.map((r) => [r.METRIC, r]));
  return {
    windowDays: WINDOW_DAYS,
    kpis: KPIS.map((k) => {
      const r = byKey.get(k.key);
      return {
        key: k.key,
        label: k.label,
        icon: k.icon,
        pct: num(r?.PCT),
        asOf: r?.ASOF ?? undefined,
        n: int(r?.N),
      };
    }),
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
 * The spine itself only moves hourly, so a live read on every page load would
 * open four Snowflake connections to re-derive numbers that cannot have
 * changed. Five minutes is short enough that an operator refreshing after a
 * sync sees the new figures within one coffee, and long enough that a team all
 * opening the tab at 9am costs one query set rather than forty.
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
