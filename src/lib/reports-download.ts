// Filtered CSV downloads for the Reports desk.
//
// Four reports, no rendered grid — the deliverable is the file. Three of them
// run the SAME query strings the at-a-glance panels run (courierSql / laneSql
// from reports-dashboard.ts), because a download that disagrees with the panel
// above it is a bug and the only way to make that impossible is to share the
// string rather than to keep two copies honest by inspection.
//
// The odd one out is the order-level detail export, and deliberately so. It is
// the operational workhorse — one row per order, the app's own journey state,
// its resolved anchor and its primary AWB — so it reads RetailJourney's own
// spine-backed Postgres and INCLUDES the out-of-rulebook orders that
// distribution_analytics drops. It is not a must-match report; it is the one an
// operator opens to go find a specific consignment.

import { toCsv, csvFilename, type CsvColumn } from "./csv";
import { scopedOrders, type OrderRow } from "./data";
import { addDays, istDateOf, istToday } from "./ist";
import {
  REPORT_TABLE,
  courierSql,
  courierWindow,
  laneSql,
  laneWindow,
  toCourierRow,
  toLaneRow,
  scopeClause,
  WINDOW_DAYS,
  type CourierRow,
  type LaneRow,
} from "./reports-dashboard";
import { querySnowflake } from "./snowflake";
import { LEG_LABEL, SLA_LABEL, type SlaLeg } from "./sla";
import { OVERALL_LABEL, STATUS_LABEL } from "./journey";
import { entitledFacilities, resolveScope } from "./rbac";
import { FACILITIES, type Facility, type FacilityScope, type User } from "./types";

/** A filter the caller got wrong — answered as 400, not 500. */
export class FilterError extends Error {}

export interface DownloadDef {
  slug: string;
  title: string;
  description: string;
  icon: string;
  /** Which extra filter control the form shows, beyond dates + facility. */
  filter?: "courier" | "lane";
}

export const DOWNLOADS: DownloadDef[] = [
  {
    slug: "order-detail",
    title: "Order-level detail",
    description:
      "One row per order — journey stage, every SLA leg, the live AWB and the reconciliation columns.",
    icon: "clipboard-list-bold-duotone",
  },
  {
    slug: "courier-performance",
    title: "Courier partner performance",
    description: "The courier panel above, as a file. Same figures, filterable to one partner.",
    icon: "delivery-bold-duotone",
    filter: "courier",
  },
  {
    slug: "lane-performance",
    title: "Lane-wise performance",
    description: "The lane panel above, as a file. Same figures, filterable to one lane.",
    icon: "routing-bold-duotone",
    filter: "lane",
  },
  {
    slug: "dispatch-summary",
    title: "Dispatch summary (DOD)",
    description: "Boxes and pieces picked up per day, pivoted across warehouses.",
    icon: "box-bold-duotone",
  },
];

export const downloadBySlug = (slug: string) => DOWNLOADS.find((d) => d.slug === slug);

/**
 * Default trailing window when the operator sets no dates.
 *
 * An unfiltered order-level export would otherwise stream the whole table on
 * every click. It is deliberately the PANEL's window rather than a round 30:
 * with the dates left alone, the lane download is the lane panel, row for row.
 * (The courier panel stops at yesterday while this range runs to today, so that
 * file is the panel plus any AWB created this morning — more current, never
 * less.) Stated on the form, so a bounded file is never a surprise.
 */
export const DEFAULT_WINDOW_DAYS = WINDOW_DAYS;

