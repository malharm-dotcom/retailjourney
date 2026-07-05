import { Icon } from "@/components/icon";
import { cn, type StatusVisual } from "@/lib/ui";
import type { Source } from "@/lib/types";

/** Status pill — icon + label, optional source badge. Never colour alone. */
export function StatusPill({
  visual,
  source,
  size = "md",
  className,
}: {
  visual: StatusVisual;
  source?: Source;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full font-semibold",
          size === "md" ? "px-3 py-1.5 text-xs" : "px-2 py-0.5 text-[11px]",
          visual.pill,
        )}
      >
        <Icon name={visual.icon} size={size === "md" ? 15 : 13} />
        {visual.label}
      </span>
      {source ? <SourceBadge source={source} /> : null}
    </span>
  );
}

/** ● synced (from UC/eShipz) vs ✎ manual (hand-entered / overridden). */
export function SourceBadge({ source, className }: { source: Source; className?: string }) {
  return source === "SYNCED" ? (
    <span className={cn("text-[10px] font-medium text-deliv", className)} title="Synced from API">
      ● synced
    </span>
  ) : (
    <span className={cn("text-[10px] font-medium text-ink-soft", className)} title="Entered manually">
      ✎ manual
    </span>
  );
}
