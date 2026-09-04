// Loading placeholders. These exist so a route change shows the SHAPE of what
// is coming instead of an empty screen that snaps into content — the pop-in was
// the single biggest reason the app read as sticky.
//
// The shimmer is a background animation only: no transform, so reduced-motion
// users get a plain resting block (see globals.css).

import { cn } from "@/lib/ui";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-shimmer rounded-md bg-[linear-gradient(90deg,rgba(0,0,0,.045)_25%,rgba(0,0,0,.085)_37%,rgba(0,0,0,.045)_63%)] bg-[length:400%_100%]",
        className,
      )}
    />
  );
}

/** Page title + subtitle block, matching PageHead's rhythm. */
export function PageHeadSkeleton() {
  return (
    <div className="mb-6">
      <Skeleton className="h-9 w-[280px]" />
      <Skeleton className="mt-3 h-4 w-[420px] max-w-full" />
    </div>
  );
}

/** The In-Transit board's four-figure summary strip. Without this the skeleton
 *  went straight from the heading to the table and the real content pushed the
 *  board down as it landed — the exact shift these placeholders exist to avoid. */
export function StatStripSkeleton({ items = 4 }: { items?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading summary"
      className="mb-5 grid grid-cols-2 gap-x-5 gap-y-4 rounded-card bg-card px-5 py-4 shadow-card sm:grid-cols-4 sm:gap-x-0 sm:divide-x sm:divide-line"
    >
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="sm:px-5 sm:first:pl-0 sm:last:pr-0">
          <Skeleton className="h-3 w-[92px]" />
          <Skeleton className="mt-2 h-6 w-[46px]" />
          <Skeleton className="mt-2 h-3 w-[76px]" />
        </div>
      ))}
    </div>
  );
}

/**
 * The chip + control row that sits above every one of these tables.
 *
 * No loading state included this, so each route change painted heading-then-
 * table and the real page then INSERTED a filter bar, shoving the table down by
 * ~120px. That shift is the thing these placeholders exist to prevent, and it
 * happened on every navigation.
 */
export function FilterBarSkeleton({ chips = 5, controls = 0 }: { chips?: number; controls?: number }) {
  return (
    <div aria-hidden className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        {Array.from({ length: chips }).map((_, i) => (
          <Skeleton key={i} className="h-[34px] w-[104px] rounded-full" />
        ))}
        <Skeleton className="ml-auto h-[38px] w-[132px] rounded-control" />
      </div>
      {controls > 0 ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Skeleton className="h-[38px] w-[240px] rounded-control" />
          {Array.from({ length: controls }).map((_, i) => (
            <Skeleton key={i} className="h-[38px] w-[136px] rounded-control" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Generic table screen (warehouse, in-transit, logistics, rulebook, reports).
 *
 * `rowHeight` matters: a 48px placeholder row under a 96px real row means the
 * table grows as it lands, which reads as the page still loading after it has
 * finished. Callers pass the height their rows actually render at.
 */
export function TableSkeleton({ rows = 8, rowHeight = 64 }: { rows?: number; rowHeight?: number }) {
  return (
    <div role="status" aria-label="Loading" className="overflow-hidden rounded-card bg-card shadow-card">
      <div className="flex items-center gap-3 border-b border-line bg-paper px-5 py-3.5">
        <Skeleton className="h-3.5 w-[140px]" />
        <Skeleton className="h-3.5 w-[110px]" />
        <Skeleton className="hidden h-3.5 w-[90px] sm:block" />
        <Skeleton className="ml-auto h-3.5 w-[90px]" />
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5" style={{ height: rowHeight }}>
            <Skeleton className="h-3.5 w-[110px]" />
            <Skeleton className="h-3.5 w-[170px]" />
            <Skeleton className="hidden h-3.5 w-[90px] sm:block" />
            <Skeleton className="ml-auto h-5 w-[70px] rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
