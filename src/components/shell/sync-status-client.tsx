"use client";

// Renders the two per-source freshness chips and keeps the RELATIVE part
// ticking client-side. The timestamps themselves are server data (SyncRun
// rows) — the client clock is only used to phrase "N min ago" and to flip a
// chip to stale once its cadence is well overdue. Health states:
//   fresh  — last run within 2× cadence and did not error
//   stale  — no run, or last run started more than 2× its cadence ago
//   failed — last run errored
// The title tooltip documents the cadence (that IS the in-product doc).

import Link from "next/link";
import { useEffect, useState } from "react";
// Relative import so vitest (no path-alias config) can load this module.
import { cn } from "../../lib/ui";

export interface SourceStatus {
  label: string;
  cadenceMin: number;
  /** startedAt of the latest SyncRun (epoch ms), null = never ran. */
  atMs: number | null;
  /** Preformatted IST absolute ("28 Jun, 3:42 pm") from the server. */
  absolute: string;
  failed: boolean;
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});

/** Health verdict — failed beats stale beats fresh; stale = no run yet or
 *  the last run started more than 2× the cadence ago. (Pure, unit-tested.) */
export function healthOf(s: Pick<SourceStatus, "failed" | "atMs" | "cadenceMin">, nowMs: number): "failed" | "stale" | "fresh" {
  if (s.failed) return "failed";
  if (s.atMs === null || nowMs - s.atMs > s.cadenceMin * 2 * 60000) return "stale";
  return "fresh";
}

function rel(atMs: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - atMs) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SyncStatusClient({ statuses }: { statuses: SourceStatus[] }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Link
      href="/admin"
      title={statuses
        .map(
          (s) =>
            `${s.label} sync — every ${s.cadenceMin >= 60 ? `${s.cadenceMin / 60}h` : `${s.cadenceMin} min`}. Last run ${s.absolute} IST${s.failed ? " — FAILED" : ""}.`,
        )
        .join("\n")}
      className="flex items-center gap-3.5 whitespace-nowrap"
      aria-label="Sync freshness — details in Admin"
    >
      {statuses.map((s) => {
        const state = healthOf(s, nowMs);
        return (
          <span key={s.label} className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-[7px] w-[7px] rounded-full",
                state === "fresh" && "bg-sage",
                state === "stale" && "bg-ofd",
                state === "failed" && "bg-breach",
              )}
            />
            <span className="text-[10.5px] font-semibold leading-none text-ink-soft">{s.label}</span>
            <span
              className={cn(
                "mono text-[10.5px] leading-none",
                state === "fresh" && "text-mute",
                state === "stale" && "font-semibold text-ofd",
                state === "failed" && "font-semibold text-breach",
              )}
            >
              {s.failed
                ? `failed · ${s.atMs === null ? "—" : IST_TIME.format(s.atMs).replace(/\s/g, "")}`
                : s.atMs === null
                  ? "never"
                  : `${rel(s.atMs, nowMs)} · ${IST_TIME.format(s.atMs).replace(/\s/g, "")}${state === "stale" ? " · overdue" : ""}`}
            </span>
          </span>
        );
      })}
    </Link>
  );
}
