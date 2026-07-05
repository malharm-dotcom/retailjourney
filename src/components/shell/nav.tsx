"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ui";

const ITEMS = [
  { href: "/", label: "Control Tower" },
  { href: "/in-transit", label: "In-Transit" },
  { href: "/warehouse", label: "Warehouse" },
  { href: "/logistics", label: "Logistics" },
  { href: "/rulebook", label: "Rulebook" },
  { href: "/reports", label: "Reports" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="ml-1.5 hidden gap-[3px] lg:flex">
      {ITEMS.map((it) => {
        const on = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              "rounded-[9px] px-3.5 py-2 text-[13.5px] font-medium transition-colors",
              on ? "bg-ink text-white" : "text-ink-soft hover:bg-line/70",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
