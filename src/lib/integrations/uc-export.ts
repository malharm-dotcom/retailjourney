// Unicommerce direct intake — the Phase-A fast path (PRD §8a, Artifact E).
//
// This exists to cut order-visibility lag, nothing more. The spine remains the
// enrichment, tracking and SLA authority (Phase-B); this gets an order into
// Postgres in ~30 minutes instead of waiting an hour for maplemonk, carrying
// only the fields needed to make it real on a board.
//
// SHAPE OF THE SOURCE, measured rather than assumed (28,632 rows / 178 orders,
// SAPL-WH2, 24h):
//
//   - The export is ASYNC and FACILITY-LEVEL. create → poll → download a CSV,
//     one job per facility. Without a Facility header UC answers 403
//     "Illegal Access, facility is required", so a single call can never see
//     the whole estate — runUcIntake fans out and unions.
//   - `exportColums` MUST be named. An empty array is rejected outright.
//     Everything financial, tax-bearing or personal is therefore never
//     REQUESTED — the safest place to drop customer data is before it is sent.
//   - UC returns columns that were never asked for. Every field below is read
//     BY HEADER; nothing here may depend on column position.
//   - Grain is one row per Sale Order Item Code (unique across all 28,632).
//     Item lines are aggregated away here and never stored: order quantity is
//     their COUNT, and that is the only thing the app needs from them.
//   - `Weight` is per SHIPPING PACKAGE, not per item (178 packages, none with
//     conflicting weights), and is in grams.
//   - `Tracking Number` equals the Shipping Package Code and the courier reads
//     SELF. It is an internal package reference, NOT a courier AWB, and is
//     deliberately not mapped — treating it as one would collide with the real
//     AWBs the spine and eShipz carry.

import { parseCsv } from "../csv";
import { isoFromIstNtz, istDateFromNtz } from "../ist";
import { normOrderType } from "../distribution-map";
import { FACILITIES, type Facility, type Order, type OrderType } from "../types";
import { ucDownload, ucPost } from "./uc-client";

const POLL_INTERVAL_MS = 5_000;
/** ~3 minutes. A real export took 25 polls; this leaves headroom without
 *  letting one wedged facility hold the whole run open indefinitely. */
const POLL_MAX_ATTEMPTS = 36;

/** The four channels store orders arrive on. */
export const UC_STORE_CHANNELS = [
  "FRANCHISE_STORE_B2B",
  "OWN_STORE",
  "FRANCHISE_STORE",
  "OWN_STORE_B2B",
];

/** UC's own column keys. See the header note on why nothing financial, taxable
 *  or personal appears here. */
const UC_COLUMNS = [
  "soicode",
  "displayorderCode",
  "saleOrderCode",
  "ShippingPackageCode",
  "channel",
  "facility",
  "saleOrderCustomFields_Order_Type",
  "status",
  "SoiStatus",
  "shippingPackageStatusCode",
  "onhold",
  "cancellationReason",
  "created",
  "displayOrderDateTime",
  "updated",
  "packingtimeinvoiceuser",
  "dispatchDate",
  "skuCode",
  "skuName",
  "actualWeight",
  "invoiceCode",
];

function exportJobTypeName(): string {
  return process.env.UC_EXPORT_JOB_TYPE ?? "4mclothingllp Sale Orders";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ExportCreateResponse {
  jobCode?: string;
  errors?: unknown[];
}
interface ExportStatusResponse {
  status?: string; // QUEUED | RUNNING | PROCESSING | COMPLETE | FAILED
  filePath?: string;
  errors?: unknown[];
}

/**
 * One export job for one facility → the raw CSV text.
 *
 * `updatedOn` is the filter id the tenant actually uses — NOT the `updatedAt`
 * the pre-removal client sent. It is also the field the watermark advances on,
 * so the two cannot drift apart.
 */
export async function runUcExport(
  facility: Facility,
  startMs: number,
  endMs: number,
): Promise<string> {
  const create = await ucPost<ExportCreateResponse>("/services/rest/v1/export/job/create", {
    facility,
    body: {
      exportJobTypeName: exportJobTypeName(),
      exportColums: UC_COLUMNS,
      exportFilters: [
        { id: "updatedOn", dateRange: { start: startMs, end: endMs } },
        { id: "channelFilter", selectedValues: UC_STORE_CHANNELS },
      ],
      frequency: "ONETIME",
    },
  });
  if (!create.jobCode) {
    throw new Error(
      `UC export create (${facility}) returned no jobCode: ${JSON.stringify(create.errors ?? create).slice(0, 300)}`,
    );
  }

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    const status = await ucPost<ExportStatusResponse>("/services/rest/v1/export/job/status", {
      facility,
      body: { jobCode: create.jobCode },
    });
    if (status.status === "COMPLETE" && status.filePath) return ucDownload(status.filePath);
    if (status.status === "FAILED") {
      throw new Error(
        `UC export job ${create.jobCode} (${facility}) FAILED: ${JSON.stringify(status.errors ?? {}).slice(0, 300)}`,
      );
    }
  }
  throw new Error(`UC export job ${create.jobCode} (${facility}) did not complete in time`);
}

