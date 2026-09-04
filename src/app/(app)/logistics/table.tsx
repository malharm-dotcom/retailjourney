"use client";

// The Logistics table.
//
// This replaced a nine-column table whose Courier cell read "—" on every live
// row (it read `logisticsPartner`, which the spine never fills) and which had
// no sort, no export and no way to find a consignment by invoice or AWB — the
// three things the team's spreadsheet tracker does best.
//
// It mirrors the tracker's SHAPE, not its column count: one row per dispatch,
// dispatch-date led, tracker naming. Thirteen columns are the ones the team
// acts on; the rest of the tracker is on row-expand, and the full 50-column
// file is the order-level download on the Reports desk. Every edit — paperwork
// and stage move alike — is behind ONE ShipmentDialog.

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { ShipmentDialog } from "@/components/shipment-dialog";
import { StatusPill } from "@/components/ui/pill";
import { Button, Chip, Input, Select } from "@/components/ui/primitives";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import { addDays, fmtDate, istToday } from "@/lib/ist";
import type { OrderType, ShipmentStatus, Source } from "@/lib/types";
import { OVERALL_VISUAL, ROW_ACTION, SHIPMENT_VISUAL, TONE, cn, railOf, type Tone } from "@/lib/ui";
import type { TatStatus } from "./tat";

export interface LogisticsRow {
  so: string;
  /** Dispatch date — the transit anchor. `dispatchedDate` is NULL on every
   *  spine order, so this is the manifest (or the earliest child pickup). */
  dispatch?: string;
  invoice?: string;
  type: OrderType;
  store: string;
  facility: string;
  zone: string;
  lane?: string;
  /** `courierPartner`, falling back to the manual `logisticsPartner`. */
  courier?: string;
  self: boolean;
  /** Furthest-forward live AWB, from primaryAwb() — never a dead RTO label. */
  awb?: string;
  awbCount: number;
  /** Courier collection date (IST business date). Undefined = not collected. */
  pickup?: string;
  /** Days since collection. Undefined when `pickup` is. */
  sincePickup?: number;
  /** Primary EDD — our own promise (`idealDeliveryDate`), rulebook-derived on
   *  ~93% of dispatched orders and the spine's delivery target behind that.
   *  Labelled "Store Delivery EDD": it is the target the SLA engine's DELIVERY
   *  leg measures against, so the two carry one name. */
  edd?: string;
  eddDay?: string;
  /** The courier's own EDD (`expectedDate`), on row-expand. Labelled
   *  "Logistics Delivery EDD" — the LOGISTICS_DELIVERY leg's target. */
  courierEdd?: string;
  courierEddDay?: string;
  shipment?: ShipmentStatus;
  source: Source;
  delivered?: string;
  tat?: TatStatus;
  /** Collected on the rulebook's handover day? Undefined when unknowable. */
  perRulebook?: boolean;
  rulebookDay?: string;
  /** The SLA engine's own two delivery verdicts, named for the legs they come
   *  from (LEG_LABEL.DELIVERY / LEG_LABEL.LOGISTICS_DELIVERY). Same delivery
   *  event, two yardsticks: ours (`edd`) and the courier's (`courierEdd`). */
  storeDeliverySla?: string;
  logisticsDeliverySla?: string;
  dc?: string;
  lr?: string;
  vehicle?: string;
  eway?: string;
  boxes?: number;
  qty: number;
  city?: string;
  attempts: number;
  pod?: string;
  trackingLink?: string;
  msg?: string;
  breaching: boolean;
}

type Filter = "open" | "pending" | "transit" | "failed" | "self" | "delivered";
type Density = "comfortable" | "compact";
type SortKey = "dispatch" | "invoice" | "store" | "courier" | "pickup" | "edd";

const TAT_VISUAL: Record<TatStatus, { label: string; tone: Tone }> = {
  early: { label: "Early", tone: "done" },
  ontime: { label: "On time", tone: "done" },
  late: { label: "Late", tone: "failed" },
  pending: { label: "Pending", tone: "pending" },
};

