// The forward-only contract for MANUAL shipment edits.
//
// Two rules are under test and they are easy to confuse:
//   · checkManualStage — the linear ladder, manual writes only, monotonic.
//   · canTransitionShipment — the older sync map, deliberately NOT monotonic
//     (a returned label can re-forward, an NDR can go back on the road).
// The whole point of this change is that those two stayed separate, so the
// last block here pins the sync map's non-monotonic edges in place.

import { describe, expect, it } from "vitest";
import {
  SHIPMENT_LADDER,
  canTransitionShipment,
  checkManualStage,
  isLadderStatus,
  ladderOrdinal,
  rollupOverall,
  rollupShipments,
} from "./journey";
import type { Order, ShipmentStatus } from "./types";

describe("ladder shape", () => {
  it("is the locked order", () => {
    expect([...SHIPMENT_LADDER]).toEqual([
      "INFORECEIVED",
      "PICKED_UP",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ]);
  });

  it("puts the off-ladder states off the ladder", () => {
    expect(isLadderStatus("DELIVERY_FAILED")).toBe(false);
    expect(isLadderStatus("RETURN")).toBe(false);
    expect(ladderOrdinal("RETURN")).toBeUndefined();
    expect(ladderOrdinal(undefined)).toBeUndefined();
    expect(ladderOrdinal("IN_TRANSIT")).toBe(2);
  });
});

describe("checkManualStage — forward-only", () => {
  it("advances up the ladder", () => {
    expect(checkManualStage("PICKED_UP", "IN_TRANSIT")).toEqual({ kind: "advance", to: "IN_TRANSIT" });
    expect(checkManualStage("INFORECEIVED", "DELIVERED")).toEqual({ kind: "advance", to: "DELIVERED" });
  });

  it("treats an unset status as below rung 0", () => {
    expect(checkManualStage(undefined, "INFORECEIVED")).toEqual({ kind: "advance", to: "INFORECEIVED" });
    expect(checkManualStage(undefined, "DELIVERED")).toEqual({ kind: "advance", to: "DELIVERED" });
  });

  it("is idempotent on the same rung — no stage change, no error", () => {
    expect(checkManualStage("IN_TRANSIT", "IN_TRANSIT")).toEqual({ kind: "idempotent", to: "IN_TRANSIT" });
  });

  it("never regresses", () => {
    for (const [from, to] of [
      ["IN_TRANSIT", "PICKED_UP"],
      ["OUT_FOR_DELIVERY", "IN_TRANSIT"],
      ["PICKED_UP", "INFORECEIVED"],
    ] as [ShipmentStatus, ShipmentStatus][]) {
      expect(checkManualStage(from, to).kind).toBe("reject");
    }
  });

  it("locks DELIVERED as terminal against every source", () => {
    for (const to of SHIPMENT_LADDER) {
      const out = checkManualStage("DELIVERED", to);
      // Even DELIVERED → DELIVERED is refused rather than idempotent: the
      // terminal check runs first, on purpose.
      expect(out.kind).toBe("reject");
    }
  });

  it("refuses the off-ladder states as manual TARGETS", () => {
    expect(checkManualStage("IN_TRANSIT", "DELIVERY_FAILED").kind).toBe("reject");
    expect(checkManualStage("IN_TRANSIT", "RETURN").kind).toBe("reject");
  });

  it("refuses manual edits when the CURRENT state is off-ladder", () => {
    // No ordinal to compare against — the poller resolves these, not a person.
    expect(checkManualStage("DELIVERY_FAILED", "OUT_FOR_DELIVERY").kind).toBe("reject");
    expect(checkManualStage("RETURN", "IN_TRANSIT").kind).toBe("reject");
  });
});

