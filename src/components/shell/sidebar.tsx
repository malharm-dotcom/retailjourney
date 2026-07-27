"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
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
                    "flex min-h-[42px] items-center gap-3 rounded-control px-3 py-2.5 text-ui font-semibold transition-colors",
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

/** Left navigation: a fixed rail on desktop, a slide-in drawer on phone/tablet. */
export function Sidebar({ open, onClose, isAdmin = false }: { open: boolean; onClose: () => void; isAdmin?: boolean }) {
  // Close the drawer on Escape while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-overlayIn bg-ink/30 backdrop-blur-[2px]" onClick={onClose} />
          <aside className="absolute left-0 top-0 flex h-full w-[248px] animate-slideIn flex-col border-r border-line bg-paper shadow-pop">
            <div className="flex h-[60px] items-center justify-between px-6">
              <Wordmark />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="grid h-10 w-10 place-items-center rounded-control text-ink-soft hover:bg-line/60"
              >
                <Icon name="close-circle-bold" size={18} />
              </button>
            </div>
            <div className="pt-2">
              <NavList onNavigate={onClose} isAdmin={isAdmin} />
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
