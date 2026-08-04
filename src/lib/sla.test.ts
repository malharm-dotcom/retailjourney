// Leg anchoring (PRD §4, §7). Two legs, two clocks, and the whole point is
// that they do not share an actual:
//
//   HANDOVER (WH Processing)  handover_deadline_ts vs manifestedTs
//   PICKUP   (Courier Pickup) pickup_tat           vs child trackingPickTs
//                                                  (?? order.shippedTs)
//
// The warehouse leg used to read a pickup-derived actual, which charged
// courier lateness to the warehouse. Moving it to the manifest does not
// forgive late warehouse work — a manifest after the deadline still breaches —
// it just stops a late van from breaching a consignment that was ready on time.

import { describe, expect, it } from "vitest";
import { computeOrderSla } from "./sla";
import type { AnchorShipment } from "./transit-anchor";
import { earliestPickup } from "./transit-anchor";
import type { Order, RulebookEntry } from "./types";

const NOW = "2026-07-28T06:00:00.000Z"; // 11:30 IST on the 28th

/** Minimal order carrying only what the handover leg reads. */
function order(over: Partial<Order> = {}): Order {
  return {
    soNumber: "SO-1",
    storeId: "store-1",
    storeNameFormat: "SNITCH - COCO - TEST",
    type: "FRESH",
    status: "DISPATCHED_TO_STORE",
    orderDate: "2026-07-20",
    orderTimestamp: "2026-07-20T04:00:00.000Z",
    // The deadline is Snowflake-authoritative and present on 100% of live
    // orders, so every test pins it rather than leaning on deriveTargets.
    handoverDeadlineTs: "2026-07-22T12:30:00.000Z", // 6PM IST on the 22nd
    ...over,
  } as Order;
}

const handover = (o: Order, kids?: AnchorShipment[]) =>
  computeOrderSla(o, undefined as RulebookEntry | undefined, NOW, kids).legs.find((l) => l.leg === "HANDOVER")!;

describe("earliestPickup", () => {
  it("prefers the eShipz scan over the spine pick date on the same child", () => {
    expect(
      earliestPickup([{ pickedUpTs: "2026-07-22T05:00:00.000Z", trackingPickTs: "2026-07-21T05:00:00.000Z" }]),
    ).toBe("2026-07-22T05:00:00.000Z");
  });

  it("takes the earliest child of a split order, whatever the row order", () => {
    const kids: AnchorShipment[] = [
      { trackingPickTs: "2026-07-23T05:00:00.000Z" },
      { pickedUpTs: "2026-07-21T05:00:00.000Z" },
      { trackingPickTs: "2026-07-22T05:00:00.000Z" },
    ];
    expect(earliestPickup(kids)).toBe("2026-07-21T05:00:00.000Z");
    expect(earliestPickup([...kids].reverse())).toBe("2026-07-21T05:00:00.000Z");
  });

  it("is undefined with no children and with unpicked children", () => {
    expect(earliestPickup()).toBeUndefined();
    expect(earliestPickup([])).toBeUndefined();
    expect(earliestPickup([{ pickedUpTs: undefined, trackingPickTs: undefined }])).toBeUndefined();
  });
});