// ---------------------------------------------------------------------------
// Mapping. Pure from here down — every function below is testable without UC.

/** Channel arrives in TWO vocabularies at once: display labels ("Own Store",
 *  "Franchise Store") alongside the enums (OWN_STORE_B2B, FRANCHISE_STORE_B2B).
 *  Matching on the enum alone silently dropped 52 of 178 orders in the live
 *  sample, so both are normalised through one predicate. */
export function normUcChannel(v?: string): Order["channel"] | undefined {
  const c = (v ?? "").toUpperCase().replace(/[^A-Z]+/g, "_");
  if (!c) return undefined;
  if (c.includes("FRANCHISE")) return "FRANCHISE_STORE";
  if (c.includes("OWN")) return "OWN_STORE";
  return undefined;
}

/** UC facility strings are already the app's codes; anything else is refused
 *  rather than coerced, so an unknown warehouse never lands in a scoped view. */
export function normUcFacility(v?: string): Facility | undefined {
  const f = (v ?? "").trim().toUpperCase();
  return (FACILITIES as readonly string[]).includes(f) ? (f as Facility) : undefined;
}

/** One item row, already reduced to the fields intake reads. */
export interface UcItemRow {
  itemCode: string;
  soNumber: string;
  packageCode?: string;
  channel?: Order["channel"];
  facility?: Facility;
  type: OrderType;
  itemStatus?: string;
  packageStatus?: string;
  onHold: boolean;
  createdTs?: string;
  orderTs?: string;
  updatedTs?: string;
  packedTs?: string;
  dispatchedTs?: string;
  /** Grams, at PACKAGE grain — the same value repeats on every item row of a
   *  package and must be counted once per package, never summed per item. */
  packageWeightG?: number;
  invoiceCode?: string;
}

/** Header → index, matched case/punctuation-insensitively. Returns -1 when the
 *  column is absent, which every read below tolerates: UC adding or renaming a
 *  column must degrade one field, never throw away a whole export. */
function headerIndex(headers: string[]): (name: string) => number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map(headers.map((h, i) => [norm(h), i]));
  return (name: string) => map.get(norm(name)) ?? -1;
}

export function parseUcExport(csv: string): UcItemRow[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const at = headerIndex(rows[0]);
  const I = {
    item: at("Sale Order Item Code"),
    order: at("Display Order Code"),
    pkg: at("Shipping Package Code"),
    channel: at("Channel Name"),
    facility: at("Facility"),
    type: at("Order_Type"),
    itemStatus: at("Sale Order Item Status"),
    pkgStatus: at("Shipping Package Status Code"),
    onHold: at("On Hold"),
    created: at("Created"),
    orderTs: at("Order Date as dd/mm/yyyy hh:MM:ss"),
    updated: at("Updated"),
    packed: at("Packing Time"),
    dispatched: at("Dispatch Date"),
    weight: at("Weight"),
    invoice: at("Invoice Code"),
  };
  const cell = (r: string[], i: number): string | undefined => {
    if (i < 0) return undefined;
    const v = (r[i] ?? "").trim();
    return v === "" ? undefined : v;
  };

  const out: UcItemRow[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const itemCode = cell(r, I.item);
    const soNumber = cell(r, I.order);
    if (!itemCode || !soNumber) continue;
    // Dedupe on Sale Order Item Code. Unique across the whole live sample, but
    // a re-export overlapping the previous window would repeat rows and must
    // not double the quantity.
    if (seen.has(itemCode)) continue;
    seen.add(itemCode);

    const weight = Number(cell(r, I.weight));
    out.push({
      itemCode,
      soNumber,
      packageCode: cell(r, I.pkg),
      channel: normUcChannel(cell(r, I.channel)),
      facility: normUcFacility(cell(r, I.facility)),
      type: normOrderType(cell(r, I.type)),
      itemStatus: cell(r, I.itemStatus),
      packageStatus: cell(r, I.pkgStatus),
      onHold: (cell(r, I.onHold) ?? "").toLowerCase() === "true",
      createdTs: isoFromIstNtz(cell(r, I.created)),
      orderTs: isoFromIstNtz(cell(r, I.orderTs)),
      updatedTs: isoFromIstNtz(cell(r, I.updated)),
      packedTs: isoFromIstNtz(cell(r, I.packed)),
      dispatchedTs: isoFromIstNtz(cell(r, I.dispatched)),
      packageWeightG: Number.isFinite(weight) ? weight : undefined,
      invoiceCode: cell(r, I.invoice),
    });
  }
  return out;
}

