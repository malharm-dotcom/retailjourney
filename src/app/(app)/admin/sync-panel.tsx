"use client";

// Admin sync controls (M2): per-source health cards, on-demand "Sync now",
// and the unmatched-channel review queue (UC channel → Store mapping).

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Button, Select } from "@/components/ui/primitives";
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
  source: "UC" | "ESHIPZ" | "ESHIPZ_WEBHOOK" | "SNOWFLAKE";
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

  const trigger = (source: "UC" | "ESHIPZ" | "SNOWFLAKE") => {
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
          <section key={c.source} className="rounded-2xl bg-card p-5 shadow-card">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-pending-bg text-ink-soft">
                <Icon name={c.icon} size={19} />
              </span>
              <div className="min-w-0">
                <h3 className="text-[13.5px] font-bold">{c.name}</h3>
                <p className="text-[11.5px] text-mute">{c.detail}</p>
              </div>
              {c.passive ? null : (
                <Button
                  variant="outline"
                  className="ml-auto px-3 py-1.5 text-[12px]"
                  disabled={pending || !c.configured || !dbReady}
                  onClick={() => trigger(c.source as "UC" | "ESHIPZ" | "SNOWFLAKE")}
                >
                  <Icon name="refresh-bold-duotone" size={14} className={cn(running === c.source && "animate-spin")} />
                  Sync now
                </Button>
              )}
            </div>
            <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-[12px] font-semibold text-mute">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", state.dot)} />
              <span className="truncate">{state.label}</span>
            </div>
            {r?.finishedAt ? (
              <div className="mono mt-2 grid grid-cols-3 gap-2 text-center text-[11.5px] text-ink-soft">
                <div className="rounded-lg bg-paper py-1.5">
                  <span className="block text-[14px] font-bold text-ink">{r.rowsFetched}</span>fetched
                </div>
                <div className="rounded-lg bg-paper py-1.5">
                  <span className="block text-[14px] font-bold text-ink">{r.rowsUpserted}</span>upserted
                </div>
                <div className={cn("rounded-lg bg-paper py-1.5", r.conflicts > 0 && "bg-ofd-bg")}>
                  <span className="block text-[14px] font-bold text-ink">{r.conflicts}</span>conflicts
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function UnmatchedChannels({
  unmatched,
  stores,
}: {
  unmatched: UnmatchedChannelView[];
  stores: { id: string; label: string }[];
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
      if (res.ok) toast.success(`Channel "${channel}" mapped — next UC sweep ingests its orders`);
      else toast.error(res.error);
    });
  };

  return (
    <section className="mb-6 overflow-hidden rounded-2xl bg-card shadow-card">
      <header className="flex items-center gap-2.5 border-b border-line bg-ofd-bg px-5 py-3.5">
        <Icon name="danger-triangle-bold-duotone" size={17} className="text-ofd" />
        <h2 className="text-[13px] font-bold">Unmatched UC channels — review queue</h2>
        <span className="ml-auto text-[11.5px] text-mute">
          orders from these channels are held until mapped to a store
        </span>
      </header>
      <div className="divide-y divide-line">
        {unmatched.map((u) => (
          <div key={u.channel} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="mono text-[13px] font-bold">{u.channel}</div>
              <div className="mt-0.5 text-[11.5px] text-mute">
                {u.orderCount} order{u.orderCount === 1 ? "" : "s"} · last seen {fmtDateTime(u.lastSeenAt)}
                {u.sampleSoNumbers.length ? ` · e.g. ${u.sampleSoNumbers.slice(0, 3).join(", ")}` : ""}
              </div>
            </div>
            <Select
              className="w-64"
              value={choice[u.channel] ?? ""}
              onChange={(e) => setChoice((c) => ({ ...c, [u.channel]: e.target.value }))}
            >
              <option value="">Map to store…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Button variant="primary" className="px-3 py-1.5 text-[12px]" disabled={pending} onClick={() => assign(u.channel)}>
              Assign
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
