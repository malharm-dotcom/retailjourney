import Link from "next/link";
import { cn } from "@/lib/ui";

/**
 * Segmented tabs that are plain links.
 *
 * One query parameter switches the view, so the state is in the URL and
 * survives a refresh, a bookmark and a shared link — and the whole control
 * works with JavaScript off. Every other filter on the page rides along in
 * `params`, so switching tab never silently clears the operator's filters.
 */
export function LinkTabs({
  items,
  active,
  name = "view",
  params,
  className,
}: {
  items: readonly { value: string; label: string }[];
  active: string;
  /** Query parameter the tabs set. */
  name?: string;
  /** Filters to carry across the switch. */
  params?: URLSearchParams;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-control bg-line/50 p-1", className)}>
      {items.map((it) => {
        const p = new URLSearchParams(params);
        p.set(name, it.value);
        const on = active === it.value;
        return (
          <Link
            key={it.value}
            href={`?${p.toString()}`}
            aria-current={on ? "page" : undefined}
            className={cn(
              "rounded-[7px] px-3.5 py-1.5 text-ui font-semibold transition-colors duration-150 ease-ui",
              on ? "bg-card text-ink shadow-card" : "text-mute hover:text-ink",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
