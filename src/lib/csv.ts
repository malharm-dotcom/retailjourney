// Client-side CSV export for the boards.
//
// The boards already hold their filtered rows in the browser, so exporting what
// is on screen is a string join and a Blob — a server endpoint would re-run the
// query, re-apply the filters from scratch, and still be capable of disagreeing
// with what the operator was looking at when they pressed the button.
//
// Excel is the destination for every one of these files, which drives the two
// unobvious decisions below: the BOM, and the formula guard.

import { istToday } from "./ist";

/** A column: its header, and how to read it off a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | undefined | null;
}

/**
 * Cells that Excel would execute rather than display.
 *
 * A cell opening with = + - @ (or a tab/CR, which Excel strips before parsing)
 * is read as a formula, so a store name or a campaign tag arriving from the
 * spine as `=HYPERLINK(...)` becomes live code in the operator's spreadsheet.
 * Prefixing with an apostrophe is the standard defusal: Excel shows the
 * original text and evaluates nothing. Everything on these boards is
 * externally sourced, so this applies to every field rather than a chosen few.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV cell: formula-guarded, then quoted only when it has to be. */
export function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  const raw = String(value);
  if (raw === "") return "";
  // Numbers skip the guard. They cannot carry a formula, and defusing them
  // would turn a legitimate -3 into the text `'-3`, which stops being a number
  // in the spreadsheet — the export exists to be summed and sorted.
  const safe = typeof value !== "number" && FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  // Leading/trailing spaces are quoted too: unquoted, they are whitespace a
  // reader is free to trim, and a store code is not.
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Rows to a CSV string. CRLF line endings, because that is what Excel expects
 * and what every other consumer tolerates.
 */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  return lines.join("\r\n");
}

/** `<prefix>-YYYY-MM-DD.csv`, stamped with the IST business date rather than
 *  the browser's local one, so a late-evening export is filed under the day the
 *  floor considers it to belong to. */
export function csvFilename(prefix: string): string {
  return `${prefix}-${istToday()}.csv`;
}

/**
 * Hand the file to the browser.
 *
 * The BOM is not optional: without it Excel on Windows decodes the file as the
 * system codepage, and every store name with a non-ASCII character in it
 * arrives mangled.
 */
export function downloadCsv(filename: string, csv: string): void {
  // Written as an escape, not a literal: a bare U+FEFF in source is invisible
  // and the next person to touch this line would delete it without knowing.
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some browsers; one turn
  // of the event loop is enough for the click to have been consumed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
