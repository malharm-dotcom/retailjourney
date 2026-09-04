"use client";

// Admin sync controls (M2): per-source health cards, on-demand "Sync now",
// and the unmatched-channel review queue (channel → Store mapping).

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/primitives";
import { mapChannelToStore, runSyncNow } from "@/app/actions";
import { fmtDateTime } from "@/lib/ist";
import { cn } from "@/lib/ui";

export interface SyncRunView {
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  rowsFetched: number;
  rowsUpserted: number;
  conflicts: number;
  errorCount: number;
  firstError?: string;
}

export interface UnmatchedChannelView {
  channel: string;
  orderCount: number;
  lastSeenAt: string;
  sampleSoNumbers: string[];
}

export interface SourceCard {
  source: "ESHIPZ" | "ESHIPZ_WEBHOOK" | "SNOWFLAKE";
  name: string;
  detail: string;
  icon: string;
  configured: boolean;
  /** Push-driven sources (webhooks) have no "Sync now" button. */
  passive?: boolean;
  lastRun?: SyncRunView;
}

export function SyncHealthCards({ cards, dbReady }: { cards: SourceCard[]; dbReady: boolean }) {
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<string | null>(null);

  const trigger = (source: "ESHIPZ" | "SNOWFLAKE") => {
    setRunning(source);
    startTransition(async () => {
      const res = await runSyncNow(source);
      setRunning(null);
      if (res.ok && res.summaries) {
        const s = res.summaries[0];
        if (s.ok) toast.success(`${s.source} sync: ${s.upserted} upserted of ${s.fetched} fetched, ${s.conflicts} conflicts`);
        else toast.error(`${s.source} sync failed: ${s.errors[0] ?? "see sync log"}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  };

  return (
    <div className="mb-6 grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => {
        const r = c.lastRun;
        const state = !c.configured
          ? { dot: "bg-pending", label: "Not configured — set the env vars" }
          : !dbReady
            ? { dot: "bg-pending", label: "Waiting for database (DATABASE_URL)" }
            : !r
              ? { dot: "bg-pending", label: c.passive ? "Configured — waiting for first webhook" : "Configured — no runs yet" }
              : r.ok === false
                ? { dot: "bg-breach", label: `Last run failed · ${r.firstError ?? `${r.errorCount} errors`}` }
                : !r.finishedAt
                  ? { dot: "bg-ofd", label: "Run in progress…" }
                  : { dot: "bg-deliv", label: `OK · ${fmtDateTime(r.finishedAt)}` };
        return (
          <section key={c.source} className="rounded-card bg-card p-5 shadow-card">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-control bg-pending-bg text-ink-soft">
                <Icon name={c.icon} size={19} />
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-title font-bold">{c.name}</h3>
                <p className="text-cap text-mute">{c.detail}</p>
              </div>
              {c.passive ? null : (
                <Button
                  variant="outline"
                  // No `text-dense` here. `cn` is twMerge, which cannot tell a
                  // custom colour token from a custom font-size token — both
                  // are `text-*` — so a size override silently DELETES the
                  // variant's own text colour. On this outline button that only
                  // darkened the label; on the primary Assign button below it
                  // rendered ink on ink, i.e. invisible.
                  className="ml-auto px-3 py-1.5"
                  disabled={pending || !c.configured || !dbReady}
                  onClick={() => trigger(c.source as "ESHIPZ" | "SNOWFLAKE")}
                >
                  <Icon name="refresh-bold-duotone" size={14} className={cn(running === c.source && "animate-spin")} />
                  Sync now
                </Button>
              )}
            </div>
            <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-dense font-semibold text-mute">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", state.dot)} />
              <span className="truncate">{state.label}</span>
            </div>
            {r?.finishedAt ? (
              <div className="mono mt-2 grid grid-cols-3 gap-2 text-center text-cap text-ink-soft">
                <div className="rounded-lg bg-paper py-1.5">
                  <span className="block text-row font-bold text-ink">{r.rowsFetched}</span>fetched
                </div>
                <div className="rounded-lg bg-paper py-1.5">
                  <span className="block text-row font-bold text-ink">{r.rowsUpserted}</span>upserted
                </div>
                <div className={cn("rounded-lg bg-paper py-1.5", r.conflicts > 0 && "bg-ofd-bg")}>
                  <span className="block text-row font-bold text-ink">{r.conflicts}</span>conflicts
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** One selectable store. `codes` are the identifiers this store answers to —
 *  searchable alongside the name, because an operator reading a raw channel
 *  string usually has a code in hand, not a store name. */
export interface StoreOption {
  id: string;
  label: string;
  codes: string[];
}

/** Match on the name AND on every code, both literally and with punctuation
 *  squashed out — store names carry " - " separators the typist will not
 *  reproduce ("kalyannagar" has to find "QC - KALYAN NAGAR"). */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const MAX_VISIBLE = 60;

function StoreCombobox({
  stores,
  value,
  onChange,
  channel,
}: {
  stores: StoreOption[];
  value: string;
  onChange: (id: string) => void;
  channel: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const selected = stores.find((s) => s.id === value);

  const matches = useMemo(() => {
    const raw = query.trim().toLowerCase();
    if (!raw) return stores;
    const sq = squash(query);
    const scored: { s: StoreOption; rank: number }[] = [];
    for (const s of stores) {
      const hay = [s.label, ...s.codes];
      let rank = -1;
      for (const h of hay) {
        const l = h.toLowerCase();
        const q = squash(h);
        // Prefix beats contains, so typing "cofo" surfaces the COFO stores
        // above every store that merely mentions it later in its name.
        if (l.startsWith(raw) || q.startsWith(sq)) rank = Math.max(rank, 2);
        else if (l.includes(raw) || (sq.length > 0 && q.includes(sq))) rank = Math.max(rank, 1);
      }
      if (rank > 0) scored.push({ s, rank });
    }
    scored.sort((a, b) => b.rank - a.rank || a.s.label.localeCompare(b.s.label));
    return scored.map((x) => x.s);
  }, [stores, query]);

  const visible = matches.slice(0, MAX_VISIBLE);

  // Keep the highlight inside the list as it shrinks under a longer query, and
  // scroll it into view when the keyboard is what moved it.
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (s: StoreOption) => {
    onChange(s.id);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => {
        const n = visible.length;
        if (n === 0) return 0;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter") {
      if (open && visible[active]) {
        e.preventDefault();
        choose(visible[active]);
      }
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className="relative w-80"
      // Closes on click-away and on tabbing out, but NOT when focus moves to an
      // option inside this same subtree — which is what a plain input onBlur
      // would do, killing the click before it lands.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-control border bg-paper px-3 transition-colors duration-150 ease-ui",
          open ? "border-sage" : "border-line-control",
        )}
      >
        <Icon name="magnifer-linear" size={15} className="shrink-0 text-mute" />
        <label htmlFor={inputId} className="sr-only">
          Search a store to map channel {channel} to, by name or code
        </label>
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && visible[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={open ? query : (selected?.label ?? "")}
          placeholder={selected ? selected.label : "Search store name or code…"}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // Editing the text abandons the pick: Assign must never fire
            // against a store the operator has typed past.
            if (value) onChange("");
          }}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent py-2 text-ui text-ink outline-none placeholder:text-mute"
        />
        {selected && !open ? (
          <button
            type="button"
            aria-label={`Clear the selected store for ${channel}`}
            onClick={() => {
              onChange("");
              setQuery("");
            }}
            className="shrink-0 text-mute transition-colors duration-150 ease-ui hover:text-ink"
          >
            <Icon name="close-circle-bold" size={15} />
          </button>
        ) : (
          <Icon name="alt-arrow-down-bold" size={13} className="shrink-0 text-mute" />
        )}
      </div>

      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Matching stores"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-72 overflow-y-auto rounded-control border border-line bg-card py-1 shadow-card"
        >
          {visible.length === 0 ? (
            <li className="px-3 py-2.5 text-dense text-mute">No store matches “{query.trim()}”</li>
          ) : (
            visible.map((s, i) => (
              <li key={s.id} id={`${listId}-${i}`} data-idx={i} role="option" aria-selected={s.id === value}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s)}
                  className={cn(
                    "block w-full px-3 py-2 text-left transition-colors duration-150 ease-ui",
                    i === active ? "bg-sage-soft" : "hover:bg-paper",
                  )}
                >
                  <span className="block text-dense font-semibold text-ink">{s.label}</span>
                  {s.codes.length ? (
                    <span className="mono block text-meta text-mute">{s.codes.join(" · ")}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
          {matches.length > visible.length ? (
            <li className="border-t border-line px-3 py-2 text-meta text-mute">
              {matches.length - visible.length} more — keep typing to narrow
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export function UnmatchedChannels({
  unmatched,
  stores,
}: {
  unmatched: UnmatchedChannelView[];
  stores: StoreOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});

  if (unmatched.length === 0) return null;

  const assign = (channel: string) => {
    const storeId = choice[channel];
    if (!storeId) {
      toast.error("Pick a store first");
      return;
    }
    startTransition(async () => {
      const res = await mapChannelToStore(channel, storeId);
      if (res.ok) toast.success(`Channel "${channel}" mapped — its orders regain rulebook targets on the next sync`);
      else toast.error(res.error);
    });
  };

  return (
    <section className="mb-6 overflow-hidden rounded-card bg-card shadow-card">
      {/* Informational, not a warning: nothing on this panel blocks an order,
          so it must not wear the danger triangle and the amber ground that the
          genuinely-alarming panels use. */}
      <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
        <Icon name="info-circle-bold-duotone" size={17} className="text-mute" />
        <h2 className="font-display text-sec font-bold">Unmatched channels — reconciliation aid</h2>
        <span className="ml-auto text-cap text-mute">
          these orders already process normally — mapping only restores rulebook targets
        </span>
      </header>
      <div className="divide-y divide-line">
        {unmatched.map((u) => (
          <div key={u.channel} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="mono text-ui font-bold">{u.channel}</div>
              <div className="mt-0.5 text-cap text-mute">
                {u.orderCount} order{u.orderCount === 1 ? "" : "s"} processing · last seen{" "}
                {fmtDateTime(u.lastSeenAt)}
                {u.sampleSoNumbers.length ? ` · e.g. ${u.sampleSoNumbers.slice(0, 3).join(", ")}` : ""}
              </div>
            </div>
            <StoreCombobox
              channel={u.channel}
              stores={stores}
              value={choice[u.channel] ?? ""}
              onChange={(id) => setChoice((c) => ({ ...c, [u.channel]: id }))}
            />
            {/* Disabled until a store is actually picked. The old control could
                not be in this state — a native select with a placeholder option
                always had a "value" — so Assign was always live and the only
                thing standing between a mis-click and a write was a toast. */}
            <Button
              variant="primary"
              className="px-3 py-1.5"
              disabled={pending || !choice[u.channel]}
              onClick={() => assign(u.channel)}
            >
              Assign
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
