// Order Detail / Journey (PRD §6.5) — the full OrderEvent timeline across all
// phases, per-leg SLA, tracking, reconciliation, and manual override on every
// field with per-field source provenance.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icon";
import { StatusPill, SourceBadge } from "@/components/ui/pill";
import { orderBySo } from "@/lib/data";
import { fmtDate, fmtDateTime } from "@/lib/ist";
import { OVERALL_LABEL, RECEIPT_LABEL, SHIPMENT_LABEL, STATUS_LABEL } from "@/lib/journey";
import { LEG_LABEL, type SlaLeg } from "@/lib/sla";
import { policyOf } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import { requireSession } from "@/lib/session";
import type { OrderEvent, OverallStatus, Source } from "@/lib/types";
import {
  OVERALL_VISUAL,
  RECEIPT_VISUAL,
  SHIPMENT_VISUAL,
  SLA_VISUAL,
  WH_STATUS_VISUAL,
  cn,
  tileOf,
} from "@/lib/ui";
import { FieldGrid } from "./field-grid";

export const dynamic = "force-dynamic";

/**
 * The track. `INWARDED` is included deliberately: it is a real `OverallStatus`
 * and the true end of the journey (the store has booked the stock in), but it was
 * missing from this array — so `STAGES.indexOf("INWARDED")` returned -1 and the
 * whole track rendered blank on the most completely finished orders in the system.
 */
const STAGES: OverallStatus[] = ["WH_PROCESSING", "PICKUP_PENDING", "IN_TRANSIT", "DELIVERED", "INWARDED"];

/**
 * The SLA leg that carries the baton INTO each stage. This is what lets a
 * connector show its own hop's verdict instead of the track being uniformly sage
 * regardless of whether a leg was late.
 */
const STAGE_LEG: Partial<Record<OverallStatus, SlaLeg>> = {
  WH_PROCESSING: "PLACEMENT",
  PICKUP_PENDING: "HANDOVER",
  IN_TRANSIT: "PICKUP",
  DELIVERED: "DELIVERY",
  // INWARDED is the store phase and has no rulebook leg.
};

function eventVisual(e: OrderEvent) {
  if (e.field === "status") return WH_STATUS_VISUAL[e.toValue as keyof typeof WH_STATUS_VISUAL] ?? null;
  if (e.field === "shipmentStatus") return SHIPMENT_VISUAL[e.toValue as keyof typeof SHIPMENT_VISUAL] ?? null;
  if (e.field === "receiptStatus") return RECEIPT_VISUAL[e.toValue as keyof typeof RECEIPT_VISUAL] ?? null;
  return null;
}

function eventTitle(e: OrderEvent): string {
  if (e.field === "status") return STATUS_LABEL[e.toValue as keyof typeof STATUS_LABEL] ?? e.toValue;
  if (e.field === "shipmentStatus") return SHIPMENT_LABEL[e.toValue as keyof typeof SHIPMENT_LABEL] ?? e.toValue;
  if (e.field === "receiptStatus") return RECEIPT_LABEL[e.toValue as keyof typeof RECEIPT_LABEL] ?? e.toValue;
  return `${e.field} → ${e.toValue}`;
}