describe("computeOrderSla — WH-processing leg (HANDOVER)", () => {
  it("is WITHIN_SLA when the manifest beat the deadline", () => {
    const leg = handover(order({ manifestedTs: "2026-07-21T04:00:00.000Z" }), []);
    expect(leg.actualTs).toBe("2026-07-21T04:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("still BREACHES genuinely-late warehouse work", () => {
    // The guard against 4850589's concern: manifest is not a free pass. A
    // manifest after the deadline breaches exactly as before.
    expect(handover(order({ manifestedTs: "2026-07-23T04:00:00.000Z" }), []).state).toBe("BREACHED");
  });

  it("does not let a late courier breach a warehouse that finished on time", () => {
    // This is the 985-order case. Manifested a day early, collected two days
    // late: the warehouse leg is clean and the lateness belongs to PICKUP.
    const o = order({ manifestedTs: "2026-07-21T04:00:00.000Z" });
    const sla = computeOrderSla(o, undefined, NOW, [{ trackingPickTs: "2026-07-24T05:00:00.000Z" }]);
    expect(sla.legs.find((l) => l.leg === "HANDOVER")!.state).toBe("WITHIN_SLA");
    expect(sla.legs.find((l) => l.leg === "PICKUP")!.actualTs).toBe("2026-07-24T05:00:00.000Z");
  });

  it("ignores the courier pickup entirely — children cannot credit the warehouse", () => {
    // An un-manifested order is NOT credited by a courier scan. This is the
    // generosity 4850589 removed and it stays removed.
    const leg = handover(order(), [{ trackingPickTs: "2026-07-21T05:00:00.000Z" }]);
    expect(leg.actualTs).toBeUndefined();
    expect(leg.state).toBe("BREACHED_PENDING");
  });

  it("is FUTURE_SLA when nothing is manifested but the deadline has not passed", () => {
    expect(handover(order({ handoverDeadlineTs: "2026-07-30T12:30:00.000Z" }), []).state).toBe("FUTURE_SLA");
  });

  it("lets a real dispatch timestamp outrank the manifest", () => {
    const leg = handover(
      order({ dispatchedTs: "2026-07-21T05:00:00.000Z", manifestedTs: "2026-07-23T04:00:00.000Z" }),
      [],
    );
    expect(leg.actualTs).toBe("2026-07-21T05:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("ignores dispatchedDate, which no live order carries and which used to fake a 6PM handover", () => {
    const leg = handover(order({ dispatchedDate: "2026-07-21" }), []);
    expect(leg.actualTs).toBeUndefined();
    expect(leg.state).toBe("BREACHED_PENDING");
  });

  it("is null, not breaching, when the rulebook sets no handover deadline", () => {
    const leg = handover(order({ handoverDeadlineTs: undefined }), []);
    expect(leg.state).toBeNull();
  });
});

describe("computeOrderSla — PICKUP leg", () => {
  const PICKUP_TAT = "2026-07-23T12:30:00.000Z";
  const pickup = (o: Order, kids?: AnchorShipment[]) =>
    computeOrderSla(o, undefined as RulebookEntry | undefined, NOW, kids).legs.find((l) => l.leg === "PICKUP")!;

  it("anchors on the courier's own pick date", () => {
    const leg = pickup(order({ pickupTat: PICKUP_TAT }), [{ trackingPickTs: "2026-07-22T05:00:00.000Z" }]);
    expect(leg.actualTs).toBe("2026-07-22T05:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("takes the earliest box of a split order, not the last", () => {
    const leg = pickup(order({ pickupTat: PICKUP_TAT }), [
      { trackingPickTs: "2026-07-24T05:00:00.000Z" },
      { trackingPickTs: "2026-07-22T05:00:00.000Z" },
    ]);
    expect(leg.actualTs).toBe("2026-07-22T05:00:00.000Z");
  });

  it("does NOT use pickedUpTs — the leg is measured on the spine's pick clock", () => {
    const leg = pickup(order({ pickupTat: PICKUP_TAT }), [{ pickedUpTs: "2026-07-22T05:00:00.000Z" }]);
    expect(leg.actualTs).toBeUndefined();
  });

  it("falls back to shippedTs so the self-delivery lane stays measurable", () => {
    // No eShipz feed means no trackingPickTs, ever. shippedTs is the only
    // pickup those orders will ever have, and it is what the manual write on
    // Logistics sets (set-once).
    const leg = pickup(order({ pickupTat: PICKUP_TAT, shippedTs: "2026-07-22T05:00:00.000Z" }), []);
    expect(leg.actualTs).toBe("2026-07-22T05:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("prefers the courier pick date over shippedTs when both exist", () => {
    // shippedTs is stamped at poll-observation time, not the real pick moment.
    const leg = pickup(order({ pickupTat: PICKUP_TAT, shippedTs: "2026-07-24T09:00:00.000Z" }), [
      { trackingPickTs: "2026-07-22T05:00:00.000Z" },
    ]);
    expect(leg.actualTs).toBe("2026-07-22T05:00:00.000Z");
  });

  it("is pending when nothing has collected it", () => {
    expect(pickup(order({ pickupTat: PICKUP_TAT }), []).state).toBe("BREACHED_PENDING");
  });
});

describe("the two legs stay independent", () => {
  it("does not disturb the other legs", () => {
    const sla = computeOrderSla(order(), undefined, NOW, [{ trackingPickTs: "2026-07-24T05:00:00.000Z" }]);
    expect(sla.legs.find((l) => l.leg === "PLACEMENT")!.actualTs).toBe("2026-07-20T04:00:00.000Z");
    expect(sla.legs.find((l) => l.leg === "DELIVERY")!.actualTs).toBeUndefined();
  });

  it("reads different actuals for the same order", () => {
    const sla = computeOrderSla(
      order({ manifestedTs: "2026-07-21T04:00:00.000Z", pickupTat: "2026-07-23T12:30:00.000Z" }),
      undefined,
      NOW,
      [{ trackingPickTs: "2026-07-22T05:00:00.000Z" }],
    );
    expect(sla.legs.find((l) => l.leg === "HANDOVER")!.actualTs).toBe("2026-07-21T04:00:00.000Z");
    expect(sla.legs.find((l) => l.leg === "PICKUP")!.actualTs).toBe("2026-07-22T05:00:00.000Z");
  });
});
