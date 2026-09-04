"use client";

// The Daily Plan's two lists, with a warehouse filter and a CSV export.
//
// Client-side ONLY because both are view state. The facility scope is already
// decided on the server from the session user's entitlements (planFacilities),
// and this can subtract from that set, never add to it — the same rule the
// Logistics queue's facet filters follow. A supervisor entitled to one
// warehouse never sees a chip for another, because the rows were never sent.

import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Button, Chip } from "@/components/ui/primitives";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import type { DailyPlan, PlanRow, PlanSection } from "@/lib/daily-plan";
import { fmtDate, fmtDateTime, isoFromIstNtz, istDateFromNtz } from "@/lib/ist";
import { cn } from "@/lib/ui";

/** Snowflake NTZ strings are IST wall clock. Convert to the true instant first
 *  (isoFromIstNtz), then format in Asia/Kolkata — never a naive +5:30 on top of
 *  a value that has already been converted. */
const ts = (v?: string) => fmtDateTime(isoFromIstNtz(v));
const day = (v?: string) => fmtDate(istDateFromNtz(v));
const text = (v?: string) => v ?? "—";

/** The emailer's rule, unchanged: a manifest stamp means it was picked up. */
function PickupChip({ pickedUp }: { pickedUp: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-r-[3px] border-l-[3px] px-2 py-0.5 text-meta font-semibold",
        pickedUp ? "border-l-deliv bg-deliv-bg text-deliv" : "border-l-breach bg-breach-bg text-breach",
      )}
      title={pickedUp ? "Manifested — picked up" : "Not manifested — action required"}
    >
      <Icon name={pickedUp ? "check-circle-bold" : "danger-triangle-bold"} size={13} />
      {pickedUp ? "Picked up" : "Pending"}
    </span>
  );
}

/** An order with no rulebook timeline — its WH processing TAT is the derived
 *  order + 2 days, not a rulebook deadline. Flagged so the floor never reads a
 *  derived date as a negotiated one. Same words the Logistics tracker uses. */
function RulebookTag({ onRulebook }: { onRulebook: boolean }) {
  return onRulebook ? null : (
    <span
      className="mt-0.5 block text-meta font-bold text-ofd"
      title="No rulebook timeline — TAT derived as order date + 2 days"
    >
      off rulebook
    </span>
  );
}

const COLS: { h: string; v: (r: PlanRow) => React.ReactNode; label?: true }[] = [
  { h: "Status", v: (r) => <PickupChip pickedUp={r.pickedUp} />, label: true },
  { h: "Order date", v: (r) => day(r.orderDate), label: true },
  {
    h: "Order",
    v: (r) => (
      <>
        {r.orderName}
        <RulebookTag onRulebook={r.onRulebook} />
      </>
    ),
    label: true,
  },
  { h: "Store", v: (r) => text(r.store), label: true },
  { h: "Warehouse", v: (r) => text(r.warehouse), label: true },
  { h: "Type", v: (r) => text(r.orderType), label: true },
  { h: "Qty", v: (r) => r.quantity ?? "—" },
  // The two deadlines, side by side and never merged: the first is the
  // warehouse's (packed + manifested by), the second the courier's
  // (collected by). Different owners, routinely different days.
  { h: "WH processing TAT", v: (r) => ts(r.whProcessingTat), label: true },
  { h: "Pickup TAT", v: (r) => ts(r.pickupTat), label: true },
  { h: "Handover date", v: (r) => day(r.handoverDate), label: true },
  { h: "Manifested", v: (r) => ts(r.manifestedAt), label: true },
  { h: "Lane", v: (r) => text(r.lane), label: true },
  { h: "AWB", v: (r) => text(r.tracking), label: true },
  { h: "Courier", v: (r) => text(r.courier), label: true },
  { h: "Final status", v: (r) => text(r.finalStatus), label: true },
];

/**
 * The export, column for column with the table above it.
 *
 * Raw values, not the screen's formatting: the NTZ deadlines go out as the IST
 * wall-clock strings Snowflake produced, because this file is opened in Excel
 * and re-sorted, and a "04 Sep 2026, 17:30" string sorts alphabetically.
 */
const CSV_COLUMNS: CsvColumn<PlanRow>[] = [
  { header: "Status", value: (r) => (r.pickedUp ? "Picked up" : "Pending") },
  { header: "Order Date", value: (r) => istDateFromNtz(r.orderDate) },
  { header: "Order", value: (r) => r.orderName },
  { header: "On Rulebook", value: (r) => (r.onRulebook ? "yes" : "no") },
  { header: "Store", value: (r) => r.store },
  { header: "Warehouse", value: (r) => r.warehouse },
  { header: "Type", value: (r) => r.orderType },
  { header: "Qty", value: (r) => r.quantity },
  { header: "WH Processing TAT", value: (r) => r.whProcessingTat },
  { header: "Pickup TAT", value: (r) => r.pickupTat },
  { header: "Handover Date", value: (r) => istDateFromNtz(r.handoverDate) },
  { header: "Manifested", value: (r) => r.manifestedAt },
  { header: "Lane", value: (r) => r.lane },
  { header: "AWB", value: (r) => r.tracking },
  { header: "Courier", value: (r) => r.courier },
  { header: "Final Status", value: (r) => r.finalStatus },
];

