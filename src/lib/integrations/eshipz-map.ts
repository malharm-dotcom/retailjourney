// eShipz tag/subtag → behaviour, in ONE extensible table (per the M2 spec):
// carriers surface new subtags over time, so extending this file is the whole
// change. Behaviours:
//   pickup_pending    — order not picked up yet: keep PICKUP_PENDING, store checkpoint
//   in_transit        — IN_TRANSIT
//   ofd               — OUT_FOR_DELIVERY (firstOfdDate on first sight, always latestOfdDate)
//   delivered         — DELIVERED (deliveredTs from delivery_date, store pod_link)
//   ndr               — DELIVERY_FAILED + attempts++
//   transit_exception — stays IN_TRANSIT, exception checkpoint logged as OrderEvent

export type EshipzBehaviour =
  | "pickup_pending"
  | "in_transit"
  | "ofd"
  | "delivered"
  | "ndr"
  | "transit_exception"
  | "ignore";

const TAG_BEHAVIOUR: Record<string, EshipzBehaviour> = {
  INFORECEIVED: "pickup_pending",
  PENDING: "pickup_pending",
  PICKEDUP: "in_transit",
  INTRANSIT: "in_transit",
  OUTFORDELIVERY: "ofd",
  DELIVERED: "delivered",
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
    if (NDR_SUBTAG_PATTERNS.some((p) => p.test(s))) return "ndr";
    if (TRANSIT_EXCEPTION_PATTERNS.some((p) => p.test(s))) return "transit_exception";
    // Unknown exception: keep the shipment moving but surface it on the timeline.
    return "transit_exception";
  }
  return TAG_BEHAVIOUR[t] ?? "ignore";
}
