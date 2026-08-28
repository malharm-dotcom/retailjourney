// The CSV importer's file-and-row layer: the parser, the templates, the date
// rule and the per-row validation.
//
// The cases that matter here are the ones that fail SILENTLY if they regress:
// a date read as the wrong day, a partner typo accepted as a courier, a
// duplicate SO advancing an order twice, and the template drifting out of step
// with what the modal asks for.

import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv";
import {
  MAX_IMPORT_ROWS,
  parseImportDate,
  parseImportRows,
  stageRefusal,
  templateColumns,
  templateNote,
} from "./csv-import";
import { REQUIRED_CAPTURES } from "./journey";

describe("parseCsv", () => {
  it("round-trips what toCsv writes, quotes and all", () => {
    const rows = [{ a: 'He said "hi"', b: "x,y", c: "line\r\nbreak", d: " padded " }];
    const csv = toCsv(
      [
        { header: "A", value: (r: (typeof rows)[0]) => r.a },
        { header: "B", value: (r: (typeof rows)[0]) => r.b },
        { header: "C", value: (r: (typeof rows)[0]) => r.c },
        { header: "D", value: (r: (typeof rows)[0]) => r.d },
      ],
      rows,
    );
    expect(parseCsv(csv)).toEqual([
      ["A", "B", "C", "D"],
      ['He said "hi"', "x,y", "line\r\nbreak", " padded "],
    ]);
  });

  it("eats the BOM our own downloads lead with", () => {
    expect(parseCsv("﻿SO_NUMBER,BOX_COUNT\r\nSO-1,4")[0][0]).toBe("SO_NUMBER");
  });

  it("keeps a last row that has no trailing newline", () => {
    expect(parseCsv("a,b\r\nc,d")).toHaveLength(2);
  });

  it("reads a bare LF file (not everything is Excel)", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseImportDate", () => {
  it("reads the DD-MM-YYYY the floor writes", () => {
    expect(parseImportDate("17-07-2026")).toBe("2026-07-17");
    expect(parseImportDate("3/4/2026")).toBe("2026-04-03"); // 3 April, not 4 March
  });

  it("reads YYYY-MM-DD unchanged", () => {
    expect(parseImportDate("2026-07-17")).toBe("2026-07-17");
  });

  it("does NOT shift the day — a business date is not an instant", () => {
    // The naive-+5:30 bug would land this on the 16th. rtsLogicDate is already
    // an IST business date; the day written is the day recorded.
    expect(parseImportDate("17-07-2026")).toBe("2026-07-17");
    expect(parseImportDate("01-01-2026")).toBe("2026-01-01");
    expect(parseImportDate("31-12-2026")).toBe("2026-12-31");
  });

  it("rejects dates that are well-formed and not real", () => {
    expect(parseImportDate("31-02-2026")).toBeUndefined();
    expect(parseImportDate("17-13-2026")).toBeUndefined();
    expect(parseImportDate("00-07-2026")).toBeUndefined();
  });

  it("rejects anything it cannot read unambiguously", () => {
    expect(parseImportDate("17 July 2026")).toBeUndefined();
    expect(parseImportDate("17-07-26")).toBeUndefined();
    expect(parseImportDate("")).toBeUndefined();
  });
});

describe("templates mirror the modal", () => {
  it("asks for exactly the transition's capture fields, plus the key and note", () => {
    for (const to of ["RTS_LOGIC", "DISPATCHED_TO_STORE"] as const) {
      const captured = templateColumns(to)
        .map((c) => c.field)
        .filter(Boolean);
      expect(captured).toEqual((REQUIRED_CAPTURES[to] ?? []).map((f) => f.field));
      expect(templateColumns(to)[0].header).toBe("SO_NUMBER");
      expect(templateColumns(to).at(-1)?.header).toBe("NOTE");
    }
  });

  it("marks optional exactly what the server treats as optional", () => {
    for (const to of ["RTS_LOGIC", "DISPATCHED_TO_STORE"] as const) {
      for (const f of REQUIRED_CAPTURES[to] ?? []) {
        const col = templateColumns(to).find((c) => c.field === f.field);
        expect(col?.optional).toBe(f.optional === true);
      }
    }
  });

  it("states the date format and the row cap in the note", () => {
    expect(templateNote("RTS_LOGIC")).toContain("DD-MM-YYYY");
    expect(templateNote("RTS_LOGIC")).toContain("IST");
    expect(templateNote("RTS_LOGIC")).toContain(String(MAX_IMPORT_ROWS));
    expect(templateNote("RTS_LOGIC")).toContain("QUANTITY");
  });
});

const RTS_HEAD = "SO_NUMBER,BOX_COUNT,WEIGHT_KG,SALE_INVOICE_NO,RTS_LOGIC_DATE,QUANTITY,NOTE";
const RTS_ROW = "SO-1,6,42.5,SI-1,17-07-2026,,";

describe("parseImportRows", () => {
  it("accepts a good file and captures every column", () => {
    const { error, rows } = parseImportRows("RTS_LOGIC", `${RTS_HEAD}\r\n${RTS_ROW}`);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      soNumber: "SO-1",
      captures: { boxCount: 6, weightKg: 42.5, saleInvoiceNumber: "SI-1", rtsLogicDate: "2026-07-17" },
    });
    // Blank QUANTITY is absent, NOT zero — the server fills it from the ordered
    // quantity, and a 0 here would dispatch an empty consignment.
    expect(rows[0].captures.fulfilledQty).toBeUndefined();
  });

  it("skips the # note line, so an untouched template still imports", () => {
    const note = `"${templateNote("RTS_LOGIC").replace(/"/g, '""')}"`;
    const { error, rows } = parseImportRows("RTS_LOGIC", `${note}\r\n${RTS_HEAD}\r\n${RTS_ROW}`);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(1);
  });

  it("rejects the wrong template by its missing columns", () => {
    const { error } = parseImportRows("DISPATCHED_TO_STORE", `${RTS_HEAD}\r\n${RTS_ROW}`);
    expect(error).toMatch(/DC_NUMBER/);
  });

  it("rejects an empty file and a headers-only file", () => {
    expect(parseImportRows("RTS_LOGIC", "").error).toBeTruthy();
    expect(parseImportRows("RTS_LOGIC", "\r\n\r\n").error).toBeTruthy();
    expect(parseImportRows("RTS_LOGIC", RTS_HEAD).error).toMatch(/no order rows/);
  });

  it("caps the row count rather than streaming an unbounded import", () => {
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => RTS_ROW.replace("SO-1", `SO-${i}`));
    const { error } = parseImportRows("RTS_LOGIC", [RTS_HEAD, ...body].join("\r\n"));
    expect(error).toMatch(new RegExp(String(MAX_IMPORT_ROWS)));
  });

  it("flags a missing required field on the row, not the file", () => {
    const { error, rows } = parseImportRows("RTS_LOGIC", `${RTS_HEAD}\r\nSO-1,,42.5,SI-1,17-07-2026,,`);
    expect(error).toBeUndefined();
    expect(rows[0].error).toMatch(/BOX_COUNT is required/);
  });

  it("flags a non-numeric number and an unreadable date", () => {
    const rows = parseImportRows(
      "RTS_LOGIC",
      `${RTS_HEAD}\r\nSO-1,six,42.5,SI-1,17-07-2026,,\r\nSO-2,6,42.5,SI-1,17 July,,`,
    ).rows;
    expect(rows[0].error).toMatch(/BOX_COUNT must be a number/);
    expect(rows[1].error).toMatch(/RTS_LOGIC_DATE must be DD-MM-YYYY/);
  });

  it("flags a duplicate SO rather than advancing it twice", () => {
    const { rows } = parseImportRows("RTS_LOGIC", `${RTS_HEAD}\r\n${RTS_ROW}\r\n${RTS_ROW}`);
    expect(rows[0].error).toBeUndefined();
    expect(rows[1].error).toMatch(/duplicate of row 2/);
  });

  it("ignores a column the operator added and an absent optional one", () => {
    const { error, rows } = parseImportRows(
      "RTS_LOGIC",
      "SO_NUMBER,BOX_COUNT,WEIGHT_KG,SALE_INVOICE_NO,RTS_LOGIC_DATE,MY_OWN_NOTES\r\nSO-1,6,42.5,SI-1,17-07-2026,whatever",
    );
    expect(error).toBeUndefined();
    expect(rows[0].error).toBeUndefined();
  });

  const DISPATCH_HEAD = "SO_NUMBER,DC_NUMBER,LR_NUMBER,LOGISTICS_PARTNER,VEHICLE_NO,E_WAY_BILL,NOTE";

  it("holds LOGISTICS_PARTNER to the allowed list, case-insensitively", () => {
    const { rows } = parseImportRows(
      "DISPATCHED_TO_STORE",
      `${DISPATCH_HEAD}\r\nSO-1,DC-1,LR-1,muditacargo,,,\r\nSO-2,DC-1,LR-1,DELHIVERY,,,`,
    );
    expect(rows[0].error).toBeUndefined();
    expect(rows[0].captures.logisticsPartner).toBe("MUDITACARGO");
    expect(rows[1].error).toMatch(/LOGISTICS_PARTNER must be one of/);
  });

  it("lets the dispatch optionals be blank and carries the note", () => {
    const { rows } = parseImportRows(
      "DISPATCHED_TO_STORE",
      `${DISPATCH_HEAD}\r\nSO-1,DC-1,LR-1,SELF,,,late handover`,
    );
    expect(rows[0].error).toBeUndefined();
    expect(rows[0].captures.vehicleNumber).toBeUndefined();
    expect(rows[0].note).toBe("late handover");
  });
});

describe("stageRefusal", () => {
  it("passes an order sitting at the expected source stage", () => {
    expect(stageRefusal("RTS_LOGIC", "READY_TO_DISPATCH")).toBeUndefined();
    expect(stageRefusal("DISPATCHED_TO_STORE", "RTS_LOGIC")).toBeUndefined();
  });

  it("calls at-or-past the target 'already advanced', not an error", () => {
    expect(stageRefusal("RTS_LOGIC", "RTS_LOGIC")).toBe("already advanced");
    expect(stageRefusal("RTS_LOGIC", "DISPATCHED_TO_STORE")).toBe("already advanced");
    expect(stageRefusal("DISPATCHED_TO_STORE", "DISPATCHED_TO_STORE")).toBe("already advanced");
  });

  it("refuses an order that has not got there yet, or is off the flow", () => {
    expect(stageRefusal("RTS_LOGIC", "PACKING")).toMatch(/not at expected stage/);
    expect(stageRefusal("RTS_LOGIC", "ON_HOLD")).toMatch(/not at expected stage/);
    expect(stageRefusal("DISPATCHED_TO_STORE", "CANCELLED")).toMatch(/not at expected stage/);
  });
});
