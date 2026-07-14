// The canonical order state machine (PRD §4) — the app owns this logic.
// Granular WH `status` + eShipz `shipmentStatus` + Phase C `receiptStatus`,
// rolled up to the four-stage `overallStatus` the dashboards use.

import type {
  Order,
  OrderStatus,
  OverallStatus,
  ReceiptStatus,
  ShipmentStatus,
} from "./types";

/** Phase A happy path, in lane order (kanban columns). */
export const WH_FLOW: OrderStatus[] = [
  "NOT_STARTED",
  "PICKING",
  "PACKING",
  "READY_TO_DISPATCH",
  "RTS_LOGIC",
  "DISPATCHED_TO_STORE",
];

export const TERMINAL_STATUSES: OrderStatus[] = ["CANCELLED", "UNFULFILLABLE"];

/** Allowed Phase A transitions. ON_HOLD is reversible; CANCELLED/UNFULFILLABLE terminal. */
export const WH_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  NOT_STARTED: ["PICKING", "ON_HOLD", "CANCELLED", "UNFULFILLABLE"],
  PICKING: ["PACKING", "ON_HOLD", "CANCELLED", "UNFULFILLABLE"],
  PACKING: ["READY_TO_DISPATCH", "PICKING", "ON_HOLD", "CANCELLED", "UNFULFILLABLE"],
  READY_TO_DISPATCH: ["RTS_LOGIC", "PACKING", "ON_HOLD", "CANCELLED"],
  RTS_LOGIC: ["DISPATCHED_TO_STORE", "READY_TO_DISPATCH", "ON_HOLD", "CANCELLED"],
  DISPATCHED_TO_STORE: [],
  ON_HOLD: ["NOT_STARTED", "PICKING", "PACKING", "READY_TO_DISPATCH", "RTS_LOGIC", "CANCELLED"],
  CANCELLED: [],
  UNFULFILLABLE: [],
};

/** Allowed Phase B transitions (manual override may set any of these). */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "DELIVERY_FAILED", "DELIVERED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "DELIVERY_FAILED"],
  DELIVERY_FAILED: ["IN_TRANSIT", "OUT_FOR_DELIVERY"],
  DELIVERED: [],
};

/** Phase C progression. */
export const RECEIPT_FLOW: ReceiptStatus[] = ["RECEIVED", "INWARDED", "CLOSED"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return WH_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionShipment(from: ShipmentStatus | undefined, to: ShipmentStatus): boolean {
  // No shipment state yet → any first state is forward: the first poll after
  // dispatch may find the shipment already OFD / DELIVERED / FAILED, not just
  // freshly scanned (verified live with a delivered Bluedart AWB).
  if (!from) return true;
  return SHIPMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Fields that MUST be captured when entering a status (PRD §4).
 * The UI raises a capture dialog for these; the server action validates them.
 */
export const REQUIRED_CAPTURES: Partial<Record<OrderStatus, { field: keyof Order; label: string; kind: "text" | "number" | "date" | "partner"; optional?: boolean }[]>> = {
  READY_TO_DISPATCH: [
    { field: "boxCount", label: "Box count", kind: "number" },
    { field: "weightKg", label: "Weight (kg)", kind: "number" },
  ],
  RTS_LOGIC: [
    { field: "saleInvoiceNumber", label: "Sale invoice no.", kind: "text" },
    { field: "rtsLogicDate", label: "RTS Logic date", kind: "date" },
  ],
  DISPATCHED_TO_STORE: [
    { field: "dcNumber", label: "DC number", kind: "text" },
    { field: "lrNumber", label: "LR number", kind: "text" },
    { field: "logisticsPartner", label: "Logistics partner", kind: "partner" },
    { field: "vehicleNumber", label: "Vehicle no.", kind: "text", optional: true },
    { field: "eWayBill", label: "e-Way bill", kind: "text", optional: true },
  ],
};

/** UC-lifecycle timestamps written when a status is entered. */
export const STATUS_TIMESTAMPS: Partial<Record<OrderStatus, (keyof Order)[]>> = {
  PICKING: ["pickingTs"],
  PACKING: ["pickedTs"],
  READY_TO_DISPATCH: ["packedTs", "rtsTs"],
  RTS_LOGIC: ["manifestedTs"],
  DISPATCHED_TO_STORE: ["dispatchedTs"],
  CANCELLED: ["cancelledTs"],
};

/**
 * Roll the granular statuses up to the four-stage `overallStatus` (PRD §4).
 * PICKUP_PENDING = dispatched from WH but no courier movement scan yet.
 */
export function rollupOverall(o: Pick<Order, "status" | "shipmentStatus">): OverallStatus {
  if (o.shipmentStatus === "DELIVERED") return "DELIVERED";
  if (o.shipmentStatus) return "IN_TRANSIT";
  if (o.status === "DISPATCHED_TO_STORE") return "PICKUP_PENDING";
  return "WH_PROCESSING";
}

/** Progression rank for the worst-of shipment rollup. `undefined` = no courier
 *  movement yet (pickup pending); DELIVERY_FAILED sits below IN_TRANSIT — an
 *  NDR'd shipment needs attention, it is not "progressing". */
const SHIPMENT_RANK: Record<ShipmentStatus, number> = {
  DELIVERY_FAILED: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
};

/**
 * Least-progressed state across an order's shipments (split-dispatch rollup):
 * an order with one Delivered and one Pickup Pending AWB is NOT delivered.
 * Returns undefined when any shipment has no movement yet (or there are none).
 */
export function rollupShipments(
  states: (ShipmentStatus | undefined)[],
): ShipmentStatus | undefined {
  if (states.length === 0) return undefined;
  let worst: ShipmentStatus | undefined;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const s of states) {
    if (!s) return undefined; // a shipment with no scan floors the whole order
    if (SHIPMENT_RANK[s] < worstRank) {
      worst = s;
      worstRank = SHIPMENT_RANK[s];
    }
  }
  return worst;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  NOT_STARTED: "Not Started",
  PICKING: "Picking",
  PACKING: "Packing",
  ON_HOLD: "On Hold",
  READY_TO_DISPATCH: "Ready to Dispatch",
  RTS_LOGIC: "RTS Logic",
  DISPATCHED_TO_STORE: "Dispatched",
  CANCELLED: "Cancelled",
  UNFULFILLABLE: "Unfulfillable",
};

export const OVERALL_LABEL: Record<OverallStatus, string> = {
  WH_PROCESSING: "WH Processing",
  PICKUP_PENDING: "Pickup Pending",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
};

export const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  IN_TRANSIT: "In Transit",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  DELIVERY_FAILED: "Delivery Failed",
};

export const RECEIPT_LABEL: Record<ReceiptStatus, string> = {
  RECEIVED: "Received",
  INWARDED: "Inwarded",
  CLOSED: "Closed",
};
