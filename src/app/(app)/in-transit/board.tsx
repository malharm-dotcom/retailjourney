"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { ShipmentDialog } from "@/components/shipment-dialog";
import { StatusPill, SourceBadge } from "@/components/ui/pill";
import { Chip, Input } from "@/components/ui/primitives";
import { OVERALL_VISUAL, SHIPMENT_VISUAL, cn, type StatusVisual } from "@/lib/ui";
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

export function TransitBoard({
  rows,
  canEdit,
  scopeLabel,
}: {
  rows: TransitRow[];
  canEdit: boolean;
  scopeLabel: string;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [q, setQ] = useState("");

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
        <Chip active={filter === "PICKUP_PENDING"} dot="#9A9080" onClick={() => setFilter("PICKUP_PENDING")}>
          Pickup Pending
        </Chip>
        <Chip active={filter === "IN_TRANSIT"} dot="#4C7A99" onClick={() => setFilter("IN_TRANSIT")}>
          In Transit
        </Chip>
        <Chip active={filter === "DELIVERED"} dot="#3E7A5C" onClick={() => setFilter("DELIVERED")}>
          Delivered
        </Chip>
        <Chip active={filter === "breach"} dot="#BE5340" onClick={() => setFilter("breach")}>
          Breaching
        </Chip>
        <div className="ml-auto flex min-w-[250px] items-center gap-2 rounded-xl border border-line-strong bg-paper px-3 py-1 text-mute">
          <Icon name="magnifer-linear" size={15} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SO · LR · store · area manager"
            className="border-0 bg-transparent px-0 py-1.5 focus:border-0"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-card shadow-card">
        <div className="hidden grid-cols-[2.3fr_1.35fr_1.5fr_2.4fr_.85fr_.95fr] border-b border-line bg-paper px-5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute md:grid">
          <div className="px-2 py-3.5">Store</div>
          <div className="px-2 py-3.5">LR · Courier</div>
          <div className="px-2 py-3.5">Status</div>
          <div className="px-2 py-3.5">Latest checkpoint</div>
          <div className="px-2 py-3.5">Transit age</div>
          <div />
        </div>

        {shown.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-mute">
            No shipments match — clear the filters or switch facility.
          </div>
        ) : (
          shown.map((r, i) => {
            const v = visualOf(r);
            const hot = r.breaching || r.ageing >= 5;
            return (
              <div
                key={r.so}
                className="rail grid animate-rise grid-cols-1 gap-0 border-b border-line px-5 last:border-b-0 hover:bg-[#FCFBF7] md:grid-cols-[2.3fr_1.35fr_1.5fr_2.4fr_.85fr_.95fr] md:items-center"
                style={{ "--rail": r.breaching ? "#BE5340" : v.rail, animationDelay: `${Math.min(i, 12) * 45}ms` } as React.CSSProperties}
              >
                <div className="px-2 pb-1 pt-4 md:py-4">
                  <Link href={`/orders/${r.so}`} className="text-sm font-semibold hover:text-sage">
                    {r.store}
                  </Link>
                  <div className="mt-1 text-xs text-mute">
                    {r.zone} · {r.lane ?? "—"} · {r.type} · {r.qty} pcs
                  </div>
                </div>
                <div className="mono px-2 py-1 md:py-4">
                  <span className="font-display text-[13.5px] font-semibold">{r.lr ?? "—"}</span>
                  <span className="block text-xs text-mute">
                    {(r.courier ?? "—").replace("_", " ")}
                    {r.self ? " · manual lane" : ""}
                  </span>
                </div>
                <div className="px-2 py-1 md:py-4">
                  <StatusPill visual={v} source={r.source} />
                </div>
                <div className="px-2 py-1 text-[13px] leading-snug text-ink-soft md:py-4">
                  {r.msg ?? "Awaiting first scan"}
                  <span className="mt-1 flex items-center gap-1 text-[11.5px] text-mute">
                    <Icon name="map-point-linear" size={13} />
                    {r.city ?? "—"}
                    {r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}
                  </span>
                </div>
                <div className="hidden px-2 py-4 md:block">
                  <span className={cn("mono font-display text-[19px] font-bold", hot && "text-breach")}>
                    {r.ageing}
                    <span className="block font-sans text-[11px] font-normal text-mute">days</span>
                  </span>
                </div>
                <div className="flex gap-1.5 px-2 pb-4 pt-1 md:py-4">
                  {r.trackingLink ? (
                    <a
                      href={r.trackingLink}
                      target="_blank"
                      rel="noreferrer"
                      title="Courier tracking"
                      className="grid h-[34px] w-[34px] place-items-center rounded-[10px] border border-line-strong bg-paper text-ink-soft transition-all hover:-translate-y-px hover:border-sage hover:bg-sage-soft hover:text-sage"
                    >
                      <Icon name="routing-2-linear" size={17} />
                    </a>
                  ) : null}
                  <JourneyLink so={r.so} />
                  {canEdit && r.overall !== "DELIVERED" ? (
                    <ShipmentDialog soNumber={r.so} current={r.shipment} self={r.self}>
                      <button
                        title="Update status"
                        className="grid h-[34px] w-[34px] place-items-center rounded-[10px] border border-line-strong bg-paper text-ink-soft transition-all hover:-translate-y-px hover:border-sage hover:bg-sage-soft hover:text-sage"
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

      <div className="flex items-center justify-between px-1 pb-8 pt-4 text-[12.5px] text-mute">
        <div>
          Showing <b className="font-semibold text-ink-soft">{shown.length}</b> of{" "}
          <b className="font-semibold text-ink-soft">{rows.length}</b> shipments · facility{" "}
          <b className="font-semibold text-ink-soft">{scopeLabel}</b>
        </div>
        <div>Sorted by ageing · breaches first</div>
      </div>
    </>
  );
}
