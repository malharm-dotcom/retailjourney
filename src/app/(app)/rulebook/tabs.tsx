"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Chip } from "@/components/ui/primitives";
import { WEEKDAYS, type OrderType, type RulebookEntry, type Store, type Weekday } from "@/lib/types";
import { cn } from "@/lib/ui";

const LEGS = [
  { key: "targetOrderDay", short: "O", label: "Order cutoff", color: "#5C5648", bg: "#EEEAE0" },
  { key: "targetHandoverDay", short: "H", label: "WH handover", color: "#3E5D4C", bg: "#E8EEE9" },
  { key: "targetPickupDay", short: "P", label: "Courier pickup", color: "#4C7A99", bg: "#E7EFF4" },
  { key: "targetDeliveryDay", short: "D", label: "Store delivery", color: "#3E7A5C", bg: "#E6F0EA" },
] as const;

const TYPES: OrderType[] = ["FRESH", "RPL", "OTHER"];
type Tab = "grid" | "stores" | "lanes";

export function RulebookTabs({
  stores,
  rules,
  isAdmin,
}: {
  stores: Store[];
  rules: RulebookEntry[];
  isAdmin: boolean;
}) {
  const [tab, setTab] = useState<Tab>("grid");
  const [type, setType] = useState<OrderType>("FRESH");

  const ruleOf = useMemo(() => {
    const m = new Map<string, RulebookEntry>();
    for (const r of rules) m.set(`${r.storeId}:${r.orderType}`, r);
    return m;
  }, [rules]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="flex gap-[3px] rounded-[11px] bg-line/80 p-[3px]">
          {(
            [
              ["grid", "Weekly grid"],
              ["stores", "Stores"],
              ["lanes", "Lanes & zones"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-all",
                tab === t ? "bg-white text-ink shadow-[0_1px_3px_rgba(35,32,25,.12)]" : "text-ink-soft hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "grid" ? (
          <div className="flex gap-2">
            {TYPES.map((t) => (
              <Chip key={t} active={type === t} onClick={() => setType(t)}>
                {t}
              </Chip>
            ))}
          </div>
        ) : null}
        {isAdmin ? (
          <button
            onClick={() => toast("CSV upload + inline editing land in M4", { description: "Rulebook maintenance is read-only on seed data." })}
            className="ml-auto flex items-center gap-2 rounded-[10px] border border-line-strong bg-paper px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-sage hover:text-sage"
          >
            <Icon name="upload-bold-duotone" size={15} />
            Upload CSV (monthly version)
          </button>
        ) : null}
      </div>

      {tab === "grid" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[11.5px] text-mute">
            {LEGS.map((l) => (
              <span key={l.key} className="flex items-center gap-1.5">
                <span
                  className="grid h-[18px] w-[18px] place-items-center rounded-md text-[10px] font-bold"
                  style={{ background: l.bg, color: l.color }}
                >
                  {l.short}
                </span>
                {l.label}
              </span>
            ))}
            <span className="ml-auto">cutoffs shown under the marker</span>
          </div>
          <div className="overflow-hidden rounded-2xl bg-card shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse">
                <thead>
                  <tr className="border-b border-line bg-paper text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
                    <th className="sticky left-0 z-10 bg-paper px-5 py-3.5 text-left font-semibold">Store</th>
                    {WEEKDAYS.map((d) => (
                      <th key={d} className="px-2 py-3.5 text-center font-semibold">
                        {d}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stores.map((s) => {
                    const r = ruleOf.get(`${s.id}:${type}`);
                    return (
                      <tr key={s.id} className="border-b border-line last:border-b-0 hover:bg-[#FCFBF7]">
                        <td className="sticky left-0 z-10 bg-card px-5 py-2.5">
                          <span className="block text-[12.5px] font-semibold">{s.storeName}</span>
                          <span className="block text-[10.5px] text-mute">
                            {s.zone} · {r?.laneClassification ?? "—"} · best {r?.bestTatDays ?? "—"}d
                          </span>
                        </td>
                        {WEEKDAYS.map((d) => (
                          <td key={d} className="px-2 py-2.5 text-center align-middle">
                            <div className="flex items-center justify-center gap-1">
                              {LEGS.filter((l) => (r?.[l.key] as Weekday | undefined) === d).map((l) => (
                                <span key={l.key} className="inline-flex flex-col items-center" title={l.label}>
                                  <span
                                    className="grid h-[22px] w-[22px] place-items-center rounded-md text-[10.5px] font-bold"
                                    style={{ background: l.bg, color: l.color }}
                                  >
                                    {l.short}
                                  </span>
                                  {l.key === "targetOrderDay" && r?.targetOrderCutoff ? (
                                    <span className="mt-0.5 text-[9px] text-mute">{r.targetOrderCutoff}</span>
                                  ) : l.key === "targetHandoverDay" && r?.targetHandoverCutoff ? (
                                    <span className="mt-0.5 text-[9px] text-mute">{r.targetHandoverCutoff}</span>
                                  ) : null}
                                </span>
                              ))}
                            </div>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {tab === "stores" ? (
        <div className="overflow-hidden rounded-2xl bg-card shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
                  {["Code", "Store", "City", "Zone", "Serving WH", "Area manager", "Merchandiser", "Rank", "30d sales"].map((h) => (
                    <th key={h} className="px-4 py-3.5 font-semibold first:px-5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.id} className="border-b border-line text-[12.5px] last:border-b-0 hover:bg-[#FCFBF7]">
                    <td className="mono px-5 py-3 text-mute">{s.branchCode}</td>
                    <td className="px-4 py-3 font-semibold">{s.storeName}</td>
                    <td className="px-4 py-3 text-ink-soft">{s.storeCity}</td>
                    <td className="px-4 py-3 text-ink-soft">{s.zone}</td>
                    <td className="mono px-4 py-3 text-ink-soft">{s.facility}</td>
                    <td className="px-4 py-3 text-ink-soft">{s.areaManager}</td>
                    <td className="px-4 py-3 text-ink-soft">{s.merchandiser}</td>
                    <td className="mono px-4 py-3 text-ink-soft">#{s.rank}</td>
                    <td className="mono px-4 py-3 text-ink-soft">
                      ₹{((s.sales30d ?? 0) / 100000).toFixed(1)}L
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "lanes" ? (
        <LaneView stores={stores} rules={rules} />
      ) : null}
    </>
  );
}

function LaneView({ stores, rules }: { stores: Store[]; rules: RulebookEntry[] }) {
  const lanes = useMemo(() => {
    const m = new Map<string, { stores: Set<string>; zones: Set<string>; tats: number[] }>();
    for (const r of rules) {
      const s = stores.find((x) => x.id === r.storeId);
      if (!s || !r.laneClassification) continue;
      const e = m.get(r.laneClassification) ?? { stores: new Set(), zones: new Set(), tats: [] };
      e.stores.add(s.storeName);
      e.zones.add(s.zone);
      if (r.bestTatDays != null) e.tats.push(r.bestTatDays);
      m.set(r.laneClassification, e);
    }
    return [...m.entries()].sort((a, b) => b[1].stores.size - a[1].stores.size);
  }, [stores, rules]);

  return (
    <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
      {lanes.map(([lane, e]) => (
        <section key={lane} className="rounded-2xl bg-card p-5 shadow-card">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-sage-soft text-sage">
              <Icon name="routing-3-bold-duotone" size={17} />
            </span>
            <h3 className="text-[13.5px] font-bold">{lane}</h3>
            <span className="mono ml-auto font-display text-sm font-bold text-ink-soft">
              {e.stores.size} stores
            </span>
          </div>
          <div className="mt-3 text-[12px] text-mute">
            Zones {[...e.zones].join(" · ")} · best TAT{" "}
            {e.tats.length ? `${Math.min(...e.tats)}–${Math.max(...e.tats)}d` : "—"}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[...e.stores].slice(0, 8).map((s) => (
              <span key={s} className="rounded-full bg-paper px-2.5 py-1 text-[11px] font-medium text-ink-soft">
                {s}
              </span>
            ))}
            {e.stores.size > 8 ? (
              <span className="rounded-full px-2 py-1 text-[11px] text-mute">+{e.stores.size - 8} more</span>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}