/**
 * Columns, in render order. `key` marks the ones whose header sorts.
 *
 * EIGHT, not thirteen. The shell measures 1360px and gives the table ~1250 of
 * it; thirteen columns plus three row actions divided that into ~70px each,
 * which truncated "RPL" to "R…" and printed "25 …" for a date — a table that
 * fits but cannot be read is not better than one that scrolls. Five columns
 * are PAIRED into the cell they belong with rather than dropped: type joins
 * the store's meta line, lane joins its courier, the rulebook verdict joins
 * the pickup it is measured from, and the TAT cue joins the EDD it is measured
 * against. Every tracker fact is still on screen, in both densities.
 */
const COLUMNS: { key: SortKey | null; label: string }[] = [
  { key: "dispatch", label: "Dispatch date" },
  { key: "invoice", label: "Invoice · SO" },
  { key: "store", label: "Store · type" },
  { key: "courier", label: "Courier · lane" },
  { key: null, label: "AWB" },
  { key: "pickup", label: "Picked up" },
  { key: "edd", label: "EDD · TAT" },
  { key: null, label: "Shipment status" },
];

/**
 * One grid template shared by the header and every row, so a column and its
 * heading can never drift apart. The leading 1.75rem is the expand gutter, the
 * trailing 9rem holds three 40px row actions plus their gaps.
 *
 * Every flexible track is `minmax(0, Nfr)`, not `Nfr`. A bare `fr` has an AUTO
 * minimum: a long store name or "Dedicated Vehicle Lane" forces its track wider
 * than its share, which pushes the row past the card AND makes each row compute
 * its own widths — so the rows no longer line up with the header, which has
 * different content. A zero minimum lets a track shrink to its share and the
 * cell truncate inside it, which is why every cell below is `truncate` or
 * `whitespace-nowrap` — including the headers, whose labels used to spill into
 * the neighbouring column and overlap it.
 */
const GRID =
  "md:grid-cols-[1.75rem_minmax(0,.75fr)_minmax(0,1.3fr)_minmax(0,1.95fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,.95fr)_minmax(0,.95fr)_minmax(0,1.4fr)_9rem]";

const CELL = "min-w-0 px-1.5 py-2";

/**
 * Dispatch-date shortcuts, as OPEN-ENDED windows (a from with no to).
 *
 * Computed on click, never at module load: this file is a client component and
 * a date frozen at first render would go stale on a board left open overnight —
 * which is exactly how the Logistics queue is used.
 *
 * istToday()/addDays() operate on YYYY-MM-DD IST business dates, so nothing
 * here touches a timezone offset by hand.
 */
const DATE_PRESETS: { label: string; from: () => string }[] = [
  { label: "Today", from: () => istToday() },
  { label: "7d", from: () => addDays(istToday(), -6) },
  { label: "30d", from: () => addDays(istToday(), -29) },
];

/** Values that must never wrap into a second line inside a narrow track. */
const ONE_LINE = "block truncate whitespace-nowrap";

/** Mobile-only field label — the md+ grid has a header row, the stacked
 *  layout has none. */
function MobileLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1.5 text-cap font-semibold uppercase tracking-[0.04em] text-mute md:hidden">{children}</span>
  );
}

const statusLabel = (r: LogisticsRow) =>
  (r.shipment ? SHIPMENT_VISUAL[r.shipment] : OVERALL_VISUAL.PICKUP_PENDING).label;

/**
 * The export: the grid, plus the fields row-expand shows.
 *
 * A superset of the grid but NOT of the screen — every column here is one the
 * team can point at, either in a row or inside its expanded detail. The full
 * 50-column report stays where it was, on the Reports desk.
 */
