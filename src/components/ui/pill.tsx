import { Icon } from "@/components/icon";
import { TONE, cn, pillOf, railOf, type StatusVisual } from "@/lib/ui";
import type { Source } from "@/lib/types";

/**
 * Status pill — a ruled tag: solid rule on the leading edge, tint behind,
 * icon + label. Never colour alone.
 *
 * The `failed` tone escalates by SHAPE, not only hue. Every pill used to be
 * the same lozenge in a different colour, so on a fast scan down a status
 * column "we have lost the day" carried exactly the same visual weight as
 * "waiting, and that is fine" — the reader had to decode hue to find the
 * problem. A breach now also gains a full hairline ring and a heavier weight,
 * so it registers as escalated before the colour is read at all. That is the
 * whole point: hue is the slowest channel to scan.
 */
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
  const escalated = visual.tone === "failed";
  return (
    // `min-w-0` + `flex-wrap`, and the nowrap lives on the PILL, not here.
    // This span used to be `whitespace-nowrap` around both children with no
    // zero floor, so in a grid track it refused to shrink and the source badge
    // spilled into the next column — on the In-Transit board "● synced" landed
    // on top of "Awaiting first scan". The pill itself still never breaks; the
    // badge drops to a second line when the track is genuinely too tight.
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-r-[3px] border-l-[3px]",
          size === "md" ? "px-2.5 py-1.5 text-cap" : "px-2 py-0.5 text-meta",
          pillOf(visual),
          // `ring-breach` rather than a dynamic ring colour: escalation is only
          // ever the failed tone, so the class stays static and Tailwind-safe.
          escalated ? "font-extrabold tracking-[0.012em] ring-1 ring-inset ring-breach" : "font-semibold",
        )}
        style={{ borderLeftColor: railOf(visual) }}
        title={TONE[visual.tone].gloss}
      >
        <Icon name={visual.icon} size={size === "md" ? 15 : 13} className="shrink-0" />
        {/* Truncates inside the pill rather than pushing the pill wider than
            its track — "Out for Delivery" is the longest label and was being
            sliced by the next column on the Logistics grid. */}
        <span className="truncate">{visual.label}</span>
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
