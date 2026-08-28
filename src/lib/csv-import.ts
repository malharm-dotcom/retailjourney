// CSV bulk import for the two per-order-detail warehouse transitions.
//
// WHY THIS EXISTS: the bulk bar captures ONE detail set and applies it to every
// selected order. For a single-consignment dispatch that is right — one truck,
// one DC, one LR. For box count, weight and sale invoice it is nonsense: one
// box count cannot describe 290 orders. This module is the per-row alternative.
//
// Everything here is PURE — no database, no session, no writes. It turns a file
// into a list of "this SO, these captures" (or "this SO, this reason it is not
// importable"). The order-dependent checks (does it exist, is it at the right
// stage, is it in scope) and the write itself live in app/import-actions.ts,
// which drives the SAME advanceOne() every other transition path uses.
//
// The field set is DERIVED from REQUIRED_CAPTURES rather than restated, so the
// template can never ask for a field the modal does not, or mark something
// optional that the server requires.

import { parseCsv } from "./csv";
import { REQUIRED_CAPTURES, WH_FLOW } from "./journey";
import { LOGISTICS_PARTNERS, type Order, type OrderStatus } from "./types";

/** The two transitions that carry per-order detail. */
export type ImportTarget = "RTS_LOGIC" | "DISPATCHED_TO_STORE";

export const IMPORT_TARGETS: ImportTarget[] = ["RTS_LOGIC", "DISPATCHED_TO_STORE"];

/** The stage an order must be sitting at for a row to be importable. Anything
 *  earlier is not ready; anything at or past the target is already advanced. */
export const SOURCE_STAGE: Record<ImportTarget, OrderStatus> = {
  RTS_LOGIC: "READY_TO_DISPATCH",
  DISPATCHED_TO_STORE: "RTS_LOGIC",
};

/**
 * Row ceiling for one import.
 *
 * Matches MAX_BULK in bulk-actions.ts on purpose: both are "one sweep of the
 * floor", and having the CSV path accept a batch the selection path refuses
 * would just move the runaway somewhere less visible. Streaming an unbounded
 * file is not on the table — every row is a guarded read-modify-write.
 */
export const MAX_IMPORT_ROWS = 500;

/** CSV header for each capture field. Not derived from the field name: the
 *  floor's vocabulary is not camelCase, and SALE_INVOICE_NO / VEHICLE_NO are
 *  what the old Sheet's columns were called. */
const HEADERS: Partial<Record<keyof Order, string>> = {
  fulfilledQty: "QUANTITY",
  boxCount: "BOX_COUNT",
  weightKg: "WEIGHT_KG",
  saleInvoiceNumber: "SALE_INVOICE_NO",
  rtsLogicDate: "RTS_LOGIC_DATE",
  dcNumber: "DC_NUMBER",
  lrNumber: "LR_NUMBER",
  logisticsPartner: "LOGISTICS_PARTNER",
  vehicleNumber: "VEHICLE_NO",
  eWayBill: "E_WAY_BILL",
};

/** One filled-in row, so the sample is a worked example rather than a blank
 *  grid the operator has to guess the shape of. */
const EXAMPLES: Partial<Record<keyof Order, string>> = {
  fulfilledQty: "180",
  boxCount: "6",
  weightKg: "42.5",
  saleInvoiceNumber: "SI-2026-04417",
  rtsLogicDate: "17-07-2026",
  dcNumber: "DC-88213",
  lrNumber: "LR-40119",
  logisticsPartner: "MUDITACARGO",
  vehicleNumber: "HR55AB1234",
  eWayBill: "281004417901",
};

export const SO_HEADER = "SO_NUMBER";
export const NOTE_HEADER = "NOTE";

export interface ImportColumn {
  header: string;
  /** The capture field this column writes. Absent for the key and the note,
   *  which are not captures — the note is its own advanceOne parameter. */
  field?: keyof Order;
  kind: "text" | "number" | "date" | "partner";
  optional: boolean;
  example: string;
}

