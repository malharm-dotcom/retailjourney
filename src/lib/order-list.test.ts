// The /orders list and the board snapshot, against the in-memory seed repo.
//
// The first case is the bug it pins: the repo proxy dropped `search` from M2
// until 2026-09-15, so every search — and the 30-day default — returned every
// order on record. The tests that existed only exercised matchesSearch().

import { beforeAll, describe, expect, it } from "vitest";
import { scopedOrders } from "./data";
import { pageFromParams, EMPTY_SEARCH } from "./order-search";
import { repo } from "./repo";
import type { User } from "./types";

beforeAll(() => {
  delete process.env.DATABASE_URL;
});

const admin = { id: "t", name: "T", role: "ADMIN", facilities: [] } as unknown as User;

describe("order search reaches the repo", () => {
  it("a search narrows the list instead of returning every order", async () => {
    const all = await repo.listOrders("ALL");
    const so = all[0].soNumber;
    const hits = await repo.listOrders("ALL", undefined, { ...EMPTY_SEARCH, q: so });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(all.length);
    expect(hits.every((o) => o.soNumber.includes(so) || o.storeNameFormat.includes(so))).toBe(true);
  });

  it("pages the same result set, and reports the total it was cut from", async () => {
    const search = { ...EMPTY_SEARCH, from: "2000-01-01" };
    const full = await repo.listOrders("ALL", undefined, search);
    const first = await repo.searchOrders("ALL", undefined, search, 0, 2);
    const second = await repo.searchOrders("ALL", undefined, search, 2, 2);
    expect(first.total).toBe(full.length);
    expect(first.orders.map((o) => o.soNumber)).toEqual(full.slice(0, 2).map((o) => o.soNumber));
    expect(second.orders.map((o) => o.soNumber)).toEqual(full.slice(2, 4).map((o) => o.soNumber));
  });

  it("?page= is 1-based and degrades to page 1", () => {
    expect(pageFromParams({})).toBe(1);
    expect(pageFromParams({ page: "3" })).toBe(3);
    expect(pageFromParams({ page: "0" })).toBe(1);
    expect(pageFromParams({ page: "abc" })).toBe(1);
    expect(pageFromParams({ page: ["2", "5"] })).toBe(2);
  });
});

describe("board snapshot", () => {
  it("a manual edit shows on the very next read — the cache never hides a write", async () => {
    const before = await scopedOrders("ALL", admin);
    const so = before[0].order.soNumber;
    await repo.updateFields(so, { logisticsComments: "snapshot-test" }, admin, "MANUAL", "test");
    const after = await scopedOrders("ALL", admin);
    expect(after.find((r) => r.order.soNumber === so)?.order.logisticsComments).toBe("snapshot-test");
  });

  it("hands each caller its own array, so sorting one never reorders another", async () => {
    const a = await scopedOrders("ALL", admin);
    const b = await scopedOrders("ALL", admin);
    expect(a).not.toBe(b);
    a.reverse();
    expect(b[0].order.soNumber).not.toBe(a[0].order.soNumber);
  });
});
