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
    <div className={cn("flex flex-wrap items-end justify-between gap-4 pb-5 pt-8", className)}>
      <div className="min-w-0">
        <h1 className="font-display text-[27px] font-bold leading-[1.05] tracking-tight sm:text-[32px]">
          {title}
        </h1>
        {sub ? <div className="mt-2 max-w-[68ch] text-sm leading-relaxed text-mute">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}
