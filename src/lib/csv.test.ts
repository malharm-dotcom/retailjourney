// CSV shaping. These files are opened in Excel by warehouse and logistics
// staff, so the two things worth testing are the quoting rules and the formula
// guard — a mangled quote loses a column, and an unguarded `=` cell is code.

import { describe, expect, it } from "vitest";
import { csvCell, csvFilename, toCsv, type CsvColumn } from "./csv";
import { istToday } from "./ist";

describe("cells", () => {
  it("leaves ordinary values bare", () => {
    expect(csvCell("SO-1001")).toBe("SO-1001");
    expect(csvCell(42)).toBe("42");
  });

  it("renders absent values as an empty cell, not as 'undefined'", () => {
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell("")).toBe("");
    // 0 is a real quantity, not an absence.
    expect(csvCell(0)).toBe("0");
  });

  it("quotes only what has to be quoted", () => {
    expect(csvCell("SNITCH - FOCO - BOPAL")).toBe("SNITCH - FOCO - BOPAL");
    expect(csvCell("Mumbai, MH")).toBe('"Mumbai, MH"');
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("doubles embedded quotes rather than dropping them", () => {
    expect(csvCell('He said "go"')).toBe('"He said ""go"""');
  });

  it("quotes leading and trailing whitespace so a code keeps its shape", () => {
    expect(csvCell(" 007")).toBe('" 007"');
    expect(csvCell("007 ")).toBe('"007 "');
  });

  it("defuses cells Excel would execute", () => {
    // Everything on these boards is externally sourced, so a campaign tag or a
    // store name really can arrive starting with one of these.
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1234")).toBe("'+1234");
    expect(csvCell("-1234")).toBe("'-1234");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("does not defuse a number, which cannot carry a formula", () => {
    // A real -3 defused to `'-3` stops being a number in the spreadsheet, and
    // the export exists to be summed and sorted.
    expect(csvCell(-3)).toBe("-3");
    // The same characters arriving as TEXT are still guarded.
    expect(csvCell("-3")).toBe("'-3");
  });
});

describe("rows", () => {
  interface Row {
    so: string;
    qty: number;
    store?: string;
  }
  const cols: CsvColumn<Row>[] = [
    { header: "Order", value: (r) => r.so },
    { header: "Qty", value: (r) => r.qty },
    { header: "Store", value: (r) => r.store },
  ];

  it("writes a header row even when there are no rows", () => {
    expect(toCsv(cols, [])).toBe("Order,Qty,Store");
  });

  it("writes one line per row, CRLF-separated, in column order", () => {
    const csv = toCsv(cols, [
      { so: "SO-1", qty: 3, store: "BOPAL" },
      { so: "SO-2", qty: 1 },
    ]);
    expect(csv).toBe("Order,Qty,Store\r\nSO-1,3,BOPAL\r\nSO-2,1,");
  });

  it("keeps the caller's row order — the export mirrors the screen", () => {
    const csv = toCsv(cols, [
      { so: "SO-9", qty: 1 },
      { so: "SO-1", qty: 1 },
    ]);
    expect(csv.split("\r\n").slice(1).map((l) => l.split(",")[0])).toEqual(["SO-9", "SO-1"]);
  });
});

describe("filenames", () => {
  it("stamps the IST business date", () => {
    expect(csvFilename("warehouse-queue")).toBe(`warehouse-queue-${istToday()}.csv`);
    expect(csvFilename("in-transit")).toMatch(/^in-transit-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
