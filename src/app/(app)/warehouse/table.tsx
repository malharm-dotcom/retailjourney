"use client";

// The Warehouse queue table.
//
// This replaced a seven-lane kanban. The lanes were the problem: only four fit
// at 1280px, so RTS Logic, Dispatched and On Hold — 187 of the 208 orders on
// this board — lived off the right-hand edge behind a horizontal scroll. Stage
// is a COLUMN VALUE here, and narrowing to one stage is a filter pill with its
// count on it, so every stage is reachable without scrolling sideways.
//
// The transitions themselves are unchanged: the same WH_TRANSITIONS map decides
// what a row may do, the same guarded actions perform it, and the bulk path
// still goes through advanceOrdersBulk with its forward-only assertForward.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { advanceOrderStatus } from "@/app/actions";
import { advanceOrdersBulk } from "@/app/bulk-actions";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { StatusPill } from "@/components/ui/pill";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import type { ImportTarget } from "@/lib/csv-import";
import { fmtDate, fmtDateTime } from "@/lib/ist";
import { REQUIRED_CAPTURES, STATUS_LABEL, WH_FLOW, WH_TRANSITIONS } from "@/lib/journey";
import { ageingBucket } from "@/lib/sla";
import { LOGISTICS_PARTNERS, type Order, type OrderStatus, type OrderType } from "@/lib/types";
import { AGE_EMPHASIS, TONE, WH_STATUS_VISUAL, cn, railOf } from "@/lib/ui";
import { BulkBar } from "./bulk-bar";
import { FilterBar } from "./filter-bar";
import { ImportDialog } from "./import-dialog";
import type { QueueFilters } from "./filters";

export interface QueueRow {
  so: string;
  store: string;
  qty: number;
  type: OrderType;
  channel?: string;
  priority?: string;
  campaign?: string;
  status: OrderStatus;
  facility: string;
  due?: "today" | "overdue";
  ageDays: number;
  /** The warehouse's own deadline — packed and manifested by this moment. The
   *  same field the Handover badge beside it is derived from, so the column and
   *  the badge can never tell different stories. ISO UTC. */
  whTatTs?: string;
  /** The day the courier collects: the pickup target, falling back to the
   *  processing day. Daily Plan's HANDOVER_DATE, same coalesce. YYYY-MM-DD. */
  handoverDate?: string;
  boxCount?: number;
  weightKg?: number;
  invoice?: string;
  /** The AWB to read off to a courier — the furthest-forward live child, picked
   *  server-side by primaryAwb(). Absent while the order is still in the WH. */
  awb?: string;
  /** Total AWBs on the order, so multi-AWB is visible without opening it. */
  awbCount: number;
  /** Spine RULEBOOK_COVERED = false: no real rulebook target, so the order runs
   *  on a fallback (eShipz EDD). It is VISIBLE — the old source hid these. */
  outOfRulebook?: boolean;
  /** The store has no row in the local Store table, so the rulebook / area
   *  manager / QC enrichment behind it is missing. The store NAME is still the
   *  spine's resolved one. Advisory badge only — the order is on this queue and
   *  fully actionable exactly like any other. */
  storeUnmapped?: boolean;
}

/** Moves that end the order. Separated in the menu and confirmed in red. */
const TERMINAL_MOVES: OrderStatus[] = ["CANCELLED", "UNFULFILLABLE"];

type Density = "comfortable" | "compact";

type SortKey = "urgency" | "so" | "store" | "stage" | "qty" | "age";

interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** Columns, in render order. `sort` marks the ones whose header is a button. */
const COLUMNS: { key: SortKey | null; label: string; align?: "right"; sortable: boolean }[] = [
  { key: "so", label: "Order", sortable: true },
  { key: "store", label: "Store · facility", sortable: true },
  { key: "stage", label: "Stage", sortable: true },
  { key: null, label: "Type", sortable: false },
  { key: "qty", label: "Qty", align: "right", sortable: true },
  { key: "age", label: "Age", align: "right", sortable: true },
  { key: null, label: "AWB", sortable: false },
  { key: "urgency", label: "Handover", sortable: true },
  { key: null, label: "WH Processing", sortable: false },
  { key: null, label: "Action", sortable: false },
];

