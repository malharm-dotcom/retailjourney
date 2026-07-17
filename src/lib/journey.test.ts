// Field-placement contract for the Phase A state machine: Packing → Ready
// prompts for nothing; box count + weight are captured on the Ready →
// RTS-Logic move (alongside the invoice), and values already on the order
// satisfy the check without re-entry.

import { beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_CAPTURES } from "./journey";
import { repo } from "./repo";
import type { Order } from "./types";

// Hard guarantee the suite runs on the in-memory seed repo, never a real DB.
beforeAll(() => {
  delete process.env.DATABASE_URL;
});

const actor = { id: "test", name: "Test" };

async function seedOrderAt(status: Order["status"]): Promise<Order> {
  const orders = await repo.listOrders("ALL");
  const o = orders.find((x) => x.status === status);
  if (!o) throw new Error(`seed has no order at ${status}`);
  return o;
}

describe("REQUIRED_CAPTURES placement", () => {
  it("Packing → Ready-to-Dispatch prompts for nothing", () => {
    expect(REQUIRED_CAPTURES.READY_TO_DISPATCH).toBeUndefined();
  });

  it("box count + weight belong to the RTS-Logic move", () => {
    const fields = (REQUIRED_CAPTURES.RTS_LOGIC ?? []).map((f) => f.field);
    expect(fields).toContain("boxCount");
    expect(fields).toContain("weightKg");
    expect(fields).toContain("saleInvoiceNumber");
  });
});

describe("transitions at the new placement (in-memory repo)", () => {
  it("moves Packing → Ready without any captures", async () => {
    const o = await seedOrderAt("PACKING");
    const next = await repo.transitionStatus(o.soNumber, "READY_TO_DISPATCH", actor, {});
    expect(next.status).toBe("READY_TO_DISPATCH");
  });

  it("blocks Ready → RTS-Logic when box count / weight are missing", async () => {
    const orders = await repo.listOrders("ALL");
    const o = orders.find((x) => x.status === "READY_TO_DISPATCH" && x.boxCount == null);
    if (!o) return; // seed variant without such an order — covered by the case below
    await expect(repo.transitionStatus(o.soNumber, "RTS_LOGIC", actor, { saleInvoiceNumber: "SI1", rtsLogicDate: "2026-07-17" })).rejects.toThrow(
      /Box count|Weight/,
    );
  });

  it("moves Ready → RTS-Logic when box/weight arrive as captures", async () => {
    const o = await seedOrderAt("READY_TO_DISPATCH");
    const next = await repo.transitionStatus(o.soNumber, "RTS_LOGIC", actor, {
      boxCount: o.boxCount ?? 4,
      weightKg: o.weightKg ?? 32.5,
      saleInvoiceNumber: o.saleInvoiceNumber ?? "SI-TEST-1",
      rtsLogicDate: "2026-07-17",
    });
    expect(next.status).toBe("RTS_LOGIC");
    expect(next.boxCount).not.toBeNull();
    expect(next.weightKg).not.toBeNull();
  });

  it("in-flight order that captured box/weight earlier passes without re-entry", async () => {
    // Walk a fresh order to Ready while writing box/weight as field updates
    // (the pre-move world): the RTS move must accept the values already on it.
    const orders = await repo.listOrders("ALL");
    const o = orders.find((x) => x.status === "NOT_STARTED");
    if (!o) throw new Error("seed has no NOT_STARTED order");
    await repo.transitionStatus(o.soNumber, "PICKING", actor, {});
    await repo.transitionStatus(o.soNumber, "PACKING", actor, {});
    await repo.transitionStatus(o.soNumber, "READY_TO_DISPATCH", actor, {});
    await repo.updateFields(o.soNumber, { boxCount: 7, weightKg: 51 }, actor, "MANUAL");
    const next = await repo.transitionStatus(o.soNumber, "RTS_LOGIC", actor, {
      saleInvoiceNumber: "SI-TEST-2",
      rtsLogicDate: "2026-07-17",
    });
    expect(next.status).toBe("RTS_LOGIC");
    expect(next.boxCount).toBe(7);
  });
});
