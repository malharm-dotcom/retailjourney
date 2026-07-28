// HANDOVER-leg anchoring (PRD §4, §7). The leg's actual is the physical
// courier pickup at child grain, not the null dispatchedDate the spine never
// fills and not the WH manifest, which credits an order that is still sitting
// on the dock.

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

describe("computeOrderSla — HANDOVER leg", () => {
  it("is WITHIN_SLA when the earliest child was picked up before the deadline", () => {
    const leg = handover(order(), [{ trackingPickTs: "2026-07-22T05:00:00.000Z" }]);
    expect(leg.actualTs).toBe("2026-07-22T05:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("is BREACHED when the pickup landed after the deadline", () => {
    expect(handover(order(), [{ trackingPickTs: "2026-07-24T05:00:00.000Z" }]).state).toBe("BREACHED");
  });

  it("stays BREACHED_PENDING for a manifested-but-uncollected order past its deadline", () => {
    // The manifest anchor used to credit this as handed over. 278 live orders
    // sit in exactly this state; the whole point of the pickup anchor is that
    // they keep reading as pending rather than on-time.
    const leg = handover(order({ manifestedTs: "2026-07-21T04:00:00.000Z" }), []);
    expect(leg.actualTs).toBeUndefined();
    expect(leg.state).toBe("BREACHED_PENDING");
  });

  it("is FUTURE_SLA when nothing is picked up but the deadline has not passed", () => {
    expect(handover(order({ handoverDeadlineTs: "2026-07-30T12:30:00.000Z" }), []).state).toBe("FUTURE_SLA");
  });

  it("lets a real dispatch timestamp outrank the pickup", () => {
    const leg = handover(order({ dispatchedTs: "2026-07-21T05:00:00.000Z" }), [
      { trackingPickTs: "2026-07-24T05:00:00.000Z" },
    ]);
    expect(leg.actualTs).toBe("2026-07-21T05:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("ignores dispatchedDate, which no live order carries and which used to fake a 6PM handover", () => {
    const leg = handover(order({ dispatchedDate: "2026-07-21" }), []);
    expect(leg.actualTs).toBeUndefined();
    expect(leg.state).toBe("BREACHED_PENDING");
  });

  it("takes the earliest box of a split order, not the last", () => {
    // Earliest is before the deadline, latest is after — A(i) vs A(ii).
    const leg = handover(order(), [
      { trackingPickTs: "2026-07-24T05:00:00.000Z" },
      { trackingPickTs: "2026-07-22T05:00:00.000Z" },
    ]);
    expect(leg.actualTs).toBe("2026-07-22T05:00:00.000Z");
    expect(leg.state).toBe("WITHIN_SLA");
  });

  it("is null, not breaching, when the rulebook sets no handover deadline", () => {
    const leg = handover(order({ handoverDeadlineTs: undefined }), []);
    expect(leg.state).toBeNull();
  });

  it("does not disturb the other legs", () => {
    const sla = computeOrderSla(order(), undefined, NOW, [{ trackingPickTs: "2026-07-24T05:00:00.000Z" }]);
    expect(sla.legs.find((l) => l.leg === "PLACEMENT")!.actualTs).toBe("2026-07-20T04:00:00.000Z");
    expect(sla.legs.find((l) => l.leg === "PICKUP")!.actualTs).toBeUndefined(); // still order.shippedTs
    expect(sla.legs.find((l) => l.leg === "DELIVERY")!.actualTs).toBeUndefined();
  });
});