/**
 * One grid template shared by the header and every row, so a column and its
 * heading can never drift apart. The leading 2rem is the checkbox gutter.
 *
 * The fr values are MEASURED, not chosen: each is the intrinsic width of that
 * column's widest real value (longest store name, "NON_TRADING", a 13-digit
 * AWB, the "Ready to Dispatch" pill and action button) plus the cell's own
 * padding, divided by 100. That is what paid for the WH Processing column —
 * the old split handed Store 220px for 175px of content and Action 204px for
 * 177px while starving AWB, so rebalancing bought a tenth column outright.
 * Measured at the two real shell widths (1304px with the shell at its cap,
 * 1168px on a 1440 laptop) this fits everything except the AWB's "+N more"
 * suffix — strictly less truncation than the NINE-column grid it replaces.
 *
 * Re-measure before changing a number here; they are not taste.
 */
const GRID =
  "md:grid-cols-[2rem_minmax(0,1.17fr)_minmax(0,1.91fr)_minmax(0,1.1fr)_minmax(0,1.03fr)_minmax(0,.46fr)_minmax(0,.49fr)_minmax(0,1.3fr)_minmax(0,.75fr)_minmax(0,1.06fr)_minmax(0,1.77fr)]";

/**
 * EVERY TRACK ABOVE IS minmax(0, …) AND MUST STAY THAT WAY.
 *
 * A bare `1.17fr` means `minmax(auto, 1.17fr)`, and that `auto` floor is
 * content-derived: a track can never shrink below the widest thing in it. The
 * header and each row are SEPARATE grids, so with an auto floor every row sizes
 * its own tracks from its own content — a row carrying an AWB pushed its
 * neighbours right, a row reading "No further step" pulled them left, and the
 * columns fanned out down the page. Measured drift on the old template: 1px at
 * 1168, 23px at 1032, 101px at 900, 196px at 780.
 *
 * `minmax(0, …)` removes the floor, so all eleven grids resolve to identical
 * tracks from the container width alone and content truncates instead of
 * shoving. Verified 0px drift from 780px to 1304px.
 *
 * The corollary is that every cell must be able to SHRINK — hence min-w-0 on
 * CELL below (a grid item defaults to min-width:auto and would otherwise
 * overflow its own track) and `truncate` on each cell's text.
 */
const CELL = "min-w-0 px-2 py-2.5";

/** Mobile-only field label. The md+ grid has a header row; the stacked layout
 *  has none, so a phone user would otherwise read bare values. */
function MobileLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1.5 text-cap font-semibold uppercase tracking-[0.04em] text-mute md:hidden">{children}</span>
  );
}

/** Urgency rank for sorting: overdue first, then due today, then the rest. */
const urgencyRank = (r: QueueRow) => (r.due === "overdue" ? 2 : r.due === "today" ? 1 : 0);

/**
 * The export, column for column with the table above it.
 *
 * Deliberately NOT a superset: an export that carries fields the operator
 * cannot see on screen is a second, unreviewed report. The only additions are
 * splits of things the table renders as one cell — store and facility share a
 * column, AWB carries its "+N more" as a count — so every value here is one an
 * operator can point at. Action is a control, not data, and has no column.
 */
const CSV_COLUMNS: CsvColumn<QueueRow>[] = [
  { header: "Order", value: (r) => r.so },
  { header: "Store", value: (r) => r.store },
  { header: "Facility", value: (r) => r.facility },
  { header: "Campaign", value: (r) => r.campaign },
  { header: "Stage", value: (r) => STATUS_LABEL[r.status] },
  { header: "Type", value: (r) => r.type },
  { header: "Channel", value: (r) => r.channel },
  { header: "Priority", value: (r) => (r.priority ? "HIGH" : "") },
  { header: "Qty", value: (r) => r.qty },
  { header: "Age (days)", value: (r) => r.ageDays },
  { header: "AWB", value: (r) => r.awb },
  { header: "AWB count", value: (r) => r.awbCount },
  { header: "Handover", value: (r) => (r.due === "overdue" ? "Overdue" : r.due === "today" ? "Due today" : "") },
  // The stacked column's two halves, split — same rule as Store · facility
  // above: what the table renders as one cell exports as the values it is
  // made of. The TAT keeps its full instant rather than the "17 Jul, 6:00 pm"
  // the cell shows, because a spreadsheet sorts and filters on it.
  { header: "WH Processing TAT", value: (r) => r.whTatTs },
  { header: "Handover Date", value: (r) => r.handoverDate },
  { header: "Out of rulebook", value: (r) => (r.outOfRulebook ? "yes" : "") },
];

