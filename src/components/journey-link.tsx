// The one per-order "View journey" affordance, shared by every tab (PRD §6.5:
// any SO leads to the full timeline). Two shapes, one interaction:
//   icon  — square icon button for action clusters (Logistics, In-Transit)
//   text  — the SO itself as the link, for table cells (Reports, kanban)

import Link from "next/link";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/ui";

export function JourneyLink({
  so,
  variant = "icon",
  size = 34,
  className,
}: {
  so: string;
  variant?: "icon" | "text";
  /** Icon-variant button edge in px (34 matches the boards' action buttons). */
  size?: number;
  className?: string;
}) {
  if (variant === "text") {
    return (
      <Link
        href={`/orders/${encodeURIComponent(so)}`}
        title="View journey"
        className={cn("font-semibold text-ink transition-colors hover:text-sage", className)}
      >
        {so}
      </Link>
    );
  }
  return (
    <Link
      href={`/orders/${encodeURIComponent(so)}`}
      title="View journey"
      aria-label={`View journey for ${so}`}
      style={{ height: size, width: size }}
      className={cn(
        "grid place-items-center rounded-[10px] border border-line-strong bg-paper text-ink-soft transition-all hover:-translate-y-px hover:border-sage hover:bg-sage-soft hover:text-sage",
        className,
      )}
    >
      <Icon name="map-arrow-square-linear" size={size >= 34 ? 17 : 15} />
    </Link>
  );
}
