// Snowflake distribution_analytics rows → domain Order (parent) +
// OrderShipment children. Rows arrive one per (ORDER_NAME, TRACKING_NUMBER);
// the spine fields are identical across an order's rows, so grouping by
// ORDER_NAME dedups the parent and each row with a non-null TRACKING_NUMBER
// becomes a child shipment. Status values are normalized through the SAME
// eShipz tag normalizer the poller uses (statusForTag) — one enum space, no
// second mapping table. All timestamps are TIMESTAMP_NTZ in IST → ist.ts.

import { isoFromIstNtz, istDateFromNtz } from "./ist";
import { statusForTag } from "./integrations/eshipz-map";
import type { DistributionRow } from "./snowflake";
import type {
  Facility,
  Order,
  OrderShipment,
  OrderType,
  OverallStatus,
  ShipmentStatus,
  StoreChannel,
  Zone,
} from "./types";

/** Self-delivery/porter pseudo-AWB (observed live: "SN417", "SN4130"). Real
 *  pollable AWBs: BlueDart 11-digit, Mudita 8-digit, Ekart 10-digit numeric,
 *  Movemate alnum like "BNG26CST00791". */
export const PSEUDO_AWB = /^SN\d+$/;
export const NON_POLLABLE_COURIER = /self|porter/i;

/** TRUE only when the AWB is worth an eShipz call. */
export function isPollableAwb(awb?: string | null, courier?: string | null): boolean {
  if (!awb || !awb.trim()) return false;
  if (PSEUDO_AWB.test(awb.trim())) return false;
  if (courier && NON_POLLABLE_COURIER.test(courier)) return false;
  return true;
}

const ORDER_TYPES: OrderType[] = ["FRESH", "RPL", "Q_COMM", "ACC", "NON_TRADING", "OTHER"];
const ZONES: Zone[] = ["NORTH", "WEST", "SOUTH", "EAST", "UNMAPPED"];

function normOrderType(v?: string | null): OrderType {
  const t = (v ?? "").toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_|_$/g, "") as OrderType;
  return ORDER_TYPES.includes(t) ? t : "OTHER";
}

function normStoreChannel(v?: string | null): StoreChannel | undefined {
  const c = (v ?? "").toUpperCase().trim();
  return c === "OWN" || c === "FRANCHISE" ? c : undefined;
}

function normZone(v?: string | null): Zone {
  const z = (v ?? "").toUpperCase().trim() as Zone;
  return ZONES.includes(z) ? z : "UNMAPPED";
}

/** WAREHOUSE_NAME → our facility codes; unknown names pass through raw so the
 *  order is never dropped (visible in the All view, flagged in sync errors). */
export function normFacility(v?: string | null): Facility | undefined {
  const w = (v ?? "").toUpperCase();
  if (!w.trim()) return undefined;
  if (w.includes("NORTH") || w.includes("TAURU")) return "SAPL-NORTH-TAURU";
  if (/WH[\s_-]?1|WAREHOUSE[\s_-]?1/.test(w)) return "SAPL-WH1";
  if (/WH[\s_-]?2|WAREHOUSE[\s_-]?2/.test(w)) return "SAPL-WH2";
  return v!.trim() as Facility;
}

/** Snowflake OVERALL_STATUS → enum. Used verbatim ONLY when the order has no
 *  shipment children — once children exist the app computes the rollup itself.
 *  The spine vocabulary is INWARDED / DELIVERED / IN_TRANSIT / DISPATCHED /
 *  PACKING / WH_PROCESSING; DISPATCHED (left the WH, no courier scan yet) is
 *  exactly what PICKUP_PENDING means here, and PACKING is warehouse work. */
export function normOverallStatus(v?: string | null): OverallStatus | undefined {
  const s = (v ?? "").toUpperCase().replace(/[^A-Z]+/g, "_");
  if (s.includes("INWARD")) return "INWARDED";
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("TRANSIT")) return "IN_TRANSIT";
  if (s.includes("PICKUP") || s.includes("DISPATCH")) return "PICKUP_PENDING";
  if (s.includes("PROCESSING") || s.includes("PACKING") || s.includes("WH")) return "WH_PROCESSING";
  return undefined;
}

/** Progression rank of the spine's OVERALL_STATUS, most-advanced first. Used to
 *  pick which of an order's sibling rows speaks for the parent. */
const SPINE_STATUS_RANK: Record<string, number> = {
  INWARDED: 6,
  DELIVERED: 5,
  IN_TRANSIT: 4,
  DISPATCHED: 3,
  PACKING: 2,
  WH_PROCESSING: 1,
};

function spineRank(v?: string | null): number {
  return SPINE_STATUS_RANK[(v ?? "").toUpperCase().replace(/[^A-Z]+/g, "_")] ?? 0;
}

