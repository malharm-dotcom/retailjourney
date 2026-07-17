"use client";

import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { Input, Select } from "@/components/ui/primitives";
import { LOGISTICS_PARTNERS } from "@/lib/types";
import type { ReportTableData } from "@/lib/reports";

const TYPES = ["FRESH", "RPL", "Q_COMM", "ACC", "NON_TRADING", "OTHER"];

export function ReportTable({
  slug,
  data,
  initial,
  showLookup,
}: {
  slug: string;
  data: ReportTableData;
  initial: { q: string; type: string; courier: string; from: string; to: string };
  showLookup: boolean;
}) {
  const exportCsv = () => {
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [data.columns.map(esc).join(","), ...data.rows.map((r) => r.map(esc).join(","))].join("\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `retailjourney-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2.5">
        {showLookup ? (
          <label className="min-w-[240px] flex-1">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
              SO · DC · LR · store
            </span>
            <Input name="q" defaultValue={initial.q} placeholder="Paste any identifier…" />
          </label>
        ) : null}
        <label>
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">From</span>
          <Input type="date" name="from" defaultValue={initial.from} className="w-[150px]" />
        </label>
        <label>
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">To</span>
          <Input type="date" name="to" defaultValue={initial.to} className="w-[150px]" />
        </label>
        <label>
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">Type</span>
          <Select name="type" defaultValue={initial.type} className="w-[130px]">
            <option value="">All</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">Courier</span>
          <Select name="courier" defaultValue={initial.courier} className="w-[150px]">
            <option value="">All</option>
            {LOGISTICS_PARTNERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="submit"
          className="rounded-[10px] bg-ink px-4 py-2 text-[13px] font-semibold text-paper transition-colors hover:bg-ink/85"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={exportCsv}
          className="ml-auto flex items-center gap-1.5 rounded-[10px] border border-line-strong bg-paper px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-sage hover:text-sage"
        >
          <Icon name="download-minimalistic-bold" size={14} />
          Export CSV
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl bg-card shadow-card">
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-line bg-paper text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
                {data.columns.map((c) => (
                  <th key={c} className="bg-paper px-4 py-3.5 font-semibold first:px-5">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={data.columns.length} className="px-6 py-12 text-center text-sm text-mute">
                    No rows for these filters.
                  </td>
                </tr>
              ) : (
                data.rows.map((row, i) => (
                  <tr key={i} className="border-b border-line text-[12.5px] last:border-b-0 hover:bg-[#FCFBF7]">
                    {row.map((cell, j) => (
                      <td key={j} className="mono px-4 py-2.5 text-ink-soft first:px-5">
                        {data.linkCol === j ? <JourneyLink so={String(cell)} variant="text" /> : cell}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="px-1 pb-8 pt-3 text-[12.5px] text-mute">
        {data.rows.length} rows · export includes exactly what you see
      </div>
    </>
  );
}