/** One order, aggregated from its item rows. */
export interface UcOrder {
  soNumber: string;
  /** LEFT(order_name,6), upper-cased — the store-master SO code. */
  storePrefix: string;
  qty: number;
  cancelledItems: number;
  facility?: Facility;
  channel?: Order["channel"];
  type: OrderType;
  orderDate?: string;
  orderTimestamp?: string;
  createdTs?: string;
  packedTs?: string;
  dispatchedTs?: string;
  weightKg?: number;
  saleInvoiceNumber?: string;
  onHold: boolean;
  /** Latest `Updated` seen on the order — the watermark input. */
  updatedTs?: string;
  packageStatuses: string[];
}

const earliest = (xs: (string | undefined)[]): string | undefined =>
  xs.filter((x): x is string => !!x).sort()[0];
const latest = (xs: (string | undefined)[]): string | undefined =>
  xs.filter((x): x is string => !!x).sort().slice(-1)[0];

/**
 * Item rows → one order each.
 *
 * Quantity is the COUNT of item rows, per the intake spec. Cancelled items are
 * INCLUDED in that count and reported separately as `cancelledItems` rather
 * than being quietly netted off: the spine's QUANTITY is authoritative and
 * overwrites this the moment it arrives, so a provisional count that silently
 * disagreed with the spec would be the worse of the two errors.
 */
export function aggregateUcOrders(items: UcItemRow[]): UcOrder[] {
  const byOrder = new Map<string, UcItemRow[]>();
  for (const it of items) {
    const list = byOrder.get(it.soNumber);
    if (list) list.push(it);
    else byOrder.set(it.soNumber, [it]);
  }

  const out: UcOrder[] = [];
  for (const [soNumber, rows] of byOrder) {
    // Weight repeats on every item row of a package, so it is summed ONCE per
    // distinct package and converted grams → kg.
    const perPackage = new Map<string, number>();
    for (const r of rows) {
      if (r.packageCode && r.packageWeightG != null) perPackage.set(r.packageCode, r.packageWeightG);
    }
    const grams = [...perPackage.values()].reduce((a, b) => a + b, 0);
    const orderTs = earliest(rows.map((r) => r.orderTs));

    out.push({
      soNumber,
      storePrefix: soNumber.trim().slice(0, 6).toUpperCase(),
      qty: rows.length,
      cancelledItems: rows.filter((r) => (r.itemStatus ?? "").toUpperCase() === "CANCELLED").length,
      facility: rows.find((r) => r.facility)?.facility,
      channel: rows.find((r) => r.channel)?.channel,
      type: rows[0].type,
      orderTimestamp: orderTs,
      orderDate: orderTs ? istDateFromNtz(orderTs.slice(0, 10)) : undefined,
      createdTs: earliest(rows.map((r) => r.createdTs)),
      packedTs: earliest(rows.map((r) => r.packedTs)),
      dispatchedTs: earliest(rows.map((r) => r.dispatchedTs)),
      weightKg: grams > 0 ? Math.round(grams / 100) / 10 : undefined,
      saleInvoiceNumber: rows.find((r) => r.invoiceCode)?.invoiceCode,
      onHold: rows.some((r) => r.onHold),
      updatedTs: latest(rows.map((r) => r.updatedTs)),
      packageStatuses: [...new Set(rows.map((r) => r.packageStatus).filter((s): s is string => !!s))],
    });
  }
  return out;
}

/**
 * The stage an intake-created order starts at.
 *
 * Deliberately coarse. This runs ONLY when creating a row the spine has not
 * reached yet; the spine and the floor own every transition after that, so
 * guessing finely here would only give them something wrong to correct.
 */
export function ucInitialStatus(o: UcOrder): Order["status"] {
  if (o.packageStatuses.includes("DISPATCHED")) return "DISPATCHED_TO_STORE";
  if (o.onHold) return "ON_HOLD";
  if (o.packedTs) return "READY_TO_DISPATCH";
  if (o.packageStatuses.includes("PICKING")) return "PICKING";
  return "NOT_STARTED";
}
