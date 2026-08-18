// Precedence regression tests — the spec, verified live 2026-07-17 (poller
// fetched ~390-404/run at 1,935 orders; shipmentSource split 1,220 SYNCED vs
// 254 SYNCED_SNOWFLAKE):
//   manual override > eShipz poller (only where isPollable) > Snowflake
//   Snowflake = sole transit authority for self-delivery/porter pseudo-AWBs
//   Terminal / forward-only guards: sync never regresses progress.

import { describe, expect, it } from "vitest";
import { isPollableAwb } from "../distribution-map";
import type { DistributionRow } from "../snowflake";
import {
  ORDER_TRANSIT_FIELDS,
  guardedStatus,
  maxLastUpdated,
  resolveOverallStatus,
  spineTerminalChild,
  transitPatchFromChild,
} from "./sync";
import type { Order, OrderShipment } from "../types";

function row(lastUpdated: string | null): DistributionRow {
  return { LAST_UPDATED: lastUpdated } as DistributionRow;
}

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

describe("spineTerminalChild — a terminal spine verdict outranks the poller", () => {
  const kid = (awb: string, s?: OrderShipment["shipmentStatus"]) =>
    child({ awb, isPollable: true, shipmentStatus: s });

  it("hands back the delivered child when the spine has resolved it", () => {
    // ANSAPL16017's shape: the spine resolved eShipz and got DELIVERED; the
    // app never linked the AWB, so the poller has nothing to contribute.
    const c = spineTerminalChild([kid("90642894", "DELIVERED")]);
    expect(c?.awb).toBe("90642894");
  });

  it("stays silent while a sibling is still MOVING", () => {
    // The order must NOT be reconciled shut just because one box landed.
    expect(spineTerminalChild([kid("A", "DELIVERED"), kid("B", "IN_TRANSIT")])).toBeUndefined();
    expect(spineTerminalChild([kid("A", "DELIVERED"), kid("B", "OUT_FOR_DELIVERY")])).toBeUndefined();
  });

  it("an UNSCANNED sibling does not hold the order open — the long-standing rule", () => {
    // Deliberately different from a moving sibling: a label that never got a
    // scan is a label that was never used, so one AWB delivered + one never
    // picked up is Delivered. rollupShipments has worked this way since the
    // split-dispatch rollup landed; the reconciliation inherits it rather
    // than inventing a second answer.
    expect(spineTerminalChild([kid("A", "DELIVERED"), kid("B", undefined)])?.awb).toBe("A");
  });

  it("a delivered replacement still speaks for the order over its dead sibling", () => {
    const c = spineTerminalChild([kid("A", "RETURN"), kid("B", "DELIVERED")]);
    expect(c?.awb).toBe("B");
  });

  it("reconciles a wholly dead order too", () => {
    expect(spineTerminalChild([kid("A", "RETURN")])?.shipmentStatus).toBe("RETURN");
    expect(spineTerminalChild([kid("A", "DELIVERY_FAILED")])?.shipmentStatus).toBe("DELIVERY_FAILED");
  });

  it("stays silent on an ordinary in-flight order", () => {
    expect(spineTerminalChild([kid("A", "IN_TRANSIT")])).toBeUndefined();
    expect(spineTerminalChild([])).toBeUndefined();
  });

  it("the reconciliation still refuses to regress a delivered order", () => {
    // The guard lives in transitPatchFromChild, which the reconciliation
    // routes through — DELIVERED is terminal from every source.
    const patch = transitPatchFromChild(
      order({ shipmentStatus: "DELIVERED" }),
      child({ shipmentStatus: "RETURN" }),
    );
    expect(patch.shipmentStatus).toBeUndefined();
  });

  it("the reconciliation still loses to a manual override", () => {
    const patch = transitPatchFromChild(
      order({ shipmentStatus: "IN_TRANSIT", manualFields: ["shipmentStatus"] }),
      child({ shipmentStatus: "DELIVERED" }),
    );
    expect(patch.shipmentStatus).toBeUndefined();
  });

  it("reconciling does NOT depend on the manual DISPATCHED_TO_STORE gate", () => {
    // A spine-delivered order whose warehouse rung still lags at RTS_LOGIC
    // must still light up as delivered. The gate at repo-prisma.ts:185/218
    // guards the MANUAL path only; sync writes through applySyncPatch.
    const patch = transitPatchFromChild(
      order({ status: "RTS_LOGIC", shipmentStatus: undefined }),
      child({ shipmentStatus: "DELIVERED", deliveredTs: "2026-08-13T13:35:40.000Z" }),
    );
    expect(patch.shipmentStatus).toBe("DELIVERED");
    expect(patch.deliveredDate).toBe("2026-08-13");
  });
});

