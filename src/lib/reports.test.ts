// Age/throughput reports must measure from OrderRow.anchor, not
// dispatchedDate — which is null on every spine-sourced order.

import { describe, expect, it } from "vitest";

import type { OrderRow } from "./data";
import { buildReport } from "./reports";
import { istToday } from "./ist";
import type { OrderSla } from "./sla";
import type { TransitAnchor } from "./transit-anchor";
import type { Order } from "./types";

const today = istToday();

/** Days before today, as an IST business date. */
function daysAgo(n: number): string {
  const ms = Date.parse(`${today}T00:00:00.000Z`) - n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const emptySla: OrderSla = { legs: [], perfectOrder: null, ageing: 0 };

function row(order: Partial<Order>, anchor: TransitAnchor, sla: OrderSla = emptySla): OrderRow {
  return {
    order: {
      soNumber: "SO-1",
      storeNameFormat: "SNITCH - COCO - TEST",
      facility: "SAPL-WH1",
      overallStatus: "IN_TRANSIT",
      qty: 10,
      deliveryAttempts: 0,
      ...order,
    } as Order,
    rule: undefined,
    sla,
    breaching: false,
    anchor,
    awbCount: 0,
  };
}

const col = (t: { columns: string[] }, name: string) => t.columns.indexOf(name);

describe("ageing report", () => {
  it("ages a spine order (no dispatchedDate) off its manifest anchor", () => {
    const t = buildReport("ageing", [
      row({ soNumber: "SPINE-1" }, { date: daysAgo(6), source: "MANIFESTED" }),
    ]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][col(t, "Days out")]).toBe(6);
    expect(t.rows[0][col(t, "Bucket")]).toBe("6-9");
    expect(t.rows[0][col(t, "Anchor")]).toBe("manifest");
    expect(t.rows[0][col(t, "Anchored on")]).toBe(daysAgo(6));
  });

  it("leaves an order that already had a dispatch date unchanged", () => {
    const t = buildReport("ageing", [
      row({ soNumber: "OLD-1", dispatchedDate: daysAgo(3) }, { date: daysAgo(3), source: "DISPATCHED" }),
    ]);
    expect(t.rows[0][col(t, "Days out")]).toBe(3);
    expect(t.rows[0][col(t, "Bucket")]).toBe("3-5");
    expect(t.rows[0][col(t, "Anchor")]).toBe("dispatch");
  });

  it("never implies dispatch in a column heading", () => {
    const t = buildReport("ageing", []);
    expect(t.columns).not.toContain("Dispatched");
  });

  it("reports an anchorless order as '—', not a zero-day shipment", () => {
    const t = buildReport("ageing", [row({ soNumber: "GAP-1" }, {})]);
    expect(t.rows[0][col(t, "Days out")]).toBe("—");
    expect(t.rows[0][col(t, "Bucket")]).toBe("—");
    expect(t.rows[0][col(t, "Anchor")]).toBe("—");
  });

  it("sorts oldest first and pushes anchorless rows to the bottom", () => {
    const t = buildReport("ageing", [
      row({ soNumber: "GAP" }, {}),
      row({ soNumber: "YOUNG" }, { date: daysAgo(1), source: "MANIFESTED" }),
      row({ soNumber: "OLD" }, { date: daysAgo(9), source: "MANIFESTED" }),
    ]);
    expect(t.rows.map((r) => r[0])).toEqual(["OLD", "YOUNG", "GAP"]);
  });
});

describe("courier scorecard", () => {
  const delivered = (so: string, anchor: string, deliveredDate: string) =>
    row(
      { soNumber: so, logisticsPartner: "BLUEDART", deliveredDate, overallStatus: "DELIVERED" },
      { date: anchor, source: "MANIFESTED" },
    );

  it("computes avg days to deliver for spine orders instead of '—'", () => {
    const t = buildReport("courier-scorecard", [
      delivered("A", "2026-07-10", "2026-07-14"), // 4d
      delivered("B", "2026-07-10", "2026-07-12"), // 2d
    ]);
    expect(t.rows[0][col(t, "Avg days to deliver")]).toBe("3.0");
  });

  it("labels the column without claiming it is pure transit time", () => {
    const t = buildReport("courier-scorecard", []);
    expect(t.columns).not.toContain("Avg transit days");
    expect(t.columns).toContain("Avg days to deliver");
  });

  it("still shows '—' when no delivered order has an anchor", () => {
    const t = buildReport("courier-scorecard", [
      row(
        { logisticsPartner: "BLUEDART", deliveredDate: "2026-07-12", overallStatus: "DELIVERED" },
        {},
      ),
    ]);
    expect(t.rows[0][col(t, "Avg days to deliver")]).toBe("—");
  });
});

describe("WH throughput", () => {
  it("returns rows for spine orders that have no dispatchedDate", () => {
    const t = buildReport("wh-throughput", [
      row({ soNumber: "S1", qty: 10, facility: "SAPL-WH1" }, { date: daysAgo(2), source: "MANIFESTED" }),
      row({ soNumber: "S2", qty: 5, facility: "SAPL-WH1" }, { date: daysAgo(2), source: "MANIFESTED" }),
    ]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toEqual([`${daysAgo(2)} · SAPL-WH1`, 2, 15, 0]);
  });

  it("keeps the 14-day window and excludes anchorless orders honestly", () => {
    const t = buildReport("wh-throughput", [
      row({ soNumber: "OLD" }, { date: daysAgo(30), source: "MANIFESTED" }),
      row({ soNumber: "GAP" }, {}),
    ]);
    expect(t.rows).toHaveLength(0);
  });

  it("does not label the grouping column as a dispatch day", () => {
    const t = buildReport("wh-throughput", []);
    expect(t.columns[0]).toBe("WH-out day · facility");
  });
});

describe("rulebook adherence (verdict-dependent — untouched)", () => {
  it("still keys the handover check off dispatchedDate, so spine orders yield no check", () => {
    const rule = { targetHandoverDay: "Mon", targetDeliveryDay: "Wed" } as OrderRow["rule"];
    const t = buildReport("rulebook-adherence", [
      { ...row({ soNumber: "SPINE-1" }, { date: daysAgo(3), source: "MANIFESTED" }), rule },
    ]);
    expect(t.rows).toHaveLength(0);
  });
});
