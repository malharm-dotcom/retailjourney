import Link from "next/link";
import { Icon } from "@/components/icon";
import { TONE, cn, type Tone } from "@/lib/ui";

/**
 * KPI card — the prototype's .kpi block.
 *
 * Pass `href` to make it a real destination. Without one it renders as a plain
 * figure and gets NO hover treatment: the card used to lift 3px and deepen its
 * shadow on hover while being an inert `div`, so eight cards across two routes
 * advertised a click that did nothing.
 */
export function KpiCard({
  icon,
  tone,
  label,
  value,
  sub,
  href,
  className,
}: {
  icon: string;
  /** Draws the icon tile from the status ramp, so a card and the rows it counts
   *  cannot disagree about colour the way Pickup Pending used to. */
  tone: Tone;
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-semibold text-ink-soft">
        <span className={cn("grid h-[30px] w-[30px] place-items-center rounded-control", TONE[tone].tile)}>
          <Icon name={icon} size={17} />
        </span>
        {label}
      </div>
      <div className="mono mt-3 font-display text-[30px] font-bold leading-none tracking-tight">{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-mute">{sub}</div> : null}
    </>
  );

  const shell = "block rounded-card bg-card px-5 py-[18px] shadow-card";

  return href ? (
    <Link
      href={href}
      className={cn(
        shell,
        "transition-[transform,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-lift motion-reduce:hover:translate-y-0",
        className,
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={cn(shell, className)}>{body}</div>
  );
}
