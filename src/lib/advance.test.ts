// The RTS Logic quantity default, driven through the REAL advanceOne against
// the in-memory seed repo — so the allowlist, the facility assert and
// transitionStatus's required-field check are the ones actually running.
//
// The contract this pins down is the one that is easy to get backwards:
// blank means "all of it", a typed value wins, and `qty` — the sync-owned
// ordered quantity — is never written by either path.

import { beforeAll, describe, expect, it } from "vitest";
import { advanceOne } from "./advance";
import { REQUIRED_CAPTURES } from "./journey";
import { repo } from "./repo";
import type { Order, User } from "./types";

beforeAll(() => {
  delete process.env.DATABASE_URL;
});

/** Empty `facilities` = entitled to all of them (rbac.entitledFacilities), so
 *  this actor clears the facility assert whichever seed order we land on. */
const actor: Pick<User, "id" | "name" | "role" | "facilities"> = {
  id: "test",
  name: "Test",
  role: "WH_SUPERVISOR",
  facilities: [],
};

/** A fresh order walked up to Ready-to-Dispatch, so each case gets its own and
 *  the cases cannot consume each other's fixtures. */
async function freshReadyOrder(): Promise<Order> {
  const orders = await repo.listOrders("ALL");
  const o = orders.find((x) => x.status === "NOT_STARTED" && x.fulfilledQty == null);
  if (!o) throw new Error("seed has no unstarted order without a fulfilled qty");
  await advanceOne(actor, o.soNumber, "PICKING");
  await advanceOne(actor, o.soNumber, "PACKING");
  await advanceOne(actor, o.soNumber, "READY_TO_DISPATCH");
  const ready = await repo.getOrder(o.soNumber);
  if (!ready) throw new Error("order vanished");
  return ready;
}

const rtsCaptures = { boxCount: 4, weightKg: 32.5, saleInvoiceNumber: "SI-QTY", rtsLogicDate: "2026-07-17" };

describe("RTS Logic quantity", () => {
  it("blank quantity falls back to the UC-synced ordered qty", async () => {
    const o = await freshReadyOrder();
    await advanceOne(actor, o.soNumber, "RTS_LOGIC", rtsCaptures);
    const after = await repo.getOrder(o.soNumber);
    expect(after?.status).toBe("RTS_LOGIC");
    expect(after?.fulfilledQty).toBe(o.qty);
  });

  it("an entered quantity wins over the default", async () => {
    const o = await freshReadyOrder();
    await advanceOne(actor, o.soNumber, "RTS_LOGIC", { ...rtsCaptures, fulfilledQty: o.qty - 1 });
    const after = await repo.getOrder(o.soNumber);
    expect(after?.fulfilledQty).toBe(o.qty - 1);
  });

  it("never writes the sync-owned ordered qty", async () => {
    const o = await freshReadyOrder();
    await advanceOne(actor, o.soNumber, "RTS_LOGIC", { ...rtsCaptures, fulfilledQty: o.qty - 5 });
    const after = await repo.getOrder(o.soNumber);
    expect(after?.qty).toBe(o.qty);
    // `qty` must not even be recorded as manually touched — nothing may make
    // sync stop owning it.
    expect(after?.manualFields ?? []).not.toContain("qty");
  });

  it("does not reset a quantity the order already carries on a re-advance", async () => {
    const o = await freshReadyOrder();
    await advanceOne(actor, o.soNumber, "RTS_LOGIC", { ...rtsCaptures, fulfilledQty: o.qty - 3 });
    // Back down the ladder and up again, this time leaving quantity blank.
    await advanceOne(actor, o.soNumber, "READY_TO_DISPATCH");
    await advanceOne(actor, o.soNumber, "RTS_LOGIC", rtsCaptures);
    const after = await repo.getOrder(o.soNumber);
    expect(after?.fulfilledQty).toBe(o.qty - 3);
  });

  it("quantity is optional — its absence never blocks the move", async () => {
    const field = (REQUIRED_CAPTURES.RTS_LOGIC ?? []).find((f) => f.field === "fulfilledQty");
    expect(field?.optional).toBe(true);
  });
});
