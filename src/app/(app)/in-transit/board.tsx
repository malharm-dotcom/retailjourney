"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { ShipmentDialog } from "@/components/shipment-dialog";
import { StatusPill } from "@/components/ui/pill";
import { Chip, Input } from "@/components/ui/primitives";
import { ageingBucket } from "@/lib/sla";
import { AGE_EMPHASIS, OVERALL_VISUAL, ROW_ACTION, SHIPMENT_VISUAL, TONE, cn, railOf, type StatusVisual } from "@/lib/ui";
import type { OverallStatus, ShipmentStatus, Source } from "@/lib/types";

export interface TransitRow {
  so: string;
  store: string;
  zone: string;
  lane?: string;
  type: string;
  qty: number;
  lr?: string;
  courier?: string;
  self: boolean;
  overall: OverallStatus;
  shipment?: ShipmentStatus;
  source?: Source;
  msg?: string;
  city?: string;
  ageing: number;
  breaching: boolean;
  am?: string;
  expected?: string;
  trackingLink?: string;
  attempts: number;
}

type FilterKey = "all" | "PICKUP_PENDING" | "IN_TRANSIT" | "DELIVERED" | "breach";

function visualOf(r: TransitRow): StatusVisual {
  if (r.shipment) return SHIPMENT_VISUAL[r.shipment];
  return OVERALL_VISUAL[r.overall];
}

/** How often the board pulls fresh server data while the tab is visible. */
const REFRESH_MS = 75_000;

/**
 * A shipment's identity for change detection: what would visibly move.
 *
 * `breaching` is in here deliberately. It was not, which meant the single most
 * consequential state change in the product — an order crossing into breach —
 * produced no signal at all, while the row simultaneously jumped to the top of
 * the board (breaches sort first) with nothing bridging the move.
 */
const signatureOf = (r: TransitRow) =>
  `${r.shipment ?? r.overall}|${r.msg ?? ""}|${r.city ?? ""}|${r.attempts}|${r.breaching ? "B" : "-"}`;

/** Long enough for the 1.6s wash, and for its 2.4s reduced-motion form. */
const WASH_MS = 2600;

/** Shared cell padding, so every column keeps one vertical rhythm. */
const CELL = "px-2 py-3 md:py-4";

/** Mobile-only field label. The md+ grid has a header row; the stacked layout
 *  had none, so a phone user saw bare values with no idea what they were. */
function MobileLabel({ children }: { children: React.ReactNode }) {
  return <span className="mr-1.5 text-cap font-semibold uppercase tracking-[0.04em] text-mute md:hidden">{children}</span>;
}

