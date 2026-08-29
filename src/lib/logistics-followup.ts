// Logistics follow-up pivot — the file the team already shares with couriers,
// built from RetailJourney's own in-transit set.
//
// Store Name down the rows, a date or ageing dimension across the columns,
// distinct live AWBs in the cells, totals on both edges. Two column modes over
// ONE row set, so toggling the view can never change the count.
//
// Nothing here re-derives "in transit" or "which AWB": the predicate is the
// In-Transit board's own (in-transit/page.tsx), and the AWB is `OrderRow.awb`,
// which `primaryAwb()` already resolved furthest-forward-wins. Duplicating
// either would let this screen and the board disagree, which is the one thing
// a follow-up file must never do.

import { toCsv, type CsvColumn } from "./csv";
import type { OrderRow } from "./data";
import { daysBetween, istToday } from "./ist";
import { isDeadShipment } from "./journey";
import type { Order } from "./types";

export type EddSource = "courier" | "store";
export type ColumnMode = "edd" | "ageing";

/** Column for dockets carrying no EDD on the selected source. Present only when
 *  some docket lands in it — an always-on empty column is noise. Logistics
 *  Delivery EDD is ~59% populated, so under the default source this column is
 *  routinely the largest one on the sheet; it is a real follow-up queue ("the
 *  courier never gave us a date"), not a rounding error to hide. */
export const NO_EDD = "(no EDD)";

/**
 * Days past EDD, bucketed. Edges are the ones the follow-up is written around:
 * anything not yet due is one column, today is its own column because that is
 * the call you make first, then widening bands as the chase gets colder.
 *
 * Deliberately NOT sla.ts's `ageingBucket`. That one buckets days since
 * DISPATCH (0-2/3-5/6-9/10+) for the ageing report — a different measurement
 * off a different anchor. Bending it to fit here would silently move that
 * report's boundaries.
 */
export const AGEING_BUCKETS = ["Not due", "Due today", "1–2d", "3–5d", "6–10d", "10d+"] as const;

export function ageingBucketOf(edd: string, today: string): string {
  const past = daysBetween(edd, today); // positive once today is past the EDD
  if (past < 0) return "Not due";
  if (past === 0) return "Due today";
  if (past <= 2) return "1–2d";
  if (past <= 5) return "3–5d";
  if (past <= 10) return "6–10d";
  return "10d+";
}

/**
 * The dockets a follow-up chases: still on the road, not a dead label.
 *
 * `overallStatus === "IN_TRANSIT"` is the In-Transit board's own summary-strip
 * predicate (in-transit/page.tsx:43). PICKUP_PENDING is excluded — a docket the
 * courier has not collected yet is a pickup chase, not a transit chase.
 * DELIVERED / INWARDED / CLOSED all fail the test outright.
 *
 * The `isDeadShipment` guard is the board's second layer, kept for the same
 * reason it exists there: `rollupOverall` already sends RETURN /
 * DELIVERY_FAILED to CLOSED, but only once a sync has recomputed the order, and
 * an RTO'd label must not appear on a follow-up in the meantime.
 */
export function inTransitDockets(rows: OrderRow[]): OrderRow[] {
  return rows.filter(
    (r) => r.order.overallStatus === "IN_TRANSIT" && !isDeadShipment(r.order.shipmentStatus),
  );
}

/** Manual first, synced behind it — the app's precedence rule, and the same
 *  fallback the Logistics queue uses. `logisticsPartner` alone is NULL on every
 *  spine-synced order, which would read as one giant "—" courier here. */
export function courierOf(o: Pick<Order, "logisticsPartner" | "courierPartner">): string {
  return o.logisticsPartner ?? o.courierPartner ?? "—";
}

/** The selected EDD. Neither name exists as a column: "Store Delivery EDD" is
 *  `idealDeliveryDate` (our rulebook promise, ~93% populated) and "Logistics
 *  Delivery EDD" is `expectedDate` (the courier's own, ~59%). Both are @db.Date
 *  → already IST business dates, so nothing here does offset arithmetic. */
export function eddOf(o: Pick<Order, "idealDeliveryDate" | "expectedDate">, src: EddSource) {
  return src === "store" ? o.idealDeliveryDate : o.expectedDate;
}

export interface FollowupFilters {
  eddSource: EddSource;
  mode: ColumnMode;
  /** Empty = every courier. */
  couriers: string[];
  /** Mode 1 column bounds (inclusive IST business dates). Ignored in ageing
   *  mode, where the axis is the fixed bucket list and cannot run away. */
  from: string;
  to: string;
}

