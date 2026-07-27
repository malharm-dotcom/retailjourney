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
  className,
}: {
  so: string;
  variant?: "icon" | "text";
  className?: string;
}) {
  if (variant === "text") {
    return (
      <Link
        href={`/orders/${encodeURIComponent(so)}`}
        className={cn("font-semibold text-ink transition-colors hover:text-sage", className)}
      >
        {so}
      </Link>
    );
  }
  return (
    <Link
      href={`/orders/${encodeURIComponent(so)}`}
      aria-label={`View journey for ${so}`}
      // Fixed 40px, matching every other row action. The `size` prop existed so
      // the logistics table could render these at 32px, which put three separate
      // tap targets under the touch floor and made the same control two different
      // sizes on two boards.
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center rounded-control border border-line-control bg-paper text-ink-soft transition-colors hover:border-sage hover:bg-sage-soft hover:text-sage",
        className,
      )}
    >
      <Icon name="map-arrow-square-linear" size={17} />
    </Link>
  );
}