export interface ReportFilters {
  from?: string;
  to?: string;
  courier?: string;
  lane?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the requested range to two IST business dates.
 *
 * A supplied-but-malformed date is an ERROR, not something to quietly replace
 * with a default: a stale bookmark that silently returns the last 30 days
 * instead of the quarter someone asked for is worse than a message saying so.
 * Both bounds are inclusive IST calendar dates; nothing here does offset
 * arithmetic, because `addDays`/`istToday` already work in IST epoch terms.
 */
export function resolveRange(f: ReportFilters, defaultDays = DEFAULT_WINDOW_DAYS) {
  for (const [k, v] of [["from", f.from], ["to", f.to]] as const) {
    if (v && !DATE_RE.test(v)) throw new FilterError(`Invalid ${k} date: ${v} (expected YYYY-MM-DD)`);
  }
  const to = f.to || istToday();
  const from = f.from || addDays(to, -defaultDays);
  if (from > to) throw new FilterError(`from (${from}) is after to (${to})`);
  return { from, to };
}

/**
 * The facility a download runs against.
 *
 * The session's resolved scope is the ceiling. A `facility` parameter may
 * NARROW within it and can never widen it or move it sideways: once the session
 * has resolved to a single warehouse, the parameter is ignored entirely rather
 * than consulted. When the session is "ALL", the parameter is still passed
 * through resolveScope, so entitlements are re-checked rather than assumed.
 */
export function downloadScope(
  user: Pick<User, "role" | "facilities" | "allView">,
  sessionScope: FacilityScope,
  requested?: string,
): FacilityScope {
  if (!requested || requested === "ALL") return sessionScope;
  if (!(FACILITIES as readonly string[]).includes(requested)) return sessionScope;
  if (sessionScope !== "ALL") return sessionScope;
  return resolveScope(user, requested);
}

/** Facilities the form may offer — never more than the session already allows. */
export function selectableFacilities(
  user: Pick<User, "role" | "facilities" | "allView">,
  sessionScope: FacilityScope,
): Facility[] {
  return sessionScope === "ALL" ? entitledFacilities(user) : [sessionScope];
}

/** A value going into literal SQL text. Quote-doubled and length-capped — the
 *  courier and lane names arrive from a query string, so they are treated as
 *  hostile even though the form only ever offers values we rendered. */
function sqlText(v: string): string {
  if (v.length > 120) throw new FilterError("Filter value too long");
  return v.replace(/'/g, "''");
}

/** Courier / lane equality, with the panel's "—" placeholder mapped back to the
 *  NULL it stands for. */
function eqOrNull(column: string, value: string): string {
  return value === "—" ? `${column} IS NULL` : `${column} = '${sqlText(value)}'`;
}

const pctCell = (v: number | null) => (v == null ? "" : Number(v.toFixed(2)));
const dayCell = (v: number | null) => (v == null ? "" : Number(v.toFixed(2)));

const COURIER_COLUMNS: CsvColumn<CourierRow>[] = [
  { header: "Courier Partner", value: (r) => r.courier },
  { header: "Total AWBs", value: (r) => r.awbs },
  { header: "Box Count", value: (r) => r.boxes },
  { header: "Pickup SLA%", value: (r) => pctCell(r.pickupPct) },
  { header: "Delivery SLA%", value: (r) => pctCell(r.deliveryPct) },
  { header: "Breached Count", value: (r) => r.breached },
  { header: "P2D Avg Days", value: (r) => dayCell(r.p2dAvg) },
  { header: "P2D <=5D %", value: (r) => pctCell(r.p2dLe5Pct) },
  { header: "On-time Attempt%", value: (r) => pctCell(r.onTimeAttemptPct) },
];

const LANE_COLUMNS: CsvColumn<LaneRow>[] = [
  { header: "Lane Classification", value: (r) => r.lane },
  { header: "Warehouse Name", value: (r) => r.warehouse },
  { header: "Box Count", value: (r) => r.boxes },
  { header: "FASR%", value: (r) => pctCell(r.fasrPct) },
  { header: "On-Time Attempt%", value: (r) => pctCell(r.onTimeAttemptPct) },
  { header: "On-Time Delivery%", value: (r) => pctCell(r.onTimeDeliveryPct) },
  { header: "P50 Delivery Days", value: (r) => dayCell(r.p50) },
  { header: "P90 Delivery Days", value: (r) => dayCell(r.p90) },
  { header: "Perfect Order%", value: (r) => pctCell(r.perfectPct) },
  { header: "Total Shipments", value: (r) => r.shipments },
  { header: "Delivered%", value: (r) => pctCell(r.deliveredPct) },
];

/** The four SLA legs the desk talks about, plus the composite. Rendered with
 *  the same labels the boards use so a CSV cell and a pill read alike. */
const SLA_LEGS: SlaLeg[] = ["PLACEMENT", "HANDOVER", "PICKUP", "DELIVERY", "LOGISTICS_DELIVERY"];

const legState = (r: OrderRow, leg: SlaLeg) => {
  const s = r.sla.legs.find((l) => l.leg === leg)?.state;
  return s ? SLA_LABEL[s] : "";
};

const ANCHOR_LABEL: Record<string, string> = {
  DISPATCHED: "dispatch",
  MANIFESTED: "manifest",
  PICKED_UP: "pickup",
  TRACKING_PICK: "pickup",
};

const ORDER_COLUMNS: CsvColumn<OrderRow>[] = [
  { header: "SO Number", value: (r) => r.order.soNumber },
  { header: "Order Date", value: (r) => r.order.orderDate },
  { header: "Facility", value: (r) => r.order.facility },
  { header: "Order Type", value: (r) => r.order.type },
  { header: "Channel", value: (r) => r.order.channel },
  { header: "Store Channel", value: (r) => r.order.storeChannel },
  { header: "Store ID", value: (r) => r.order.storeId },
  { header: "Store Name", value: (r) => r.order.storeNameFormat },
  { header: "Final Store", value: (r) => r.order.finalStore },
  { header: "Ownership", value: (r) => r.order.ownership },
  { header: "State", value: (r) => r.order.state },
  { header: "Zone", value: (r) => r.order.zone },
  { header: "Area Manager", value: (r) => r.order.areaManager },
  { header: "Merchandiser", value: (r) => r.order.merchandiser },
  { header: "Qty", value: (r) => r.order.qty },
  { header: "Fulfilled Qty", value: (r) => r.order.fulfilledQty },
  { header: "Box Count", value: (r) => r.order.boxCount },
  { header: "WH Status", value: (r) => STATUS_LABEL[r.order.status] },
  { header: "Overall Status", value: (r) => OVERALL_LABEL[r.order.overallStatus] },
  { header: "Lane Classification", value: (r) => r.order.laneClassification },
  { header: "Logistics Partner", value: (r) => r.order.logisticsPartner },
  { header: "Courier Partner", value: (r) => r.order.courierPartner },
  { header: "DC Number", value: (r) => r.order.dcNumber },
  { header: "LR Number", value: (r) => r.order.lrNumber },
  // The furthest-forward live child, exactly as the boards pick it — a dead
  // RTO label never becomes the order's headline AWB. The count and the flag
  // beside it exist so a split dispatch is visible in the file rather than
  // collapsed into one row that looks single.
  { header: "AWB", value: (r) => r.awb },
  { header: "AWB Count", value: (r) => r.awbCount },
  { header: "Multi-AWB", value: (r) => (r.awbCount > 1 ? "YES" : "") },
  { header: "Tracking Status", value: (r) => r.order.trackingStatus },
  { header: "Transit Anchor Date", value: (r) => r.anchor.date },
  { header: "Anchored On", value: (r) => (r.anchor.source ? ANCHOR_LABEL[r.anchor.source] : "") },
  { header: "Manifested", value: (r) => (r.order.manifestedTs ? istDateOf(r.order.manifestedTs) : "") },
  { header: "Dispatched Date", value: (r) => r.order.dispatchedDate },
  { header: "Expected Date", value: (r) => r.order.expectedDate },
  { header: "Ideal Delivery Date", value: (r) => r.order.idealDeliveryDate },
  { header: "Delivered Date", value: (r) => r.order.deliveredDate },
  { header: "Inwarded Date", value: (r) => r.order.inwardedDate },
  { header: "Delivery Attempts", value: (r) => r.order.deliveryAttempts },
  ...SLA_LEGS.map((leg) => ({
    header: `${LEG_LABEL[leg]} SLA`,
    value: (r: OrderRow) => legState(r, leg),
  })),
  { header: "Perfect Order SLA", value: (r) => (r.sla.perfectOrder ? SLA_LABEL[r.sla.perfectOrder] : "") },
  { header: "Breaching", value: (r) => (r.breaching ? "YES" : "") },
  { header: "Ageing Days", value: (r) => r.sla.ageing },
  { header: "Rulebook Covered", value: (r) => (r.order.rulebookCovered === false ? "NO" : "YES") },
  { header: "Shortage Qty", value: (r) => r.order.shortageQty },
  { header: "Excess Qty", value: (r) => r.order.excessQty },
  { header: "STI Bill No", value: (r) => r.order.stiBillNo },
  { header: "Entry Status", value: (r) => r.order.entryStatus },
];

export interface DownloadResult {
  filename: string;
  csv: string;
  /** Data rows, excluding the header — reported back for the audit line. */
  rowCount: number;
}

/**
 * Build one report. Read-only: every branch is a SELECT or an in-memory
 * projection, and nothing here writes.
 */
export async function buildDownload(
  slug: string,
  scope: FacilityScope,
  user: User,
  filters: ReportFilters,
): Promise<DownloadResult> {
  const scoped = scopeClause(scope, user.role === "RETAIL_HEAD" ? user.areaManager : undefined);
  const { from, to } = resolveRange(filters);

  switch (slug) {
    case "order-detail": {
      // App-side, so this carries the out-of-rulebook orders the dashboard's
      // source drops, and the journey state the boards show.
      const rows = (await scopedOrders(scope, user)).filter(
        (r) => r.order.orderDate >= from && r.order.orderDate <= to,
      );
      rows.sort((a, b) => (a.order.orderDate === b.order.orderDate
        ? a.order.soNumber.localeCompare(b.order.soNumber)
        : b.order.orderDate.localeCompare(a.order.orderDate)));
      return csvResult("order-detail", ORDER_COLUMNS, rows);
    }

    case "courier-performance": {
      // Same window predicate as the panel, with its 31-day default replaced by
      // the operator's range on the SAME anchor column, so an unfiltered
      // download over the panel's window is the panel.
      const where = [
        scoped,
        courierWindow({ from, to }),
        filters.courier ? eqOrNull("COURIER_PARTNER", filters.courier) : undefined,
      ]
        .filter(Boolean)
        .join(" AND ");
      const rows = (await querySnowflake<Record<string, unknown>>(courierSql(where))).map(toCourierRow);
      return csvResult("courier-performance", COURIER_COLUMNS, rows);
    }

    case "lane-performance": {
      const where = [
        scoped,
        laneWindow({ from, to }),
        filters.lane ? eqOrNull("LANE_CLASSIFICATION", filters.lane) : undefined,
      ]
        .filter(Boolean)
        .join(" AND ");
      const rows = (await querySnowflake<Record<string, unknown>>(laneSql(where))).map(toLaneRow);
      return csvResult("lane-performance", LANE_COLUMNS, rows);
    }

    case "dispatch-summary":
      return dispatchSummary(scoped, from, to);

    default:
      throw new FilterError(`Unknown report: ${slug}`);
  }
}

/**
 * Dispatch summary (DOD): boxes and pieces per pick date, pivoted across the
 * warehouses that actually appear.
 *
 * The inner grouping is per (day, warehouse, ORDER), which is what makes the
 * piece count honest: the source is AWB-grain and QUANTITY is order-grain, so a
 * plain SUM(QUANTITY) counts a split order's pieces once per AWB. Boxes DO sum
 * across children — each AWB carries its own package count — while quantity
 * takes MAX, the one value every child of an order repeats.
 */
async function dispatchSummary(scoped: string, from: string, to: string): Promise<DownloadResult> {
  const rows = await querySnowflake<Record<string, unknown>>(`
SELECT D, WH, SUM(BOXES) AS BOXES, SUM(QTY) AS QTY FROM (
  SELECT TO_CHAR(TO_DATE(TRACKING_PICK_DATE), 'YYYY-MM-DD') AS D,
         COALESCE(WAREHOUSE_NAME, '—') AS WH,
         ORDER_NAME,
         SUM(PACKAGE_COUNT) AS BOXES,
         MAX(QUANTITY) AS QTY
  FROM ${REPORT_TABLE}
  WHERE ${scoped}
    AND NOT TRACKING_PICK_DATE IS NULL
    AND TO_DATE(TRACKING_PICK_DATE) BETWEEN '${from}' AND '${to}'
  GROUP BY 1, 2, 3
)
GROUP BY 1, 2 ORDER BY 1 DESC, 2`);

  const warehouses = [...new Set(rows.map((r) => String(r.WH)))].sort();
  const byDay = new Map<string, Map<string, { boxes: number; qty: number }>>();
  for (const r of rows) {
    const day = String(r.D);
    const cells = byDay.get(day) ?? new Map();
    cells.set(String(r.WH), { boxes: Number(r.BOXES ?? 0), qty: Number(r.QTY ?? 0) });
    byDay.set(day, cells);
  }

  interface Pivot {
    day: string;
    cells: Map<string, { boxes: number; qty: number }>;
  }
  const pivot: Pivot[] = [...byDay.entries()].map(([day, cells]) => ({ day, cells }));

  const columns: CsvColumn<Pivot>[] = [
    { header: "Pick Date", value: (p) => p.day },
    ...warehouses.flatMap((wh) => [
      { header: `${wh} Boxes`, value: (p: Pivot) => p.cells.get(wh)?.boxes ?? 0 },
      { header: `${wh} Qty`, value: (p: Pivot) => p.cells.get(wh)?.qty ?? 0 },
    ]),
    {
      header: "Total Boxes",
      value: (p) => [...p.cells.values()].reduce((a, c) => a + c.boxes, 0),
    },
    { header: "Total Qty", value: (p) => [...p.cells.values()].reduce((a, c) => a + c.qty, 0) },
  ];

  return csvResult("dispatch-summary", columns, pivot);
}

function csvResult<T>(prefix: string, columns: CsvColumn<T>[], rows: T[]): DownloadResult {
  return { filename: csvFilename(prefix), csv: toCsv(columns, rows), rowCount: rows.length };
}
