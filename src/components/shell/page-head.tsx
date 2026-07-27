import { cn } from "@/lib/ui";

/** Page title block. */
export function PageHead({
  title,
  sub,
  right,
  className,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    // `items-end` bottom-aligned the action against a WRAPPED subtitle rather
    // than against the title, so on narrow-desktop the button drifted down the
    // block. Baseline-ish alignment to the heading, and more space above the
    // heading than below it.
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3 pb-5 pt-8", className)}>
      <div className="min-w-0">
        <h1 className="font-display text-[27px] font-bold leading-[1.05] tracking-tight sm:text-[32px]">{title}</h1>
        {sub ? <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-mute">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