export interface PivotRow {
  store: string;
  /** One count per column, same order as `columns`. 0 renders blank. */
  cells: number[];
  total: number;
}

export interface Pivot {
  columns: string[];
  rows: PivotRow[];
  columnTotals: number[];
  grandTotal: number;
  /** In-transit dockets with no AWB captured yet. Excluded from the matrix —
   *  there is nothing to chase a courier with — but counted, never dropped. */
  noAwb: number;
  /** Mode 1 only: dockets whose EDD falls outside the chosen window. Same
   *  principle — bounding the column axis must not silently lose rows. */
  outOfWindow: number;
  /** The IST date the ageing was measured against. */
  today: string;
}

/**
 * Build the matrix. Pure and read-only: an in-memory projection of rows the
 * caller already fetched through the scoped read path.
 */
export function buildPivot(rows: OrderRow[], f: FollowupFilters, today = istToday()): Pivot {
  const wanted = new Set(f.couriers);
  let pool = inTransitDockets(rows);
  if (wanted.size) pool = pool.filter((r) => wanted.has(courierOf(r.order)));

  const noAwb = pool.filter((r) => !r.awb).length;
  pool = pool.filter((r) => r.awb);

  let outOfWindow = 0;
  const counts = new Map<string, Map<string, number>>();
  const seenColumns = new Set<string>();

  for (const r of pool) {
    const edd = eddOf(r.order, f.eddSource);
    let col: string;
    if (f.mode === "edd") {
      if (!edd) col = NO_EDD;
      else if (edd < f.from || edd > f.to) {
        outOfWindow++;
        continue;
      } else col = edd;
    } else {
      col = edd ? ageingBucketOf(edd, today) : NO_EDD;
    }
    seenColumns.add(col);
    const store = r.order.storeNameFormat;
    const byCol = counts.get(store) ?? new Map<string, number>();
    byCol.set(col, (byCol.get(col) ?? 0) + 1);
    counts.set(store, byCol);
  }

  // Ageing keeps every bucket whether or not it is populated: a fixed axis is
  // how you see at a glance that nothing is 10d+ yet. Dates keep only the ones
  // that occur, so a 29-day window does not render 29 mostly-blank columns.
  const columns =
    f.mode === "edd"
      ? [...seenColumns].filter((c) => c !== NO_EDD).sort()
      : [...AGEING_BUCKETS];
  if (seenColumns.has(NO_EDD)) columns.push(NO_EDD);

  const pivotRows: PivotRow[] = [...counts.keys()].sort().map((store) => {
    const byCol = counts.get(store)!;
    const cells = columns.map((c) => byCol.get(c) ?? 0);
    return { store, cells, total: cells.reduce((a, n) => a + n, 0) };
  });

  const columnTotals = columns.map((_, i) => pivotRows.reduce((a, r) => a + r.cells[i], 0));

  return {
    columns,
    rows: pivotRows,
    columnTotals,
    grandTotal: columnTotals.reduce((a, n) => a + n, 0),
    noAwb,
    outOfWindow,
    today,
  };
}

/**
 * The matrix as a CSV, laid out exactly as it renders — not a flat row dump.
 *
 * `toCsv` rather than a local join: it already carries the Excel-facing rules
 * this file needs (CRLF, quote-when-required, and the formula guard that stops
 * a store name arriving from the spine as `=HYPERLINK(...)` from executing in
 * the operator's spreadsheet). The BOM is added by `downloadCsv` at the blob.
 *
 * No XLSX: the repo has no writer dependency, and one is not worth adding for a
 * grid of integers Excel opens natively.
 */
export function pivotCsv(pivot: Pivot): string {
  // 0 is blank, matching the screen and the sample the team shares — a wall of
  // zeroes is what makes their sheet unreadable.
  const cell = (n: number) => (n === 0 ? "" : n);
  const columns: CsvColumn<PivotRow>[] = [
    { header: "Store Name", value: (r) => r.store },
    ...pivot.columns.map((c, i) => ({ header: c, value: (r: PivotRow) => cell(r.cells[i]) })),
    { header: "Grand Total", value: (r) => r.total },
  ];
  // The totals row is one more row of the same shape, so the file opens as a
  // single rectangular block rather than a table plus a footer.
  const totals: PivotRow = {
    store: "Grand Total",
    cells: pivot.columnTotals,
    total: pivot.grandTotal,
  };
  return toCsv(columns, [...pivot.rows, totals]);
}
