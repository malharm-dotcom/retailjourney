import { PageHeadSkeleton, StatStripSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      <StatStripSkeleton />
      <TableSkeleton />
    </>
  );
}
