"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/ui";

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
            <h2 className="mb-1 px-3 text-meta font-bold uppercase tracking-[0.08em] text-mute">{group.heading}</h2>
            {items.map((it) => {
              const on = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={onNavigate}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex min-h-[42px] items-center gap-3 rounded-control px-3 py-2.5 text-ui font-semibold",
                    "transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.985]",
                    on ? "bg-sage-soft text-sage" : "text-ink-soft hover:bg-line/60 hover:text-ink",
                  )}
                >
                  <Icon name={it.icon} size={19} className={on ? "text-sage" : "text-mute"} />
                  {it.label}
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
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-paper lg:flex">
        <div className="flex h-[60px] items-center px-6">
          <Wordmark />
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
