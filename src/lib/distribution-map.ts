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

/** Snowflake OVERALL_STATUS ("WH Processing" / "Pickup Pending" / "In transit"
 *  / "Delivered") → enum. Used verbatim ONLY when the order has no shipment
 *  children — once children exist the app computes the rollup itself. */
export function normOverallStatus(v?: string | null): OverallStatus | undefined {
  const s = (v ?? "").toUpperCase().replace(/[^A-Z]+/g, "_");
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("TRANSIT")) return "IN_TRANSIT";
  if (s.includes("PICKUP")) return "PICKUP_PENDING";
  if (s.includes("PROCESSING") || s.includes("WH")) return "WH_PROCESSING";
  return undefined;
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

  // One normalizer for every source: try the eShipz-vocabulary column first,
  // then the human status, then the last checkpoint tag/subtag.
  const shipmentStatus: ShipmentStatus | undefined =
    statusForTag(str(r.ESHIP_STATUS)) ??
    statusForTag(str(r.STATUS)) ??
    statusForTag(str(r.LAST_CHECKPOINT_TAG), str(r.LAST_CHECKPOINT_SUBTAG));

  return {
    awb,
    courier,
    isPollable: isPollableAwb(awb, courier),
    shipmentStatus,
    eshipStatus: str(r.ESHIP_STATUS) ?? str(r.STATUS),
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

    // Deadlines — Snowflake sole authority, the app never recomputes these
    targetOrderDay: str(r.TARGET_ORDER_DAY),
    targetOrderCutoff: str(r.TARGET_ORDER_CUTOFF),
    targetHandoverDay: str(r.TARGET_HANDOVER_DAY),
    targetHandoverCutoff: str(r.TARGET_HANDOVER_CUTOFF),
    targetPickupDay: str(r.TARGET_PICKUP_DAY),
    targetDeliveryDay: str(r.TARGET_DELIVERY_DAY),
    orderCutoffTs: isoFromIstNtz(r.ORDER_CUTOFF_TS),
    handoverDeadlineTs: isoFromIstNtz(r.HANDOVER_DEADLINE_TS),
    pickupTat: str(r.PICKUP_TAT),
    idealDeliveryDate: istDateFromNtz(r.IDEAL_DELIVERY_DATE),
    deliveryTat: str(r.DELIVERY_TAT),

    // Phase-A SLA seeds — the sync recomputes them against actuals when the
    // deadline timestamps are present
    orderPlacementSla: str(r.ORDER_PLACEMENT_SLA),
    handoverSla: str(r.HANDOVER_SLA),
  };
}

/** Group rows by ORDER_NAME → one MappedOrder + 0..n shipment children. */
export function mapDistributionRows(rows: DistributionRow[]): MappedOrder[] {
  const byOrder = new Map<string, MappedOrder>();
  for (const r of rows) {
    const soNumber = str(r.ORDER_NAME);
    if (!soNumber) continue;

    let m = byOrder.get(soNumber);
    if (!m) {
      m = {
        soNumber,
        storeKey: str(r.STORE),
        overallStatusSeed: normOverallStatus(r.OVERALL_STATUS),
        finalStatusRaw: str(r.FINAL_STATUS),
        patch: mapOrderPatch(r),
        shipments: [],
      };
      byOrder.set(soNumber, m);
    }

    const s = mapShipmentRow(r);
    if (s && !m.shipments.some((x) => x.awb === s.awb)) m.shipments.push(s);
  }
  return [...byOrder.values()];
}
