// Precedence regression tests — the spec, verified live 2026-07-17 (poller
// fetched ~390-404/run at 1,935 orders; shipmentSource split 1,220 SYNCED vs
// 254 SYNCED_SNOWFLAKE):
//   manual override > eShipz poller (only where isPollable) > Snowflake
//   Snowflake = sole transit authority for self-delivery/porter pseudo-AWBs
//   Terminal / forward-only guards: sync never regresses progress.

import { describe, expect, it } from "vitest";
import { isPollableAwb } from "../distribution-map";
import { ORDER_TRANSIT_FIELDS, guardedStatus, transitPatchFromChild } from "./sync";
import type { Order, OrderShipment } from "../types";

function order(over: Partial<Order>): Order {
  return {
    id: "o1",
    soNumber: "TEST15001",
    status: "DISPATCHED_TO_STORE",
    deliveryAttempts: 0,
    pickupAttempts: 0,
    manualFields: [],
    ...over,
  } as Order;
}

function child(over: Partial<OrderShipment>): OrderShipment {
  return { id: "s1", soNumber: "TEST15001", awb: "SN4001", isPollable: false, source: "SNOWFLAKE", ...over } as OrderShipment;
}

describe("isPollableAwb — the poller/Snowflake authority split", () => {
  it("skips exactly the self-delivery/porter pseudo-AWBs (live vocab)", () => {
    expect(isPollableAwb("SN4001", "SELF_DELIVERY")).toBe(false);
    expect(isPollableAwb("SN399", null)).toBe(false); // pseudo shape alone
    expect(isPollableAwb("12345678", "PORTER")).toBe(false);
  });
  it("keeps every real courier pollable (verified: 0 real AWBs skipped live)", () => {
    expect(isPollableAwb("53669035803", "BLUEDART")).toBe(true);
    expect(isPollableAwb("90641870", "MUDITA_CARGO")).toBe(true);
    expect(isPollableAwb("BNG26CST00803", "MOVEMATE")).toBe(true);
    expect(isPollableAwb("1234567890", "EKART_B2B_CARGO")).toBe(true);
  });
});

describe("transitPatchFromChild — Snowflake as transit authority (non-pollable only)", () => {
  it("advances a legal transition and stamps delivery", () => {
    const patch = transitPatchFromChild(
      order({ shipmentStatus: "IN_TRANSIT" }),
      child({ shipmentStatus: "DELIVERED", deliveredTs: "2026-07-16T10:00:00.000Z" }),
    );
    expect(patch.shipmentStatus).toBe("DELIVERED");
    expect(patch.shipmentSource).toBe("SYNCED_SNOWFLAKE");
    expect(patch.deliveredTs).toBe("2026-07-16T10:00:00.000Z");
    expect(patch.deliveredDate).toBe("2026-07-16");
  });

  it("manual override wins — a manual shipmentStatus is never replaced", () => {
    const patch = transitPatchFromChild(
      order({ shipmentStatus: "IN_TRANSIT", manualFields: ["shipmentStatus"] }),
      child({ shipmentStatus: "DELIVERED" }),
    );
    expect(patch.shipmentStatus).toBeUndefined();
  });

  it("never regresses: DELIVERED order is not pulled back to IN_TRANSIT", () => {
    const patch = transitPatchFromChild(
      order({ shipmentStatus: "DELIVERED" }),
      child({ shipmentStatus: "IN_TRANSIT" }),
    );
    expect(patch.shipmentStatus).toBeUndefined();
  });
});

describe("guardedStatus — Phase A forward-only", () => {
  it("never regresses WH progress", () => {
    expect(guardedStatus("RTS_LOGIC", "PACKING")).toBeUndefined();
  });
  it("never pulls an order out of ON_HOLD", () => {
    expect(guardedStatus("ON_HOLD", "PICKING")).toBeUndefined();
  });
  it("never resurrects a terminal order", () => {
    expect(guardedStatus("CANCELLED", "DISPATCHED_TO_STORE")).toBeUndefined();
  });
  it("allows forward movement", () => {
    expect(guardedStatus("PACKING", "RTS_LOGIC")).toBe("RTS_LOGIC");
  });
});

describe("terminal-freeze surface", () => {
  it("the frozen field list covers every order-level transit field the poller owns", () => {
    for (const f of ["shipmentStatus", "deliveredTs", "deliveredDate", "trackingStatus", "podLink", "expectedDate"]) {
      expect(ORDER_TRANSIT_FIELDS).toContain(f);
    }
  });
});
