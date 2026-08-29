"use client";

// The export is a button, not a form post, for the same reason the boards'
// exports are: the pivot is already rendered in this page, so writing it out is
// a string join. A server round-trip would rebuild the matrix from the query
// string and would then be capable of disagreeing with what the operator was
// looking at when they pressed it.

import { Icon } from "@/components/icon";
import { csvFilename, downloadCsv } from "@/lib/csv";
import { pivotCsv, type ColumnMode, type Pivot } from "@/lib/logistics-followup";

export function ExportButton({ pivot, mode }: { pivot: Pivot; mode: ColumnMode }) {
  return (
    <button
      type="button"
      // `csvFilename` stamps the IST business date, not the browser's local one,
      // so a late-evening export is filed under the day the floor calls it.
      onClick={() => downloadCsv(csvFilename(`logistics-followup-${mode}`), pivotCsv(pivot))}
      className="ml-auto flex items-center gap-1.5 rounded-control border border-line-control bg-paper px-3.5 py-2 text-dense font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:text-sage"
    >
      <Icon name="download-minimalistic-bold" size={14} />
      Export CSV
    </button>
  );
}