export default async function OrderPage({ params }: { params: { soNumber: string } }) {
  const { user } = await requireSession();
  const row = await orderBySo(decodeURIComponent(params.soNumber));
  if (!row) notFound();
  const { order: o, sla } = row;
  const events = await repo.listEvents(o.id);
  const shipments = await repo.listShipments(o.soNumber);
  const policy = policyOf(user.role);

  const stageIdx = STAGES.indexOf(o.overallStatus);
  const terminal = ["CANCELLED", "UNFULFILLABLE"].includes(o.status);

  // Per-field provenance: the last event wins; untouched fields read as synced.
  const lastSource = new Map<string, Source>();
  for (const e of events) lastSource.set(e.field, e.source);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5 pt-8">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-dense text-mute">
            <Link href="/in-transit" className="hover:text-sage">
              In-transit board
            </Link>
            <span>/</span>
            <span className="mono">{o.soNumber}</span>
          </div>
          <h1 className="font-display text-[27px] font-bold leading-[1.05] tracking-tight sm:text-[32px]">
            {o.soNumber}
          </h1>
          <div className="mt-2 text-sm text-mute">
            {o.finalStore} · {o.facility} · {o.type} · {o.qty} pcs
            {o.campaignTag ? ` · ${o.campaignTag}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill visual={WH_STATUS_VISUAL[o.status]} source={lastSource.get("status") ?? o.statusSource} />
          {o.shipmentStatus ? (
            <StatusPill visual={SHIPMENT_VISUAL[o.shipmentStatus]} source={o.shipmentSource ?? "SYNCED"} />
          ) : null}
          {o.receiptStatus ? <StatusPill visual={RECEIPT_VISUAL[o.receiptStatus]} /> : null}
        </div>
      </div>

      {/* RetailJourney track — the rollup as an actual baton pass.
       *
       * Three things were wrong here. A delivered order satisfied BOTH `done` and
       * `current` at the same index, so tailwind-merge kept the later class and
       * the final node rendered in the pale in-progress treatment on a finished
       * journey. An INWARDED order — the most completely finished state there is —
       * produced stageIdx === -1, so not a single node lit up. And the track
       * carried no times at all, on the one screen whose entire question is when
       * each hop happened and which one lost the day.
       *
       * The connectors now ARE the SLA legs: each one is the hop into the stage
       * that follows it, coloured by that leg's own verdict, so a breach is
       * located on the track rather than described in a panel below it. */}
      <div className={cn("mb-6 overflow-hidden rounded-card bg-card p-5 shadow-card", terminal && "opacity-70")}>
        <ol className="flex items-start">
          {STAGES.map((s, i) => {
            const v = OVERALL_VISUAL[s];
            // Mutually exclusive by construction: reached-and-passed, reached-now,
            // or not reached. No index can be two of these.
            const reached = stageIdx >= 0 && i <= stageIdx;
            const current = !terminal && i === stageIdx;
            const done = reached && !current;
            // The leg that carried the baton INTO the next stage.
            const legInto = STAGE_LEG[STAGES[i + 1]];
            const leg = legInto ? sla.legs.find((l) => l.leg === legInto) : undefined;
            const legBreached = leg?.state === "BREACHED" || leg?.state === "BREACHED_PENDING";
            const legCrossed = stageIdx > i;
            // Arrival time for this stage = when the leg into it actually landed.
            const arrivedTs = STAGE_LEG[s] ? sla.legs.find((l) => l.leg === STAGE_LEG[s])?.actualTs : undefined;
            return (
              <li key={s} className="flex flex-1 items-start last:flex-none">
                <div className="flex w-[74px] shrink-0 flex-col items-center gap-1.5 text-center">
                  <span
                    className={cn(
                      "grid h-9 w-9 place-items-center rounded-full border-2 transition-colors",
                      done && "border-sage bg-sage text-white",
                      current && "border-sage bg-sage-soft text-sage animate-stageIn",
                      !reached && "border-line-control bg-paper text-mute",
                    )}
                  >
                    <Icon name={v.icon} size={17} />
                  </span>
                  <span className={cn("text-cap font-semibold", reached ? "text-ink" : "text-mute")}>
                    {OVERALL_LABEL[s]}
                  </span>
                  {/* The times were the whole point and were simply absent. */}
                  <span className="mono block text-meta text-mute">
                    {arrivedTs ? fmtDateTime(arrivedTs) : reached ? "—" : ""}
                  </span>
                </div>
                {i < STAGES.length - 1 ? (
                  <div className="mt-[17px] flex flex-1 flex-col items-center gap-1">
                    <div className="h-[3px] w-full overflow-hidden rounded-full bg-line">
                      <div
                        className={cn(
                          "h-full w-full origin-left rounded-full",
                          legCrossed ? (legBreached ? "bg-breach animate-batonDraw" : "bg-sage animate-batonDraw") : "bg-transparent",
                        )}
                        style={{ animationDelay: `${i * 90}ms` }}
                      />
                    </div>
                    {/* A breach is named where it happened, not only in the panel
                        below — "which hop lost the day" is the actual question. */}
                    {legCrossed && legBreached ? (
                      <span className="text-meta font-semibold text-breach">{leg ? LEG_LABEL[leg.leg] : ""} late</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {terminal ? (
          <div className="mt-3 rounded-control bg-breach-bg px-3 py-2 text-dense font-semibold text-breach">
            This order ended as {STATUS_LABEL[o.status]} — the track above stopped where it stands.
          </div>
        ) : null}
      </div>

      <div className="grid gap-3.5 lg:grid-cols-[1.6fr_1fr]">
        {/* Timeline — every OrderEvent, the audit trail as the story */}
        <section className="overflow-hidden rounded-card bg-card shadow-card">
          <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
            <Icon name="history-bold-duotone" size={17} className="text-sage" />
            <h2 className="font-display text-sec font-bold">Journey timeline</h2>
            <span className="ml-auto text-cap text-mute">{events.length} events · every change is logged</span>
          </header>
          <ol className="px-5 py-4">
            {[...events].reverse().map((e, i) => {
              const v = eventVisual(e);
              return (
                <li key={e.id} className="relative flex gap-3.5 pb-5 last:pb-1">
                  {i < events.length - 1 ? (
                    <span className="absolute left-[15px] top-9 h-[calc(100%-28px)] w-px bg-line" aria-hidden />
                  ) : null}
                  {/* Tinted from the tone rather than an alpha-composited hex:
                      a `${hex}1A` fill makes the icon's contrast depend on
                      whatever sits behind it, which is exactly the case where
                      contrast cannot be verified. */}
                  <span
                    className={cn(
                      "mt-0.5 grid h-[31px] w-[31px] shrink-0 place-items-center rounded-full",
                      v ? tileOf(v) : "bg-pending-bg text-ink-soft",
                    )}
                  >
                    <Icon name={v?.icon ?? "pen-2-linear"} size={15} />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-ui font-semibold">{eventTitle(e)}</span>
                      <SourceBadge source={e.source} />
                      <span className="mono ml-auto text-cap text-mute">{fmtDateTime(e.createdAt)}</span>
                    </div>
                    <div className="mt-0.5 text-dense text-mute">
                      {e.fromValue ? `from ${eventTitle({ ...e, toValue: e.fromValue })} · ` : ""}
                      {e.actorName ?? (e.source !== "MANUAL" ? "System sync" : "Unknown")}
                      {e.note ? <span className="text-ink-soft"> — “{e.note}”</span> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <div className="flex flex-col gap-3.5">
          {/* SLA per leg */}
          <section className="overflow-hidden rounded-card bg-card shadow-card">
            <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
              <Icon name="stopwatch-bold-duotone" size={17} className="text-sage" />
              <h2 className="font-display text-sec font-bold">SLA by leg</h2>
              <span className="ml-auto text-cap text-mute">rulebook-derived · advisory</span>
            </header>
            {o.tatInheritedFrom ? (
              <div className="border-b border-line bg-ofd-bg px-5 py-2 text-cap font-semibold text-ofd">
                Inherited TAT — quick-commerce store, targets from parent {o.tatInheritedFrom}
              </div>
            ) : null}
            <div>
              {sla.legs.map((l) => (
                <div key={l.leg} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-dense font-semibold">{LEG_LABEL[l.leg]}</div>
                    <div className="mono mt-0.5 text-cap text-mute">
                      target {l.targetTs ? fmtDateTime(l.targetTs) : "—"} · actual{" "}
                      {l.actualTs ? fmtDateTime(l.actualTs) : "—"}
                    </div>
                  </div>
                  {l.state ? <StatusPill size="sm" visual={SLA_VISUAL[l.state]} /> : <span className="text-cap text-mute">no target</span>}
                </div>
              ))}
              {sla.perfectOrder ? (
                <div className="flex items-center gap-3 bg-paper px-5 py-3">
                  <div className="flex-1 text-dense font-bold">{LEG_LABEL.PERFECT_ORDER}</div>
                  <StatusPill size="sm" visual={SLA_VISUAL[sla.perfectOrder]} />
                </div>
              ) : null}
            </div>
          </section>

          {/* Shipments — every AWB child, split dispatches and RETURN labels
              included (the order-level rollup excludes RETURN, so this panel
              is the only place a dead label stays visible). */}
          {shipments.length > 0 ? (
            <section className="overflow-hidden rounded-card bg-card shadow-card">
              <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
                <Icon name="box-bold-duotone" size={17} className="text-sage" />
                <h2 className="font-display text-sec font-bold">Shipments</h2>
                <span className="ml-auto text-cap text-mute">
                  {shipments.length > 1 ? `split dispatch — ${shipments.length} AWBs` : "1 AWB"}
                </span>
              </header>
              <div>
                {shipments.map((s) => (
                  <div key={s.awb} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="mono font-display text-dense font-semibold">{s.awb}</div>
                      <div className="mt-0.5 text-cap text-mute">
                        {(s.courier ?? "—").replace("_", " ")}
                        {s.isPollable ? "" : " · manual lane"}
                        {/* Pickup date from the eShipz scan history (set-once);
                            falls back to the spine pickup date for orders the
                            poller never saw in transit. Blank when neither. */}
                        {s.pickedUpTs ?? s.trackingPickTs
                          ? ` · picked up ${fmtDate(s.pickedUpTs ?? s.trackingPickTs)}`
                          : ""}
                        {s.deliveredTs ? ` · delivered ${fmtDate(s.deliveredTs)}` : s.expectedDeliveryDate ? ` · expected ${fmtDate(s.expectedDeliveryDate)}` : ""}
                      </div>
                    </div>
                    {s.shipmentStatus ? (
                      <StatusPill size="sm" visual={SHIPMENT_VISUAL[s.shipmentStatus]} />
                    ) : (
                      <span className="text-cap text-mute">no scan yet</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Tracking */}
          {o.lrNumber ? (
            <section className="overflow-hidden rounded-card bg-card shadow-card">
              <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
                <Icon name="routing-2-bold-duotone" size={17} className="text-sage" />
                <h2 className="font-display text-sec font-bold">Tracking</h2>
                {o.logisticsPartner === "SELF" ? (
                  <span className="ml-auto rounded-full bg-ofd-bg px-2 py-0.5 text-meta font-bold text-ofd">
                    manual lane — no eShipz feed
                  </span>
                ) : null}
              </header>
              <div className="space-y-2 px-5 py-4 text-dense">
                <div className="flex justify-between gap-3">
                  <span className="text-mute">LR / AWB</span>
                  <span className="mono font-display font-semibold">{o.lrNumber}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-mute">Courier</span>
                  <span className="font-semibold">{o.logisticsPartner?.replace("_", " ")}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-mute">Latest</span>
                  <span className="text-right text-ink-soft">
                    {o.trackingLatestMessage ?? "Awaiting first scan"}
                    {o.lastCheckpointCity ? <span className="block text-cap text-mute">{o.lastCheckpointCity}</span> : null}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-mute">Expected</span>
                  <span className="mono">{fmtDate(o.expectedDate)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-mute">Attempts</span>
                  <span className={cn("mono", o.deliveryAttempts > 1 && "font-bold text-breach")}>{o.deliveryAttempts}</span>
                </div>
                <div className="flex gap-2 pt-2">
                  {o.trackingLink ? (
                    <a
                      href={o.trackingLink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 rounded-control border border-line-control bg-paper py-2 text-center text-dense font-semibold text-ink-soft transition-colors hover:border-sage hover:text-sage"
                    >
                      Courier tracking ↗
                    </a>
                  ) : null}
                  {o.podLink ? (
                    <a
                      href={o.podLink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 rounded-control border border-line-control bg-paper py-2 text-center text-dense font-semibold text-ink-soft transition-colors hover:border-sage hover:text-sage"
                    >
                      POD ↗
                    </a>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* Field grid with per-field source + manual override */}
      <div className="mt-3.5">
        <FieldGrid
          order={o}
          sources={Object.fromEntries(lastSource)}
          rights={{
            merch: policy.canEditMerch || policy.isAdmin,
            wh: policy.canEditWarehouse || policy.isAdmin,
            logistics: policy.canEditLogistics || policy.isAdmin,
            recon: policy.canEditReconciliation || policy.isAdmin,
          }}
        />
      </div>
    </>
  );
}