describe("resolveOverallStatus — an override alone is a real change", () => {
  it("reports a MOVE when the override differs, even with an empty field patch", () => {
    // The live defect: applySyncPatch computed the rollup after its no-op
    // early return, so this case wrote nothing and the order kept rendering
    // In Transit while its spine row said DELIVERED.
    const o = order({ overallStatus: "IN_TRANSIT" });
    const r = resolveOverallStatus(o, {}, "DELIVERED");
    expect(r.next).toBe("DELIVERED");
    expect(r.changed).toBe(true);
  });

  it("reports NO move when the override matches what the order already has", () => {
    const o = order({ overallStatus: "DELIVERED" });
    expect(resolveOverallStatus(o, {}, "DELIVERED").changed).toBe(false);
  });

  it("falls back to the rollup of the merged patch when no override is given", () => {
    const o = order({ overallStatus: "PICKUP_PENDING", status: "DISPATCHED_TO_STORE" });
    const r = resolveOverallStatus(o, { shipmentStatus: "IN_TRANSIT" });
    expect(r.next).toBe("IN_TRANSIT");
    expect(r.changed).toBe(true);
  });

  it("an override beats the rollup — the split-dispatch verdict is not recomputed away", () => {
    const o = order({ overallStatus: "PICKUP_PENDING", status: "DISPATCHED_TO_STORE" });
    expect(resolveOverallStatus(o, { shipmentStatus: "IN_TRANSIT" }, "DELIVERED").next).toBe("DELIVERED");
  });
});

describe("maxLastUpdated — the watermark advanced after a Snowflake run", () => {
  it("picks the newest LAST_UPDATED across the fetched rows", () => {
    const rows = [row("2026-07-28 05:17:09.000"), row("2026-07-30 03:04:07.000"), row("2026-07-13 14:32:57.000")];
    expect(maxLastUpdated(rows)).toBe("2026-07-30 03:04:07.000");
  });

  it("several rows sharing the exact newest instant (batch-stamped upstream) still resolve to one value — the boundary is never duplicated across runs", () => {
    const rows = [row("2026-07-28 05:17:09.000"), row("2026-07-28 05:17:09.000"), row("2026-07-28 05:17:09.000")];
    expect(maxLastUpdated(rows)).toBe("2026-07-28 05:17:09.000");
  });

  it("ignores NULL LAST_UPDATED rows (new orders upstream hasn't stamped yet) rather than treating null as newest", () => {
    const rows = [row("2026-07-28 05:17:09.000"), row(null), row(null)];
    expect(maxLastUpdated(rows)).toBe("2026-07-28 05:17:09.000");
  });

  it("returns undefined when every row is NULL — the watermark stays unset, so the next run still falls back to the full window", () => {
    expect(maxLastUpdated([row(null), row(null)])).toBeUndefined();
  });

  it("compares true instants, not raw strings — a shorter fractional-seconds suffix never loses to a lexically larger one", () => {
    // "2026-07-30 03:04:07.5" sorts before "2026-07-30 03:04:07.000" as a string
    // (since "5" > "0" only past index 0), which is exactly the bug a naive
    // string max would hit here: the .5 row is 500ms later and must win.
    const rows = [row("2026-07-30 03:04:07.000"), row("2026-07-30 03:04:07.5")];
    expect(maxLastUpdated(rows)).toBe("2026-07-30 03:04:07.5");
  });
});
