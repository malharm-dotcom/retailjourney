"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Chip } from "@/components/ui/primitives";
import { normStoreKey } from "@/lib/qc-tat";
import { facilityWhGroup, type RulebookOrderType, type RulebookViewRow } from "@/lib/rulebook-map";
import { WEEKDAYS, type Store, type Weekday } from "@/lib/types";
import { cn } from "@/lib/ui";

/**
 * The four rulebook legs.
 *
 * These used to be raw hex literals that re-used sage, transit-blue and deliv-green
 * — three colours with fixed STATUS meanings everywhere else in the product — as
 * leg identifiers. A reader who had learned that blue means "with the courier" then
 * met blue meaning "the pickup leg" on this screen. Legs are not statuses, so they
 * are drawn from the ink scale and separated by their initial and their position,
 * leaving the status ramp to mean one thing.
 */
const LEGS = [
  { key: "targetOrderDay", short: "O", label: "Order cutoff", cell: "bg-pending-bg text-ink-soft" },
  { key: "targetHandoverDay", short: "H", label: "WH handover", cell: "bg-line text-ink" },
  { key: "targetPickupDay", short: "P", label: "Courier pickup", cell: "bg-line-strong text-ink" },
  { key: "targetDeliveryDay", short: "D", label: "Store delivery", cell: "bg-ink text-paper" },
] as const;

// The source rulebook carries only FRESH and RPL — there is no OTHER schedule.
const TYPES: RulebookOrderType[] = ["FRESH", "RPL"];
type Tab = "timeline" | "grid" | "stores" | "lanes";

/** The four legs in the order they actually happen, paired with the cutoff the
 *  source carries for each. Only O and H have times: the rulebook's PICKUP and
 *  DELIVERY columns are bare weekdays, so those two stops legitimately show a
 *  day and nothing else rather than a missing value. */
function legsOf(r: RulebookViewRow) {
  return [
    { ...LEGS[0], day: r.targetOrderDay, time: r.targetOrderCutoff },
    { ...LEGS[1], day: r.targetHandoverDay, time: r.targetHandoverCutoff },
    { ...LEGS[2], day: r.targetPickupDay, time: undefined },
    { ...LEGS[3], day: r.targetDeliveryDay, time: undefined },
  ];
}

/** A store row paired with the rulebook line for the active order type + WH.
 *  A store served from both WHs yields two lines; a store with no rulebook row
 *  yields one line with rule=null (the coverage gap stays visible). */
interface GridLine {
  store: Store;
  rule: RulebookViewRow | null;
}

