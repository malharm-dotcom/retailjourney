import { describe, expect, it } from "vitest";
import type { OrderRow } from "./data";
import {
  AGEING_BUCKETS,
  NO_EDD,
  ageingBucketOf,
  breachedRows,
  breachedTsv,
  buildPivot,
  inTransitDockets,
} from "./logistics-followup";

const TODAY = "2026-08-29";

/** Minimal OrderRow — the pivot only reads store, status, EDDs, courier, awb. */
function row(o: {
  store: string;
  overall?: string;
  shipment?: string;
  expectedDate?: string;
  idealDeliveryDate?: string;
  courier?: string;
  awb?: string;
  boxes?: number;
  so?: string;
}): OrderRow {
  return {
    order: {
      storeNameFormat: o.store,
      overallStatus: o.overall ?? "IN_TRANSIT",
      shipmentStatus: o.shipment,
      expectedDate: o.expectedDate,
      idealDeliveryDate: o.idealDeliveryDate,
      courierPartner: o.courier ?? "BLUEDART",
      soNumber: o.so ?? "SO1",
    },
    awb: "awb" in o ? o.awb : "A1",
    boxes: o.boxes,
  } as unknown as OrderRow;
}

describe("in-transit predicate", () => {
  it("keeps IN_TRANSIT and drops every other overall status", () => {
    const rows = [
      row({ store: "S", overall: "IN_TRANSIT" }),
      row({ store: "S", overall: "PICKUP_PENDING" }),
      row({ store: "S", overall: "WH_PROCESSING" }),
      row({ store: "S", overall: "DELIVERED" }),
      row({ store: "S", overall: "INWARDED" }),
      row({ store: "S", overall: "CLOSED" }),
    ];
    expect(inTransitDockets(rows)).toHaveLength(1);
  });

  it("drops a dead label whose rollup has not been recomputed yet", () => {
    const rows = [
      row({ store: "S", shipment: "RETURN" }),
      row({ store: "S", shipment: "DELIVERY_FAILED" }),
      row({ store: "S", shipment: "OUT_FOR_DELIVERY" }),
    ];
    expect(inTransitDockets(rows)).toHaveLength(1);
  });
});

describe("ageing buckets", () => {
  it("maps days past EDD onto the shipped edges", () => {
    expect(ageingBucketOf("2026-08-30", TODAY)).toBe("Not due");
    expect(ageingBucketOf(TODAY, TODAY)).toBe("Due today");
    expect(ageingBucketOf("2026-08-28", TODAY)).toBe("1–2d");
    expect(ageingBucketOf("2026-08-27", TODAY)).toBe("1–2d");
    expect(ageingBucketOf("2026-08-26", TODAY)).toBe("3–5d");
    expect(ageingBucketOf("2026-08-24", TODAY)).toBe("3–5d");
    expect(ageingBucketOf("2026-08-23", TODAY)).toBe("6–10d");
    expect(ageingBucketOf("2026-08-19", TODAY)).toBe("6–10d");
    expect(ageingBucketOf("2026-08-18", TODAY)).toBe("10d+");
  });
});