export function QueueTable({
  rows,
  canEdit,
  terminalCount,
  filters,
  stores,
  types,
  stageCounts,
  matchedTotal,
  scopeTotal,
}: {
  rows: QueueRow[];
  canEdit: boolean;
  terminalCount: number;
  filters: QueueFilters;
  stores: string[];
  types: OrderType[];
  /** Per-stage totals with every filter EXCEPT stage applied — see page.tsx. */
  stageCounts: Record<OrderStatus, number>;
  matchedTotal: number;
  scopeTotal: number;
}) {
  const router = useRouter();
  const [move, setMove] = useState<{ row: QueueRow; to: OrderStatus } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // Row density. Comfortable keeps the second meta line (campaign, facility,
  // flags); compact drops it to a single line, so roughly twice as many orders
  // fit the viewport. Same table, same actions — just less air.
  const [density, setDensity] = useState<Density>("comfortable");
  const [sort, setSort] = useState<Sort>({ key: "urgency", dir: "desc" });
  // What just happened, for screen readers.
  const [announcement, setAnnouncement] = useState("");
  // Optimistic placement: the server has agreed but the router refresh has not
  // landed yet. For a bulk run this is applied to every order the server said
  // "ok" to, and pointedly NOT to the ones it skipped.
  const [optimistic, setOptimistic] = useState<Record<string, OrderStatus>>({});
  // Orders the server refused in a bulk run — they flash and stay selected.
  const [rejected, setRejected] = useState<Record<string, true>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  // Which template the importer opens on. Hoisted out of the dialog so the
  // bulk bar can aim it at RTS Logic without the dialog remembering a target
  // the operator picked on an earlier, unrelated trip through it.
  const [importTo, setImportTo] = useState<ImportTarget>("RTS_LOGIC");
  // Anchor for shift-click range select, as an index into the sorted list.
  const lastPicked = useRef<number | null>(null);

  // Drop an optimistic placement once the server agrees (or the order has left
  // this table entirely, e.g. cancelled). Anything else would pin a row to a
  // stale stage forever.
  useEffect(() => {
    setOptimistic((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const actual = new Map(rows.map((r) => [r.so, r.status]));
      const next: Record<string, OrderStatus> = {};
      let changed = false;
      for (const so of keys) {
        const real = actual.get(so);
        if (real === undefined || real === prev[so]) changed = true;
        else next[so] = prev[so];
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const stageOf = useCallback((r: QueueRow): OrderStatus => optimistic[r.so] ?? r.status, [optimistic]);

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: QueueRow, b: QueueRow): number => {
      switch (sort.key) {
        case "so":
          return a.so.localeCompare(b.so) * dir;
        case "store":
          return a.store.localeCompare(b.store) * dir;
        case "stage":
          return (WH_FLOW.indexOf(stageOf(a)) - WH_FLOW.indexOf(stageOf(b))) * dir;
        case "qty":
          return (a.qty - b.qty) * dir;
        case "age":
          return (a.ageDays - b.ageDays) * dir;
        default:
          return (urgencyRank(a) - urgencyRank(b)) * dir;
      }
    };
    // Age descending is the tiebreak everywhere: within equally urgent orders,
    // the one that has been sitting longest is the one to deal with first.
    return [...rows].sort((a, b) => cmp(a, b) || b.ageDays - a.ageDays || a.so.localeCompare(b.so));
  }, [rows, sort, stageOf]);

  const rowBySo = useMemo(() => new Map(rows.map((r) => [r.so, r])), [rows]);
  const selectedStatuses = useMemo(
    () =>
      [...selected]
        .map((so) => rowBySo.get(so))
        .filter(Boolean)
        .map((r) => stageOf(r!)),
    [selected, rowBySo, stageOf],
  );

  const clearSelection = () => {
    setSelected(new Set());
    lastPicked.current = null;
  };

  /** Click, or shift-click for a range in the current sort order. */
  const pick = (index: number, so: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastPicked.current !== null) {
        const [a, b] = [lastPicked.current, index].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) next.add(sorted[i].so);
      } else if (next.has(so)) {
        next.delete(so);
      } else {
        next.add(so);
      }
      return next;
    });
    lastPicked.current = index;
  };

  /** The header checkbox: "select all N shown", unchanged in meaning — shown
   *  means every row the current filters left on the table. */
  const selectAllShown = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.so))));
    lastPicked.current = null;
  };

  const requestMove = (row: QueueRow, to: OrderStatus) => {
    const fields = REQUIRED_CAPTURES[to] ?? [];
    const needsConfirm = ["ON_HOLD", "CANCELLED", "UNFULFILLABLE"].includes(to);
    if (fields.length === 0 && !needsConfirm) {
      commit(row, to, {});
      return;
    }
    // Values already on the order (captured earlier or synced) prefill the
    // dialog — in-flight orders never re-type what the floor already entered.
    const known: Record<string, string | number | undefined> = {
      boxCount: row.boxCount,
      weightKg: row.weightKg,
      saleInvoiceNumber: row.invoice,
    };
    const prefill: Record<string, string> = {};
    for (const f of fields) {
      const v = known[f.field as string];
      if (v != null && v !== "") prefill[f.field as string] = String(v);
    }
    setValues(prefill);
    setErrors({});
    setNote("");
    setMove({ row, to });
  };

  const commit = (row: QueueRow, to: OrderStatus, captures: Partial<Order>, moveNote?: string) =>
    startTransition(async () => {
      const res = await advanceOrderStatus(row.so, to, captures, moveNote);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${row.so} → ${STATUS_LABEL[to]}`);
      setMove(null);
      setAnnouncement(`${row.so} moved to ${STATUS_LABEL[to]}`);
      // Optimistic, but only after the server confirmed: the row never changes
      // stage on an unsaved change.
      setOptimistic((o) => ({ ...o, [row.so]: to }));
      router.refresh();
    });

  /** The bulk path. Selected rows change stage the moment the server answers,
   *  then reconcile: anything skipped or failed stays put and flashes. */
  const bulkAdvance = (to: OrderStatus, sharedCaptures?: Partial<Order>) => {
    const ids = [...selected];
    startTransition(async () => {
      const res = await advanceOrdersBulk({ orderIds: ids, toStatus: to, sharedCaptures });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }

      const okIds = res.results.filter((r) => r.outcome === "ok").map((r) => r.soNumber);
      const refused = res.results.filter((r) => r.outcome !== "ok");

      if (okIds.length) {
        setOptimistic((o) => ({ ...o, ...Object.fromEntries(okIds.map((so) => [so, to])) }));
      }
      if (refused.length) {
        setRejected(Object.fromEntries(refused.map((r) => [r.soNumber, true as const])));
        setTimeout(() => setRejected({}), 1200);
      }

      // One toast for the run, counts first — a per-order toast storm for a
      // forty-order dispatch is noise, not feedback.
      const parts = [`${res.advanced} moved to ${STATUS_LABEL[to]}`];
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      if (res.failed) parts.push(`${res.failed} failed`);
      const summary = parts.join(" · ");
      if (res.failed) toast.error(summary, { description: refused[0]?.reason });
      else if (res.skipped) toast(summary, { description: refused[0]?.reason });
      else toast.success(summary);

      setAnnouncement(summary);
      // Keep the refused ones selected so they can be dealt with; drop the rest.
      setSelected(new Set(refused.map((r) => r.soNumber)));
      lastPicked.current = null;
      router.refresh();
    });
  };

  const submitDialog = () => {
    if (!move) return;
    const fields = REQUIRED_CAPTURES[move.to] ?? [];
    const captures: Record<string, unknown> = {};
    // Validation reports itself AT the fields, never as a corner toast.
    const bad: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.field as string]?.trim();
      if (!raw) {
        if (!f.optional) bad[f.field as string] = "Required";
        continue;
      }
      if (f.kind === "number" && !Number.isFinite(Number(raw))) {
        bad[f.field as string] = "Numbers only";
        continue;
      }
      captures[f.field as string] = f.kind === "number" ? Number(raw) : raw;
    }
    setErrors(bad);
    if (Object.keys(bad).length > 0) return;
    commit(move.row, move.to, captures as Partial<Order>, note || undefined);
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : // Numbers and urgency open on their most interesting end (biggest
          // first); names open alphabetically.
          { key, dir: key === "so" || key === "store" || key === "stage" ? "asc" : "desc" },
    );

  const allShownSelected = rows.length > 0 && selected.size === rows.length;

  /** Export exactly what is on screen: the server-filtered rows, in the sort
   *  order currently applied, with the stage each row is actually showing —
   *  an optimistically advanced row exports the stage the operator can see,
   *  not the one the last server render had. */
  const exportCsv = () => {
    const stamped = csvFilename("warehouse-queue");
    downloadCsv(stamped, toCsv(CSV_COLUMNS, sorted.map((r) => ({ ...r, status: stageOf(r) }))));
    setAnnouncement(`Exported ${sorted.length} orders to ${stamped}`);
  };

  return (
    <>
      <FilterBar
        filters={filters}
        stores={stores}
        types={types}
        stageCounts={stageCounts}
        matchedTotal={matchedTotal}
        scopeTotal={scopeTotal}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <p className="text-dense text-mute">
          <b className="font-semibold text-ink-soft">{rows.length}</b>{" "}
          {rows.length === 1 ? "order" : "orders"}
          {selected.size ? ` · ${selected.size} selected` : ""}
        </p>

        {/* Exports the FILTERED view, not the whole queue — the button sits
            next to the count it will write, so what you get is what that
            number says. Client-side: these rows are already in the browser,
            and a server round-trip could only disagree with the screen. */}
        <Button variant="outline" onClick={exportCsv} disabled={sorted.length === 0} className="ml-auto">
          <Icon name="download-minimalistic-bold" size={15} aria-hidden />
          Export CSV
        </Button>

        {/* The per-order-detail counterpart to the bulk bar. Lives up here
            rather than in the selection bar because its first step is
            downloading a template, which needs no selection at all — though a
            selection, if there is one, pre-populates that template. */}
        {canEdit ? (
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Icon name="upload-bold" size={15} aria-hidden />
            Import CSV
          </Button>
        ) : null}

        {/* Density. A floor lead working one stage wants the whole row; a
            supervisor sweeping the queue for what is late wants twice as many
            rows on screen. Same table, two reading distances. */}
        <div
          className="flex items-center gap-[3px] rounded-control bg-line/80 p-[3px]"
          role="group"
          aria-label="Row density"
        >
          {(["comfortable", "compact"] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={density === d}
              onClick={() => setDensity(d)}
              className={cn(
                "rounded-md px-3 py-[6px] text-dense font-semibold capitalize transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.97]",
                density === d ? "bg-card text-ink shadow-[0_1px_3px_rgba(39,34,27,.12)]" : "text-ink-soft hover:text-ink",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Status changes are announced here: a corner toast plus an in-place
          re-sort gives a keyboard or screen-reader user no confirmation that
          the transition they triggered landed. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* No overflow-hidden: it would become the sticky header's containing
          block and break its offset. Corners are rounded on the header and the
          edge rows directly instead. */}
      <div className="rounded-card bg-card shadow-card">
        <div
          className={cn(
            "sticky top-[var(--bar-h)] z-10 hidden rounded-t-card border-b border-line bg-paper px-3 text-cap font-semibold uppercase tracking-[0.04em] text-mute md:grid md:items-center",
            GRID,
          )}
        >
          <div className={cn(CELL, "flex items-center")}>
            {canEdit && rows.length ? (
              <input
                type="checkbox"
                checked={allShownSelected}
                onChange={selectAllShown}
                className="h-3.5 w-3.5 shrink-0 accent-ink"
                aria-label={`Select all ${rows.length} shown`}
                title={allShownSelected ? "Deselect all" : `Select all ${rows.length} shown`}
              />
            ) : null}
          </div>
          {COLUMNS.map((c) => {
            const active = c.sortable && sort.key === c.key;
            return (
              <div key={c.label} className={cn(CELL, c.align === "right" && "text-right")}>
                {c.sortable && c.key ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key!)}
                    aria-label={`Sort by ${c.label}`}
                    className={cn(
                      "inline-flex items-center gap-1 uppercase tracking-[0.04em] transition-colors duration-150 ease-ui hover:text-ink",
                      active && "text-ink",
                    )}
                  >
                    {c.label}
                    <Icon
                      name="alt-arrow-down-bold"
                      size={11}
                      aria-hidden
                      className={cn(
                        "shrink-0 transition-[transform,opacity] duration-150 ease-ui",
                        active ? "opacity-100" : "opacity-0",
                        active && sort.dir === "asc" && "rotate-180",
                      )}
                    />
                  </button>
                ) : (
                  c.label
                )}
              </div>
            );
          })}
        </div>

        {sorted.length === 0 ? (
          <div className="rounded-b-card px-6 py-14 text-center text-sm text-mute max-md:rounded-t-card">
            No orders match — clear the filters or switch facility.
          </div>
        ) : (
          sorted.map((r, i) => {
            // The EFFECTIVE stage: an optimistically advanced row must offer
            // its new stage's transitions, not the one it came from.
            const stage = stageOf(r);
            const v = WH_STATUS_VISUAL[stage];
            const nexts = WH_TRANSITIONS[stage].filter(
              (s) => WH_FLOW.includes(s) && WH_FLOW.indexOf(s) > WH_FLOW.indexOf(stage),
            );
            const primaryNext = nexts[0];
            const others = WH_TRANSITIONS[stage].filter((s) => s !== primaryNext);
            const isSel = selected.has(r.so);
            const age = AGE_EMPHASIS[ageingBucket(r.ageDays)];
            return (
              <div
                key={r.so}
                className={cn(
                  "rail grid grid-cols-1 border-b border-line px-3 transition-colors duration-150 ease-ui last:border-b-0 hover:bg-paper md:items-center",
                  GRID,
                  density === "compact" ? "md:py-0" : "md:py-1",
                  i === 0 && "max-md:rounded-t-card",
                  i === sorted.length - 1 && "rounded-b-card",
                  isSel && "bg-paper",
                  rejected[r.so] && "animate-breachArrive",
                )}
                style={{ "--rail": r.due === "overdue" ? TONE.failed.hex : railOf(v) } as React.CSSProperties}
              >
                <div className={cn(CELL, "flex items-center max-md:pt-4")}>
                  {canEdit ? (
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={(e) => pick(i, r.so, (e.nativeEvent as MouseEvent).shiftKey)}
                      aria-label={`Select ${r.so}`}
                      className="h-4 w-4 shrink-0 accent-ink"
                    />
                  ) : null}
                </div>

                <div className={CELL}>
                  <MobileLabel>Order</MobileLabel>
                  <JourneyLink so={r.so} variant="text" className="mono block truncate font-display text-ui font-bold" />
                </div>

                <div className={CELL}>
                  <MobileLabel>Store</MobileLabel>
                  {/* One clean truncation, full name on hover. */}
                  <span className="block truncate text-ui font-semibold text-ink" title={r.store}>
                    {r.store}
                  </span>
                  {/* A FLAG, not a gate — same shape as "out of rulebook"
                      below. The order is here and fully actionable; only its
                      rulebook/AM enrichment is missing. */}
                  {r.storeUnmapped ? (
                    <span
                      className="mt-1 inline-block rounded-md bg-pending-bg px-1.5 py-0.5 text-meta font-bold text-pending"
                      title="This store has no row in the app's store list, so rulebook targets and the area manager are missing. The order is unaffected — it processes normally."
                    >
                      store unmapped
                    </span>
                  ) : null}
                  {density === "comfortable" ? (
                    <span className="block truncate text-cap text-mute" title={r.campaign}>
                      {r.facility}
                      {r.campaign ? ` · ${r.campaign}` : ""}
                    </span>
                  ) : null}
                </div>

                {/* overflow-hidden because a pill is whitespace-nowrap and
                    cannot truncate: with the track floor removed it would spill
                    into the next column rather than widen its own. Clipping is
                    the honest failure — the label stays readable from its left
                    edge, and the columns stay in line. */}
                <div className={cn(CELL, "overflow-hidden")}>
                  <MobileLabel>Stage</MobileLabel>
                  <StatusPill visual={v} size="sm" />
                </div>

                <div className={CELL}>
                  <MobileLabel>Type</MobileLabel>
                  <span className="text-ui text-ink-soft">{r.type}</span>
                  {density === "comfortable" ? (
                    <span className="block truncate text-cap text-mute">
                      {(r.channel ?? "—").replace("_", " ").toLowerCase()}
                      {r.priority ? " · high" : ""}
                    </span>
                  ) : null}
                  {/* A FLAG, not a breach: this order simply has no rulebook
                      target, so it runs on a fallback EDD. */}
                  {r.outOfRulebook ? (
                    <span
                      className="mt-1 inline-block rounded-md bg-pending-bg px-1.5 py-0.5 text-meta font-bold text-pending"
                      title="No rulebook target for this store/order type — delivery target falls back to the eShipz EDD"
                    >
                      out of rulebook
                    </span>
                  ) : null}
                </div>

                <div className={cn(CELL, "md:text-right")}>
                  <MobileLabel>Qty</MobileLabel>
                  <span className="mono block truncate text-ui text-ink-soft">{r.qty}</span>
                </div>

                {/* Age is emphasis, never a pill: it borrows the app-wide
                    ageingBucket vocabulary (2 / 5 / 9) so the table and the
                    reports cannot disagree about when an order is old. */}
                <div className={cn(CELL, "flex items-baseline gap-1.5 md:block md:text-right")}>
                  <MobileLabel>Age</MobileLabel>
                  <span className={cn("mono truncate font-display text-ui font-bold", age.className)} title={age.note}>
                    {r.ageDays}d
                  </span>
                  <span className="text-cap text-mute md:hidden"> · {age.note}</span>
                </div>

                <div className={cn(CELL, "mono")}>
                  <MobileLabel>AWB</MobileLabel>
                  {/* One truncating block, not two siblings: `truncate` is
                      overflow:hidden, which does nothing on an inline span, and
                      the count has to be inside the same box so the pair
                      ellipsises together instead of the suffix dropping onto a
                      second line. */}
                  <span className="block truncate text-ui text-ink-soft" title={r.awb}>
                    {r.awb ?? "—"}
                    {/* Multi-AWB is by design (a split consignment, or a
                        returned original plus its replacement). The one shown is
                        the furthest-forward live child; this only says there are
                        others to find inside. */}
                    {r.awbCount > 1 ? (
                      <span className="ml-1.5 font-sans text-cap text-mute">+{r.awbCount - 1} more</span>
                    ) : null}
                  </span>
                </div>

                {/* One handover column. The kanban repeated a HANDOVER OVERDUE
                    sub-banner inside every lane on top of the filter chip; the
                    verdict belongs to the order, so it is stated once, here. */}
                <div className={cn(CELL, "overflow-hidden")}>
                  <MobileLabel>Handover</MobileLabel>
                  {r.due === "overdue" ? (
                    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta font-bold", TONE.failed.pill)}>
                      <Icon name="shield-cross-bold" size={11} aria-hidden />
                      Overdue
                    </span>
                  ) : r.due === "today" ? (
                    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta font-bold", TONE.staged.pill)}>
                      <Icon name="clock-circle-bold" size={11} aria-hidden />
                      Due today
                    </span>
                  ) : (
                    <span className="text-cap text-mute">—</span>
                  )}
                </div>

                {/* The two Daily Plan deadlines, stacked. Two separate columns
                    do not fit: measured at the real shell width they squeeze
                    the action button to 39px of the 74 its label needs. Pairing
                    them is also the truer reading — one is the warehouse's
                    deadline and the other is the courier's day for the same
                    consignment, so they belong to each other. */}
                <div className={CELL}>
                  <MobileLabel>WH Processing</MobileLabel>
                  <span
                    className="mono block truncate text-ui font-semibold text-ink-soft"
                    title={r.whTatTs ? `Packed and manifested by ${fmtDateTime(r.whTatTs)} IST` : undefined}
                  >
                    {fmtDateTime(r.whTatTs)}
                  </span>
                  {/* Drops with every other second line in compact, exactly as
                      Store and Type do — same toggle, same behaviour. */}
                  {density === "comfortable" ? (
                    <span
                      className="mono block truncate text-cap text-mute"
                      title={r.handoverDate ? `Courier collects ${fmtDate(r.handoverDate)}` : undefined}
                    >
                      Handover {fmtDate(r.handoverDate)}
                    </span>
                  ) : null}
                </div>

                <div className={cn(CELL, "flex items-center gap-1.5 max-md:pb-4")}>
                  {canEdit && primaryNext ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => requestMove(r, primaryNext)}
                      // The label IS the next stage. The kanban's icon-only
                      // "..." made a supervisor guess what a row could do.
                      aria-label={`Move ${r.so} to ${STATUS_LABEL[primaryNext]}`}
                      className="flex min-h-[34px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-ink px-2 py-1.5 text-cap font-semibold text-paper transition-[transform,background-color] duration-150 ease-ui active:scale-[0.97] hover:bg-ink/85 disabled:opacity-50"
                    >
                      <span className="truncate">{STATUS_LABEL[primaryNext]}</span>
                      <Icon name="arrow-right-linear" size={13} aria-hidden className="shrink-0" />
                    </button>
                  ) : null}
                  {canEdit && others.length ? (
                    <Dropdown>
                      <DropdownTrigger asChild>
                        <button
                          type="button"
                          // Labelled, not a bare glyph — but still compact, so
                          // the primary action keeps the width it deserves.
                          className="flex min-h-[34px] shrink-0 items-center gap-1 rounded-control border border-line-control px-2 text-cap font-semibold text-ink-soft transition-[transform,border-color,color] duration-150 ease-ui active:scale-[0.97] hover:border-sage hover:text-sage"
                          aria-label={`More actions for ${r.so}`}
                        >
                          More
                          <Icon name="alt-arrow-down-bold" size={11} aria-hidden />
                        </button>
                      </DropdownTrigger>
                      <DropdownContent align="end">
                        {/* Reversals first, then a separator, then the ones
                            that END the order. */}
                        {others
                          .filter((s) => !TERMINAL_MOVES.includes(s))
                          .map((s) => (
                            <DropdownItem key={s} onSelect={() => requestMove(r, s)}>
                              <Icon name={WH_STATUS_VISUAL[s].icon} size={15} />
                              {s === "ON_HOLD" ? "Put on hold" : `Back to ${STATUS_LABEL[s]}`}
                            </DropdownItem>
                          ))}
                        <DropdownSeparator />
                        <DropdownItem asChild>
                          <Link href={`/orders/${r.so}`}>Open journey</Link>
                        </DropdownItem>
                        {others.some((s) => TERMINAL_MOVES.includes(s)) ? (
                          <>
                            <DropdownSeparator />
                            {others
                              .filter((s) => TERMINAL_MOVES.includes(s))
                              .map((s) => (
                                <DropdownItem key={s} destructive onSelect={() => requestMove(r, s)}>
                                  <Icon name={WH_STATUS_VISUAL[s].icon} size={15} />
                                  {s === "CANCELLED" ? "Cancel order" : "Mark unfulfillable"}
                                </DropdownItem>
                              ))}
                          </>
                        ) : null}
                      </DropdownContent>
                    </Dropdown>
                  ) : null}
                  {/* Dispatched and terminal rows have nowhere left to go. */}
                  {canEdit && !primaryNext && !others.length ? (
                    <span className="truncate text-cap text-mute">No further step</span>
                  ) : null}
                  {!canEdit ? (
                    <Link href={`/orders/${r.so}`} className="text-cap font-semibold text-ink-soft hover:text-sage">
                      Open journey
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="pb-24 pt-3 text-dense text-mute">
        {terminalCount} cancelled / unfulfillable orders in this scope — see Reports for the full funnel.
      </div>

      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        to={importTo}
        onToChange={setImportTo}
        selected={[...selected].map((so) => rowBySo.get(so)).filter((r): r is QueueRow => Boolean(r))}
        onImported={() => {
          clearSelection();
          router.refresh();
        }}
      />

      {canEdit ? (
        <BulkBar
          count={selected.size}
          statuses={selectedStatuses}
          pending={pending}
          onClear={clearSelection}
          onAdvance={bulkAdvance}
          onImport={() => (setImportTo("RTS_LOGIC"), setImporting(true))}
        />
      ) : null}

      <Dialog open={move !== null} onOpenChange={(o) => !o && setMove(null)}>
        {move ? (
          <DialogContent
            title={`${STATUS_LABEL[move.to]} · ${move.row.so}`}
            description={
              TERMINAL_MOVES.includes(move.to)
                ? `${move.row.store} — this ends the order. It stops moving through the journey and leaves this queue.`
                : `${move.row.store} — capture the ${STATUS_LABEL[move.to].toLowerCase()} details. Logged as a manual change.`
            }
          >
            {/* A real form: Enter submits, so a supervisor doing 200 transitions
                a shift never reaches for the mouse to finish one. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitDialog();
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                {(REQUIRED_CAPTURES[move.to] ?? []).map((f) => {
                  const key = f.field as string;
                  const err = errors[key];
                  return (
                    <div key={key} className={f.kind === "partner" ? "col-span-2" : ""}>
                      <Field label={`${f.label}${f.optional ? " (optional)" : ""}`} error={err}>
                        {f.kind === "partner" ? (
                          <Select
                            invalid={Boolean(err)}
                            value={values[key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          >
                            <option value="">Select partner…</option>
                            {LOGISTICS_PARTNERS.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            invalid={Boolean(err)}
                            type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
                            // The RTS Logic quantity is optional and defaults
                            // server-side to the ordered qty. Showing that
                            // number as the placeholder is what makes "leave it
                            // blank unless this shipped short" readable — a bare
                            // "(optional)" label reads as "we don't care".
                            // Placeholder, not prefill: a typed value is an
                            // explicit confirmation, a blank one is the default.
                            placeholder={key === "fulfilledQty" ? String(move.row.qty) : undefined}
                            value={values[key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          />
                        )}
                      </Field>
                    </div>
                  );
                })}
                <div className="col-span-2">
                  <Field label="Note (optional)">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth logging" />
                  </Field>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setMove(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={TERMINAL_MOVES.includes(move.to) ? "danger" : "primary"}
                  disabled={pending}
                >
                  {pending
                    ? "Saving…"
                    : move.to === "CANCELLED"
                      ? "Cancel this order"
                      : move.to === "UNFULFILLABLE"
                        ? "Mark unfulfillable"
                        : `Move to ${STATUS_LABEL[move.to]}`}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
