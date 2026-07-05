import { cn } from "@/lib/ui";

/** Page title block — "In-transit # board" style, hash in sage. */
export function PageHead({
  title,
  hashAfterWord,
  sub,
  right,
  className,
}: {
  title: string;
  /** 1-based word index after which the sage # sits; defaults to first word. */
  hashAfterWord?: number;
  sub?: string;
  right?: React.ReactNode;
  className?: string;
}) {
  const words = title.split(" ");
  const at = Math.min(hashAfterWord ?? 1, words.length);
  const before = words.slice(0, at).join(" ");
  const after = words.slice(at).join(" ");
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4 pb-[18px] pt-[30px]", className)}>
      <div>
        <h1 className="font-display text-[28px] font-bold leading-[1.05] tracking-tight sm:text-[33px]">
          {before} <span className="text-sage">#</span>
          {after ? ` ${after}` : ""}
        </h1>
        {sub ? <div className="mt-2 text-sm text-mute">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}
