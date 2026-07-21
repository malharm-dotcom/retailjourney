import { BoardSkeleton, PageHeadSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeadSkeleton />
      <BoardSkeleton />
    </>
  );
}
