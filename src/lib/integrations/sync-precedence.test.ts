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
  maxSpineEventTs,
  resolveOverallStatus,
  spineTerminalChild,
  transitPatchFromChild,
  withInwardSeed,
  frozenOverall,
  inferredWhStatus,
  evidenceStatus,
  dispatchedOverall,
} from "./sync";
import type { Order, OrderShipment } from "../types";

function row(lastUpdated: string | null): DistributionRow {
  return { LAST_UPDATED: lastUpdated } as DistributionRow;
}

/** A row as the spine renders it once SPINE_LAST_EVENT_TS exists. */
function eventRow(eventTs: string | null, lastUpdated: string | null = null): DistributionRow {
  return { SPINE_LAST_EVENT_TS: eventTs, LAST_UPDATED: lastUpdated } as DistributionRow;
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

describe("isPollableAwb — an AWB is an AWB", () => {
  it("polls the self-delivery SN-series that used to be skipped", () => {
    // Probed live 2026-09-11: eShipz returned tracking for 40 of 40 sampled
    // SELF_DELIVERY "SN####" AWBs. The old rule asserted these had no feed at
    // all and silenced 1,516 shipments — SN4151 sat on the board as "awaiting
    // first scan, 65d late" while eShipz held its full Delivered scan history.
    expect(isPollableAwb("SN4001", "SELF_DELIVERY")).toBe(true);
    expect(isPollableAwb("SN4151", "SELF_DELIVERY")).toBe(true);
    expect(isPollableAwb("SN399", null)).toBe(true);
    expect(isPollableAwb("12345678", "PORTER")).toBe(true);
  });
  it("keeps every real courier pollable (verified: 0 real AWBs skipped live)", () => {
    expect(isPollableAwb("53669035803", "BLUEDART")).toBe(true);
    expect(isPollableAwb("90641870", "MUDITA_CARGO")).toBe(true);
    expect(isPollableAwb("BNG26CST00803", "MOVEMATE")).toBe(true);
    expect(isPollableAwb("1234567890", "EKART_B2B_CARGO")).toBe(true);
  });
  it("a missing or blank AWB is still nothing to poll", () => {
    expect(isPollableAwb(null, "BLUEDART")).toBe(false);
    expect(isPollableAwb("   ", "BLUEDART")).toBe(false);
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

describe("maxSpineEventTs — the watermark rides the event stamp", () => {
  it("prefers SPINE_LAST_EVENT_TS over LAST_UPDATED on the same row", () => {
    // The whole point of the column: LAST_UPDATED is stamped at manifest and
    // never moves again, so a row delivered days later still reads stale.
    // These are ANSAPL16017's real values.
    expect(maxSpineEventTs([eventRow("2026-08-13 19:05:40.000", "2026-08-05 12:43:31.000")])).toBe(
      "2026-08-13 19:05:40.000",
    );
  });

  it("falls back to LAST_UPDATED only while the spine lacks the column", () => {
    expect(maxSpineEventTs([eventRow(null, "2026-08-05 12:43:31.000")])).toBe("2026-08-05 12:43:31.000");
  });

  it('treats Snowflake\'s literal "NULL" string as absent, not as a value', () => {
    // fetchAsString:["Date"] renders a NULL TIMESTAMP_NTZ as the STRING
    // "NULL", which is truthy — a raw check would carry it into the watermark.
    expect(maxSpineEventTs([eventRow("NULL", "NULL")])).toBeUndefined();
    expect(maxSpineEventTs([eventRow("NULL", "2026-08-05 12:43:31.000")])).toBe("2026-08-05 12:43:31.000");
  });
});

describe("maxSpineEventTs — the watermark advanced after a Snowflake run", () => {
  it("picks the newest LAST_UPDATED across the fetched rows", () => {
    const rows = [row("2026-07-28 05:17:09.000"), row("2026-07-30 03:04:07.000"), row("2026-07-13 14:32:57.000")];
    expect(maxSpineEventTs(rows)).toBe("2026-07-30 03:04:07.000");
  });

  it("several rows sharing the exact newest instant (batch-stamped upstream) still resolve to one value — the boundary is never duplicated across runs", () => {
    const rows = [row("2026-07-28 05:17:09.000"), row("2026-07-28 05:17:09.000"), row("2026-07-28 05:17:09.000")];
    expect(maxSpineEventTs(rows)).toBe("2026-07-28 05:17:09.000");
  });

  it("ignores NULL LAST_UPDATED rows (new orders upstream hasn't stamped yet) rather than treating null as newest", () => {
    const rows = [row("2026-07-28 05:17:09.000"), row(null), row(null)];
    expect(maxSpineEventTs(rows)).toBe("2026-07-28 05:17:09.000");
  });

  it("returns undefined when every row is NULL — the watermark stays unset, so the next run still falls back to the full window", () => {
    expect(maxSpineEventTs([row(null), row(null)])).toBeUndefined();
  });

  it("compares true instants, not raw strings — a shorter fractional-seconds suffix never loses to a lexically larger one", () => {
    // "2026-07-30 03:04:07.5" sorts before "2026-07-30 03:04:07.000" as a string
    // (since "5" > "0" only past index 0), which is exactly the bug a naive
    // string max would hit here: the .5 row is 500ms later and must win.
    const rows = [row("2026-07-30 03:04:07.000"), row("2026-07-30 03:04:07.5")];
    expect(maxSpineEventTs(rows)).toBe("2026-07-30 03:04:07.5");
  });
});

describe("withInwardSeed — the store's inward booking outranks an unclosed courier leg", () => {
  // THE pendency bug, measured live 2026-09-11: 114 open orders carried a spine
  // OVERALL_STATUS=INWARDED (and an INWARDED_DATE) while the app still showed
  // them Pickup Pending / In Transit, aging 1,415 order-days in aggregate. All
  // 114 had an AWB child, which is exactly the case where the old code threw
  // the seed away. SARJAP15631 read "awaiting first scan, 65d late" on the
  // board while its own row held inwardedDate 2026-07-14.
  it("INWARDED wins over a rollup that never left the courier leg", () => {
    expect(withInwardSeed("PICKUP_PENDING", "INWARDED")).toBe("INWARDED");
    expect(withInwardSeed("IN_TRANSIT", "INWARDED")).toBe("INWARDED");
    expect(withInwardSeed("WH_PROCESSING", "INWARDED")).toBe("INWARDED");
  });

  it("leaves every non-INWARDED seed alone — the rollup still decides", () => {
    // The per-AWB STATUS is unreliable in BOTH directions; only the inward
    // booking is a physical receipt. A spine that merely says DISPATCHED or
    // IN_TRANSIT must not override the app's own rollup.
    expect(withInwardSeed("IN_TRANSIT", "PICKUP_PENDING")).toBe("IN_TRANSIT");
    expect(withInwardSeed("PICKUP_PENDING", "IN_TRANSIT")).toBe("PICKUP_PENDING");
    expect(withInwardSeed("IN_TRANSIT", undefined)).toBe("IN_TRANSIT");
    expect(withInwardSeed("DELIVERED", "DELIVERED")).toBe("DELIVERED");
  });

  it("never pulls a CLOSED dead label back onto the ladder", () => {
    // A dead label is off the ladder entirely (schema: CLOSED is not a rung
    // above INWARDED). An RTO'd order whose spine row later gets an inward
    // stamp for the RETURNED stock must stay closed, not read as delivered.
    expect(withInwardSeed("CLOSED", "INWARDED")).toBe("CLOSED");
  });
});

describe("frozenOverall — a frozen order is delivered, whatever its manual shipmentStatus says", () => {
  it("closes an order whose every AWB delivered but a manual status held open", () => {
    // BANASH16388 / AIRIAM16410: all AWBs DELIVERED, spine INWARDED, order
    // stuck In Transit on a manual PICKED_UP / OUT_FOR_DELIVERY.
    expect(frozenOverall("IN_TRANSIT", "INWARDED")).toBe("INWARDED");
    expect(frozenOverall("IN_TRANSIT", undefined)).toBe("DELIVERED");
    expect(frozenOverall("PICKUP_PENDING", "DELIVERED")).toBe("DELIVERED");
  });

  it("never reopens a delivered order — the freeze's original promise", () => {
    expect(frozenOverall("DELIVERED", undefined)).toBe("DELIVERED");
    expect(frozenOverall("DELIVERED", "IN_TRANSIT")).toBe("DELIVERED");
    expect(frozenOverall("DELIVERED", "PICKUP_PENDING")).toBe("DELIVERED");
  });

  it("leaves DELIVERED and INWARDED exactly as they are — no mass reclassification", () => {
    // Lifting DELIVERED to INWARDED is deliberately NOT this function's job:
    // dry-run it would have moved 4,110 delivered orders, 246 of them off the
    // board's recent-deliveries rows.
    expect(frozenOverall("DELIVERED", "INWARDED")).toBe("DELIVERED");
    expect(frozenOverall("INWARDED", undefined)).toBe("INWARDED");
    expect(frozenOverall("INWARDED", "DELIVERED")).toBe("INWARDED");
  });
});

describe("resolveOverallStatus — a courier scan never reopens an inwarded order", () => {
  // Live 2026-09-15: Snowflake closed MALADI16048 to INWARDED hourly and the
  // eShipz poller reopened it to In Transit 15 minutes later, every hour.
  const inwarded = order({ overallStatus: "INWARDED", shipmentStatus: "IN_TRANSIT" });

  it("holds INWARDED against a poller patch that carries no verdict", () => {
    const r = resolveOverallStatus(inwarded, { shipmentStatus: "IN_TRANSIT", trackingLatestMessage: "scan" });
    expect(r.next).toBe("INWARDED");
    expect(r.changed).toBe(false);
  });

  it("holds it against every courier state, delivered and dead labels included", () => {
    for (const s of ["INFORECEIVED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURN"] as const) {
      expect(resolveOverallStatus(inwarded, { shipmentStatus: s }).next, s).toBe("INWARDED");
    }
  });

  it("an explicit override (the spine's own verdict) can still move it", () => {
    expect(resolveOverallStatus(inwarded, {}, "IN_TRANSIT").next).toBe("IN_TRANSIT");
  });

  it("orders that were never inwarded roll up exactly as before", () => {
    const moving = order({ overallStatus: "PICKUP_PENDING", shipmentStatus: undefined });
    expect(resolveOverallStatus(moving, { shipmentStatus: "IN_TRANSIT" }).next).toBe("IN_TRANSIT");
  });
});

describe("inferredWhStatus — a milk run with no AWB still leaves the warehouse", () => {
  type M = Parameters<typeof inferredWhStatus>[0];
  const m = (over: Partial<M>): M => ({ shipments: [], patch: {}, ...over });
  const manifested = { manifestedTs: "2026-07-03T09:39:44.000Z" };

  it("a spine past the warehouse dispatches a childless order (CYBERH15597: RTS 70+ days, spine INWARDED)", () => {
    for (const seed of ["INWARDED", "DELIVERED", "IN_TRANSIT"] as const) {
      expect(inferredWhStatus(m({ patch: manifested, overallStatusSeed: seed }))).toBe("DISPATCHED_TO_STORE");
    }
  });

  it("an AWB child still dispatches on its own", () => {
    expect(inferredWhStatus(m({ shipments: [{}] as M["shipments"] }))).toBe("DISPATCHED_TO_STORE");
  });

  it("a spine still at the warehouse keeps the old ladder", () => {
    expect(inferredWhStatus(m({ patch: manifested, overallStatusSeed: "PICKUP_PENDING" }))).toBe("RTS_LOGIC");
    expect(inferredWhStatus(m({ patch: manifested }))).toBe("RTS_LOGIC");
    expect(inferredWhStatus(m({ overallStatusSeed: "WH_PROCESSING" }))).toBeUndefined();
  });
});

describe("evidenceStatus — delivered or inwarded outranks a manual warehouse status", () => {
  it("dispatches an order a human left at an earlier stage (377 live, all manual RTS/PACKING/...)", () => {
    expect(evidenceStatus("RTS_LOGIC", "DELIVERED")).toBe("DISPATCHED_TO_STORE");
    expect(evidenceStatus("PACKING", "INWARDED")).toBe("DISPATCHED_TO_STORE");
  });

  it("in transit is not delivery evidence — the manual status stands", () => {
    expect(evidenceStatus("RTS_LOGIC", "IN_TRANSIT")).toBeUndefined();
  });

  it("never pulls an order out of ON_HOLD or a terminal state, and no-ops once dispatched", () => {
    expect(evidenceStatus("ON_HOLD", "DELIVERED")).toBeUndefined();
    expect(evidenceStatus("CANCELLED", "INWARDED")).toBeUndefined();
    expect(evidenceStatus("DISPATCHED_TO_STORE", "DELIVERED")).toBeUndefined();
  });
});

describe("a dispatch time is the warehouse done (JANAKP16765: dispatched 09-13, Not Started on 09-15)", () => {
  type M = Parameters<typeof inferredWhStatus>[0];
  const m = (over: Partial<M>): M => ({ shipments: [], patch: {}, ...over });

  it("the spine's UC dispatch — or one the UC intake back-filled — dispatches a childless order", () => {
    expect(inferredWhStatus(m({ patch: { dispatchedTs: "2026-09-13T00:33:15.000Z" }, overallStatusSeed: "PICKUP_PENDING" }))).toBe(
      "DISPATCHED_TO_STORE",
    );
    expect(inferredWhStatus(m({ overallStatusSeed: "WH_PROCESSING" }), "2026-09-15T05:14:11.000Z")).toBe("DISPATCHED_TO_STORE");
  });

  it("outranks a manual warehouse status, but never an ON_HOLD or a terminal one", () => {
    expect(evidenceStatus("NOT_STARTED", "PICKUP_PENDING", true)).toBe("DISPATCHED_TO_STORE");
    expect(evidenceStatus("RTS_LOGIC", "WH_PROCESSING", true)).toBe("DISPATCHED_TO_STORE");
    expect(evidenceStatus("ON_HOLD", "WH_PROCESSING", true)).toBeUndefined();
    expect(evidenceStatus("CANCELLED", "WH_PROCESSING", true)).toBeUndefined();
    expect(evidenceStatus("NOT_STARTED", "WH_PROCESSING", false)).toBeUndefined();
  });

  it("a dispatched order is never left reading WH Processing off a lagging seed", () => {
    expect(dispatchedOverall("WH_PROCESSING", "DISPATCHED_TO_STORE")).toBe("PICKUP_PENDING");
    expect(dispatchedOverall("WH_PROCESSING", "RTS_LOGIC")).toBe("WH_PROCESSING");
    expect(dispatchedOverall("INWARDED", "DISPATCHED_TO_STORE")).toBe("INWARDED");
  });
});