/**
 * The template's columns, in order: the key, then the transition's own capture
 * prompts exactly as the modal renders them, then the note.
 */
export function templateColumns(to: ImportTarget): ImportColumn[] {
  return [
    { header: SO_HEADER, kind: "text", optional: false, example: "SO-2026-00042" },
    ...(REQUIRED_CAPTURES[to] ?? []).map((f) => ({
      header: HEADERS[f.field] ?? String(f.field).toUpperCase(),
      field: f.field,
      kind: f.kind,
      optional: f.optional === true,
      example: EXAMPLES[f.field] ?? "",
    })),
    { header: NOTE_HEADER, kind: "text" as const, optional: true, example: "" },
  ];
}

/**
 * The `#` line the sample files open with.
 *
 * A CSV has nowhere else to put instructions, and an operator who opens the
 * template in Excel needs to read the date format and the required columns
 * without going back to the app. parseImportRows skips leading `#` rows, so
 * the note survives a round trip and re-importing an untouched template is not
 * a parse error.
 */
export function templateNote(to: ImportTarget): string {
  const cols = templateColumns(to);
  const req = cols.filter((c) => !c.optional).map((c) => c.header);
  const opt = cols.filter((c) => c.optional).map((c) => c.header);
  const parts = [
    `# ${to === "RTS_LOGIC" ? "Ready-to-Dispatch → RTS Logic" : "RTS Logic → Dispatched"} import.`,
    `Required: ${req.join(", ")}.`,
    opt.length ? `Optional (may be left blank): ${opt.join(", ")}.` : "",
    "Dates are DD-MM-YYYY, IST (YYYY-MM-DD also accepted).",
    to === "RTS_LOGIC" ? "Leave QUANTITY blank to use the ordered quantity." : "",
    `One row per order, max ${MAX_IMPORT_ROWS}. This line may be left in place.`,
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * A business date typed by a human, to the "YYYY-MM-DD" the order stores.
 *
 * NO TIMEZONE ARITHMETIC HAPPENS HERE, and that is the point. `rtsLogicDate` is
 * an IST business date, not an instant: the day the operator writes IS the day
 * the order records. Date.parse-ing it and shifting by 5.5h would turn an
 * already-IST value into the previous evening — the naive-offset bug that
 * ist.ts exists to keep out of this codebase.
 *
 * DD-MM-YYYY is what the modal's date input displays under en-IN and what the
 * floor writes; YYYY-MM-DD is accepted too because it is unambiguous (and is
 * what Excel hands back on some locales). MM-DD-YYYY is NOT accepted — there is
 * no way to tell it apart from DD-MM-YYYY, and silently reading 04-03 as March
 * would be worse than a rejection.
 */
export function parseImportDate(raw: string): string | undefined {
  const t = raw.trim();
  let y: string, m: string, d: string;
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) [, y, m, d] = iso;
  else {
    const dmy = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!dmy) return undefined;
    [, d, m, y] = dmy;
  }
  const out = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  // Round-trip to reject the dates that look well-formed and are not: 31-02,
  // month 13, day 00. Constructed and read back in UTC so no local offset can
  // roll the day over — this is a calendar check, not a clock one.
  const probe = new Date(`${out}T00:00:00Z`);
  return Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== out ? undefined : out;
}

export interface ParsedRow {
  /** 1-based line number in the file, as the operator's spreadsheet numbers
   *  it — so "row 34 is wrong" points at row 34. */
  line: number;
  soNumber: string;
  captures: Partial<Order>;
  note?: string;
  /** Set when the row cannot be imported as written. Mutually exclusive with
   *  a usable `captures`. */
  error?: string;
}

export interface ParsedFile {
  /** A problem with the FILE, not a row: nothing is importable. */
  error?: string;
  rows: ParsedRow[];
}

const PARTNERS = new Set<string>(LOGISTICS_PARTNERS);

/**
 * File → rows, validated as far as the file alone allows.
 *
 * What is checked here: the headers, the required fields, numerics, the date,
 * and partner membership. What is NOT checked here, because it needs the
 * database: whether the SO exists, what stage it is at, and whether it is in
 * the caller's facility scope. Those are the action's job, and they are checked
 * again by advanceOne on the write regardless of what this said.
 */