describe("buildPivot", () => {
  const base = {
    eddSource: "courier" as const,
    couriers: [],
    from: "2026-08-15",
    to: "2026-09-12",
  };

  it("pivots store × EDD with row, column and grand totals", () => {
    const p = buildPivot(
      [
        row({ store: "Delhi CP", expectedDate: "2026-08-30" }),
        row({ store: "Delhi CP", expectedDate: "2026-08-30" }),
        row({ store: "Delhi CP", expectedDate: "2026-08-31" }),
        row({ store: "Bengaluru IND", expectedDate: "2026-08-31" }),
      ],
      { ...base, mode: "edd" },
      TODAY,
    );
    expect(p.columns).toEqual(["2026-08-30", "2026-08-31"]);
    // Stores sorted; blank cells are 0 and render blank.
    expect(p.rows).toEqual([
      { store: "Bengaluru IND", cells: [0, 1], total: 1 },
      { store: "Delhi CP", cells: [2, 1], total: 3 },
    ]);
    expect(p.columnTotals).toEqual([2, 2]);
    expect(p.grandTotal).toBe(4);
  });

  it("counts the same dockets in ageing mode, over the fixed bucket axis", () => {
    const rows = [
      row({ store: "A", expectedDate: "2026-08-30" }), // not due
      row({ store: "A", expectedDate: TODAY }), // due today
      row({ store: "B", expectedDate: "2026-08-20" }), // 6–10d
    ];
    const edd = buildPivot(rows, { ...base, mode: "edd" }, TODAY);
    const ageing = buildPivot(rows, { ...base, mode: "ageing" }, TODAY);
    // Toggling the view must never change the count.
    expect(ageing.grandTotal).toBe(edd.grandTotal);
    expect(ageing.columns).toEqual([...AGEING_BUCKETS]);
    expect(ageing.columnTotals).toEqual([1, 1, 0, 0, 1, 0]);
  });

  it("footnotes in-transit dockets with no AWB instead of dropping them", () => {
    const p = buildPivot(
      [
        row({ store: "A", expectedDate: TODAY }),
        row({ store: "A", expectedDate: TODAY, awb: undefined }),
      ],
      { ...base, mode: "edd" },
      TODAY,
    );
    expect(p.grandTotal).toBe(1);
    expect(p.noAwb).toBe(1);
  });

  it("gives dockets with no EDD their own column rather than losing them", () => {
    const p = buildPivot(
      [row({ store: "A", expectedDate: TODAY }), row({ store: "A" })],
      { ...base, mode: "edd" },
      TODAY,
    );
    expect(p.columns).toEqual([TODAY, NO_EDD]);
    expect(p.grandTotal).toBe(2);
  });

  it("bounds the EDD axis and counts what the window excluded", () => {
    const p = buildPivot(
      [
        row({ store: "A", expectedDate: TODAY }),
        row({ store: "A", expectedDate: "2026-06-01" }),
        row({ store: "A", expectedDate: "2027-01-01" }),
      ],
      { ...base, mode: "edd" },
      TODAY,
    );
    expect(p.columns).toEqual([TODAY]);
    expect(p.grandTotal).toBe(1);
    expect(p.outOfWindow).toBe(2);
    // Ageing has no window, so nothing is excluded there.
    expect(buildPivot(
      [
        row({ store: "A", expectedDate: TODAY }),
        row({ store: "A", expectedDate: "2026-06-01" }),
      ],
      { ...base, mode: "ageing" },
      TODAY,
    ).grandTotal).toBe(2);
  });

  it("switches EDD source, and filters to the selected couriers", () => {
    const rows = [
      row({ store: "A", expectedDate: "2026-08-30", idealDeliveryDate: TODAY, courier: "BLUEDART" }),
      row({ store: "A", expectedDate: "2026-08-30", idealDeliveryDate: TODAY, courier: "MOVEMATE" }),
    ];
    expect(buildPivot(rows, { ...base, mode: "edd", eddSource: "store" }, TODAY).columns).toEqual([TODAY]);
    const filtered = buildPivot(rows, { ...base, mode: "edd", couriers: ["MOVEMATE"] }, TODAY);
    expect(filtered.grandTotal).toBe(1);
  });
});

describe("breached list", () => {
  const rows = [
    // 3 days past its courier EDD, two boxes.
    row({ store: "B store", expectedDate: "2026-08-26", awb: "A9", boxes: 2, so: "SO9" }),
    // Due today — not breached.
    row({ store: "C store", expectedDate: TODAY, awb: "A2" }),
    // Tomorrow — not breached.
    row({ store: "D store", expectedDate: "2026-08-30", awb: "A3" }),
    // 1 day past, so it sorts after the 3-day one.
    row({ store: "A store", expectedDate: "2026-08-28", awb: "A4", courier: "EKART" }),
    // No AWB: nothing to chase a courier with.
    row({ store: "E store", expectedDate: "2026-08-20", awb: undefined }),
    // No courier EDD at all: cannot be breached on this source.
    row({ store: "F store", idealDeliveryDate: "2026-08-20", awb: "A6" }),
    // Delivered — not in transit.
    row({ store: "G store", overall: "DELIVERED", expectedDate: "2026-08-20", awb: "A7" }),
  ];

  it("keeps only in-transit AWBs already past the EDD, worst first", () => {
    const out = breachedRows(rows, { eddSource: "courier", couriers: [] }, TODAY);
    expect(out.map((r) => [r.store, r.aging])).toEqual([
      ["B store", -3],
      ["A store", -1],
    ]);
  });

  it("reads the store EDD when that source is picked", () => {
    const out = breachedRows(rows, { eddSource: "store", couriers: [] }, TODAY);
    expect(out.map((r) => r.store)).toEqual(["F store"]);
  });

  it("narrows to the picked couriers", () => {
    const out = breachedRows(rows, { eddSource: "courier", couriers: ["EKART"] }, TODAY);
    expect(out.map((r) => r.store)).toEqual(["A store"]);
  });

  it("writes the courier sheet's columns, tab-separated, dd/MM/yyyy", () => {
    const tsv = breachedTsv(breachedRows(rows, { eddSource: "courier", couriers: [] }, TODAY));
    const lines = tsv.split("\n");
    expect(lines[0].split("\t")).toEqual([
      "EDD Breached Aging (Days)",
      "AWB",
      "Courier",
      "Store Name",
      "EDD",
      "Boxes",
      "Remarks",
    ]);
    expect(lines[1].split("\t")).toEqual(["-3", "A9", "BLUEDART", "B store", "26/08/2026", "2", ""]);
    // A docket whose children carry no package count must paste as an empty
    // cell, never as a 0 the courier reads as "zero boxes".
    expect(lines[2].split("\t")[5]).toBe("");
  });
});