export function RulebookTabs({
  stores,
  rules,
  snapshots,
  version,
}: {
  stores: Store[];
  rules: RulebookViewRow[];
  snapshots: string[];
  version: string | null;
}) {
  // Timeline is the default read. The weekly grid answers "what happens on
  // Wednesday"; the far more common question on this screen is "what is THIS
  // store's schedule", and the grid made you reassemble that from markers
  // scattered across seven columns and two rows.
  const [tab, setTab] = useState<Tab>("timeline");
  const [type, setType] = useState<RulebookOrderType>("FRESH");

  // Rulebook rows grouped by normalized store key for the store-joined views.
  const byStoreKey = useMemo(() => {
    const m = new Map<string, RulebookViewRow[]>();
    for (const r of rules) {
      const list = m.get(r.storeKey) ?? [];
      list.push(r);
      m.set(r.storeKey, list);
    }
    return m;
  }, [rules]);

  const gridLines = useMemo<GridLine[]>(() => {
    const lines: GridLine[] = [];
    for (const store of stores) {
      const rowsForStore = (byStoreKey.get(normStoreKey(store.finalStore)) ?? []).filter(
        (r) => r.orderType === type,
      );
      if (rowsForStore.length === 0) {
        lines.push({ store, rule: null });
      } else {
        for (const rule of rowsForStore) lines.push({ store, rule });
      }
    }
    return lines;
  }, [stores, byStoreKey, type]);

  // Same join as gridLines, but kept GROUPED by store instead of flattened —
  // the two WH rows for one store belong under one heading, not adrift as two
  // near-identical rows you have to notice are the same shop.
  const timelineGroups = useMemo(
    () =>
      stores.map((store) => ({
        store,
        rules: (byStoreKey.get(normStoreKey(store.finalStore)) ?? [])
          .filter((r) => r.orderType === type)
          // Serving WH first: it is the leg that actually applies here.
          .sort((a, b) => {
            const serving = facilityWhGroup(store.facility);
            return Number(b.whGroup === serving) - Number(a.whGroup === serving);
          }),
      })),
    [stores, byStoreKey, type],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        {/* These really are view tabs — unlike the facility switcher, which looked
            identical and changes data SCOPE. Same visual idiom for two different
            jobs was a genuine confusion, so this one is labelled as a view. */}
        <div
          role="tablist"
          aria-label="Rulebook view"
          className="flex gap-[3px] rounded-control bg-line/80 p-[3px]"
        >
          {(
            [
              ["timeline", "Timeline"],
              ["grid", "Weekly grid"],
              ["stores", "Stores"],
              ["lanes", "Lanes & zones"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`rulebook-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="rulebook-panel"
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-3.5 py-[7px] text-dense font-semibold transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.97]",
                // `bg-card`, not raw white: the card surface is warm now, so a
                // pure-white active tab read as a hole punched in the page. The
                // shadow follows the new ink value for the same reason.
                tab === t ? "bg-card text-ink shadow-[0_1px_3px_rgba(39,34,27,.12)]" : "text-ink-soft hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "grid" || tab === "timeline" ? (
          <div className="flex gap-2">
            {TYPES.map((t) => (
              <Chip key={t} active={type === t} onClick={() => setType(t)}>
                {t}
              </Chip>
            ))}
          </div>
        ) : null}
        <VersionSelector snapshots={snapshots} version={version} />
      </div>

      {/* No `key` and no fade. The key forced a full remount of a table that
          can run to hundreds of rows on every tab click, and the fade made you
          wait 180ms to read it — on a reference screen whose whole job is
          looking something up. Switching is now instant. */}
      <div id="rulebook-panel" role="tabpanel" aria-labelledby={`rulebook-tab-${tab}`}>
      {tab === "timeline" ? <TimelineView groups={timelineGroups} type={type} /> : null}

      {tab === "grid" ? (
        <>
          {/* The legend is sticky. It used to sit above a table that runs to
              hundreds of rows, so by the time you were reading O / H / P / D you
              had scrolled the only thing that explained them off the screen. */}
          <div className="sticky top-[var(--bar-h)] z-20 -mx-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-control bg-ground/95 px-1 py-2 text-cap text-mute backdrop-blur">
            {LEGS.map((l) => (
              <span key={l.key} className="flex items-center gap-1.5">
                <span className={cn("grid h-[18px] w-[18px] place-items-center rounded-md text-meta font-bold", l.cell)}>
                  {l.short}
                </span>
                {l.label}
              </span>
            ))}
            <span className="sm:ml-auto">cutoffs shown under the marker</span>
          </div>
          <div className="overflow-hidden rounded-card bg-card shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse">
                <thead>
                  <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                    <th className="sticky left-0 z-10 bg-paper px-5 py-3.5 text-left font-semibold">Store</th>
                    {WEEKDAYS.map((d) => (
                      <th key={d} className="px-2 py-3.5 text-center font-semibold">
                        {d}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {gridLines.map(({ store: s, rule: r }, i) => (
                    <tr
                      key={`${s.id}:${r?.wh ?? "none"}:${i}`}
                      className="border-b border-line last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper"
                    >
                      <td className="sticky left-0 z-10 bg-card px-5 py-2.5">
                        <span className="block text-dense font-semibold">{s.storeName}</span>
                        <span className="block text-meta text-mute">
                          {r
                            ? `${r.wh || "—"} · ${r.zone ?? s.zone} · ${r.laneClassification ?? "—"} · best ${r.bestTatDays ?? "—"}d`
                            : "no rulebook row"}
                        </span>
                      </td>
                      {WEEKDAYS.map((d) => (
                        <td key={d} className="px-2 py-2.5 text-center align-middle">
                          <div className="flex items-center justify-center gap-1">
                            {LEGS.filter((l) => (r?.[l.key] as Weekday | undefined) === d).map((l) => (
                              <span key={l.key} className="inline-flex flex-col items-center">
                                <span
                                  className={cn(
                                    "grid h-[22px] w-[22px] place-items-center rounded-md text-meta font-bold",
                                    l.cell,
                                  )}
                                >
                                  {/* The letter is decoration once the real label
                                      is available to assistive tech: the meaning
                                      used to live only in a `title` attribute. */}
                                  <span aria-hidden>{l.short}</span>
                                  <span className="sr-only">
                                    {l.label} on {d}
                                  </span>
                                </span>
                                {l.key === "targetOrderDay" && r?.targetOrderCutoff ? (
                                  <span className="mt-0.5 text-meta text-mute">{r.targetOrderCutoff}</span>
                                ) : l.key === "targetHandoverDay" && r?.targetHandoverCutoff ? (
                                  <span className="mt-0.5 text-meta text-mute">{r.targetHandoverCutoff}</span>
                                ) : null}
                              </span>
                            ))}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {tab === "stores" ? (
        <div className="overflow-hidden rounded-card bg-card shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                  {["Code", "Store", "City", "Zone", "Rulebook WH", "Serving WH", "Area manager", "Merchandiser", "Rank", "30d sales", "Orders"].map((h) => (
                    <th key={h} className="px-4 py-3.5 font-semibold first:px-5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => {
                  const rbWhs = [
                    ...new Set(
                      (byStoreKey.get(normStoreKey(s.finalStore)) ?? []).map((r) => r.wh).filter(Boolean),
                    ),
                  ];
                  return (
                    <tr key={s.id} className="border-b border-line text-dense last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper">
                      <td className="mono px-5 py-3 text-mute">{s.branchCode}</td>
                      <td className="px-4 py-3 font-semibold">{s.storeName}</td>
                      <td className="px-4 py-3 text-ink-soft">{s.storeCity}</td>
                      <td className="px-4 py-3 text-ink-soft">{s.zone}</td>
                      <td className="px-4 py-3 text-ink-soft">{rbWhs.length ? rbWhs.join(" / ") : "—"}</td>
                      <td className="mono px-4 py-3 text-ink-soft">{s.facility}</td>
                      <td className="px-4 py-3 text-ink-soft">{s.areaManager}</td>
                      <td className="px-4 py-3 text-ink-soft">{s.merchandiser}</td>
                      <td className="mono px-4 py-3 text-ink-soft">#{s.rank}</td>
                      <td className="mono px-4 py-3 text-ink-soft">
                        ₹{((s.sales30d ?? 0) / 100000).toFixed(1)}L
                      </td>
                      <td className="px-4 py-3">
                        {/* Rulebook rows are stores, not orders — the journey
                            affordance lives one hop away on this store's order
                            list, where every row carries the shared link. */}
                        <Link
                          href={`/reports/order-lookup?q=${encodeURIComponent(s.finalStore)}`}
                          title={`Order journeys for ${s.storeName}`}
                          className="text-dense font-semibold text-sage hover:underline"
                        >
                          Journeys →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "lanes" ? <LaneView rules={rules} /> : null}
      </div>
    </>
  );
}

/** One stop on a store's chain: the leg badge, the day it lands on, and the
 *  cutoff time where the source carries one. Fixed width so the four stops line
 *  up column-for-column between a store's North and South rows — comparing the
 *  two legs is most of why both are on screen. */
function Stop({
  leg,
  day,
  time,
}: {
  leg: (typeof LEGS)[number];
  day?: Weekday;
  time?: string;
}) {
  return (
    <div className="flex w-[104px] shrink-0 items-start gap-2">
      <span
        aria-hidden
        className={cn("mt-px grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-meta font-bold", leg.cell)}
      >
        {leg.short}
      </span>
      <span className="min-w-0">
        <span className="block text-dense font-semibold text-ink">
          {day ?? <span className="font-normal text-mute">—</span>}
          <span className="sr-only"> — {leg.label}</span>
        </span>
        {time ? <span className="mono block text-meta text-mute">{time}</span> : null}
      </span>
    </div>
  );
}

/** The O → H → P → D chain for ONE store × WH, read left to right. */
function Chain({ rule }: { rule: RulebookViewRow }) {
  const legs = legsOf(rule);
  return (
    <div className="flex flex-wrap items-start gap-y-3">
      {legs.map((l, i) => (
        <div key={l.key} className="flex items-start">
          {i > 0 ? (
            <span aria-hidden className="mx-2 mt-[11px] h-px w-6 shrink-0 bg-line-strong sm:w-10" />
          ) : null}
          <Stop leg={l} day={l.day} time={l.time} />
        </div>
      ))}
    </div>
  );
}

/**
 * Per-store timeline — the readable answer to "what is this store's schedule".
 *
 * The weekly grid put four markers somewhere across seven columns and made the
 * reader reassemble the sequence; here the sequence IS the layout, always in
 * the same four positions, with the cutoff under the stop it belongs to.
 */
function TimelineView({
  groups,
  type,
}: {
  groups: { store: Store; rules: RulebookViewRow[] }[];
  type: RulebookOrderType;
}) {
  const covered = groups.filter((g) => g.rules.length > 0).length;

  return (
    <div className="overflow-hidden rounded-card bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-paper px-5 py-3 text-cap text-mute">
        {LEGS.map((l) => (
          <span key={l.key} className="flex items-center gap-1.5">
            <span className={cn("grid h-[18px] w-[18px] place-items-center rounded-md text-meta font-bold", l.cell)}>
              {l.short}
            </span>
            {l.label}
          </span>
        ))}
        <span className="sm:ml-auto">
          {covered} of {groups.length} stores carry a {type} rulebook row
        </span>
      </div>

      <div className="divide-y divide-line">
        {groups.map(({ store: s, rules }) => {
          const serving = facilityWhGroup(s.facility);
          return (
            <div key={s.id} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-row font-semibold text-ink">{s.storeName}</h3>
                <span className="mono text-meta text-mute">{s.branchCode}</span>
                <span className="text-cap text-mute">
                  {s.storeCity} · {s.zone} · serving {s.facility}
                </span>
              </div>

              {rules.length === 0 ? (
                // Advisory, never a breach: a store with no row simply has no
                // suggested dates. It is not late and it is not blocked.
                <p className="mt-2.5 text-dense text-mute">
                  No {type} rulebook row — this store has no suggested timeline in this version.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {rules.map((r, i) => (
                    <div
                      key={`${r.wh || "wh"}:${i}`}
                      className="flex flex-col gap-2 lg:flex-row lg:items-start lg:gap-5"
                    >
                      {/* Always two lines — badge, then lane/TAT. Letting these
                          share a line and wrap only when long made a store's
                          North and South rows different heights, so their
                          chains stopped lining up with each other. */}
                      <div className="w-[190px] shrink-0">
                        <span
                          className={cn(
                            "inline-block rounded-full px-2.5 py-0.5 text-meta font-bold",
                            // The row that actually applies to this store is
                            // the one whose WH serves it. Both are shown —
                            // never collapsed — but only one is in force.
                            r.whGroup === serving
                              ? "bg-sage-soft text-sage"
                              : "bg-paper text-mute",
                          )}
                        >
                          {r.wh || "WH —"}
                          {r.whGroup === serving ? " · serves" : ""}
                        </span>
                        <span className="mt-1 block text-meta text-mute">
                          {r.laneClassification ?? "—"}
                          {r.bestTatDays != null ? ` · best ${r.bestTatDays}d` : ""}
                        </span>
                      </div>
                      <Chain rule={r} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VersionSelector({ snapshots, version }: { snapshots: string[]; version: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  if (snapshots.length === 0) return null;
  return (
    <label className="ml-auto flex items-center gap-2 text-dense font-semibold text-ink-soft">
      <span className="text-mute">Version</span>
      <select
        value={version ?? snapshots[0]}
        onChange={(e) => router.push(`${pathname}?v=${e.target.value}`)}
        className="rounded-control border border-line-control bg-paper px-3 py-2 text-dense font-semibold text-ink transition-colors duration-150 ease-ui hover:border-sage focus:border-sage focus:outline-none"
      >
        {snapshots.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}

function LaneView({ rules }: { rules: RulebookViewRow[] }) {
  const lanes = useMemo(() => {
    const m = new Map<string, { stores: Set<string>; zones: Set<string>; tats: number[] }>();
    for (const r of rules) {
      if (!r.laneClassification) continue;
      const e = m.get(r.laneClassification) ?? { stores: new Set(), zones: new Set(), tats: [] };
      e.stores.add(r.storeName);
      if (r.zone) e.zones.add(r.zone);
      if (r.bestTatDays != null) e.tats.push(r.bestTatDays);
      m.set(r.laneClassification, e);
    }
    return [...m.entries()].sort((a, b) => b[1].stores.size - a[1].stores.size);
  }, [rules]);

  return (
    <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
      {lanes.map(([lane, e]) => (
        <section key={lane} className="rounded-card bg-card p-5 shadow-card">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-control bg-sage-soft text-sage">
              <Icon name="routing-3-bold-duotone" size={17} />
            </span>
            <h3 className="font-display text-title font-bold">{lane}</h3>
            <span className="mono ml-auto font-display text-sm font-bold text-ink-soft">
              {e.stores.size} stores
            </span>
          </div>
          <div className="mt-3 text-dense text-mute">
            Zones {[...e.zones].join(" · ") || "—"} · best TAT{" "}
            {e.tats.length ? `${Math.min(...e.tats)}–${Math.max(...e.tats)}d` : "—"}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[...e.stores].slice(0, 8).map((s) => (
              <span key={s} className="rounded-full bg-paper px-2.5 py-1 text-cap font-medium text-ink-soft">
                {s}
              </span>
            ))}
            {e.stores.size > 8 ? (
              <span className="rounded-full px-2 py-1 text-cap text-mute">+{e.stores.size - 8} more</span>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}