const CSV_COLUMNS: CsvColumn<LogisticsRow>[] = [
  { header: "Dispatch Date", value: (r) => r.dispatch },
  { header: "Invoice No.", value: (r) => r.invoice },
  { header: "SO Number", value: (r) => r.so },
  { header: "Order Type", value: (r) => r.type },
  { header: "Store", value: (r) => r.store },
  { header: "Facility", value: (r) => r.facility },
  { header: "Zone", value: (r) => r.zone },
  { header: "City", value: (r) => r.city },
  { header: "Lane", value: (r) => r.lane },
  { header: "Courier Partner", value: (r) => r.courier },
  { header: "AWB", value: (r) => r.awb },
  { header: "AWB Count", value: (r) => r.awbCount },
  { header: "DC Number", value: (r) => r.dc },
  { header: "LR Number", value: (r) => r.lr },
  { header: "Vehicle No.", value: (r) => r.vehicle },
  { header: "e-Way Bill", value: (r) => r.eway },
  { header: "Picked Up", value: (r) => r.pickup },
  { header: "Picked Up Status", value: (r) => (r.pickup ? "Picked up" : "Pending") },
  { header: "Days Since Pickup", value: (r) => r.sincePickup },
  { header: "Store Delivery EDD", value: (r) => r.edd },
  { header: "Store Delivery EDD Day", value: (r) => r.eddDay },
  { header: "Logistics Delivery EDD", value: (r) => r.courierEdd },
  { header: "Logistics Delivery EDD Day", value: (r) => r.courierEddDay },
  { header: "Shipment Status", value: (r) => statusLabel(r) },
  { header: "Source", value: (r) => r.source },
  { header: "Delivered Date", value: (r) => r.delivered },
  { header: "TAT Status", value: (r) => (r.tat ? TAT_VISUAL[r.tat].label : "") },
  { header: "Store Delivery SLA", value: (r) => r.storeDeliverySla },
  { header: "Logistics Delivery SLA", value: (r) => r.logisticsDeliverySla },
  { header: "Dispatched As Per Rulebook", value: (r) => (r.perRulebook == null ? "" : r.perRulebook ? "Y" : "N") },
  { header: "Rulebook Handover Day", value: (r) => r.rulebookDay },
  { header: "Boxes", value: (r) => r.boxes },
  { header: "Qty", value: (r) => r.qty },
  { header: "Delivery Attempts", value: (r) => r.attempts },
  { header: "Latest Checkpoint", value: (r) => r.msg },
  { header: "Breaching", value: (r) => (r.breaching ? "yes" : "") },
  { header: "POD Link", value: (r) => r.pod },
];

