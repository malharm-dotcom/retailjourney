"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setFacilityScope } from "@/app/actions";
import { FACILITY_SHORT } from "@/lib/facilities";
import { cn } from "@/lib/ui";
import type { Facility, FacilityScope } from "@/lib/types";

export function FacilitySwitcher({
  current,
  options,
  allView,
}: {
  current: FacilityScope;
  options: Facility[];
  allView: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const choose = (scope: string) =>
    startTransition(async () => {
      await setFacilityScope(scope);
      router.refresh();
    });

  const tabs: { key: string; label: string }[] = [
    ...(allView ? [{ key: "ALL", label: "All" }] : []),
    ...options.map((f) => ({ key: f, label: FACILITY_SHORT[f] })),
  ];

  if (tabs.length <= 1) return null; // locked roles don't see the switcher

  // Was role="tablist"/role="tab" with no tabpanel anywhere and no arrow-key
  // handling — announced as tabs, then no panel to reach. This control does not
  // switch views, it re-scopes the data on the page, so it is a single choice
  // from a set: a radiogroup, with the arrow keys that implies.
  const move = (from: number, delta: number) => {
    const next = (from + delta + tabs.length) % tabs.length;
    choose(tabs[next].key);
  };

  return (
    <div
      className={cn("flex gap-[3px] rounded-control bg-line/80 p-[3px]", pending && "opacity-60")}
      role="radiogroup"
      aria-label="Facility scope"
      aria-busy={pending || undefined}
    >
      {tabs.map((t, i) => {
        const on = current === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={on}
            // Only the active option is in the tab order; the arrows move within
            // the group, which is how a radiogroup is expected to behave.
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            onClick={() => choose(t.key)}
            className={cn(
              "rounded-md px-3 py-[7px] text-dense font-semibold transition-colors",
              on ? "bg-white text-ink shadow-[0_1px_3px_rgba(35,32,25,.12)]" : "text-ink-soft hover:text-ink",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
