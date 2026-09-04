// Matches the flat queue this screen actually renders: stage chips, a filter
// row, then the table. It previously showed BoardSkeleton — a seven-lane
// kanban, from the design this table replaced — so every visit to the Warehouse
// queue painted a board and then snapped to a completely different layout.

import { FilterBarSkeleton, PageHeadSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      {/* Seven stage chips + "All stages", then search + four facet selects. */}
      <FilterBarSkeleton chips={8} controls={4} />
      <TableSkeleton rows={10} rowHeight={64} />
    </>
  );
}
