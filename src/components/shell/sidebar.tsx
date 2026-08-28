"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/ui";

/** Where the rail's collapsed state is remembered. Read by the pre-paint
 *  script in app/layout.tsx — keep the two in step. */
export const NAV_STORAGE_KEY = "retailjourney-nav";

/** The two work groups. Grouping keeps each list at or under Miller's four
 *  before the eye has to choose, and gives /admin a home — it was reachable only
 *  through the user dropdown and the sync strip, so nothing in the primary
 *  navigation ever mentioned it. */
const GROUPS: { heading: string; items: { href: string; label: string; icon: string; adminOnly?: boolean }[] }[] = [
  {
    heading: "The floor",
    items: [
      { href: "/", label: "Control Tower", icon: "widget-5-bold-duotone" },
      { href: "/in-transit", label: "In-Transit", icon: "delivery-bold-duotone" },
      { href: "/warehouse", label: "Warehouse", icon: "box-minimalistic-bold-duotone" },
      // Sits beside Warehouse because it is the same team's shift work list.
      // NOT under Reference next to /rulebook — that tab is the distribution
      // rulebook (per-store targets), a different thing with a colliding name.
      { href: "/daily-plan", label: "Daily Plan", icon: "clipboard-check-bold-duotone" },
      { href: "/logistics", label: "Logistics", icon: "tram-bold-duotone" },
    ],
  },
  {
    heading: "Reference",
    items: [
      { href: "/rulebook", label: "Rulebook", icon: "notebook-bold-duotone" },
      { href: "/reports", label: "Reports", icon: "chart-2-bold-duotone" },
      { href: "/admin", label: "Admin", icon: "shield-check-bold-duotone", adminOnly: true },
    ],
  },
];

function NavList({ onNavigate, isAdmin }: { onNavigate?: () => void; isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-4 px-3">
      {GROUPS.map((group) => {
        const items = group.items.filter((it) => !it.adminOnly || isAdmin);
        if (items.length === 0) return null;
        return (
          <div key={group.heading} className="flex flex-col gap-0.5">
            <h2 className="nav-heading mb-1 px-3 text-meta font-bold uppercase tracking-[0.08em] text-mute">
              {group.heading}
            </h2>
            {items.map((it) => {
              const on = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  aria-current={on ? "page" : undefined}
                  // The title is the collapsed rail's only label. It is set
                  // unconditionally rather than only when collapsed: the
                  // collapse is CSS-driven and this component never learns
                  // which state it is rendering in.
                  title={it.label}
                  className={cn(
                    "nav-item flex min-h-[42px] items-center gap-3 rounded-control px-3 py-2.5 text-ui font-semibold",
                    "transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.985]",
                    on ? "bg-sage-soft text-sage" : "text-ink-soft hover:bg-line/60 hover:text-ink",
                  )}
                >
                  <Icon name={it.icon} size={19} className={on ? "text-sage" : "text-mute"} />
                  {/* Hidden by CSS when collapsed, never unmounted — a screen
                      reader still reads the destination either way. */}
                  <span className="nav-label">{it.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center", className)} aria-label="RetailJourney — Snitch">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/snitch-wordmark.png" alt="Snitch" className="h-[22px] w-auto" />
    </Link>
  );
}

/**
 * The rail's collapse control.
 *
 * The COLLAPSE ITSELF IS PURE CSS, driven by `data-nav` on <html> which a
 * pre-paint script in app/layout.tsx stamps from localStorage. That split is
 * the whole point: reading localStorage in an effect would render the rail at
 * its full 216px and snap it shut a frame later, on every single navigation.
 *
 * React state here therefore tracks ONE thing — what this button should say —
 * and is adopted from the DOM after hydration rather than guessed during it,
 * so the server and client render the same markup. A collapsed user sees a
 * correct rail immediately and a correct button label a tick later; the
 * reverse trade (correct label, flashing rail) is the one that shows.
 */
function RailToggle() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(document.documentElement.dataset.nav === "collapsed");
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.documentElement.dataset.nav = next ? "collapsed" : "expanded";
    // Private browsing and a full quota both throw on write. Losing the
    // preference is not worth breaking the button over.
    try {
      localStorage.setItem(NAV_STORAGE_KEY, next ? "collapsed" : "expanded");
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
      title={collapsed ? "Expand navigation" : "Collapse navigation"}
      className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-control text-mute transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.97] hover:bg-line/60 hover:text-ink"
    >
      <Icon name="sidebar-minimalistic-linear" size={17} />
    </button>
  );
}

/**
 * Left navigation: a fixed rail on desktop, a slide-in drawer on phone/tablet.
 *
 * The drawer was the one overlay in the product not built on Radix, and it was
 * missing everything Radix gives away: it had no exit animation (it slid in and
 * then vanished on unmount), no focus trap, no focus restore, no scroll lock —
 * the page scrolled underneath it — and no `aria-modal`, so a screen reader
 * could walk straight out of an open drawer into the page behind. Moving it
 * onto DialogPrimitive fixes all five at once and deletes the hand-rolled
 * Escape listener, because Radix already does that too.
 */
export function Sidebar({ open, onClose, isAdmin = false }: { open: boolean; onClose: () => void; isAdmin?: boolean }) {
  return (
    <>
      {/* Desktop rail */}
      {/* The collapse is INSTANT, deliberately. This rail is a flex sibling of
          the main column, so transitioning its width relayouts the entire
          content area every frame — and the widest page behind it is the
          Warehouse table, a ~200-row CSS grid. That is roughly a dozen
          full-table reflows to decorate a button press. Transform cannot help
          here: translating the rail would leave a gap or overlay the content,
          and the whole point of collapsing is that main RECLAIMS the 152px.
          The reduced-motion block in globals.css was already flattening this
          for anyone who asked, so the instant version was shipping regardless
          — this just gives everyone the good one. */}
      <aside className="nav-rail sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-paper lg:flex">
        <div className="nav-rail-head flex h-[60px] items-center gap-2 px-6">
          <Wordmark className="nav-wordmark" />
          <RailToggle />
        </div>
        <div className="pt-2">
          <NavList isAdmin={isAdmin} />
        </div>
      </aside>

      {/* Mobile drawer */}
      <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[2px] data-[state=open]:animate-overlayIn data-[state=closed]:animate-[fade_.14s_ease-in_reverse] lg:hidden" />
          <DialogPrimitive.Content
            // Width is capped rather than fixed at 248px: at a 390px viewport a
            // fixed drawer leaves an awkward strip, and 80vw keeps the
            // dismiss-by-tapping-outside target honest at every phone size.
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex w-[min(80vw,272px)] flex-col border-r border-line bg-paper shadow-pop outline-none lg:hidden",
              "data-[state=open]:animate-drawerIn data-[state=closed]:animate-drawerOut",
            )}
            // The drawer is navigation; the links describe themselves. Passing
            // undefined explicitly opts out of Radix's description warning
            // rather than inventing prose no one needs read aloud.
            aria-describedby={undefined}
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex h-[60px] items-center justify-between px-6">
              <Wordmark />
              <DialogPrimitive.Close
                aria-label="Close menu"
                className="grid h-10 w-10 place-items-center rounded-control text-ink-soft transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.97] hover:bg-line/60"
              >
                <Icon name="close-circle-bold" size={18} />
              </DialogPrimitive.Close>
            </div>
            <div className="pt-2">
              <NavList onNavigate={onClose} isAdmin={isAdmin} />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
