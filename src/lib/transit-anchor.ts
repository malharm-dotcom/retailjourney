// Transit-age anchor resolution — DISPLAY ONLY. Nothing here is persisted.
//
// WHY: `dispatchedDate` is null on every spine-sourced order, so the boards
// showed DISPATCHED "—" and "0d in transit" on orders that were already
// delivered. RETAIL_JOURNEY_SPINE carries no dispatch column to map:
//   · STO_BILL_DATE   — the store-side STO bill. Only lands once the order is
//                       INWARDED (100% present there, ~90% NULL on orders that
//                       are DELIVERED but not yet inwarded, and it plateaus at
//                       ~82% at 90 days, so it is inward-gated, not lagging).
//                       It is also bill-grain: it varies across the children of
//                       a split order. Unusable as the order's dispatch anchor.
//   · PACKED_TIMESTAMP / MANIFESTED_TIMESTAMP — warehouse events, not dispatch.
//
// So the fix stays in the display calc and `dispatchedDate` is left honest —
// the underlying spine gap remains visible and reportable rather than being
// papered over with a synthesised date.
//
// The chain, most-authoritative first:
//   dispatchedTs / dispatchedDate  a real dispatch, whenever one exists
//   manifestedTs                   WH manifest (RTS-Logic). Order-level and
//                                  present on 100% of spine orders past the
//                                  warehouse; it sits ~17h BEFORE courier
//                                  pickup, so anchoring here KEEPS the
//                                  WH→pickup dwell leg inside the measured age
//                                  instead of hiding it.
//   earliest child pickedUpTs      eShipz scan-history pickup
//   earliest child trackingPickTs  spine pickup date
//
// GRAIN: dispatch is order-level, pickup is shipment-level. A multi-AWB order
// resolves on its EARLIEST child — the order left the warehouse when its first
// box did, and the later AWB must not shorten the measured age.

import { istDateOf, daysBetween } from "./ist";
import type { Order, OrderShipment } from "./types";

/** Which link of the chain the anchor came from — for provenance in the UI. */
export type AnchorSource = "DISPATCHED" | "MANIFESTED" | "PICKED_UP" | "TRACKING_PICK";

export interface TransitAnchor {
  /** IST business date (YYYY-MM-DD) to measure transit age from. */
  date?: string;
  source?: AnchorSource;
}

/** Only the child fields the anchor needs — callers may pass full shipments. */
export type AnchorShipment = Pick<OrderShipment, "pickedUpTs" | "trackingPickTs">;

/** Earliest of a set of ISO timestamps, ignoring blanks. */
function earliest(values: (string | undefined)[]): string | undefined {
  let out: string | undefined;
  for (const v of values) {
    if (!v) continue;
    if (!out || v < out) out = v;
  }
  return out;
}

/**
 * The moment the order physically left the warehouse in a courier's hands:
 * the EARLIEST child pickup, taking each child's eShipz scan (`pickedUpTs`)
 * over the spine's own pick date (`trackingPickTs`).
 *
 * One definition of "handed over" app-wide — the SLA engine's HANDOVER leg
 * keys off this, so the board's age and the board's verdict cannot disagree
 * about when the baton changed hands. `undefined` means no child has been
 * picked up yet, which is a real pending handover, not an on-time one.
 *
 * Earliest, not latest: the order left when its first box did, and a later
 * AWB must not be able to move the handover backwards or forwards. Only 16
 * live orders are multi-AWB and the two readings disagree on 11 of them.
 */
export function earliestPickup(shipments: AnchorShipment[] = []): string | undefined {
  return earliest(shipments.map((s) => s.pickedUpTs ?? s.trackingPickTs));
}

/**
 * Resolve the date transit age should be measured from. Returns an empty
 * anchor when every link is missing — callers keep their existing behaviour
 * in that case, and the order is a genuine spine-side data gap.
 */
export function transitAnchor(
  order: Pick<Order, "dispatchedTs" | "dispatchedDate" | "manifestedTs">,
  shipments: AnchorShipment[] = [],
): TransitAnchor {
  if (order.dispatchedTs) return { date: istDateOf(order.dispatchedTs), source: "DISPATCHED" };
  if (order.dispatchedDate) return { date: order.dispatchedDate, source: "DISPATCHED" };
  if (order.manifestedTs) return { date: istDateOf(order.manifestedTs), source: "MANIFESTED" };

  const pickedUp = earliest(shipments.map((s) => s.pickedUpTs));
  if (pickedUp) return { date: istDateOf(pickedUp), source: "PICKED_UP" };

  const trackingPick = earliest(shipments.map((s) => s.trackingPickTs));
  if (trackingPick) return { date: istDateOf(trackingPick), source: "TRACKING_PICK" };

  return {};
}

/**
 * Transit age in days against `endDate` (delivered date, else today).
 * `undefined` when no anchor exists — distinct from a real 0, so callers can
 * fall back rather than print a misleading "0d".
 */
export function transitAgeDays(
  order: Pick<Order, "dispatchedTs" | "dispatchedDate" | "manifestedTs">,
  shipments: AnchorShipment[] | undefined,
  endDate: string,
): number | undefined {
  const { date } = transitAnchor(order, shipments);
  if (!date) return undefined;
  return Math.max(0, daysBetween(date, endDate));
}