describe("the sync map is left alone", () => {
  it("keeps the re-entrant RETURN → IN_TRANSIT re-forward edge", () => {
    // Manual may not do this (asserted above); sync still must.
    expect(canTransitionShipment("RETURN", "IN_TRANSIT")).toBe(true);
    expect(canTransitionShipment("DELIVERY_FAILED", "OUT_FOR_DELIVERY")).toBe(true);
  });

  it("still lets a first poll land anywhere", () => {
    expect(canTransitionShipment(undefined, "DELIVERED")).toBe(true);
  });

  it("lets an NDR'd shipment reach DELIVERED on a successful re-attempt", () => {
    // The bucket-A root cause: DELIVERED was missing from DELIVERY_FAILED's
    // targets, so a re-delivered parcel could never leave the failed state.
    expect(canTransitionShipment("DELIVERY_FAILED", "DELIVERED")).toBe(true);
    expect(canTransitionShipment("RETURN", "DELIVERED")).toBe(true);
  });

  it("keeps DELIVERED terminal — nothing moves off it", () => {
    for (const to of ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_FAILED", "RETURN"] as const) {
      expect(canTransitionShipment("DELIVERED", to)).toBe(false);
    }
  });

  it("routes the new rungs onward without letting anything regress into them", () => {
    expect(canTransitionShipment("INFORECEIVED", "PICKED_UP")).toBe(true);
    expect(canTransitionShipment("PICKED_UP", "IN_TRANSIT")).toBe(true);
    expect(canTransitionShipment("IN_TRANSIT", "PICKED_UP")).toBe(false);
    expect(canTransitionShipment("OUT_FOR_DELIVERY", "INFORECEIVED")).toBe(false);
  });
});

describe("rollupOverall keeps INFORECEIVED pickup-pending", () => {
  const at = (s?: ShipmentStatus) =>
    rollupOverall({ status: "DISPATCHED_TO_STORE", shipmentStatus: s } as Pick<
      Order,
      "status" | "shipmentStatus"
    >);

  it("does not promote an acknowledged-but-uncollected label to In Transit", () => {
    // This is the regression the new rung would otherwise have caused: before,
    // such a shipment had a null status and fell through to PICKUP_PENDING.
    expect(at("INFORECEIVED")).toBe("PICKUP_PENDING");
    expect(at(undefined)).toBe("PICKUP_PENDING");
  });

  it("still counts a collected parcel as moving", () => {
    expect(at("PICKED_UP")).toBe("IN_TRANSIT");
    expect(at("IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(at("DELIVERED")).toBe("DELIVERED");
  });

  it("takes dead labels off the open set instead of ageing them as In Transit", () => {
    // Live: an RTO'd label read "In Transit" for 48 days because both of these
    // fell through to the bare `if (shipmentStatus)` branch.
    expect(at("RETURN")).toBe("CLOSED");
    expect(at("DELIVERY_FAILED")).toBe("CLOSED");
  });
});

describe("rollupShipments — dead children never speak for a live order", () => {
  it("a delivered replacement wins over its dead sibling", () => {
    expect(rollupShipments(["RETURN", "DELIVERED"])).toBe("DELIVERED");
    expect(rollupShipments(["DELIVERY_FAILED", "DELIVERED"])).toBe("DELIVERED");
  });

  it("an in-flight sibling STILL holds the order open", () => {
    // The regression this guards: DELIVERY_FAILED ranks lowest, so while it
    // counted as active it won the least-progressed contest and would have
    // closed an order whose other box was still in the air.
    expect(rollupShipments(["DELIVERY_FAILED", "IN_TRANSIT"])).toBe("IN_TRANSIT");
    expect(rollupShipments(["DELIVERED", "IN_TRANSIT"])).toBe("IN_TRANSIT");
  });

  it("closes only when every label is dead, and keeps the RTO fact", () => {
    expect(rollupShipments(["RETURN", "DELIVERY_FAILED"])).toBe("RETURN");
    expect(rollupShipments(["DELIVERY_FAILED"])).toBe("DELIVERY_FAILED");
    expect(rollupShipments(["RETURN"])).toBe("RETURN");
  });

  it("is unchanged for the ordinary cases", () => {
    expect(rollupShipments([])).toBeUndefined();
    expect(rollupShipments([undefined])).toBeUndefined();
    expect(rollupShipments([undefined, "DELIVERED"])).toBe("DELIVERED");
  });
});
