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

/** Allowed Phase B transitions for SYNC flows (poller / spine). Manual writes
 *  do NOT use this map — they go through the linear ladder guard below. */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  // The two low rungs are sync-only entry points. A first scan may legitimately
  // land anywhere ahead of them (a shipment can be found already delivered),
  // so they are permissive forward — but nothing regresses INTO them, which is
  // why no existing state lists them as a target.
  INFORECEIVED: ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURN"],
  PICKED_UP: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURN"],
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "DELIVERY_FAILED", "DELIVERED", "RETURN"],
  OUT_FOR_DELIVERY: ["DELIVERED", "DELIVERY_FAILED", "RETURN"],
  // DELIVERED is a legal target: the overwhelmingly common end of an NDR is a
  // successful re-attempt. Omitting it stranded every re-delivered shipment on
  // DELIVERY_FAILED permanently — the poller re-read the Delivered scan every
  // 15 minutes and discarded it every time (live: 35 orders, up to 48 days,
  // several with a POD already on file).
  DELIVERY_FAILED: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETURN"],
  // A returned label occasionally resumes (re-forward) — sync may move it on.
  RETURN: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"],
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

// ---------------------------------------------------------------------------
// The linear ladder — manual writes only.
//
// Sync flows keep using SHIPMENT_TRANSITIONS above, which is deliberately
// non-monotonic (a RETURN can re-forward, an NDR can go back on the road).
// A human editing a shipment by hand gets a much narrower contract: they may
// only walk this ladder forwards, and only onto rungs that are on it.

