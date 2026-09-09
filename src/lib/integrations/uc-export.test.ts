// UC intake mapping — the parts that must be right before anything is written.
//
// Every fixture below is the shape the live tenant actually returned
// (SAPL-WH2, 24h, 28,632 rows / 178 orders), not an invented one.

import { describe, expect, it } from "vitest";

import {
  aggregateUcOrders,
  normUcChannel,
  normUcFacility,
  parseUcExport,
  ucInitialStatus,
} from "./uc-export";

/** The real header row, in the real order UC returned it. */
const HEADERS = [
  "Sale Order Item Code",
  "Display Order Code",
  "Sale Order Code",
  "Shipping Package Code",
  "Channel Name",
  "Facility",
  "Order_Type",
  "STORE-CODE",
  "Sale Order Status",
  "Sale Order Item Status",
  "Shipping Package Status Code",
  "On Hold",
  "Cancellation Reason",
  "Created",
  "Order Date as dd/mm/yyyy hh:MM:ss",
  "Updated",
  "Packing Time",
  "Fulfillment TAT",
  "Dispatch Date",
  "Delivery Time",
  "Item SKU Code",
  "SKU Name",
  "Item Type Name",
  "Item Type Color",
  "Item Type Size",
  "Weight",
  "Tracking Number",
  "Shipping Courier",
  "Shipping provider",
  "Invoice Code",
  "Channel Shipping",
  "Item Details",
];

function csv(rows: Record<string, string>[]): string {
  const line = (vals: string[]) => vals.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
  return [line(HEADERS), ...rows.map((r) => line(HEADERS.map((h) => r[h] ?? "")))].join("\r\n");
}

const item = (over: Record<string, string> = {}): Record<string, string> => ({
  "Sale Order Item Code": "RAJAJI16691108-1",
  "Display Order Code": "RAJAJI16691",
  "Shipping Package Code": "WH2SAPL/743730",
  "Channel Name": "Franchise Store",
  Facility: "SAPL-WH2",
  Order_Type: "RPL",
  "Sale Order Item Status": "DISPATCHED",
  "Shipping Package Status Code": "DISPATCHED",
  "On Hold": "false",
  Created: "2026-09-07 13:17:29",
  "Order Date as dd/mm/yyyy hh:MM:ss": "2026-09-07 13:17:28",
  Updated: "2026-09-08 06:58:54",
  "Packing Time": "2026-09-08 01:59:27",
  "Dispatch Date": "2026-09-08 02:29:51",
  Weight: "158400.000",
  "Invoice Code": "WH2INS/2750355",
  ...over,
});

describe("normUcChannel", () => {
  it("accepts BOTH vocabularies UC returns at once", () => {
    // Display labels and enums arrive in the same export. Matching only the
    // enum dropped 52 of 178 orders in the live sample.
    expect(normUcChannel("Own Store")).toBe("OWN_STORE");
    expect(normUcChannel("OWN_STORE_B2B")).toBe("OWN_STORE");
    expect(normUcChannel("Franchise Store")).toBe("FRANCHISE_STORE");
    expect(normUcChannel("FRANCHISE_STORE_B2B")).toBe("FRANCHISE_STORE");
  });

  it("refuses to guess at anything else", () => {
    expect(normUcChannel("")).toBeUndefined();
    expect(normUcChannel("MARKETPLACE")).toBeUndefined();
  });
});

describe("normUcFacility", () => {
  it("takes only known warehouses, never coerces", () => {
    expect(normUcFacility("SAPL-WH2")).toBe("SAPL-WH2");
    expect(normUcFacility("sapl-wh1")).toBe("SAPL-WH1");
    expect(normUcFacility("SAPL-WH9")).toBeUndefined();
  });
});