/** Recount a filtered section. The server's totals describe every entitled
 *  warehouse, so showing them beside a narrowed table would have the header
 *  and the rows disagree about how much work there is. */
function recount(rows: PlanRow[]): PlanSection {
  return {
    rows,
    total: rows.length,
    manifested: rows.filter((r) => r.pickedUp).length,
    pending: rows.filter((r) => !r.pickedUp).length,
    offRulebook: rows.filter((r) => !r.onRulebook).length,
  };
}

function Counts({ s }: { s: PlanSection }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-dense font-semibold">
      <span className="text-ink">{s.total.toLocaleString("en-IN")} orders</span>
      <span className="text-deliv">{s.manifested.toLocaleString("en-IN")} picked up</span>
      <span className="text-breach">{s.pending.toLocaleString("en-IN")} pending</span>
      {s.offRulebook ? (
        <span className="text-ofd" title="No rulebook timeline — TAT derived as order date + 2 days">
          {s.offRulebook.toLocaleString("en-IN")} off rulebook
        </span>
      ) : null}
    </div>
  );
}

function PlanTable({
  title,
  sub,
  s,
  empty,
  onExport,
}: {
  title: string;
  sub: string;
  s: PlanSection;
  empty: string;
  onExport: () => void;
}) {
  return (
    <section className="mb-5 overflow-hidden rounded-card bg-card shadow-card">
      <header className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-title font-bold leading-snug tracking-tight">{title}</h2>
            <p className="mt-1 text-dense leading-relaxed text-mute">{sub}</p>
          </div>
          {/* Per list, not one button for the page: these are two different
              work lists handed to two different people, and a single file
              would need a column to tell them apart. */}
          <Button variant="outline" onClick={onExport} disabled={s.rows.length === 0}>
            <Icon name="download-minimalistic-bold" size={15} aria-hidden />
            Export CSV
          </Button>
        </div>
        <Counts s={s} />
      </header>
      {/* Fifteen columns of dispatch facts, so the table scrolls inside its own
          card rather than squeezing cells past legibility — the same trade the
          Logistics grid makes. */}
      <div className="max-h-[58vh] overflow-auto">
        <table className="w-full min-w-[1400px] border-collapse text-left">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
              {COLS.map((c) => (
                <th key={c.h} className={cn("bg-paper px-4 py-3 font-semibold first:px-5", !c.label && "text-right")}>
                  {c.h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.length === 0 ? (
              <tr>
                <td colSpan={COLS.length} className="px-6 py-10 text-center text-sm text-mute">
                  {empty}
                </td>
              </tr>
            ) : (
              s.rows.map((r, i) => (
                <tr key={`${r.orderName}-${i}`} className="border-b border-line text-dense last:border-b-0">
                  {COLS.map((c) => (
                    <td
                      key={c.h}
                      className={cn(
                        "px-4 py-2.5 text-ink-soft first:px-5",
                        c.label ? "" : "mono text-right",
                        c.h === "Order" && "font-semibold text-ink",
                      )}
                    >
                      {c.v(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PlanBoard({ plan }: { plan: DailyPlan }) {
  const [wh, setWh] = useState("");

  // Facets from the rows actually present, not from the entitlement list: a
  // warehouse with no work today should not offer a chip that empties the
  // table. WAREHOUSE_NAME is populated on every spine row.
  const warehouses = useMemo(
    () =>
      [
        ...new Set([...plan.process.rows, ...plan.handover.rows].map((r) => r.warehouse).filter(Boolean) as string[]),
      ].sort(),
    [plan],
  );

  const process = useMemo(
    () => (wh ? recount(plan.process.rows.filter((r) => r.warehouse === wh)) : plan.process),
    [plan.process, wh],
  );
  const handover = useMemo(
    () => (wh ? recount(plan.handover.rows.filter((r) => r.warehouse === wh)) : plan.handover),
    [plan.handover, wh],
  );

  /** Exports what is on screen, filter included — the rows are already here,
   *  and a file that disagrees with the table it was downloaded from is worse
   *  than no file. */
  const exportSection = (name: string, s: PlanSection) =>
    downloadCsv(csvFilename(`daily-plan-${name}${wh ? `-${wh}` : ""}`), toCsv(CSV_COLUMNS, s.rows));

  return (
    <>
      {warehouses.length > 1 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by warehouse">
          <Chip active={wh === ""} onClick={() => setWh("")}>
            All warehouses
          </Chip>
          {warehouses.map((w) => (
            <Chip key={w} active={wh === w} onClick={() => setWh(w)}>
              {w}
            </Chip>
          ))}
        </div>
      ) : null}

      <PlanTable
        title="To process"
        sub="Packed and manifested before today's WH processing TAT — earliest TAT first."
        s={process}
        empty="Nothing due for processing today."
        onExport={() => exportSection("to-process", process)}
      />
      <PlanTable
        title="To handover"
        sub="Being collected by a courier today."
        s={handover}
        empty="Nothing due for handover today."
        onExport={() => exportSection("to-handover", handover)}
      />
    </>
  );
}
