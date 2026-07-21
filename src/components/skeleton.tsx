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

/** The warehouse board: fixed-width lanes with a few cards each. */
export function BoardSkeleton({ lanes = 7, cards = 3 }: { lanes?: number; cards?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading board"
      className="mb-4 flex flex-col gap-2.5 overflow-hidden lg:h-[calc(100dvh-238px)] lg:flex-row lg:gap-3"
    >
      {Array.from({ length: lanes }).map((_, i) => (
        <section key={i} className="flex flex-col lg:h-full lg:w-[264px] lg:min-w-[264px] lg:flex-none">
          <div className="mb-2.5 flex items-center gap-2 rounded-xl bg-card px-3 py-2.5 shadow-card">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-3.5 w-[96px]" />
            <Skeleton className="ml-auto h-4 w-6" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: cards }).map((_, j) => (
              <div key={j} className="rounded-xl bg-card p-3 shadow-card">
                <Skeleton className="h-3.5 w-[110px]" />
                <Skeleton className="mt-2 h-3.5 w-[150px]" />
                <Skeleton className="mt-2 h-3 w-[120px]" />
                <Skeleton className="mt-3 h-[30px] w-full rounded-lg" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Generic table screen (in-transit, logistics, rulebook, reports). */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="overflow-hidden rounded-2xl bg-card shadow-card">
      <div className="flex items-center gap-3 border-b border-line bg-paper px-5 py-3.5">
        <Skeleton className="h-3.5 w-[140px]" />
        <Skeleton className="ml-auto h-3.5 w-[90px]" />
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5">
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