describe("parseUcExport", () => {
  it("reads by header, not position — UC returns columns nobody asked for", () => {
    const shuffled = [...HEADERS].reverse();
    const line = (v: string[]) => v.join(",");
    const one = item();
    const text = [line(shuffled), line(shuffled.map((h) => one[h] ?? ""))].join("\r\n");
    const [row] = parseUcExport(text);
    expect(row.soNumber).toBe("RAJAJI16691");
    expect(row.facility).toBe("SAPL-WH2");
    expect(row.type).toBe("RPL");
  });

  it("reads IST wall-clock stamps as IST, never as UTC", () => {
    const [row] = parseUcExport(csv([item()]));
    // 2026-09-07 13:17:29 IST is 07:47:29Z.
    expect(row.createdTs).toBe("2026-09-07T07:47:29.000Z");
  });

  it("dedupes on Sale Order Item Code so an overlapping window cannot double a quantity", () => {
    const rows = parseUcExport(csv([item(), item(), item({ "Sale Order Item Code": "X-2" })]));
    expect(rows).toHaveLength(2);
  });

  it("drops rows with no order or item code rather than inventing one", () => {
    expect(parseUcExport(csv([item({ "Display Order Code": "" })]))).toHaveLength(0);
    expect(parseUcExport(csv([item({ "Sale Order Item Code": "" })]))).toHaveLength(0);
  });

  it("survives a column UC stops returning", () => {
    const without = HEADERS.filter((h) => h !== "Weight");
    const one = item();
    const text = [without.join(","), without.map((h) => one[h] ?? "").join(",")].join("\r\n");
    const [row] = parseUcExport(text);
    expect(row.packageWeightG).toBeUndefined();
    expect(row.soNumber).toBe("RAJAJI16691");
  });
});

describe("aggregateUcOrders", () => {
  const three = parseUcExport(
    csv([
      item({ "Sale Order Item Code": "A-1" }),
      item({ "Sale Order Item Code": "A-2" }),
      item({ "Sale Order Item Code": "A-3", "Sale Order Item Status": "CANCELLED" }),
    ]),
  );

  it("counts item rows into the order quantity", () => {
    const [o] = aggregateUcOrders(three);
    expect(o.qty).toBe(3);
    // Cancelled items are counted, and reported separately rather than being
    // quietly netted off — the spine's QUANTITY overwrites this anyway.
    expect(o.cancelledItems).toBe(1);
  });

  it("counts a package weight ONCE, not once per item, and converts g → kg", () => {
    const [o] = aggregateUcOrders(three);
    // Three item rows, one package of 158,400 g.
    expect(o.weightKg).toBe(158.4);
  });

  it("sums across distinct packages", () => {
    const rows = parseUcExport(
      csv([
        item({ "Sale Order Item Code": "A-1", "Shipping Package Code": "P1", Weight: "1000" }),
        item({ "Sale Order Item Code": "A-2", "Shipping Package Code": "P2", Weight: "2500" }),
      ]),
    );
    expect(aggregateUcOrders(rows)[0].weightKg).toBe(3.5);
  });

  it("takes the store prefix from the order name, upper-cased", () => {
    expect(aggregateUcOrders(three)[0].storePrefix).toBe("RAJAJI");
  });

  it("separates orders and keeps the newest update stamp for the watermark", () => {
    const rows = parseUcExport(
      csv([
        item({ "Sale Order Item Code": "A-1", Updated: "2026-09-08 06:00:00" }),
        item({ "Sale Order Item Code": "A-2", Updated: "2026-09-08 09:00:00" }),
        item({ "Sale Order Item Code": "B-1", "Display Order Code": "HESARA10003" }),
      ]),
    );
    const out = aggregateUcOrders(rows);
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.soNumber === "RAJAJI16691")!.updatedTs).toBe("2026-09-08T03:30:00.000Z");
  });

  it("keeps NSO — a store opening is an ordinary order here", () => {
    const rows = parseUcExport(csv([item({ Order_Type: "NSO", "Display Order Code": "HESARA10003" })]));
    const [o] = aggregateUcOrders(rows);
    expect(o.type).toBe("NSO");
  });
});

describe("ucInitialStatus", () => {
  const base = aggregateUcOrders(parseUcExport(csv([item()])))[0];

  it("reads a dispatched package as dispatched", () => {
    expect(ucInitialStatus(base)).toBe("DISPATCHED_TO_STORE");
  });

  it("holds an on-hold order ahead of any packing signal", () => {
    expect(ucInitialStatus({ ...base, packageStatuses: [], onHold: true })).toBe("ON_HOLD");
  });

  it("falls back to NOT_STARTED rather than guessing", () => {
    expect(
      ucInitialStatus({ ...base, packageStatuses: [], onHold: false, packedTs: undefined }),
    ).toBe("NOT_STARTED");
  });
});
