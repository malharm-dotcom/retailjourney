"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setFacilityScope } from "@/app/actions";
import { cn } from "@/lib/ui";
import type { Facility, FacilityScope } from "@/lib/types";

export const FACILITY_SHORT: Record<Facility, string> = {
  "SAPL-NORTH-TAURU": "North",
  "SAPL-WH1": "WH-1",
  "SAPL-WH2": "WH-2",
};

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

  return (
    <div
      className={cn("flex gap-[3px] rounded-[11px] bg-line/80 p-[3px]", pending && "opacity-60")}
      role="tablist"
      aria-label="Facility"
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={current === t.key}
          onClick={() => choose(t.key)}
          className={cn(
            "rounded-lg px-3 py-[7px] text-[12.5px] font-semibold transition-all",
            current === t.key
              ? "bg-white text-ink shadow-[0_1px_3px_rgba(35,32,25,.12)]"
              : "text-ink-soft hover:text-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
