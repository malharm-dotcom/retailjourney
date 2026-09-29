// Age/throughput reports must measure from OrderRow.anchor, not
// dispatchedDate — which is null on every spine-sourced order.

import { describe, expect, it } from "vitest";

import type { OrderRow } from "./data";
import { REPORTS, buildReport, filterReportRows } from "./reports";
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

describe("rulebook adherence", () => {
  const rule = { targetHandoverDay: "Mon", targetDeliveryDay: "Wed" } as OrderRow["rule"];
  it("checks WH handover off the manifest when a spine order has no dispatch date", () => {
    // dispatchedDate is blank on every spine order; keying off it alone left
    // this report delivery-only. 2026-09-28 is a Monday (IST).
    const t = buildReport("rulebook-adherence", [
      { ...row({ soNumber: "SPINE-1", manifestedTs: "2026-09-28T06:00:00.000Z" }, { date: "2026-09-28", source: "MANIFESTED" }), rule },
    ]);
    expect(t.rows).toEqual([["SPINE-1", "SNITCH - COCO - TEST", "WH handover", "Mon", "Mon", "YES"]]);
  });

  it("prefers a real dispatch date over the manifest", () => {
    const t = buildReport("rulebook-adherence", [
      { ...row({ soNumber: "D-1", dispatchedDate: "2026-09-29", manifestedTs: "2026-09-28T06:00:00.000Z" }, {}), rule },
    ]);
    expect(t.rows[0][4]).toBe("Tue");
    expect(t.rows[0][5]).toBe("off-day");
  });
});

describe("nso-openings", () => {
  const nso = row(
    { soNumber: "HESARA10003", type: "NSO", qty: 600, status: "PICKING", orderDate: daysAgo(2) },
    {},
  );
  const rpl = row({ soNumber: "RAJAJI16691", type: "RPL", orderDate: daysAgo(1) }, {});

  it("shows only store-opening orders", () => {
    const out = buildReport("nso-openings", [nso, rpl]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0][0]).toBe("HESARA10003");
  });

  it("carries NO deadline column — an NSO order has no TAT to miss", () => {
    const { columns } = buildReport("nso-openings", [nso]);
    // Whole words, not substrings: "WH status" contains "tat", which is the
    // kind of match that makes a guard like this quietly meaningless.
    const words = columns.flatMap((c) => c.toLowerCase().split(/[^a-z]+/));
    for (const banned of ["tat", "due", "deadline", "breach", "breaching", "sla", "overdue"]) {
      expect(words).not.toContain(banned);
    }
  });

  it("puts the newest opening first", () => {
    const older = row({ soNumber: "OLD-1", type: "NSO", orderDate: daysAgo(30) }, {});
    const out = buildReport("nso-openings", [older, nso]);
    expect(out.rows.map((r) => r[0])).toEqual(["HESARA10003", "OLD-1"]);
  });
});

describe("WH throughput boxes", () => {
  it("counts boxes off the AWB children when the order-level count is blank", () => {
    const r = { ...row({ soNumber: "S1", qty: 10 }, { date: daysAgo(1), source: "MANIFESTED" }), boxes: 4 };
    expect(buildReport("wh-throughput", [r]).rows[0][3]).toBe(4);
  });

  it("honours an explicit date range past the 14-day default window", () => {
    const old = row({ soNumber: "OLD" }, { date: daysAgo(30), source: "MANIFESTED" });
    expect(buildReport("wh-throughput", [old], undefined, true).rows).toHaveLength(1);
  });
});

describe("store slice", () => {
  it("counts an inwarded order with no delivered date as delivered", () => {
    const t = buildReport("store-slice", [row({ soNumber: "I-1", overallStatus: "INWARDED" }, {})]);
    expect(t.rows[0][col(t, "Delivered")]).toBe(1);
  });
});

describe("filterReportRows", () => {
  const def = (slug: string) => REPORTS.find((r) => r.slug === slug)!;
  const rows = [
    row({ soNumber: "A", type: "FRESH", courierPartner: "BLUEDART", facility: "SAPL-WH1", orderDate: "2026-09-10", status: "NOT_STARTED" }, {}),
    row({ soNumber: "B", type: "RPL", courierPartner: "MOVEMATE", facility: "SAPL-WH2", orderDate: "2026-09-20", status: "NOT_STARTED" }, {}),
    row({ soNumber: "C", type: "NSO", courierPartner: "MUDITA_CARGO", facility: "SAPL-NORTH-TAURU", orderDate: "2026-09-25", status: "NOT_STARTED" }, {}),
    row({ soNumber: "X", type: "FRESH", courierPartner: "BLUEDART", facility: "SAPL-WH1", orderDate: "2026-09-12", status: "CANCELLED" }, {}),
  ];
  const sos = (rs: OrderRow[]) => rs.map((r) => r.order.soNumber);

  it("keeps any of several ticked values — 2 of 3 couriers, 2 of 3 facilities", () => {
    expect(sos(filterReportRows(def("store-slice"), rows, { couriers: ["BLUEDART", "MOVEMATE"] }))).toEqual(["A", "B"]);
    expect(sos(filterReportRows(def("store-slice"), rows, { facilities: ["SAPL-WH2", "SAPL-NORTH-TAURU"] }))).toEqual(["B", "C"]);
    expect(sos(filterReportRows(def("store-slice"), rows, { types: ["FRESH", "NSO"] }))).toEqual(["A", "C"]);
  });

  it("drops cancelled orders from every report except the lookup", () => {
    expect(sos(filterReportRows(def("store-slice"), rows, {}))).not.toContain("X");
    expect(sos(filterReportRows(def("order-lookup"), rows, {}))).toContain("X");
  });

  it("ignores a filter the report does not show", () => {
    // In-transit ageing has no date filter: a stale ?from= must not hide old shipments.
    expect(filterReportRows(def("ageing"), rows, { from: "2026-09-24" })).toHaveLength(3);
  });

  it("filters dates inclusively", () => {
    expect(sos(filterReportRows(def("store-slice"), rows, { from: "2026-09-20", to: "2026-09-25" }))).toEqual(["B", "C"]);
  });
});
