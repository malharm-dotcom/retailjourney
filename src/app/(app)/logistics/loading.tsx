import { FilterBarSkeleton, PageHeadSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      {/* Six stage chips, then search + three facet selects + the date window. */}
      <FilterBarSkeleton chips={6} controls={4} />
      <TableSkeleton rows={9} rowHeight={76} />
    </>
  );
}
