// eShipz tag/subtag → behaviour, in ONE extensible table (per the M2 spec):
// carriers surface new subtags over time, so extending this file is the whole
// change. Behaviours:
//   pickup_pending    — order not picked up yet: keep PICKUP_PENDING, store checkpoint
//   in_transit        — IN_TRANSIT
//   ofd               — OUT_FOR_DELIVERY (firstOfdDate on first sight, always latestOfdDate)
//   delivered         — DELIVERED (deliveredTs from delivery_date, store pod_link)
//   ndr               — DELIVERY_FAILED + attempts++
//   transit_exception — stays IN_TRANSIT, exception checkpoint logged as OrderEvent

import type { ShipmentStatus, TrackingCheckpoint } from "../types";

export type EshipzBehaviour =
  | "pickup_pending"
  | "inforeceived"
  | "picked_up"
  | "in_transit"
  | "ofd"
  | "delivered"
  | "ndr"
  | "return"
  | "transit_exception"
  | "ignore";

const TAG_BEHAVIOUR: Record<string, EshipzBehaviour> = {
  // Own rung now (was "pickup_pending", i.e. no status at all): the carrier has
  // acknowledged the label. Still NOT collected — rollupOverall keeps this
  // order Pickup Pending.
  INFORECEIVED: "inforeceived",
  // Genuinely stateless — the carrier has told us nothing yet, so unlike
  // INFORECEIVED these still write no shipmentStatus.
  PENDING: "pickup_pending",
  // Snowflake distribution_analytics human-form statuses (same enum space —
  // its STATUS column is fed by the same eShipz pipeline).
  PICKUPPENDING: "pickup_pending",
  // Own rung now (was collapsed into IN_TRANSIT): the parcel is physically
  // collected but has no transit scan yet.
  PICKEDUP: "picked_up",
  INTRANSIT: "in_transit",
  OUTFORDELIVERY: "ofd",
  DELIVERED: "delivered",
  // Cancelled / RTO'd label (observed live in distribution_analytics STATUS
  // on split dispatches) — a dead shipment, excluded from the order rollup.
  RETURN: "return",
  RETURNED: "return",
  RTO: "return",
  RETURNTOORIGIN: "return",
  // Exception is resolved per-subtag below.
};

/** Exception subtags that are delivery-attempt failures (NDR). Extend as real
 *  carrier data shows new patterns. Checked against the UPPERCASED subtag. */
const NDR_SUBTAG_PATTERNS: RegExp[] = [
  /UNDELIVERED/,
  /NDR/,
  /DELIVERY.?(FAILED|ATTEMPT)/,
  /ATTEMPT.?FAIL/,
  /CONSIGNEE.?(UNAVAILABLE|NOT.?AVAILABLE|REFUSED)/,
  /REFUSED/,
  /ADDRESS.?(ISSUE|INCORRECT|NOT.?FOUND)/,
  /PREMISES.?CLOSED/,
  /CUSTOMER.?NOT.?AVAILABLE/,
];

/** Exception subtags about pickup — the shipment is NOT in transit yet
 *  (live example: Bluedart "PickupException" / "PICKUP CANCELLED BY CALL"). */
const PICKUP_EXCEPTION_PATTERNS: RegExp[] = [/PICKUP/];

/** Exception subtags that are transit hiccups — shipment keeps moving. */
const TRANSIT_EXCEPTION_PATTERNS: RegExp[] = [
  /INTRANSITEXCEPTION/,
  /DELAY/,
  /VEHICLE/,
  /WEATHER/,
  /REROUTE/,
  /MISROUTE/,
  /HELD|HOLD/,
];

const norm = (s?: string): string => (s ?? "").toUpperCase().replace(/[^A-Z]/g, "");

export function behaviourFor(tag?: string, subtag?: string): EshipzBehaviour {
  const t = norm(tag);
  if (t === "EXCEPTION") {
    const s = norm(subtag);
    if (PICKUP_EXCEPTION_PATTERNS.some((p) => p.test(s))) return "pickup_pending";
    if (NDR_SUBTAG_PATTERNS.some((p) => p.test(s))) return "ndr";
    if (TRANSIT_EXCEPTION_PATTERNS.some((p) => p.test(s))) return "transit_exception";
    // Unknown exception: keep the shipment moving but surface it on the timeline.
    return "transit_exception";
  }
  return TAG_BEHAVIOUR[t] ?? "ignore";
}

/**
 * Behaviour → ShipmentStatus, THE single tag normalizer for every source
 * (eShipz polling, eShipz webhook, Snowflake distribution_analytics) so all
 * status values land in the same enum space. undefined = no transition
 * (pickup_pending / unknown tag).
 */
