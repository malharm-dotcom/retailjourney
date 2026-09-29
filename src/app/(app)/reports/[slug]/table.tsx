"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { StatusPill } from "@/components/ui/pill";
import { MultiSelect, type MultiOption } from "@/components/ui/multi-select";
import { Input } from "@/components/ui/primitives";
import { visualByLabel } from "@/lib/ui";
import type { ReportDef, ReportTableData } from "@/lib/reports";

const FIELD = "text-meta font-semibold uppercase tracking-[0.06em] text-mute sm:pt-[2px]";
const FIELD_BLOCK = "mb-1 block text-meta font-semibold uppercase tracking-[0.06em] text-mute";

export function ReportTable({
  slug,
  def,
  data,
  initial,
  options,
  showLookup,
}: {
  slug: string;
  def: Pick<ReportDef, "question" | "grain" | "dateBasis" | "filters">;
  data: ReportTableData;
  initial: { q: string; from: string; to: string; type: string[]; courier: string[]; facility: string[] };
  options: { type: MultiOption[]; courier: MultiOption[]; facility: string[] };
  showLookup: boolean;
}) {
  const has = (k: ReportDef["filters"][number]) => def.filters.includes(k);
  // Column sort, client-side: a report is one page of rows the server already
  // built, so there is nothing here a re-query would add.
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return data.rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...data.rows].sort((a, b) => {
      const va = a[sort.col];
      const vb = b[sort.col];
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va ?? "").localeCompare(String(vb ?? ""));
      return cmp * dir;
    });
  }, [data.rows, sort]);

  const exportCsv = () => {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [data.columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `retailjourney-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      {/* What this report is, before any number: the question it answers and
          what one row means. The most common misread was treating a per-leg
          or per-courier row as an order count. */}
      <div className="mb-4 grid gap-2 rounded-card bg-card px-5 py-3.5 text-dense shadow-card sm:grid-cols-[auto_1fr] sm:gap-x-6">
        <span className={FIELD}>Answers</span>
        <span className="font-semibold text-ink">{def.question}</span>
        <span className={FIELD}>Each row</span>
        <span className="text-ink-soft">{def.grain}</span>
        {def.dateBasis ? (
          <>
            <span className={FIELD}>Dates filter on</span>
            <span className="text-ink-soft">{def.dateBasis}</span>
          </>
        ) : null}
        {slug !== "order-lookup" ? (
          <>
            <span className={FIELD}>Excludes</span>
            <span className="text-ink-soft">Cancelled and unfulfillable orders — they never shipped.</span>
          </>
        ) : null}
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2.5">
        {showLookup ? (
          <label className="min-w-[240px] flex-1">
            <span className={FIELD_BLOCK}>SO · DC · LR · store</span>
            <Input name="q" defaultValue={initial.q} placeholder="Paste any identifier…" />
          </label>
        ) : null}
        {has("date") ? (
          <>
            <label>
              <span className={FIELD_BLOCK}>From</span>
              <Input type="date" name="from" defaultValue={initial.from} className="w-[150px]" />
            </label>
            <label>
              <span className={FIELD_BLOCK}>To</span>
              <Input type="date" name="to" defaultValue={initial.to} className="w-[150px]" />
            </label>
          </>
        ) : null}
        {has("facility") && options.facility.length ? (
          <div>
            <span className={FIELD_BLOCK}>Facility</span>
            <MultiSelect name="facility" options={options.facility} defaultValue={initial.facility} className="w-[190px]" />
          </div>
        ) : null}
        {has("type") ? (
          <div>
            <span className={FIELD_BLOCK}>Order type</span>
            <MultiSelect name="type" options={options.type} defaultValue={initial.type} className="w-[160px]" />
          </div>
        ) : null}
        {has("courier") ? (
          <div>
            <span className={FIELD_BLOCK}>Courier</span>
            <MultiSelect name="courier" options={options.courier} defaultValue={initial.courier} className="w-[190px]" />
          </div>
        ) : null}
        <button
          type="submit"
          className="rounded-control bg-ink px-4 py-2 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85"
        >
          Apply
        </button>
        <a
          href={`/reports/${slug}`}
          className="rounded-control px-3 py-2 text-dense font-semibold text-mute transition-colors duration-150 ease-ui hover:text-ink"
        >
          Reset
        </a>
        <button
          type="button"
          onClick={exportCsv}
          className="ml-auto flex items-center gap-1.5 rounded-control border border-line-control bg-paper px-3.5 py-2 text-dense font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:text-sage"
        >
          <Icon name="download-minimalistic-bold" size={14} />
          Export CSV
        </button>
      </form>

      <div className="overflow-hidden rounded-card bg-card shadow-card">
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                {data.columns.map((c, j) => {
                  const active = sort?.col === j;
                  return (
                    <th key={c} className="bg-paper px-4 py-3 font-semibold first:px-5">
                      <button
                        type="button"
                        onClick={() =>
                          setSort((s) =>
                            s?.col === j ? { col: j, dir: s.dir === "asc" ? "desc" : "asc" } : { col: j, dir: "asc" },
                          )
                        }
                        className="flex items-center gap-1 font-semibold uppercase tracking-[0.04em] transition-colors duration-150 ease-ui hover:text-ink"
                        aria-label={`Sort by ${c}`}
                      >
                        {c}
                        <Icon
                          name="alt-arrow-down-bold"
                          size={12}
                          className={active ? (sort!.dir === "asc" ? "rotate-180" : "") : "opacity-0"}
                          aria-hidden
                        />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={data.columns.length} className="px-6 py-12 text-center text-sm text-mute">
                    No rows for these filters.
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={i} className="border-b border-line text-dense last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper">
                    {row.map((cell, j) => {
                      // Every SLA verdict on this surface used to render as grey
                      // `text-ink-soft` — "BREACHED" and "Within SLA" indistinguishable
                      // at a glance — because a report cell is a bare string. A cell
                      // that IS a status now says so, in the same pill the boards use.
                      const visual = data.linkCol === j ? null : visualByLabel(cell);
                      return (
                        <td key={j} className="mono px-4 py-2.5 text-ink-soft first:px-5">
                          {data.linkCol === j ? (
                            <JourneyLink so={String(cell)} variant="text" />
                          ) : visual ? (
                            <StatusPill visual={visual} size="sm" />
                          ) : (
                            cell
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p aria-live="polite" className="px-1 pb-8 pt-3 text-dense text-mute">
        {data.rows.length} rows · export includes exactly what you see
      </p>
    </>
  );
}
