import { Icon } from "@/components/icon";
import { TONE, cn, pillOf, type StatusVisual } from "@/lib/ui";
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
          size === "md" ? "px-3 py-1.5 text-xs" : "px-2 py-0.5 text-meta",
          pillOf(visual),
        )}
        title={TONE[visual.tone].gloss}
      >
        <Icon name={visual.icon} size={size === "md" ? 15 : 13} />
        {visual.label}
      </span>
      {source ? <SourceBadge source={source} /> : null}
    </span>
  );
}

/**
 * ● synced (from UC/eShipz/Snowflake) vs ✎ manual (hand-entered / overridden).
 *
 * The glyphs are text rather than icons on purpose: at 10px a duotone icon turns
 * to mud, and these two need to be legible at a glance in a dense table. The
 * `title` is a convenience — the word beside it already carries the meaning, so
 * nothing here depends on a hover.
 */
export function SourceBadge({ source, className }: { source: Source; className?: string }) {
  return source !== "MANUAL" ? (
    <span
      className={cn("text-meta font-medium text-deliv", className)}
      title={source === "SYNCED_SNOWFLAKE" ? "Synced from Snowflake" : "Synced from API"}
    >
      ● synced
    </span>
  ) : (
    <span className={cn("text-meta font-medium text-ink-soft", className)} title="Entered manually">
      ✎ manual
    </span>
  );
}