export function statusForTag(tag?: string, subtag?: string): ShipmentStatus | undefined {
  switch (behaviourFor(tag, subtag)) {
    case "inforeceived":
      return "INFORECEIVED";
    case "picked_up":
      return "PICKED_UP";
    case "in_transit":
    case "transit_exception":
      return "IN_TRANSIT";
    case "ofd":
      return "OUT_FOR_DELIVERY";
    case "delivered":
      return "DELIVERED";
    case "ndr":
      return "DELIVERY_FAILED";
    case "return":
      return "RETURN";
    default:
      return undefined;
  }
}

/**
 * A proof-of-delivery marker in free text. Carriers surface the POD on the
 * checkpoint rather than the tag on some lanes (live: Bluedart remark
 * "PODDC IMAGE " under tag Delivered, and PODDC alone on others).
 */
const POD_TEXT = /\bPODDC\b|\bPOD\s*(IMAGE|LINK|UPLOAD)/i;

/** Every input the status decision is allowed to read, from ANY source. */
export interface ShipmentEvidence {
  /** Top-level carrier tag (eShipz `tag`, spine `STATUS`). */
  tag?: string;
  subtag?: string;
  /** Presence alone is proof of delivery — see statusForShipment. */
  podLink?: string;
  /** Newest-first, as every source delivers them. */
  checkpoints?: TrackingCheckpoint[];
}

/** TRUE when this checkpoint is itself proof the parcel landed. */
function isDeliveredCheckpoint(c: TrackingCheckpoint): boolean {
  return (
    behaviourFor(c.tag, c.subtag) === "delivered" ||
    POD_TEXT.test(c.remark ?? "") ||
    POD_TEXT.test(c.subtag ?? "")
  );
}

/**
 * THE status decision for a shipment, from the full evidence set — used by
 * every source (eShipz polling, eShipz webhook, spine STATUS) so all three
 * land in one enum space and cannot disagree.
 *
 * Precedence, strongest first:
 *
 *  1. DELIVERED — a `pod_link`, or ANY delivered checkpoint (incl. a bare
 *     PODDC remark). A POD is a signed physical receipt: it cannot be undone
 *     by a later exception scan, and carriers demonstrably emit one (live:
 *     "Delivery Failed" sitting on top of a Delivered checkpoint, 38 orders
 *     stuck In Transit for up to 48 days). Deliberately scans the WHOLE
 *     history rather than the latest scan.
 *  2. The carrier's own top-level verdict (RETURN / OFD / NDR / in transit),
 *     via statusForTag — which already resolves Exception per subtag.
 *  3. Only when the top level is UNKNOWN to us ("ignore" — a missing tag, or
 *     a carrier vocabulary we have not mapped yet): the newest checkpoint
 *     that does carry a verdict. This rescues a payload whose top-level tag
 *     is absent but whose scans are perfectly clear.
 *
 *     A tag we DO understand is never second-guessed here, even when it
 *     yields no status. A pickup exception ("PICKUP CANCELLED BY CALL") is a
 *     deliberate no-transition, not an absence of information — falling
 *     through to its older InfoReceived scan would quietly promote every
 *     awaiting-pickup exception onto a rung the carrier never claimed.
 *
 * undefined = no transition (still pickup-pending / nothing known).
 */
export function statusForShipment(e: ShipmentEvidence): ShipmentStatus | undefined {
  const checkpoints = e.checkpoints ?? [];
  if (e.podLink?.trim()) return "DELIVERED";
  if (checkpoints.some(isDeliveredCheckpoint)) return "DELIVERED";

  const top = statusForTag(e.tag, e.subtag);
  if (top) return top;
  if (behaviourFor(e.tag, e.subtag) !== "ignore") return undefined;

  for (const c of checkpoints) {
    const s = statusForTag(c.tag, c.subtag);
    if (s) return s;
  }
  return undefined;
}

/**
 * The pickup moment = the EARLIEST checkpoint that put the shipment in transit
 * (tag PickedUp / InTransit → behaviour "in_transit"). This scans the FULL scan
 * history, not just the latest scan, so a DELIVERED AWB still yields its pickup
 * timestamp (the pickup scan survives at a non-zero index; only the top-level
 * tag reads "Delivered"). Checkpoints arrive newest-first, so the LAST in-transit
 * one we walk past is the oldest = the pickup. Pickup/transit exceptions are
 * deliberately NOT counted (behaviourFor returns pickup_pending/transit_exception
 * for those), so an exception can never become the pickup anchor. undefined when
 * no in-transit scan is present yet (still pickup-pending).
 */
export function pickupTsFromCheckpoints(checkpoints: TrackingCheckpoint[]): string | undefined {
  let pickupTs: string | undefined;
  for (const c of checkpoints) {
    // "picked_up" MUST be counted here. It used to be folded into "in_transit",
    // and splitting it onto its own rung would otherwise have quietly dropped
    // the PickedUp scan out of this scan — which is the very scan this function
    // exists to find. Dropping it would push the pickup anchor forward to the
    // first transit scan and shorten every measured handover leg.
    const b = behaviourFor(c.tag, c.subtag);
    if (c.date && (b === "in_transit" || b === "picked_up")) pickupTs = c.date;
  }
  return pickupTs;
}