/**
 * Choose the row that represents the ORDER when its AWB children disagree.
 *
 * Order-level columns are supposed to repeat across an order's rows, but they
 * do not always: 28 orders in the live spine carry a different OVERALL_STATUS
 * or DELIVERY_TARGET_EDD per row (a bill still in the warehouse alongside two
 * that have shipped). Taking whichever row arrived first made the parent depend
 * on Snowflake's row order. Rank by progression instead, so the most-advanced
 * row wins deterministically.
 */
export function pickParentRow(rows: DistributionRow[]): DistributionRow {
  return rows.reduce((best, r) => (spineRank(r.OVERALL_STATUS) > spineRank(best.OVERALL_STATUS) ? r : best));
}

const str = (v: unknown): string | undefined =>
  v == null || String(v).trim() === "" ? undefined : String(v).trim();

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const int = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};

export interface MappedOrder {
  soNumber: string;
  /** Raw STORE string ("SNITCH - COCO - NAME") — resolved to a Store by the
   *  sync; unmatched values go to the Admin review queue, never dropped. */
  storeKey?: string;
  /** Seed for overallStatus — only applied when the order has zero children. */
  overallStatusSeed?: OverallStatus;
  finalStatusRaw?: string;
  /** Spine + deadlines + SLA seeds. No store/status fields — the sync owns those. */
  patch: Partial<Order>;
  shipments: MappedShipment[];
}

export type MappedShipment = Partial<OrderShipment> & { awb: string; isPollable: boolean };

function mapShipmentRow(r: DistributionRow): MappedShipment | undefined {
  const awb = str(r.TRACKING_NUMBER);
  if (!awb) return undefined; // still in WH — no AWB yet
  const courier = str(r.COURIER_PARTNER);

  // One normalizer for every source. STATUS carries the eShipz tag vocabulary
  // (DELIVERED / INTRANSIT / EXCEPTION …, verified live); ESHIP_STATUS is an
  // internal state (cancelled / pickup_schedule / success) kept as provenance.
  const shipmentStatus: ShipmentStatus | undefined =
    statusForTag(str(r.STATUS)) ??
    statusForTag(str(r.LAST_CHECKPOINT_TAG), str(r.LAST_CHECKPOINT_SUBTAG));

  return {
    awb,
    shipmentBill: str(r.SHIPMENT_BILL),
    courier,
    isPollable: isPollableAwb(awb, courier),
    shipmentStatus,
    eshipStatus: str(r.STATUS) ?? str(r.ESHIP_STATUS),
    logisticsCreatedTs: isoFromIstNtz(r.LOGISTICS_CREATED_TIMESTAMP),
    trackingPickTs: isoFromIstNtz(r.TRACKING_PICK_DATE),
    deliveredTs: isoFromIstNtz(r.LOGISTICS_DELIVERY_TIMESTAMP),
    expectedDeliveryDate: istDateFromNtz(r.LOGISTICS_EXPECTED_DELIVERY_DATE),
    firstOfdTs: isoFromIstNtz(r.FIRST_OFD_DATE),
    latestOfdTs: isoFromIstNtz(r.LATEST_OFD_DATE),
    deliveryAttempts: int(r.DELIVERY_ATTEMPTS),
    pickupAttempts: int(r.PICKUP_ATTEMPTS),
    trackingLink: str(r.TRACKING_LINK),
    trackingStatus: str(r.TRACKING_STATUS),
    trackingSubStatus: str(r.TRACKING_SUB_STATUS),
    trackingLatestLocation: str(r.TRACKING_LATEST_LOCATION),
    trackingLatestMessage: str(r.TRACKING_LATEST_MESSAGE),
    lastCheckpointCity: str(r.LAST_CHECKPOINT_CITY),
    lastCheckpointState: str(r.LAST_CHECKPOINT_STATE),
    lastCheckpointRemark: str(r.LAST_CHECKPOINT_REMARK),
    lastCheckpointSubtag: str(r.LAST_CHECKPOINT_SUBTAG),
    lastCheckpointTag: str(r.LAST_CHECKPOINT_TAG),
    podLink: str(r.POD_LINK),
    packageCount: num(r.PACKAGE_COUNT),
    pickupSla: str(r.PICKUP_SLA),
    deliverySla: str(r.DELIVERY_SLA),
    logisticsDeliverySla: str(r.LOGISTICS_DELIVERY_SLA),
    perfectOrderSla: str(r.PERFECT_ORDER_SLA),
    source: "SNOWFLAKE",
  };
}

