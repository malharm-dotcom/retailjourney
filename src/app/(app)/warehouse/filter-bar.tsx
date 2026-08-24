"use client";

// The multi-facet filter bar. Every change rewrites the URL and lets the server
// component re-filter, so what you see is what you can send someone: the board
// is addressable, not just configurable.
//
// Search is debounced because it round-trips to the server now; the selects
// commit immediately, since a picker has no in-between state worth waiting on.

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { Button, Chip, Input, Select } from "@/components/ui/primitives";
import { STATUS_LABEL } from "@/lib/journey";
import { WH_STATUS_VISUAL, cn } from "@/lib/ui";
import type { OrderStatus, OrderType } from "@/lib/types";
import { AGE_BUCKETS, QUEUE_STAGES, isFiltered, paramsFromFilters, type QueueFilters } from "./filters";

const CHANNELS: { value: string; label: string }[] = [
  { value: "OWN_STORE", label: "Own store" },
  { value: "FRANCHISE_STORE", label: "Franchise" },
];

export function FilterBar({
  filters,
  stores,
  types,
  stageCounts,
  matchedTotal,
  scopeTotal,
}: {
  filters: QueueFilters;
  stores: string[];
  types: OrderType[];
  /** Per-stage totals with every OTHER facet applied, so narrowing to one
   *  stage still shows how many orders wait in the ones you left. */
  stageCounts: Record<OrderStatus, number>;
  matchedTotal: number;
  scopeTotal: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchId = useId();
  const [q, setQ] = useState(filters.q);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the box in step when the URL changes underneath (back button, a
  // shared link, the Clear button).
  useEffect(() => setQ(filters.q), [filters.q]);

  const apply = (next: Partial<QueueFilters>) => {
    router.push(`${pathname}${paramsFromFilters({ ...filters, ...next })}`, { scroll: false });
  };

  const onSearch = (value: string) => {
    setQ(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => apply({ q: value.trim() }), 300);
  };

  useEffect(() => () => void (debounce.current && clearTimeout(debounce.current)), []);

  const on = isFiltered(filters);
  // "All stages" counts what the other facets left, not the whole facility, so
  // the pills always add up to the number next to them.
  const acrossStages = QUEUE_STAGES.reduce((n, s) => n + (stageCounts[s] ?? 0), 0);

  return (
    <>
      {/* The stage quick-filter. This is what the kanban's columns became: the
          same stage separation, minus the horizontal scroll that kept three of
          the seven stages permanently off-screen. Each pill carries its count,
          so a supervisor can see where the queue is piling up before clicking. */}
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by stage">
        <Chip active={!filters.stage} onClick={() => apply({ stage: "" })}>
          All stages
          <span className="mono text-cap text-inherit opacity-70">{acrossStages}</span>
        </Chip>
        {QUEUE_STAGES.map((s) => {
          const n = stageCounts[s] ?? 0;
          const active = filters.stage === s;
          return (
            <Chip
              key={s}
              active={active}
              tone={WH_STATUS_VISUAL[s].tone}
              // An empty stage stays visible but unclickable: knowing that
              // Picking is at zero is information, and a pill that disappears
              // when it empties makes the row jump under the pointer.
              disabled={n === 0 && !active}
              onClick={() => apply({ stage: active ? "" : s })}
              className={cn(n === 0 && !active && "opacity-45")}
            >
              {STATUS_LABEL[s]}
              <span className="mono text-cap text-inherit opacity-70">{n}</span>
            </Chip>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
      <div className="flex min-w-[230px] flex-1 items-center gap-2 rounded-control border border-line-control bg-paper px-3 text-mute sm:max-w-[340px] sm:flex-none">
        <Icon name="magnifer-linear" size={15} />
        <label htmlFor={searchId} className="sr-only">
          Find an order on this board by SO, store or campaign
        </label>
        <Input
          id={searchId}
          type="search"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Find SO · store · campaign"
          className="border-0 bg-transparent px-0 py-2 focus:border-0"
        />
      </div>

      <Select
        aria-label="Filter by store"
        value={filters.store}
        onChange={(e) => apply({ store: e.target.value })}
        className="w-auto min-w-[150px] max-w-[220px]"
      >
        <option value="">All stores</option>
        {stores.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by order type"
        value={filters.type}
        onChange={(e) => apply({ type: e.target.value as OrderType | "" })}
        className="w-auto min-w-[110px]"
      >
        <option value="">All types</option>
        {types.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by channel"
        value={filters.channel}
        onChange={(e) => apply({ channel: e.target.value })}
        className="w-auto min-w-[125px]"
      >
        <option value="">Any channel</option>
        {CHANNELS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Filter by order age"
        value={filters.age}
        onChange={(e) => apply({ age: e.target.value as QueueFilters["age"] })}
        className="w-auto min-w-[115px]"
      >
        <option value="">Any age</option>
        {AGE_BUCKETS.map((b) => (
          <option key={b.key} value={b.key}>
            {b.label}
          </option>
        ))}
      </Select>

      {/* The one facet that is a verdict rather than an attribute, so it reads
          as a toggle rather than sitting inside a picker. */}
      <Chip active={filters.overdue} tone="failed" onClick={() => apply({ overdue: !filters.overdue })}>
        Handover overdue
      </Chip>

      {on ? (
        <>
          <p aria-live="polite" className="text-dense text-mute">
            <b className="font-semibold text-ink-soft">{matchedTotal}</b> of {scopeTotal} orders
          </p>
          <Button variant="ghost" onClick={() => router.push(pathname, { scroll: false })}>
            Clear
          </Button>
        </>
      ) : null}
      </div>
    </>
  );
}
