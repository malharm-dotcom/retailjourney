// Control Tower (and any route without its own loading.tsx): the shell paints
// at once and the page streams in, instead of a blank wait on the server.
import { PageHeadSkeleton, StatStripSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      <StatStripSkeleton items={4} />
      <TableSkeleton rows={6} />
    </>
  );
}