export function LogisticsTable({ rows, canEdit }: { rows: LogisticsRow[]; canEdit: boolean }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [facility, setFacility] = useState("");
  const [type, setType] = useState("");
  const [courier, setCourier] = useState("");
  // Dispatch-date window, inclusive IST business dates. Empty = unbounded on
  // that end, so one box alone is a valid "everything since" / "everything up
  // to" filter rather than requiring both.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [density, setDensity] = useState<Density>("comfortable");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "dispatch", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const searchId = useId();
  const fromId = useId();

  // Facets come from what is actually in scope, so a picker never offers a
  // value that would return an empty table.
  const facilities = useMemo(() => [...new Set(rows.map((r) => r.facility))].sort(), [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  const couriers = useMemo(
    () => [...new Set(rows.map((r) => r.courier).filter(Boolean) as string[])].sort(),
    [rows],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const dir = sort.dir === "asc" ? 1 : -1;
    const of = (r: LogisticsRow): string =>
      sort.key === "dispatch"
        ? r.dispatch ?? ""
        : sort.key === "invoice"
          ? r.invoice ?? ""
          : sort.key === "store"
            ? r.store
            : sort.key === "courier"
              ? r.courier ?? ""
              : sort.key === "pickup"
                ? r.pickup ?? ""
                : r.edd ?? "";
    return rows
      .filter((r) => {
        if (filter === "open" && r.delivered) return false;
        // Awaiting pickup is either "no scan at all" (null) or the explicit
        // INFORECEIVED rung — an acknowledged-but-uncollected shipment must not
        // fall out of the one filter that exists to find them.
        if (filter === "pending" && ((r.shipment && r.shipment !== "INFORECEIVED") || r.delivered)) return false;
        if (
          filter === "transit" &&
          !(r.shipment === "PICKED_UP" || r.shipment === "IN_TRANSIT" || r.shipment === "OUT_FOR_DELIVERY")
        )
          return false;
        if (filter === "failed" && r.shipment !== "DELIVERY_FAILED") return false;
        if (filter === "self" && !(r.self && !r.delivered)) return false;
        if (filter === "delivered" && !r.delivered) return false;
        // Client-side narrowing only. The server already scoped this list to
        // the session's facilities; this can subtract from that, never add.
        if (facility && r.facility !== facility) return false;
        if (type && r.type !== type) return false;
        if (courier && r.courier !== courier) return false;
        // String compare is safe and correct here: both sides are YYYY-MM-DD
        // IST business dates, never timestamps, so this needs no Date parsing
        // and cannot pick up a UTC offset on the way through.
        if (from && (!r.dispatch || r.dispatch < from)) return false;
        if (to && (!r.dispatch || r.dispatch > to)) return false;
        if (
          needle &&
          ![r.invoice, r.awb, r.store, r.so, r.lr, r.dc]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(needle))
        )
          return false;
        return true;
      })
      // Blanks sort last in both directions — an undated dispatch is a data
      // gap, not the newest row on the board.
      .sort((a, b) => {
        const [x, y] = [of(a), of(b)];
        if (!x !== !y) return x ? -1 : 1;
        return x.localeCompare(y) * dir || a.so.localeCompare(b.so);
      });
  }, [rows, filter, q, facility, type, courier, from, to, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : // Dates open newest-first; names open alphabetically.
          { key, dir: key === "store" || key === "courier" || key === "invoice" ? "asc" : "desc" },
    );

  const toggleRow = (so: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(so)) next.add(so);
      return next;
    });

  /** Exports the FILTERED view, in the order on screen — the rows are already
   *  in the browser, and a server round-trip could only disagree with what the
   *  operator pressed the button on. */
  const exportCsv = () => {
    const stamped = csvFilename("logistics");
    downloadCsv(stamped, toCsv(CSV_COLUMNS, shown));
    setAnnouncement(`Exported ${shown.length} dispatches to ${stamped}`);
  };

  const filtered = Boolean(facility || type || courier || from || to || q.trim());

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by stage">
        <Chip active={filter === "open"} onClick={() => setFilter("open")}>
          All open
        </Chip>
        <Chip active={filter === "pending"} tone="pending" onClick={() => setFilter("pending")}>
          Awaiting pickup
        </Chip>
        <Chip active={filter === "transit"} tone="motion" onClick={() => setFilter("transit")}>
          Moving
        </Chip>
        <Chip active={filter === "failed"} tone="failed" onClick={() => setFilter("failed")}>
          NDR / failed
        </Chip>
        <Chip active={filter === "self"} tone="handling" onClick={() => setFilter("self")}>
          Self-delivery (manual)
        </Chip>
        <Chip active={filter === "delivered"} tone="done" onClick={() => setFilter("delivered")}>
          Delivered 7d
        </Chip>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex min-w-[230px] flex-1 items-center gap-2 rounded-control border border-line-control bg-paper px-3 text-mute sm:max-w-[320px] sm:flex-none">
          <Icon name="magnifer-linear" size={15} />
          <label htmlFor={searchId} className="sr-only">
            Find a dispatch by invoice, AWB, store, SO, LR or DC
          </label>
          <Input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find invoice · AWB · store"
            className="border-0 bg-transparent px-0 py-2 focus:border-0"
          />
        </div>

        {/* Narrows within the session's scope — the server decided which
            facilities are in `rows` and this cannot widen that. */}
        {facilities.length > 1 ? (
          <Select
            aria-label="Filter by facility"
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            className="w-auto min-w-[150px]"
          >
            <option value="">All facilities</option>
            {facilities.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        ) : null}

        <Select
          aria-label="Filter by order type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="w-auto min-w-[110px]"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by courier partner"
          value={courier}
          onChange={(e) => setCourier(e.target.value)}
          className="w-auto min-w-[150px]"
        >
          <option value="">All couriers</option>
          {couriers.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, " ")}
            </option>
          ))}
        </Select>

        {/* Dispatch-date window. Native `type="date"` on purpose: it gives the
            floor its own locale, its own keyboard and a real picker on a phone,
            which no bundled calendar component matches. */}
        <div className="flex items-center gap-1.5">
          <label htmlFor={fromId} className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">
            Dispatched
          </label>
          <Input
            id={fromId}
            type="date"
            aria-label="Dispatched on or after"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="w-auto py-1.5"
          />
          <span className="text-cap text-mute">to</span>
          <Input
            type="date"
            aria-label="Dispatched on or before"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="w-auto py-1.5"
          />
        </div>

        {/* The three windows the floor actually asks for, so the common case is
            one tap rather than two date pickers. */}
        {DATE_PRESETS.map((p) => (
          <Chip
            key={p.label}
            active={Boolean(from) && from === p.from() && to === ""}
            onClick={() => {
              setFrom(p.from());
              setTo("");
            }}
          >
            {p.label}
          </Chip>
        ))}

        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setFacility("");
              setType("");
              setCourier("");
              setFrom("");
              setTo("");
              setQ("");
            }}
          >
            Clear
          </Button>
        ) : null}

        <Button variant="outline" onClick={exportCsv} disabled={shown.length === 0} className="ml-auto">
          <Icon name="download-minimalistic-bold" size={15} aria-hidden />
          Export CSV
        </Button>

        {/* Density. A dispatcher chasing one consignment wants the whole row;
            a lead sweeping the day's dispatches wants twice as many on screen. */}
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
          <div className={CELL} />
          {COLUMNS.map((c) => {
            const active = sort.key === c.key;
            return (
              <div key={c.label} className={cn(CELL, "overflow-hidden")}>
                {c.key ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key!)}
                    aria-label={`Sort by ${c.label}`}
                    className={cn(
                      "flex max-w-full items-center gap-1 uppercase tracking-[0.04em] transition-colors duration-150 ease-ui hover:text-ink",
                      active && "text-ink",
                    )}
                  >
                    {/* Wraps rather than ellipsing — "Dispatch …" tells a
                        reader nothing, and the header band is two lines tall
                        anyway. The cell's overflow-hidden keeps it inside its
                        own column either way. */}
                    <span className="break-words text-left">{c.label}</span>
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
                  <span className="block break-words">{c.label}</span>
                )}
              </div>
            );
          })}
          <div className={CELL}>
            <span className="sr-only">Row actions</span>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="rounded-b-card px-6 py-14 text-center text-sm text-mute max-md:rounded-t-card">
            Nothing here — clear the filters, or dispatch something from the Warehouse queue.
          </div>
        ) : (
          shown.map((r, i) => {
            const v = r.shipment ? SHIPMENT_VISUAL[r.shipment] : OVERALL_VISUAL.PICKUP_PENDING;
            const tat = r.tat ? TAT_VISUAL[r.tat] : null;
            const expanded = open.has(r.so);
            const isLast = i === shown.length - 1;
            return (
              <div key={r.so}>
                <div
                  className={cn(
                    // overflow-hidden is the backstop: with every track able to
                    // shrink, nothing should exceed its cell — and if something
                    // ever does, it clips instead of widening the page.
                    "rail row-skip grid grid-cols-1 overflow-hidden border-b border-line px-3 transition-colors duration-150 ease-ui hover:bg-paper md:items-center",
                    GRID,
                    density === "compact" ? "md:py-0" : "md:py-1",
                    i === 0 && "max-md:rounded-t-card",
                    isLast && !expanded && "rounded-b-card border-b-0",
                    expanded && "bg-paper",
                  )}
                  style={{ "--rail": r.breaching ? TONE.failed.hex : railOf(v), "--row-h": density === "compact" ? "56px" : "76px" } as React.CSSProperties}
                >
                  <div className={cn(CELL, "flex items-center max-md:pt-3")}>
                    <button
                      type="button"
                      onClick={() => toggleRow(r.so)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Hide" : "Show"} full tracker detail for ${r.invoice ?? r.so}`}
                      className="grid h-6 w-6 place-items-center rounded-md text-mute transition-colors duration-150 ease-ui hover:bg-line/60 hover:text-ink"
                    >
                      <Icon
                        name="alt-arrow-down-bold"
                        size={13}
                        aria-hidden
                        className={cn("transition-transform duration-150 ease-ui", expanded && "rotate-180")}
                      />
                    </button>
                  </div>

                  <div className={cn(CELL, "mono text-dense text-ink-soft")}>
                    <MobileLabel>Dispatch</MobileLabel>
                    <span className={ONE_LINE}>{fmtDate(r.dispatch)}</span>
                  </div>

                  <div className={cn(CELL, "mono")}>
                    <MobileLabel>Invoice</MobileLabel>
                    <span className={cn(ONE_LINE, "font-display text-ui font-semibold")} title={r.invoice}>
                      {r.invoice ?? "—"}
                    </span>
                    {density === "comfortable" ? (
                      <span className={cn(ONE_LINE, "text-cap text-mute")}>{r.so}</span>
                    ) : null}
                  </div>

                  {/* Store carries its type. Compact drops the facility, never
                      the type — the type is a tracker column, the facility is
                      already the toggle at the top of the page. */}
                  <div className={CELL}>
                    <MobileLabel>Store</MobileLabel>
                    <Link
                      href={`/orders/${r.so}`}
                      className={cn(ONE_LINE, "text-ui font-semibold hover:text-sage")}
                      title={r.store}
                    >
                      {r.store}
                    </Link>
                    <span className={cn(ONE_LINE, "text-cap text-mute")}>
                      {density === "comfortable" ? `${r.facility} · ` : ""}
                      {r.zone} · {r.type}
                    </span>
                  </div>

                  {/* Courier carries its lane: both answer "how does this
                      move", and the lane is the longest value on the row. */}
                  <div className={cn(CELL, "text-dense text-ink-soft")}>
                    <MobileLabel>Courier</MobileLabel>
                    <span className={ONE_LINE} title={r.courier}>
                      {(r.courier ?? "—").replace(/_/g, " ")}
                    </span>
                    <span className={cn(ONE_LINE, "text-cap text-mute")} title={r.lane}>
                      {r.lane ?? "—"}
                      {r.self ? " · manual lane" : ""}
                    </span>
                  </div>

                  <div className={cn(CELL, "mono text-dense text-ink-soft")}>
                    <MobileLabel>AWB</MobileLabel>
                    <span className={ONE_LINE} title={r.awb}>
                      {r.awb ?? "—"}
                    </span>
                    {/* Multi-AWB is by design (a split consignment, or a
                        returned original plus its replacement). The one shown
                        is the furthest-forward live child. */}
                    {r.awbCount > 1 ? (
                      <span className="font-sans text-cap text-mute">+{r.awbCount - 1} more</span>
                    ) : null}
                  </div>

                  {/* Not collected is a different fact from collected-today, so
                      it gets its own words rather than a "—" and a 0. The
                      rulebook verdict rides here because it IS this date: the
                      rulebook handover day against the day it was collected. */}
                  <div className={cn(CELL, "mono text-dense text-ink-soft")}>
                    <MobileLabel>Picked up</MobileLabel>
                    {r.pickup ? (
                      <>
                        <span className={ONE_LINE}>{fmtDate(r.pickup)}</span>
                        {r.sincePickup !== undefined && density === "comfortable" && !r.delivered ? (
                          <span
                            className={cn(
                              ONE_LINE,
                              "text-cap",
                              // Stale only matters while it is still moving.
                              r.sincePickup >= 5 ? "font-semibold text-breach" : "text-mute",
                            )}
                          >
                            {r.sincePickup}d ago
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className={cn(ONE_LINE, "font-sans text-mute")}>Pending</span>
                    )}
                    {r.perRulebook == null ? null : (
                      <span
                        className={cn(
                          ONE_LINE,
                          "font-sans text-meta font-bold",
                          r.perRulebook ? "text-deliv" : "text-breach",
                        )}
                        title={`Rulebook handover day: ${r.rulebookDay}`}
                      >
                        {r.perRulebook ? "on rulebook" : "off rulebook"}
                      </span>
                    )}
                  </div>

                  {/* EDD carries its TAT: the cue is nothing but this date read
                      against the delivery, so the two belong in one cell. */}
                  <div className={cn(CELL, "mono text-dense text-ink-soft")}>
                    <MobileLabel>EDD</MobileLabel>
                    <span className={ONE_LINE}>{fmtDate(r.edd)}</span>
                    {r.delivered && density === "comfortable" ? (
                      <span className={cn(ONE_LINE, "text-cap text-mute")}>del. {fmtDate(r.delivered)}</span>
                    ) : null}
                    {tat ? (
                      <span
                        className={cn(
                          "mt-0.5 inline-block max-w-full truncate rounded-md px-1.5 py-0.5 font-sans text-meta font-bold",
                          TONE[tat.tone].pill,
                        )}
                        title={`TAT against the Store Delivery EDD ${r.edd}`}
                      >
                        {tat.label}
                      </span>
                    ) : null}
                  </div>

                  <div className={cn(CELL, "overflow-hidden")}>
                    <MobileLabel>Status</MobileLabel>
                    {/* The synced badge is dropped here, unlike In-Transit: it
                        is ~60px on every row of a 13-column grid to say what
                        all but a handful of rows say. A MANUAL source is the
                        exception worth the width, so only that one shows. */}
                    <StatusPill
                      visual={v}
                      source={r.source === "MANUAL" ? r.source : undefined}
                      size="sm"
                      className="max-w-full"
                    />
                  </div>

                  <div className={cn(CELL, "flex items-center gap-1 max-md:pb-3 md:justify-end")}>
                    <JourneyLink so={r.so} />
                    {/* ONE control. There were two — a pencil for paperwork and
                        a van for the stage move — sitting adjacent in a dense
                        row, which meant guessing which dialog held the field
                        you wanted. Both live behind this one now. */}
                    {canEdit ? (
                      <ShipmentDialog
                        soNumber={r.so}
                        current={r.shipment}
                        self={r.self}
                        store={r.store}
                        lr={r.lr}
                        courier={r.courier}
                        awb={r.awb}
                        pickup={r.pickup}
                        paperwork={{
                          dcNumber: r.dc,
                          lrNumber: r.lr,
                          vehicleNumber: r.vehicle,
                          eWayBill: r.eway,
                          expectedDate: r.courierEdd,
                          podLink: r.pod,
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`Update shipment and dispatch paperwork for ${r.so}`}
                          className={ROW_ACTION}
                        >
                          <Icon name="delivery-bold-duotone" size={15} />
                        </button>
                      </ShipmentDialog>
                    ) : null}
                  </div>
                </div>

                {/* The rest of the tracker. Nothing is lost — it just does not
                    get to make the default grid unreadable. */}
                {expanded ? (
                  <dl
                    className={cn(
                      "grid gap-x-6 gap-y-3 border-b border-line bg-paper px-4 py-4 text-dense sm:grid-cols-3 lg:grid-cols-5",
                      isLast && "rounded-b-card border-b-0",
                    )}
                  >
                    <Detail label="SO number" value={r.so} mono />
                    <Detail label="DC · LR" value={[r.dc, r.lr].filter(Boolean).join(" · ")} mono />
                    <Detail label="Vehicle no." value={r.vehicle} mono />
                    <Detail label="e-Way bill" value={r.eway} mono />
                    <Detail label="City" value={r.city} />
                    <Detail label="Boxes · pieces" value={`${r.boxes ?? "—"} · ${r.qty}`} mono />
                    <Detail
                      label="Store Delivery EDD"
                      value={r.edd ? `${fmtDate(r.edd)} · ${r.eddDay}` : undefined}
                    />
                    <Detail
                      label="Logistics Delivery EDD"
                      value={r.courierEdd ? `${fmtDate(r.courierEdd)} · ${r.courierEddDay}` : undefined}
                    />
                    <Detail label="Store Delivery SLA" value={r.storeDeliverySla} />
                    <Detail label="Logistics Delivery SLA" value={r.logisticsDeliverySla} />
                    <Detail label="Rulebook handover day" value={r.rulebookDay} />
                    <Detail label="Delivered" value={r.delivered ? fmtDate(r.delivered) : undefined} />
                    <Detail label="Delivery attempts" value={r.attempts} />
                    <Detail label="Latest checkpoint" value={r.msg} />
                    <div>
                      <dt className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">Links</dt>
                      <dd className="mt-0.5 flex gap-3">
                        {r.pod ? (
                          <a
                            href={r.pod}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open proof of delivery for ${r.so} in a new tab`}
                            className="font-semibold text-sage hover:underline"
                          >
                            POD ↗
                          </a>
                        ) : null}
                        {r.trackingLink ? (
                          <a
                            href={r.trackingLink}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open courier tracking for ${r.so} in a new tab`}
                            className="font-semibold text-sage hover:underline"
                          >
                            Tracking ↗
                          </a>
                        ) : null}
                        {!r.pod && !r.trackingLink ? <span className="text-mute">—</span> : null}
                      </dd>
                    </div>
                  </dl>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <p aria-live="polite" className="px-1 pb-8 pt-4 text-dense text-mute">
        Showing <b className="font-semibold text-ink-soft">{shown.length}</b> of{" "}
        <b className="font-semibold text-ink-soft">{rows.length}</b> dispatches
      </p>

    </>
  );
}

/** One field inside the row-expand panel. */
function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | number;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-ink-soft", mono && "mono")}>
        {value === undefined || value === "" ? "—" : value}
      </dd>
    </div>
  );
}
