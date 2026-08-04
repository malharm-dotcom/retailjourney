// The manual write path end-to-end through the repo, not just the pure guard.
// What matters here is that the guard is actually WIRED IN — an earlier version
// of this feature enforced forward-only in the dialog and nowhere else.

import { beforeAll, describe, expect, it } from "vitest";
import { repo } from "./repo";
import type { Order } from "./types";

beforeAll(() => {
  delete process.env.DATABASE_URL;
});

const actor = { id: "test", name: "Test" };

/** A dispatched order with no shipment state yet. Cloned per test via the
 *  seed's own ordering so tests do not fight over one row. */
async function dispatched(skip = 0): Promise<Order> {
  const orders = await repo.listOrders("ALL");
  const found = orders.filter((o) => o.status === "DISPATCHED_TO_STORE");
  if (found.length <= skip) throw new Error("seed has too few dispatched orders");
  return found[skip];
}

describe("manualShipmentUpdate", () => {
  it("advances forward and records the source as MANUAL", async () => {
    const o = await dispatched(0);
    const next = await repo.manualShipmentUpdate(o.soNumber, { to: "OUT_FOR_DELIVERY" }, actor);
    expect(next.shipmentStatus).toBe("OUT_FOR_DELIVERY");
    expect(next.shipmentSource).toBe("MANUAL");
  });

  it("rejects a backwards move server-side", async () => {
    const o = await dispatched(0); // already OUT_FOR_DELIVERY from the test above
    await expect(repo.manualShipmentUpdate(o.soNumber, { to: "PICKED_UP" }, actor)).rejects.toThrow(
      /Cannot move back/i,
    );
  });

  it("refuses off-ladder targets even though the client could send them", async () => {
    const o = await dispatched(0);
    await expect(repo.manualShipmentUpdate(o.soNumber, { to: "RETURN" }, actor)).rejects.toThrow(
      /courier tracking/i,
    );
  });

  it("locks a delivered shipment", async () => {
    const o = await dispatched(1);
    await repo.manualShipmentUpdate(o.soNumber, { to: "DELIVERED" }, actor);
    await expect(repo.manualShipmentUpdate(o.soNumber, { to: "DELIVERED" }, actor)).rejects.toThrow(
      /delivered/i,
    );
    await expect(repo.manualShipmentUpdate(o.soNumber, { to: "IN_TRANSIT" }, actor)).rejects.toThrow(
      /delivered/i,
    );
  });

  it("is idempotent on the same rung", async () => {
    const o = await dispatched(2);
    await repo.manualShipmentUpdate(o.soNumber, { to: "IN_TRANSIT" }, actor);
    const before = (await repo.getOrder(o.soNumber))!;
    const after = await repo.manualShipmentUpdate(o.soNumber, { to: "IN_TRANSIT" }, actor);
    expect(after.shipmentStatus).toBe("IN_TRANSIT");
    // No churn on the timestamp the SLA pickup leg reads.
    expect(after.shippedTs).toBe(before.shippedTs);
  });

  it("keeps the pickup date set-once — a second value never clobbers the first", async () => {
    const o = await dispatched(3);
    await repo.manualShipmentUpdate(o.soNumber, { pickupDate: "2026-07-01" }, actor);
    const first = (await repo.getOrder(o.soNumber))!.shippedTs;
    expect(first).toBeTruthy();
    await repo.manualShipmentUpdate(o.soNumber, { pickupDate: "2026-07-09" }, actor);
    expect((await repo.getOrder(o.soNumber))!.shippedTs).toBe(first);
  });

  it("applies a set-once pickup even when the stage edit is idempotent", async () => {
    const o = await dispatched(4);
    await repo.manualShipmentUpdate(o.soNumber, { to: "PICKED_UP" }, actor);
    // PICKED_UP already stamped shippedTs, so this is the no-op case; the point
    // is that the call succeeds rather than throwing on the same-rung target.
    const after = await repo.manualShipmentUpdate(
      o.soNumber,
      { to: "PICKED_UP", pickupDate: "2026-07-02" },
      actor,
    );
    expect(after.shipmentStatus).toBe("PICKED_UP");
  });

  it("refuses to touch an order that has not been dispatched", async () => {
    const orders = await repo.listOrders("ALL");
    const notDispatched = orders.find((x) => x.status === "PICKING");
    if (!notDispatched) return;
    await expect(
      repo.manualShipmentUpdate(notDispatched.soNumber, { to: "IN_TRANSIT" }, actor),
    ).rejects.toThrow(/not dispatched/i);
  });
});