export function TransitBoard({
  rows,
  canEdit,
  scopeLabel,
}: {
  rows: TransitRow[];
  canEdit: boolean;
  scopeLabel: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [q, setQ] = useState("");
  const searchId = useId();

  // Rows whose checkpoint changed on the last server refresh. The 15-minute
  // eShipz poller used to swap a row's text silently — the board is often left
  // open on a wall screen, so a change nobody saw arrive is a change nobody
  // acted on. These get a one-off wash, not an entrance.
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  // Rows that CROSSED INTO BREACH on this refresh. Kept separate from `arrived`
  // because it is a different event deserving a different, louder cue: the row
  // also re-sorts to the top when this happens, so the wash is the only thing
  // connecting where it was to where it now is.
  const [breached, setBreached] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef<Map<string, { sig: string; breaching: boolean }> | null>(null);
  const arriveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = new Map(rows.map((r) => [r.so, { sig: signatureOf(r), breaching: r.breaching }]));
    const prev = seen.current;
    seen.current = next;
    // First render establishes the baseline: everything is "new" on arrival and
    // flashing the whole board would be noise, not signal.
    if (!prev) return;
    const changed = new Set<string>();
    const crossed = new Set<string>();
    for (const [so, cur] of next) {
      const before = prev.get(so);
      if (before === undefined) continue;
      // Crossing into breach wins over any other change on the same row —
      // there is only one wash per row and this is the one worth spending it on.
      if (!before.breaching && cur.breaching) crossed.add(so);
      else if (before.sig !== cur.sig) changed.add(so);
    }
    if (changed.size === 0 && crossed.size === 0) return;
    setArrived(changed);
    setBreached(crossed);
    // Colour and motion are both invisible to a screen reader, and this is the
    // one change on the board that means somebody has to act.
    if (crossed.size > 0) {
      setAnnouncement(`${crossed.size} shipment${crossed.size === 1 ? "" : "s"} just breached SLA`);
    }
    if (arriveTimer.current) clearTimeout(arriveTimer.current);
    arriveTimer.current = setTimeout(() => {
      setArrived(new Set());
      setBreached(new Set());
    }, WASH_MS);
  }, [rows]);

  useEffect(() => () => void (arriveTimer.current && clearTimeout(arriveTimer.current)), []);

  // Keep the board live. A Retail Head leaves this open and walks away; without
  // this the data froze at page load with no cue that it had. Paused while the
  // tab is hidden so a backgrounded board is not polling all afternoon, and
  // refreshed immediately on return so the first glance back is current.
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      router.refresh();
      setRefreshedAt(new Date());
    };
    const id = setInterval(tick, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (filter === "breach" && !r.breaching) return false;
        if (filter !== "all" && filter !== "breach" && r.overall !== filter) return false;
        if (
          needle &&
          ![r.so, r.lr, r.store, r.am, r.courier]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(needle))
        )
          return false;
        return true;
      })
      .sort((a, b) => Number(b.breaching) - Number(a.breaching) || b.ageing - a.ageing);
  }, [rows, filter, q]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          All open
        </Chip>
        <Chip active={filter === "PICKUP_PENDING"} tone="pending" onClick={() => setFilter("PICKUP_PENDING")}>
          Pickup Pending
        </Chip>
        <Chip active={filter === "IN_TRANSIT"} tone="motion" onClick={() => setFilter("IN_TRANSIT")}>
          In Transit
        </Chip>
        <Chip active={filter === "DELIVERED"} tone="done" onClick={() => setFilter("DELIVERED")}>
          Delivered
        </Chip>
        <Chip active={filter === "breach"} tone="failed" onClick={() => setFilter("breach")}>
          Breaching
        </Chip>
        <div className="ml-auto flex min-w-[250px] flex-1 items-center gap-2 rounded-control border border-line-control bg-paper px-3 text-mute sm:flex-none">
          <Icon name="magnifer-linear" size={15} />
          {/* The placeholder was doing the label's job, which leaves nothing to
              announce and nothing to read once you have typed. */}
          <label htmlFor={searchId} className="sr-only">
            Search shipments by SO, LR, store or area manager
          </label>
          <Input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SO · LR · store · area manager"
            className="border-0 bg-transparent px-0 py-2 focus:border-0"
          />
        </div>
      </div>

      {/* Breach arrivals are announced. The wash and the rail colour are both
          invisible to a screen reader, and this is the change that matters. */}
      <p aria-live="assertive" className="sr-only">
        {announcement}
      </p>

      <div className="overflow-hidden rounded-card bg-card shadow-card">
        {/* Sticky so the column meaning survives a long scroll. `top` clears the
            60px bar plus the sync strip that sit above it. */}
        <div className="sticky top-[var(--bar-h)] z-10 hidden grid-cols-[2.3fr_1.35fr_1.5fr_2.4fr_.85fr_1.1fr] border-b border-line bg-paper px-5 text-cap font-semibold uppercase tracking-[0.04em] text-mute md:grid">
          <div className={CELL}>Store</div>
          <div className={CELL}>LR · Courier</div>
          <div className={CELL}>Status</div>
          <div className={CELL}>Latest checkpoint</div>
          <div className={CELL}>Transit age</div>
          <div />
        </div>

        {shown.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-mute">
            No shipments match — clear the filters or switch facility.
          </div>
        ) : (
          shown.map((r) => {
            const v = visualOf(r);
            const age = AGE_EMPHASIS[ageingBucket(r.ageing)];
            return (
              <div
                key={r.so}
                className={cn(
                  "rail grid grid-cols-1 gap-0 border-b border-line px-5 transition-colors duration-150 ease-ui last:border-b-0 hover:bg-paper md:grid-cols-[2.3fr_1.35fr_1.5fr_2.4fr_.85fr_1.1fr] md:items-center",
                  // No entrance animation. The rows are the content; staggering
                  // them made every filter tap cost half a second of choreography
                  // on top of a server round-trip.
                  breached.has(r.so) && "animate-breachArrive",
                  arrived.has(r.so) && "animate-arrive",
                )}
                style={{ "--rail": r.breaching ? TONE.failed.hex : railOf(v) } as React.CSSProperties}
              >
                <div className={cn(CELL, "pb-1 pt-4 md:py-4")}>
                  <Link href={`/orders/${r.so}`} className="text-row font-semibold hover:text-sage">
                    {r.store}
                  </Link>
                  <div className="mt-1 text-cap text-mute">
                    {r.zone} · {r.lane ?? "—"} · {r.type} · {r.qty} pcs
                  </div>
                </div>
                <div className={cn(CELL, "mono py-1 md:py-4")}>
                  <MobileLabel>LR</MobileLabel>
                  <span className="font-display text-ui font-semibold">{r.lr ?? "—"}</span>
                  <span className="block text-cap text-mute">
                    {(r.courier ?? "—").replace("_", " ")}
                    {r.self ? " · manual lane" : ""}
                  </span>
                </div>
                <div className={cn(CELL, "py-1 md:py-4")}>
                  <StatusPill visual={v} source={r.source} />
                </div>
                <div className={cn(CELL, "py-1 text-ui leading-snug text-ink-soft md:py-4")}>
                  <MobileLabel>Checkpoint</MobileLabel>
                  {r.msg ?? "Awaiting first scan"}
                  <span className="mt-1 flex items-center gap-1 text-cap text-mute">
                    <Icon name="map-point-linear" size={13} />
                    {r.city ?? "—"}
                    {r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}
                  </span>
                </div>
                {/* Was `hidden md:block`. This is the number that decides whether
                    an Area Manager escalates, and she is on a phone. */}
                <div className={cn(CELL, "flex items-baseline gap-1.5 py-1 md:block md:py-4")}>
                  <MobileLabel>Transit age</MobileLabel>
                  <span className={cn("mono font-display text-num font-bold", age.className)}>{r.ageing}</span>
                  <span className="font-sans text-cap font-normal text-mute md:block">
                    days<span className="md:hidden"> · {age.note}</span>
                  </span>
                </div>
                <div className={cn(CELL, "flex gap-2 pb-4 pt-2 md:justify-end md:py-4")}>
                  {r.trackingLink ? (
                    <a
                      href={r.trackingLink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open courier tracking for ${r.so} in a new tab`}
                      className={ROW_ACTION}
                    >
                      <Icon name="routing-2-linear" size={17} />
                    </a>
                  ) : null}
                  <JourneyLink so={r.so} />
                  {canEdit && r.overall !== "DELIVERED" ? (
                    <ShipmentDialog
                      soNumber={r.so}
                      current={r.shipment}
                      self={r.self}
                      store={r.store}
                      lr={r.lr}
                      courier={r.courier}
                    >
                      <button
                        type="button"
                        aria-label={`Update shipment status for ${r.so}`}
                        className={ROW_ACTION}
                      >
                        <Icon name="pen-new-square-linear" size={17} />
                      </button>
                    </ShipmentDialog>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-1 pb-8 pt-4 text-dense text-mute">
        {/* Announced, because filtering is the one action here whose entire
            result is a number that changes somewhere else on the screen. */}
        <p aria-live="polite">
          Showing <b className="font-semibold text-ink-soft">{shown.length}</b> of{" "}
          <b className="font-semibold text-ink-soft">{rows.length}</b> shipments · facility{" "}
          <b className="font-semibold text-ink-soft">{scopeLabel}</b>
        </p>
        <p>
          Sorted by ageing · breaches first
          {refreshedAt ? (
            <span className="mono"> · refreshed {refreshedAt.toLocaleTimeString("en-IN", { hour12: false })} IST</span>
          ) : null}
        </p>
      </div>
    </>
  );
}