/** The monotonic lifecycle, in ascending order. Index = ordinal. */
export const SHIPMENT_LADDER = [
  "INFORECEIVED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const satisfies readonly ShipmentStatus[];

/** A status that sits on the linear ladder (i.e. has an ordinal). */
export type LadderStatus = (typeof SHIPMENT_LADDER)[number];

/** The statuses a human may set by hand. DELIVERY_FAILED and RETURN are
 *  excluded on purpose: they are courier facts the poller owns, not stages a
 *  person advances an order through. (NDR is recorded via its own attempt
 *  action, which is not a ladder move.) */
export function isLadderStatus(s: ShipmentStatus | undefined): s is LadderStatus {
  return s !== undefined && (SHIPMENT_LADDER as readonly string[]).includes(s);
}

/** Ordinal on the ladder, or undefined for off-ladder / unset states.
 *  undefined `from` is rung -1 in effect: nothing has happened yet, so any
 *  ladder target is an advance. */
export function ladderOrdinal(s: ShipmentStatus | undefined): number | undefined {
  return isLadderStatus(s) ? SHIPMENT_LADDER.indexOf(s) : undefined;
}

export type ManualStageOutcome =
  | { kind: "advance"; to: LadderStatus }
  /** Same rung — no stage change, but set-once timestamps still apply. */
  | { kind: "idempotent"; to: LadderStatus }
  | { kind: "reject"; reason: string };

/**
 * THE forward-only floor check for manual stage edits. Single source of truth —
 * both repo implementations call this and nothing else re-derives ordinals.
 *
 *   incoming >  current → advance
 *   incoming == current → idempotent (no stage change, timestamps still set-once)
 *   incoming <  current → reject, never regress
 *   current  == DELIVERED → terminal, reject everything
 *
 * An off-ladder CURRENT state (DELIVERY_FAILED / RETURN) has no ordinal to
 * compare against. Rather than invent one, manual edits are refused outright:
 * a failed or returned shipment is the poller's to resolve, and letting a
 * human hand-wave it back onto the ladder is exactly the regression this
 * guard exists to prevent.
 */
export function checkManualStage(
  current: ShipmentStatus | undefined,
  incoming: ShipmentStatus,
): ManualStageOutcome {
  if (!isLadderStatus(incoming)) {
    return {
      kind: "reject",
      reason: `${SHIPMENT_LABEL[incoming]} is set by courier tracking, not by hand`,
    };
  }
  if (current === "DELIVERED") {
    return { kind: "reject", reason: "This shipment is delivered — its status is final" };
  }
  if (current !== undefined && !isLadderStatus(current)) {
    return {
      kind: "reject",
      reason: `${SHIPMENT_LABEL[current]} is resolved by courier tracking, not by hand`,
    };
  }
  const from = ladderOrdinal(current);
  const to = SHIPMENT_LADDER.indexOf(incoming);
  if (from === undefined) return { kind: "advance", to: incoming };
  if (to > from) return { kind: "advance", to: incoming };
  if (to === from) return { kind: "idempotent", to: incoming };
  return {
    kind: "reject",
    reason: `Cannot move back to ${SHIPMENT_LABEL[incoming]} from ${SHIPMENT_LABEL[current!]}`,
  };
}

/**
 * Fields that MUST be captured when entering a status (PRD §4).
 * The UI raises a capture dialog for these; the server action validates them.
 */
export const REQUIRED_CAPTURES: Partial<Record<OrderStatus, { field: keyof Order; label: string; kind: "text" | "number" | "date" | "partner"; optional?: boolean }[]>> = {
  // Packing → Ready-to-Dispatch prompts for nothing: boxes are counted and
  // weighed when the consignment leaves Ready for RTS-Logic, not while the
  // floor is still closing cartons. (Fields already on the order — captured
  // earlier or synced — satisfy the check without re-entry.)
  RTS_LOGIC: [
    { field: "boxCount", label: "Box count", kind: "number" },
    { field: "weightKg", label: "Weight (kg)", kind: "number" },
    { field: "saleInvoiceNumber", label: "Sale invoice no.", kind: "text" },
    { field: "rtsLogicDate", label: "RTS Logic date", kind: "date" },
    // The CONFIRMED quantity leaving the warehouse, optional because it is the
    // ordered quantity on all but the short-shipped orders. Left blank, the
    // server fills it from the UC-synced `qty` (see rtsQuantityDefault in
    // advance.ts) — never the other way round: `qty` is sync-owned and is not
    // manually editable anywhere, which is why this writes `fulfilledQty`.
    // reports.ts already reads `fulfilledQty ?? qty` for exactly this reason.
    { field: "fulfilledQty", label: "Quantity", kind: "number", optional: true },
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
/** Off-ladder terminals: the shipment stopped without delivering. These are
 *  DEAD LABELS — they must leave the open population rather than age forever.
 *  Exported so the boards and the transit clock agree on one definition. */
export const DEAD_SHIPMENT_STATUSES: ShipmentStatus[] = ["RETURN", "DELIVERY_FAILED"];

export function isDeadShipment(s: ShipmentStatus | undefined): boolean {
  return s !== undefined && DEAD_SHIPMENT_STATUSES.includes(s);
}

export function rollupOverall(o: Pick<Order, "status" | "shipmentStatus">): OverallStatus {
  if (o.shipmentStatus === "DELIVERED") return "DELIVERED";
  // Dead label → off the board. Both of these used to fall through to the bare
  // `if (o.shipmentStatus)` below and render as In Transit, so an RTO'd or
  // permanently-failed shipment accrued transit age indefinitely (live: 48
  // days on "SHIPPER INSTRUCTED TO RTO THE SHIPMENT").
  //
  // This is the ORDER-level rollup, so on a split dispatch it only ever sees
  // the verdict rollupShipments already reached — and that function drops
  // every dead child before choosing. A dead label therefore reaches here only
  // when NO sibling is still alive, which is exactly when closing the order is
  // right: a delivered replacement AWB still wins.
  if (isDeadShipment(o.shipmentStatus)) return "CLOSED";
  // INFORECEIVED means the label exists but nothing has been collected — that
  // is still pickup-pending, NOT in transit. Before this rung existed the same
  // shipment carried a null shipmentStatus and fell through to the
  // DISPATCHED_TO_STORE branch below; without this line the bare
  // `if (o.shipmentStatus)` underneath would silently promote every
  // awaiting-pickup shipment to In Transit the moment the poller started
  // emitting the new value.
  if (o.shipmentStatus === "INFORECEIVED") {
    return o.status === "DISPATCHED_TO_STORE" ? "PICKUP_PENDING" : "WH_PROCESSING";
  }
  if (o.shipmentStatus) return "IN_TRANSIT";
  if (o.status === "DISPATCHED_TO_STORE") return "PICKUP_PENDING";
  return "WH_PROCESSING";
}

/** Progression rank for the worst-of shipment rollup. DELIVERY_FAILED sits
 *  below IN_TRANSIT — an NDR'd shipment needs attention, it is not
 *  "progressing". RETURN is ranked only for the all-returned edge case. */
/** Renumbered to make room for the two low rungs. The RELATIVE order of the
 *  five original values is unchanged — only the gaps moved — so no existing
 *  rollup outcome shifts. */
const SHIPMENT_RANK: Record<ShipmentStatus, number> = {
  RETURN: 0,
  DELIVERY_FAILED: 1,
  INFORECEIVED: 2,
  PICKED_UP: 3,
  IN_TRANSIT: 4,
  OUT_FOR_DELIVERY: 5,
  DELIVERED: 6,
};

/**
 * Split-dispatch rollup across an order's shipments. DEAD children (RETURN and
 * DELIVERY_FAILED) are excluded — observed live: an AWB is returned, its
 * replacement delivers, and the order IS delivered. Likewise a sibling with no
 * scan yet is ignored once any sibling is moving (one AWB delivered + one never
 * picked up → Delivered, not Pickup Pending). Among the active shipments the
 * least-progressed state wins (one delivered + one in transit is still In
 * Transit). undefined = no courier movement anywhere.
 *
 * DELIVERY_FAILED joined RETURN in that exclusion deliberately. It carries the
 * LOWEST rank below, so while it was still counted as active it won the
 * least-progressed contest outright: a single failed box dragged the whole
 * order down, and once dead labels started closing orders that would have
 * closed an order whose other box was still in the air. Excluding it keeps
 * both halves of the contract — a delivered replacement wins, and a genuinely
 * in-flight sibling still holds the order open.
 */
export function rollupShipments(
  states: (ShipmentStatus | undefined)[],
): ShipmentStatus | undefined {
  if (states.length === 0) return undefined;
  const live: (ShipmentStatus | undefined)[] = states.filter((s) => !isDeadShipment(s));
  // Everything is dead: the order closes. RETURN is reported ahead of
  // DELIVERY_FAILED so an RTO'd order still reads as returned, not failed —
  // both roll up to CLOSED, but the shipment-level fact stays honest.
  if (live.length === 0) return states.includes("RETURN") ? "RETURN" : "DELIVERY_FAILED";
  const active = live.filter((s): s is ShipmentStatus => s !== undefined);
  if (active.length === 0) return undefined; // nothing scanned yet
  let worst: ShipmentStatus = active[0];
  for (const s of active) {
    if (SHIPMENT_RANK[s] < SHIPMENT_RANK[worst]) worst = s;
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
  INWARDED: "Inwarded",
  CLOSED: "Closed — not delivered",
};

export const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  INFORECEIVED: "Awaiting Pickup",
  PICKED_UP: "Picked Up",
  IN_TRANSIT: "In Transit",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
  DELIVERY_FAILED: "Delivery Failed",
  RETURN: "Return",
};

export const RECEIPT_LABEL: Record<ReceiptStatus, string> = {
  RECEIVED: "Received",
  INWARDED: "Inwarded",
  CLOSED: "Closed",
};