export function parseImportRows(to: ImportTarget, text: string): ParsedFile {
  const columns = templateColumns(to);
  const all = parseCsv(text);

  // Blank rows (Excel loves trailing ones) and the `#` note are not data.
  const meaningful = all
    .map((cells, i) => ({ line: i + 1, cells }))
    .filter(({ cells }) => cells.some((c) => c.trim() !== "") && !cells[0].trimStart().startsWith("#"));

  if (meaningful.length === 0) return { error: "That file has no rows in it.", rows: [] };

  const header = meaningful[0].cells.map((h) => h.trim().toUpperCase());
  const index = new Map(header.map((h, i) => [h, i]));
  // Only the required columns must be present. An extra column the operator
  // added for their own notes is ignored rather than rejected; a missing
  // OPTIONAL column just means every row leaves it blank.
  const missing = columns.filter((c) => !c.optional && !index.has(c.header)).map((c) => c.header);
  if (missing.length) {
    return {
      error: `This looks like the wrong template — missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
      rows: [],
    };
  }

  const body = meaningful.slice(1);
  if (body.length === 0) return { error: "That file has headers but no order rows.", rows: [] };
  if (body.length > MAX_IMPORT_ROWS) {
    return {
      error: `${body.length} rows — import at most ${MAX_IMPORT_ROWS} at a time. Split the file and run it twice.`,
      rows: [],
    };
  }

  const seen = new Map<string, number>();
  return {
    rows: body.map(({ line, cells }) => {
      const at = (h: string) => (index.has(h) ? (cells[index.get(h)!] ?? "").trim() : "");
      const soNumber = at(SO_HEADER);
      const row: ParsedRow = { line, soNumber, captures: {} };
      if (!soNumber) return { ...row, error: `${SO_HEADER} is blank` };

      // A duplicate would advance the same order twice and append two events —
      // the same reason advanceOrdersBulk de-duplicates its selection.
      const first = seen.get(soNumber);
      if (first !== undefined) return { ...row, error: `duplicate of row ${first}` };
      seen.set(soNumber, line);

      const captures: Record<string, unknown> = {};
      for (const c of columns) {
        if (!c.field) continue;
        const raw = at(c.header);
        if (!raw) {
          if (!c.optional) return { ...row, error: `${c.header} is required` };
          continue;
        }
        if (c.kind === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n)) return { ...row, error: `${c.header} must be a number, got "${raw}"` };
          captures[c.field] = n;
        } else if (c.kind === "date") {
          const d = parseImportDate(raw);
          if (!d) return { ...row, error: `${c.header} must be DD-MM-YYYY, got "${raw}"` };
          captures[c.field] = d;
        } else if (c.kind === "partner") {
          // The modal offers a fixed <select>; a CSV is free text, so the
          // allowed list has to be enforced here or the column becomes a
          // typo-shaped way to invent a courier.
          const p = raw.toUpperCase();
          if (!PARTNERS.has(p)) {
            return { ...row, error: `${c.header} must be one of ${LOGISTICS_PARTNERS.join(", ")} — got "${raw}"` };
          }
          captures[c.field] = p;
        } else {
          captures[c.field] = raw;
        }
      }
      return { ...row, captures: captures as Partial<Order>, note: at(NOTE_HEADER) || undefined };
    }),
  };
}

/**
 * Why an order sitting at `from` cannot take this import, or undefined if it
 * can. Read off WH_FLOW so it agrees with assertForward rather than restating
 * the ladder — an order at or past the target is a clean skip, not an error.
 */
export function stageRefusal(to: ImportTarget, from: OrderStatus): string | undefined {
  const here = WH_FLOW.indexOf(from);
  const there = WH_FLOW.indexOf(to);
  if (here >= 0 && here >= there) return "already advanced";
  return from === SOURCE_STAGE[to] ? undefined : `not at expected stage (at ${from})`;
}
