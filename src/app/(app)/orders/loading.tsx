import { PageHeadSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      <TableSkeleton rows={5} />
    </>
  );
}
