// Round-trip tests for the domain <-> Prisma row mapping — the one place
// where ISO/YYYY-MM-DD strings meet DateTime/@db.Date columns.

import { describe, expect, it } from "vitest";
import { orderToDb, orderToDomain } from "./prisma-map";
import { seedData } from "./seed/orders";
import type { Order as DbOrder } from "../generated/prisma/client";

describe("orderToDb", () => {
  it("converts timestamp strings to Date and business dates to UTC midnight", () => {
    const row = orderToDb({
      dispatchedTs: "2026-07-01T09:30:00.000Z",
      dispatchedDate: "2026-07-01",
      qty: 100,
    });
    expect(row.dispatchedTs).toEqual(new Date("2026-07-01T09:30:00.000Z"));
    expect(row.dispatchedDate).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(row.qty).toBe(100);
  });

  it("skips undefined keys", () => {
    expect(Object.keys(orderToDb({ qty: 5, boxCount: undefined }))).toEqual(["qty"]);
  });
});

describe("orderToDomain <-> orderToDb round trip", () => {
  it("preserves every seed order field", () => {
    const { orders } = seedData();
    for (const o of orders.slice(0, 25)) {
      const row = orderToDb(o) as unknown as DbOrder;
      // Simulate DB defaults for columns the domain object may omit.
      row.manualFields = row.manualFields ?? [];
      row.checkpoints = row.checkpoints ?? null;
      const back = orderToDomain(row);
      for (const [k, v] of Object.entries(o)) {
        if (v === undefined) continue;
        expect(back[k as keyof typeof back], `field ${k} on ${o.soNumber}`).toEqual(v);
      }
    }
  });
});