function mapOrderPatch(r: DistributionRow): Partial<Order> {
  return {
    // Spine — Snowflake-authoritative, consumed as-is
    orderTimestamp: isoFromIstNtz(r.ORDER_TIMESTAMP),
    orderDate: istDateFromNtz(r.ORDER_DATE),
    type: normOrderType(r.ORDER_TYPE),
    facility: normFacility(r.WAREHOUSE_NAME),
    qty: int(r.QUANTITY),
    saleInvoiceNumber: str(r.INVOICE_NUMBER),
    manifestedTs: isoFromIstNtz(r.MANIFESTED_TIMESTAMP),
    merchandiser: str(r.MERCHANDISER),
    areaManager: str(r.AREA_MANAGER),
    sales30d: num(r.SALES_30D),
    storeRank: int(r.RANK),
    laneClassification: str(r.LANE_CLASSIFICATION),
    bestTat: int(r.BEST_TAT),
    zone: normZone(r.ZONE),
    receiverCity: str(r.RECEIVER_CITY),
    receiverState: str(r.RECEIVER_STATE),
    receiverPostalCode: str(r.RECEIVER_POSTAL_CODE),
    storeChannel: normStoreChannel(r.STORE_CHANNEL),
    // Nullable BOOLEAN: only a real false means "out of rulebook". A missing
    // value must not be read as uncovered — that would badge everything.
    rulebookCovered: r.RULEBOOK_COVERED == null ? undefined : Boolean(r.RULEBOOK_COVERED),
    deliveryTargetEdd: isoFromIstNtz(r.DELIVERY_TARGET_EDD),

    // Inward — DATA ONLY this arc. Present in the model, read by no UI.
    inwardedDate: istDateFromNtz(r.INWARDED_DATE),
    stiQty: int(r.STI_QTY),
    exShort: int(r.EX_SHORT),

    // Deadlines — Snowflake sole authority, the app never recomputes these
    targetOrderDay: str(r.TARGET_ORDER_DAY),
    targetOrderCutoff: str(r.TARGET_ORDER_CUTOFF),
    targetHandoverDay: str(r.TARGET_HANDOVER_DAY),
    targetHandoverCutoff: str(r.TARGET_HANDOVER_CUTOFF),
    targetPickupDay: str(r.TARGET_PICKUP_DAY),
    targetDeliveryDay: str(r.TARGET_DELIVERY_DAY),
    orderCutoffTs: isoFromIstNtz(r.ORDER_CUTOFF_TS),
    handoverDeadlineTs: isoFromIstNtz(r.HANDOVER_DEADLINE_TS),
    pickupTat: isoFromIstNtz(r.PICKUP_TAT),
    // Delivery target: the rulebook-derived date stays PRIMARY so covered
    // orders display exactly what they displayed before. DELIVERY_TARGET_EDD
    // fills in behind it — which is what out-of-rulebook orders have instead
    // (it carries their eShipz EDD). Same field, same UI, just flagged.
    idealDeliveryDate: istDateFromNtz(r.IDEAL_DELIVERY_DATE) ?? istDateFromNtz(r.DELIVERY_TARGET_EDD),
    deliveryTat: isoFromIstNtz(r.DELIVERY_TAT),

    // Phase-A SLA seeds — the sync recomputes them against actuals when the
    // deadline timestamps are present
    orderPlacementSla: str(r.ORDER_PLACEMENT_SLA),
    handoverSla: str(r.HANDOVER_SLA),
  };
}

/**
 * Group rows by ORDER_NAME → one MappedOrder + 0..n shipment children.
 *
 * Two passes on purpose: the parent's fields come from the most-advanced row
 * (pickParentRow), which cannot be known until every sibling has been seen.
 * Every row with an AWB still becomes its own child, so a split bill keeps
 * both tracked shipments.
 */
export function mapDistributionRows(rows: DistributionRow[]): MappedOrder[] {
  const grouped = new Map<string, DistributionRow[]>();
  for (const r of rows) {
    const soNumber = str(r.ORDER_NAME);
    if (!soNumber) continue;
    const list = grouped.get(soNumber);
    if (list) list.push(r);
    else grouped.set(soNumber, [r]);
  }

  const out: MappedOrder[] = [];
  for (const [soNumber, siblings] of grouped) {
    const parent = pickParentRow(siblings);
    const m: MappedOrder = {
      soNumber,
      storeKey: str(parent.STORE),
      overallStatusSeed: normOverallStatus(parent.OVERALL_STATUS),
      finalStatusRaw: str(parent.FINAL_STATUS),
      patch: mapOrderPatch(parent),
      shipments: [],
    };
    for (const r of siblings) {
      const s = mapShipmentRow(r);
      if (s && !m.shipments.some((x) => x.awb === s.awb)) m.shipments.push(s);
    }
    out.push(m);
  }
  return out;
}
