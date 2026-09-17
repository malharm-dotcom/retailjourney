"use client";

// The exports are buttons, not form posts, for the same reason the boards'
// exports are: the rows are already rendered in this page, so writing them out
// is a string join. A server round-trip would rebuild them from the query
// string and would then be capable of disagreeing with what the operator was
// looking at when they pressed it.

import { useState } from "react";
import { Icon } from "@/components/icon";
import { csvFilename, downloadCsv } from "@/lib/csv";
import {
  breachedCsv,
  breachedTsv,
  pivotCsv,
  type BreachedRow,
  type ColumnMode,
  type Pivot,
} from "@/lib/logistics-followup";

const BTN =
  "flex items-center gap-1.5 rounded-control border border-line-control bg-paper px-3.5 py-2 text-dense font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:text-sage";

export function ExportButton({ pivot, mode }: { pivot: Pivot; mode: ColumnMode }) {
  return (
    <button
      type="button"
      // `csvFilename` stamps the IST business date, not the browser's local one,
      // so a late-evening export is filed under the day the floor calls it.
      onClick={() => downloadCsv(csvFilename(`logistics-followup-${mode}`), pivotCsv(pivot))}
      className={`ml-auto ${BTN}`}
    >
      <Icon name="download-minimalistic-bold" size={14} />
      Export CSV
    </button>
  );
}

/**
 * Copy + download for the breached list.
 *
 * Copy is the primary action and deliberately so: the team's actual workflow is
 * filter → copy → paste into the mail to the courier, and a CSV download makes
 * them open Excel to do the paste they were already going to do. Tab-separated,
 * so it lands as a table in Gmail and Sheets alike.
 */
export function BreachedActions({ rows }: { rows: BreachedRow[] }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = breachedTsv(rows);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard.writeText needs a secure context; on plain http the floor
      // would otherwise get a dead button with no explanation.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ml-auto flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        disabled={rows.length === 0}
        className="flex items-center gap-1.5 rounded-control bg-ink px-4 py-2 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45"
      >
        <Icon name={copied ? "check-circle-bold" : "clipboard-list-bold-duotone"} size={14} />
        {copied ? "Copied" : `Copy ${rows.length} rows`}
      </button>
      <button
        type="button"
        onClick={() => downloadCsv(csvFilename("edd-breached"), breachedCsv(rows))}
        disabled={rows.length === 0}
        className={`${BTN} disabled:pointer-events-none disabled:opacity-45`}
      >
        <Icon name="download-minimalistic-bold" size={14} />
        CSV
      </button>
    </div>
  );
}
