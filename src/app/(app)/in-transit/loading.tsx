import { FilterBarSkeleton, PageHeadSkeleton, StatStripSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      <StatStripSkeleton />
      {/* Five stage chips + search + export, matching the board's own bar. */}
      <FilterBarSkeleton chips={6} />
      {/* Rows here carry three stacked lines, so they run ~96px, not 64. */}
      <TableSkeleton rows={8} rowHeight={96} />
    </>
  );
}
