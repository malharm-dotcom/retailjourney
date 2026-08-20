// Sync orchestration (M2 part 2). Requires a database — sync never runs on
// the in-memory repo. Every run writes a SyncRun row; every synced write goes
// through OrderEvents with source=SYNCED; fields last edited MANUAL are never
// overwritten (the conflict is logged instead — manual wins, PRD §2).

import { mapDistributionRows, isPollableAwb, type MappedOrder } from "../distribution-map";
import { prisma, databaseConfigured } from "../db";
import { isoFromEpochMs, isoFromIstNtz, istDateOf, nowIso, istToday } from "../ist";
import { TERMINAL_STATUSES, WH_FLOW, canTransitionShipment, isDeadShipment, rollupOverall, rollupShipments } from "../journey";
import { orderToDb, orderToDomain, shipmentToDb, shipmentToDomain, storeToDomain } from "../prisma-map";
import { buildInheritedTat, normStoreKey, resolveQcParent, shouldInheritQcTat, type TatTemplate } from "../qc-tat";
import { flattenRulebook, rulebookTemplateFor, type RulebookOrderType, type RulebookViewRow } from "../rulebook-map";
import { slaState } from "../sla";
import {
  SPINE_SWEEP_DAYS,
  ntzValue,
  queryRetailJourneySpine,
  snowflakeConfigured,
  isProbeableOrderName,
  spineHasEventTs,
  spineOrderDateFloor,
  spinePresentOrderNames,
  type DistributionRow,
} from "../snowflake";
import { readRulebookSnapshot } from "../snowflake-rulebook";
import { FACILITIES, type Order, type OrderShipment, type OrderStatus, type OverallStatus, type ShipmentStatus, type Source, type Store } from "../types";
import { EshipzTrackingSource, eshipzConfigured, fetchShipmentMeta, mapShipment, type EshipzShipment } from "./eshipz-source";
import type { TrackingUpdate } from "./types";

export type SyncSource = "ESHIPZ" | "ESHIPZ_WEBHOOK" | "SNOWFLAKE";

export interface SyncSummary {
  source: SyncSource;
  ok: boolean;
  fetched: number;
  upserted: number;
  conflicts: number;
  errors: string[];
}

const MAX_ERRORS_STORED = 25;

/** Fields updated silently (no OrderEvent) — they churn every run and would
 *  drown the journey timeline. Status/shipment/delivery changes always log. */
const QUIET_FIELDS = new Set<keyof Order>([
  "checkpoints",
  "trackingLatestMessage",
  "trackingLatestLocation",
  "lastCheckpointCity",
  "lastCheckpointState",
  "eshipStatus",
  "trackingStatus",
  "trackingSubStatus",
  "expectedDate",
  "trackingLink",
  "ucStatus",
  "fulfilledQty",
  "latestOfdDate",
  // Derived alongside an explicitly-logged status/shipment transition:
  "statusSource",
  "shipmentSource",
  "shippedTs",
  "firstOfdDate",
  "deliveredTs",
  "deliveredDate",
  "deliveryAttempts",
  "createdTs",
  "dispatchedTs",
  "dispatchedDate",
  // Snowflake enrichment — refreshed hourly, would drown the timeline:
  "receiverCity",
  "receiverState",
  "receiverPostalCode",
  "sales30d",
  "storeRank",
  "bestTat",
  "targetOrderDay",
  "targetOrderCutoff",
  "targetHandoverDay",
  "targetHandoverCutoff",
  "targetPickupDay",
  "targetDeliveryDay",
  "pickupTat",
  "deliveryTat",
  "orderPlacementSla",
  "handoverSla",
  "trackingNumber",
  "courierPartner",
  "laneClassification",
  "merchandiser",
  "areaManager",
]);

const val = (v: unknown): string =>
  v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

interface PendingEvent {
  field: string;
  fromValue: string | null;
  toValue: string;
  source: Source;
  actorId: string | null;
  note?: string;
}

/** Stable stringify — Postgres jsonb does NOT preserve object key order, so a
 *  plain JSON.stringify compare of stored vs fresh checkpoints always differs
 *  (verified live: every run re-updated identical checkpoints). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function eq(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object") return canonical(a) === canonical(b);
  return a === b;
}

/**
 * The overallStatus a synced patch resolves to, and whether that is a MOVE.
 *
 * Extracted from applySyncPatch because the rollup used to be computed AFTER
 * that function's no-op early return: a patch whose only effect was a changed
 * overallStatus (an `overallStatusOverride` from the split-dispatch rollup,
 * with every scalar field already equal) returned `changed: false` and wrote
 * NOTHING. Live consequence — spine rows that had resolved to DELIVERED kept
 * rendering In Transit because the override never reached the database.
 * (Exported for the precedence tests only.)
 */
export function resolveOverallStatus(
  o: Order,
  data: Partial<Order>,
  override?: OverallStatus,
): { next: OverallStatus; changed: boolean } {
  const next = override ?? rollupOverall({ ...o, ...data });
  return { next, changed: next !== o.overallStatus };
}

/**
 * Write a SYNCED patch to an existing order: manual fields are skipped (with
 * a conflict OrderEvent when the values differ), unchanged fields are no-ops
 * (idempotent), meaningful changes get OrderEvents.
 */
async function applySyncPatch(
  o: Order,
  patch: Partial<Order>,
  extraEvents: PendingEvent[] = [],
  source: Source = "SYNCED",
  overallStatusOverride?: OverallStatus,
): Promise<{ changed: boolean; conflicts: number }> {
  const manual = new Set(o.manualFields ?? []);
  const alreadyLogged = new Set(extraEvents.map((e) => e.field));
  const data: Record<string, unknown> = {};
  const events: PendingEvent[] = [...extraEvents];
  let conflicts = 0;

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const key = k as keyof Order;
    const prev = o[key];
    if (eq(prev, v)) continue;
    if (manual.has(k)) {
      conflicts += 1;
      events.push({
        field: k,
        fromValue: val(prev),
        toValue: val(v),
        source,
        actorId: null,
        note: "sync conflict — manual value kept",
      });
      continue;
    }
    data[k] = v;
    if (!QUIET_FIELDS.has(key) && !alreadyLogged.has(k)) {
      events.push({ field: k, fromValue: prev == null ? null : val(prev), toValue: val(v), source, actorId: null });
    }
  }

  // Resolved BEFORE the no-op check: a moved overallStatus is itself a change
  // worth writing, even when no other field differs.
  const overall = resolveOverallStatus(o, data as Partial<Order>, overallStatusOverride);
  if (Object.keys(data).length === 0 && events.length === 0 && !overall.changed) {
    return { changed: false, conflicts };
  }
  data.overallStatus = overall.next;

  const db = prisma();
  await db.$transaction([
    db.order.update({ where: { id: o.id }, data: orderToDb(data as Partial<Order>) }),
    ...(events.length
      ? [db.orderEvent.createMany({ data: events.map((e) => ({ ...e, orderId: o.id })) })]
      : []),
  ]);
  return { changed: Object.keys(data).length > 0, conflicts };
}

async function startRun(source: SyncSource) {
  return prisma().syncRun.create({ data: { source } });
}

async function finishRun(
  id: string,
  summary: Omit<SyncSummary, "source">,
  note?: string,
  watermark?: string,
): Promise<void> {
  await prisma().syncRun.update({
    where: { id },
    data: {
      finishedAt: new Date(),
      ok: summary.ok,
      rowsFetched: summary.fetched,
      rowsUpserted: summary.upserted,
      conflicts: summary.conflicts,
      errors: summary.errors.length ? summary.errors.slice(0, MAX_ERRORS_STORED) : undefined,
      ...(note ? { note } : {}),
      ...(watermark !== undefined ? { watermark } : {}),
    },
  });
}

/** SyncRun.source for scheduler lifecycle markers. Deliberately outside the
 *  SyncSource union — it is not a data source, it is proof-of-life for the
 *  in-app scheduler, and it must never be picked up by the per-source
 *  freshness strip or the admin health cards. */
const SCHEDULER_SOURCE = "SCHEDULER";

/**
 * Boot marker: a durable record that this process started with the schedulers
 * ARMED. Without it, "no SyncRun rows" is ambiguous between "the scheduler
 * never started" (env gate / instrumentation) and "it started but every run
 * died before writing a row" — the exact ambiguity that let both pollers sit
 * silently stale for three days.
 */
export async function recordSchedulerBoot(note: string): Promise<void> {
  if (!databaseConfigured()) return;
  try {
    await prisma().syncRun.create({
      data: { source: SCHEDULER_SOURCE, finishedAt: new Date(), ok: true, note: note.slice(0, 500) },
    });
  } catch (e) {
    console.error("[sync] could not write scheduler boot marker:", e instanceof Error ? e.message : e);
  }
}

/**
 * Persist a COMPLETED FAILED run for a tick that blew up before startRun ever
 * created a row — a thrown dynamic import, an unconfigured credential, a dead
 * connection. Silence must never render as health: with this, the freshness
 * strip goes red (failed) instead of merely drifting stale.
 */
export async function recordFailedRun(source: SyncSource, message: string): Promise<void> {
  if (!databaseConfigured()) return;
  try {
    await prisma().syncRun.create({
      data: { source, finishedAt: new Date(), ok: false, errors: [message.slice(0, 500)] },
    });
  } catch (e) {
    console.error("[sync] could not persist failed run:", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Shared sync helpers (status guard + unmatched-channel review queue)

/** Forward-only status guard: sync may never regress the floor's progress,
 *  pull an order out of ON_HOLD, or resurrect a terminal order.
 *  (Exported for the precedence tests only.) */
export function guardedStatus(current: Order["status"], next?: Order["status"]): Order["status"] | undefined {
  if (!next || next === current) return undefined;
  if (TERMINAL_STATUSES.includes(current)) return undefined;
  if (TERMINAL_STATUSES.includes(next)) return next;
  if (current === "ON_HOLD") return undefined;
  const cur = WH_FLOW.indexOf(current);
  const nxt = WH_FLOW.indexOf(next);
  if (nxt <= cur) return undefined;
  return next;
}

/** Unmatched channels are collected in-memory per run, then flushed once.
 *  orderCount is SET to the run's distinct-order count — never incremented —
 *  so the number always means "orders currently held for this channel", not
 *  cumulative sync attempts (previous inflated counts self-correct on the
 *  next run). */
type UnmatchedMap = Map<string, Set<string>>;

function noteUnmatched(map: UnmatchedMap, channel: string, soNumber: string): void {
  let sos = map.get(channel);
  if (!sos) map.set(channel, (sos = new Set()));
  sos.add(soNumber);
}

async function flushUnmatched(map: UnmatchedMap, resolves: (channel: string) => boolean): Promise<void> {
  const db = prisma();
  for (const [channel, sos] of map) {
    const sample = [...sos].slice(0, 10);
    await db.unmatchedChannel.upsert({
      where: { channel },
      create: { channel, orderCount: sos.size, sampleSoNumbers: sample },
      update: { lastSeenAt: new Date(), orderCount: sos.size, sampleSoNumbers: sample },
    });
  }
  // Queue rows whose channel now resolves to a store (mapped in Admin or bulk
  // loaded) are done reviewing — drop them so the queue only shows live gaps.
  const rows = await db.unmatchedChannel.findMany();
  for (const u of rows) {
    if (resolves(u.channel)) await db.unmatchedChannel.delete({ where: { id: u.id } });
  }
}

// ---------------------------------------------------------------------------
// eShipz

/**
 * Persist the AWB's pickup timestamp on its shipment child, SET-ONCE: written
 * the first time a pickup scan is seen and NEVER overwritten or nulled by a
 * later poll (a Delivered poll must not erase it — the `pickedUpTs: null` guard
 * makes the write a no-op once set). Also a no-op when there is no pickup time
 * or no child row for this AWB yet. Parallel to the order-level status write:
 * it touches no Order field and changes no status output.
 */
async function persistPickedUp(soNumber: string, awb: string, pickedUpTs?: string): Promise<void> {
  if (!pickedUpTs) return;
  await prisma().orderShipment.updateMany({
    where: { soNumber, awb, pickedUpTs: null },
    data: { pickedUpTs: new Date(pickedUpTs) },
  });
}

function buildShipmentPatch(o: Order, u: TrackingUpdate): { patch: Partial<Order>; events: PendingEvent[] } {
  const patch: Partial<Order> = {
    eshipStatus: u.tag,
    trackingStatus: u.tag,
    trackingSubStatus: u.subtag,
    ...(u.checkpoints.length
      ? {
          checkpoints: u.checkpoints,
          trackingLatestMessage: u.checkpoints[0]?.remark,
          lastCheckpointCity: u.checkpoints[0]?.city,
          lastCheckpointState: u.checkpoints[0]?.state,
          trackingLatestLocation: u.checkpoints[0]?.city,
        }
      : {}),
    ...(u.expectedDate ? { expectedDate: u.expectedDate } : {}),
    ...(u.podLink ? { podLink: u.podLink } : {}),
    ...(u.trackingLink && !o.trackingLink ? { trackingLink: u.trackingLink } : {}),
  };
  const events: PendingEvent[] = [];
  const next = u.status;
  const manualShipment = (o.manualFields ?? []).includes("shipmentStatus");

  if (next && next !== o.shipmentStatus && !manualShipment && canTransitionShipment(o.shipmentStatus, next)) {
    patch.shipmentStatus = next;
    patch.shipmentSource = "SYNCED";
    const now = nowIso();
    if (next === "IN_TRANSIT" && !o.shippedTs) {
      patch.shippedTs = u.checkpoints[u.checkpoints.length - 1]?.date ?? now;
    }
    if (next === "OUT_FOR_DELIVERY") {
      const ofdAt = u.checkpoints[0]?.date ?? now;
      if (!o.firstOfdDate) patch.firstOfdDate = ofdAt;
      patch.latestOfdDate = ofdAt;
    }
    if (next === "DELIVERED") {
      const deliveredTs = u.deliveredTs ?? u.checkpoints[0]?.date ?? now;
      patch.deliveredTs = deliveredTs;
      patch.deliveredDate = istDateOf(deliveredTs);
      patch.deliveryAttempts = o.deliveryAttempts + 1;
    }
    if (next === "DELIVERY_FAILED") {
      patch.deliveryAttempts = o.deliveryAttempts + 1;
      const ofdAt = u.checkpoints[0]?.date ?? now;
      if (!o.firstOfdDate) patch.firstOfdDate = ofdAt;
      patch.latestOfdDate = ofdAt;
    }
    events.push({
      field: "shipmentStatus",
      fromValue: o.shipmentStatus ?? null,
      toValue: next,
      source: "SYNCED",
      actorId: null,
      note: u.checkpoints[0]?.remark,
    });
  } else if (next && next !== o.shipmentStatus && manualShipment) {
    events.push({
      field: "shipmentStatus",
      fromValue: o.shipmentStatus ?? null,
      toValue: next,
      source: "SYNCED",
      actorId: null,
      note: "sync conflict — manual value kept",
    });
  }

  // Transit exceptions keep the shipment IN_TRANSIT but surface on the journey
  // timeline (e.g. "Vehicle delayed") — only when the message is new.
  if (u.exceptionNote && u.exceptionNote !== o.trackingLatestMessage) {
    events.push({
      field: "trackingException",
      fromValue: null,
      toValue: u.exceptionNote,
      source: "SYNCED",
      actorId: null,
      note: u.subtag,
    });
  }

  return { patch, events };
}

export async function runEshipzSync(): Promise<SyncSummary> {
  if (!databaseConfigured()) throw new Error("eShipz sync requires DATABASE_URL");
  if (!eshipzConfigured()) throw new Error("eShipz sync requires ESHIPZ_API_TOKEN");

  const run = await startRun("ESHIPZ");
  const summary: SyncSummary = { source: "ESHIPZ", ok: false, fetched: 0, upserted: 0, conflicts: 0, errors: [] };
  const db = prisma();

  try {
    // Every non-delivered order that has an AWB (trackingNumber, falling back
    // to lrNumber) — regardless of WH stage, so pickup-pending shipments are
    // tracked too. SELF (self-delivery) has no eShipz feed.
    const rows = await db.order.findMany({
      where: {
        AND: [
          { OR: [{ trackingNumber: { not: null } }, { lrNumber: { not: null } }] },
          { OR: [{ shipmentStatus: null }, { shipmentStatus: { not: "DELIVERED" } }] },
          { OR: [{ logisticsPartner: null }, { logisticsPartner: { not: "SELF" } }] },
        ],
      },
    });
    // Skip non-pollable shipments entirely — self-delivery/porter pseudo-AWBs
    // ("SN417") have no eShipz feed; Snowflake is their transit authority.
    const nonPollableAwbs = new Set(
      (
        await db.orderShipment.findMany({ where: { isPollable: false }, select: { awb: true } })
      ).map((r) => r.awb),
    );
    const orders = rows.map(orderToDomain).filter((o) => {
      const awb = o.trackingNumber ?? o.lrNumber!;
      return isPollableAwb(awb, o.courierPartner ?? o.logisticsPartner) && !nonPollableAwbs.has(awb);
    });
    const byAwb = new Map<string, Order>();
    for (const o of orders) {
      if (o.lrNumber) byAwb.set(o.lrNumber, o);
      if (o.trackingNumber) byAwb.set(o.trackingNumber, o); // preferred key wins
    }
    const awbs = [...new Set(orders.map((o) => o.trackingNumber ?? o.lrNumber!))];
    summary.fetched = orders.length;

    if (orders.length) {
      const source = new EshipzTrackingSource();
      // A failed chunk lands in summary.errors (so the run reads ok:false and
      // the Admin card goes red) WITHOUT discarding the chunks that succeeded.
      const updates = await source.fetchTracking(awbs, (m) => summary.errors.push(m));

      // v1 enrichment ONLY for matched orders still missing trackingLink.
      let meta = new Map<string, { trackingLink?: string }>();
      const needLink = updates
        .map((u) => byAwb.get(u.trackingNumber))
        .filter((o): o is Order => Boolean(o && !o.trackingLink))
        .map((o) => o.trackingNumber ?? o.lrNumber!);
      if (needLink.length) {
        try {
          meta = await fetchShipmentMeta([...new Set(needLink)]);
        } catch (e) {
          summary.errors.push(`enrichment: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const u of updates) {
        const o = byAwb.get(u.trackingNumber);
        if (!o) continue;
        u.trackingLink = meta.get(u.trackingNumber)?.trackingLink;
        try {
          const { patch, events } = buildShipmentPatch(o, u);
          // Conflict events for manual shipmentStatus are built above; count them.
          const conflictEvents = events.filter((e) => e.note === "sync conflict — manual value kept").length;
          const res = await applySyncPatch(o, patch, events);
          if (res.changed) summary.upserted += 1;
          summary.conflicts += res.conflicts + conflictEvents;
          await persistPickedUp(o.soNumber, u.trackingNumber, u.pickedUpTs);
        } catch (e) {
          summary.errors.push(`${u.trackingNumber}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    summary.ok = summary.errors.length === 0;
  } catch (e) {
    summary.errors.push(e instanceof Error ? e.message : String(e));
    summary.ok = false;
  }

  await finishRun(run.id, summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Snowflake distribution_analytics (hourly) — the order data source that
// replaced the abandoned UC integration. Order (parent) + OrderShipment
// (children) grain; precedence manual > eShipz-poller > Snowflake, EXCEPT that
// the poller only outranks Snowflake on pollable shipments — for
// self-delivery/porter, Snowflake IS the transit authority.

/** Order-level Phase-B fields owned by the poller on pollable shipments.
 *  (Exported for the precedence tests only.) */
export const ORDER_TRANSIT_FIELDS: (keyof Order)[] = [
  "shipmentStatus",
  "shipmentSource",
  "eshipStatus",
  "trackingStatus",
  "trackingSubStatus",
  "trackingLatestLocation",
  "trackingLatestMessage",
  "lastCheckpointCity",
  "lastCheckpointState",
  "trackingLink",
  "podLink",
  "expectedDate",
  "deliveredDate",
  "deliveredTs",
  "deliveryAttempts",
  "pickupAttempts",
  "firstOfdDate",
  "latestOfdDate",
  "shippedTs",
];

function isKnownFacility(f?: string): boolean {
  return Boolean(f && (FACILITIES as readonly string[]).includes(f));
}

/** Order-level transit patch from the (single) authoritative child — applied
 *  only when the order has NO pollable shipment (self-delivery/porter).
 *  (Exported for the precedence tests only.) */
export function transitPatchFromChild(o: Order, s: OrderShipment): Partial<Order> {
  const patch: Partial<Order> = {
    eshipStatus: s.eshipStatus,
    trackingStatus: s.trackingStatus ?? s.eshipStatus,
    trackingSubStatus: s.trackingSubStatus,
    trackingLatestLocation: s.trackingLatestLocation,
    trackingLatestMessage: s.trackingLatestMessage,
    lastCheckpointCity: s.lastCheckpointCity,
    lastCheckpointState: s.lastCheckpointState,
    trackingLink: s.trackingLink,
    podLink: s.podLink,
    expectedDate: s.expectedDeliveryDate,
    deliveryAttempts: s.deliveryAttempts,
    pickupAttempts: s.pickupAttempts,
    firstOfdDate: s.firstOfdTs,
    latestOfdDate: s.latestOfdTs,
  };
  const next = s.shipmentStatus;
  const manualShipment = (o.manualFields ?? []).includes("shipmentStatus");
  if (next && next !== o.shipmentStatus && !manualShipment && canTransitionShipment(o.shipmentStatus, next)) {
    patch.shipmentStatus = next;
    patch.shipmentSource = "SYNCED_SNOWFLAKE";
    if (next === "IN_TRANSIT" && !o.shippedTs) patch.shippedTs = s.trackingPickTs ?? nowIso();
    if (next === "DELIVERED") {
      const deliveredTs = s.deliveredTs ?? nowIso();
      patch.deliveredTs = deliveredTs;
      patch.deliveredDate = istDateOf(deliveredTs);
    }
  }
  return patch;
}

/**
 * The child that speaks for the order when the SPINE itself has reached a
 * terminal verdict — DELIVERED, or a dead label — and `undefined` while any
 * sibling is still alive.
 *
 * Gated on the ROLLUP rather than on any single child on purpose: that is what
 * keeps "a delivered replacement wins" and "an in-flight sibling holds the
 * order open" true at the same time.
 * (Exported for the precedence tests only.)
 */
export function spineTerminalChild(children: OrderShipment[]): OrderShipment | undefined {
  const rollup = rollupShipments(children.map((c) => c.shipmentStatus));
  if (rollup !== "DELIVERED" && !isDeadShipment(rollup)) return undefined;
  return children.find((c) => c.shipmentStatus === rollup);
}

/** Recompute the Phase-A SLA verdicts against actuals (Snowflake only seeds). */
function phaseASla(patch: Partial<Order>, existing?: Order): Partial<Order> {
  const out: Partial<Order> = {};
  const orderTs = patch.orderTimestamp ?? existing?.orderTimestamp;
  const placement = slaState(patch.orderCutoffTs ?? existing?.orderCutoffTs, orderTs);
  if (placement) out.orderPlacementSla = placement;
  const handoverActual =
    existing?.dispatchedTs ?? patch.manifestedTs ?? existing?.manifestedTs;
  const handover = slaState(patch.handoverDeadlineTs ?? existing?.handoverDeadlineTs, handoverActual);
  if (handover) out.handoverSla = handover;
  return out;
}

async function upsertShipments(
  soNumber: string,
  mapped: MappedOrder["shipments"],
  existingChildren: OrderShipment[],
): Promise<{ children: OrderShipment[]; events: PendingEvent[] }> {
  const db = prisma();
  const events: PendingEvent[] = [];
  const children = new Map(existingChildren.map((c) => [c.awb, c]));

  for (const s of mapped) {
    const prev = children.get(s.awb);
    const { awb, ...rest } = s;
    const data = shipmentToDb(rest);
    // Never regress a child that already reached DELIVERED (terminal).
    if (prev?.shipmentStatus === "DELIVERED") {
      delete data.shipmentStatus;
      delete data.deliveredTs;
    }
    const row = await db.orderShipment.upsert({
      where: { soNumber_awb: { soNumber, awb } },
      create: { soNumber, awb, ...data } as never,
      update: data,
    });
    const next = shipmentToDomain(row);
    children.set(awb, next);
    if (!prev) {
      events.push({
        field: "shipment",
        fromValue: null,
        toValue: awb,
        source: "SYNCED_SNOWFLAKE",
        actorId: null,
        note: `AWB ${awb}${s.courier ? ` via ${s.courier}` : ""}${s.isPollable ? "" : " (not pollable)"}`,
      });
    } else if (s.shipmentStatus && next.shipmentStatus !== prev.shipmentStatus) {
      events.push({
        field: "shipmentStatus",
        fromValue: prev.shipmentStatus ?? null,
        toValue: next.shipmentStatus ?? "",
        source: "SYNCED_SNOWFLAKE",
        actorId: null,
        note: `AWB ${awb}`,
      });
    }
  }
  return { children: [...children.values()], events };
}

/** The parent's authoritative TAT pattern, read from its rulebook row (serving
 *  WH preferred, the other type as fallback) — the source a QC order inherits
 *  from now that the rulebook table is available. Replaces the old heuristic
 *  that scavenged the pattern off the parent's most recent order. */
function parentRulebookTemplate(
  rulebookRows: RulebookViewRow[],
  parent: Store,
  type: Order["type"] | undefined,
): TatTemplate | undefined {
  const preferred: RulebookOrderType = type === "RPL" ? "RPL" : "FRESH";
  const other: RulebookOrderType = preferred === "FRESH" ? "RPL" : "FRESH";
  const row =
    rulebookTemplateFor(rulebookRows, parent.finalStore, preferred, parent.facility) ??
    rulebookTemplateFor(rulebookRows, parent.finalStore, other, parent.facility);
  if (!row) return undefined;
  return {
    targetOrderDay: row.targetOrderDay,
    targetOrderCutoff: row.targetOrderCutoff,
    targetHandoverDay: row.targetHandoverDay,
    targetHandoverCutoff: row.targetHandoverCutoff,
    targetPickupDay: row.targetPickupDay,
    targetDeliveryDay: row.targetDeliveryDay,
    bestTat: row.bestTatDays,
    laneClassification: row.laneClassification,
    zone: row.zone,
  };
}

/**
 * QC TAT inheritance (in place on m.patch): a quick-commerce store has no
 * rulebook row of its own, so its rows carry no deadlines — inherit the PARENT
 * store's rulebook row (resolved via the shared branchCode), re-anchored on
 * this order's date. Edge cases surface instead of guessing: no parent /
 * ambiguous parent / parent without a rulebook row all leave the patch
 * untouched (legs read "no target", never a false breach) and the situation is
 * reported on the SyncRun note.
 */
async function applyQcInheritance(
  m: MappedOrder,
  store: Store,
  stores: Store[],
  rulebookRows: RulebookViewRow[],
  notes: Set<string>,
): Promise<void> {
  const r = resolveQcParent(store, stores);
  if (!r.parent) {
    notes.add(
      r.reason === "NO_PARENT"
        ? `QC store ${store.finalStore}: no parent shares branch code ${store.branchCode} — no TAT inherited`
        : `QC store ${store.finalStore}: branch code ${store.branchCode} matches ${r.candidates.length} non-QC stores — ambiguous, no TAT inherited`,
    );
    return;
  }
  const tmpl = parentRulebookTemplate(rulebookRows, r.parent, m.patch.type);
  const inherited = tmpl && buildInheritedTat(m.patch.orderDate ?? istToday(), tmpl);
  if (!inherited) {
    notes.add(
      `QC store ${store.finalStore}: parent ${r.parent.finalStore} has no rulebook row — no TAT inherited`,
    );
    return;
  }
  Object.assign(m.patch, inherited);
  if (!m.patch.laneClassification && tmpl.laneClassification) m.patch.laneClassification = tmpl.laneClassification;
  if ((!m.patch.zone || m.patch.zone === "UNMAPPED") && tmpl.zone) m.patch.zone = tmpl.zone as Order["zone"];
  m.patch.tatInheritedFrom = r.parent.finalStore;
}

async function createOrderFromSnowflake(m: MappedOrder, store: Store): Promise<void> {
  const db = prisma();
  const status: OrderStatus = m.shipments.length
    ? "DISPATCHED_TO_STORE"
    : m.patch.manifestedTs
      ? "RTS_LOGIC"
      : "NOT_STARTED";
  const shipRollup = rollupShipments(m.shipments.map((s) => s.shipmentStatus));
  const primary = m.shipments.find((s) => s.isPollable) ?? m.shipments[0];

  const base: Partial<Order> = {
    soNumber: m.soNumber,
    orderDate: m.patch.orderDate ?? istToday(),
    orderTimestamp: m.patch.orderTimestamp ?? nowIso(),
    channel: store.channel,
    storeId: store.id,
    storeNameFormat: store.storeName,
    finalStore: store.finalStore,
    ownership: store.ownership,
    state: store.storeState,
    type: "OTHER",
    qty: 0,
    ...m.patch,
    facility: isKnownFacility(m.patch.facility) ? m.patch.facility : store.facility,
    status,
    statusSource: "SYNCED_SNOWFLAKE",
    deliveryAttempts: primary?.deliveryAttempts ?? 0,
    pickupAttempts: primary?.pickupAttempts ?? 0,
    trackingNumber: primary?.awb,
    courierPartner: primary?.courier,
    ...phaseASla(m.patch),
  };
  base.overallStatus = m.shipments.length
    ? rollupOverall({ status, shipmentStatus: shipRollup })
    : (m.overallStatusSeed ?? rollupOverall({ status, shipmentStatus: undefined }));
  // A lone non-pollable shipment makes Snowflake the transit authority from birth.
  const pollable = m.shipments.some((s) => s.isPollable);
  if (!pollable && primary) {
    Object.assign(
      base,
      transitPatchFromChild({ ...(base as Order), manualFields: [] }, primary as OrderShipment),
    );
    base.overallStatus = rollupOverall({ status, shipmentStatus: base.shipmentStatus });
  }

  const row = await db.order.create({ data: orderToDb(base) as never });
  const events: PendingEvent[] = [
    {
      field: "status",
      fromValue: null,
      toValue: status,
      source: "SYNCED_SNOWFLAKE",
      actorId: null,
      note: "Order ingested from Snowflake distribution_analytics",
    },
  ];
  if (base.tatInheritedFrom) {
    events.push({
      field: "tatInheritedFrom",
      fromValue: null,
      toValue: base.tatInheritedFrom,
      source: "SYNCED_SNOWFLAKE",
      actorId: null,
      note: "QC store — TAT inherited from the parent store via the shared branch code",
    });
  }
  const { events: shipmentEvents } = await upsertShipments(m.soNumber, m.shipments, []);
  await db.orderEvent.createMany({
    data: [...events, ...shipmentEvents].map((e) => ({ ...e, orderId: row.id })),
  });
}

async function syncSnowflakeOrder(
  m: MappedOrder,
  existing: Order,
  existingChildren: OrderShipment[],
): Promise<{ changed: boolean; conflicts: number }> {
  // Terminal-freeze: a delivered rollup (or all children delivered) is never
  // reopened by the hourly sync — spine/enrichment may still refresh.
  const frozen =
    existing.overallStatus === "DELIVERED" ||
    (existingChildren.length > 0 && existingChildren.every((c) => c.shipmentStatus === "DELIVERED"));

  const { children, events } = await upsertShipments(m.soNumber, m.shipments, existingChildren);

  const patch: Partial<Order> = { ...m.patch, ...phaseASla(m.patch, existing) };
  if (!isKnownFacility(patch.facility)) delete patch.facility;

  const inferred: OrderStatus | undefined = m.shipments.length
    ? "DISPATCHED_TO_STORE"
    : m.patch.manifestedTs
      ? "RTS_LOGIC"
      : undefined;
  patch.status = frozen ? undefined : guardedStatus(existing.status, inferred);
  if (patch.status) patch.statusSource = "SYNCED_SNOWFLAKE";

  const hasPollable = children.some((c) => c.isPollable);
  let overallOverride: OverallStatus | undefined;
  /** Set when a TERMINAL spine verdict was reconciled onto the order below. */
  let spineTerminal: ShipmentStatus | undefined;

  if (frozen) {
    for (const f of ORDER_TRANSIT_FIELDS) delete patch[f];
  } else if (children.length) {
    if (!hasPollable) {
      // Self-delivery/porter: Snowflake owns the order-level transit fields.
      const primary = children[children.length - 1];
      Object.assign(patch, transitPatchFromChild(existing, primary));
    } else {
      // The poller owns transit on pollable shipments — Snowflake only fills
      // the keys the poller needs and never touches its fields.
      if (!existing.trackingNumber) {
        const p = children.find((c) => c.isPollable)!;
        patch.trackingNumber = p.awb;
        if (!existing.courierPartner) patch.courierPartner = p.courier;
      }

      // ...EXCEPT when the spine has reached a TERMINAL verdict. Furthest
      // forward wins across sources, and a terminal STATUS is as far forward
      // as it goes — so here the spine outranks the poller even on a pollable
      // AWB. That is not a tie being broken arbitrarily: this is exactly the
      // case where the poller has nothing to say, because the AWB reached the
      // spine and was never linked here, so it was never polled at all. Live:
      // 985 open orders against a terminal spine row, 833 of them with no
      // shipment child whatsoever (ANSAPL16017 — spine DELIVERED with a POD
      // on 2026-08-13 while the app still read Pickup Pending).
      //
      // Gated on the ROLLUP, not on any single child, so a delivered
      // replacement wins while a genuinely in-flight sibling still holds the
      // order open.
      const authoritative = spineTerminalChild(children);
      // transitPatchFromChild carries the guards with it: manual still wins,
      // and canTransitionShipment still refuses anything that would regress.
      if (authoritative) {
        Object.assign(patch, transitPatchFromChild(existing, authoritative));
        spineTerminal = patch.shipmentStatus;
      }
    }
    // Split-dispatch rollup: least-progressed child wins; the poller-tracked
    // AWB uses the fresher order-level state.
    const states = children.map((c) =>
      c.isPollable && (existing.trackingNumber === c.awb || existing.lrNumber === c.awb)
        ? (existing.shipmentStatus ?? c.shipmentStatus)
        : c.shipmentStatus,
    );
    overallOverride = rollupOverall({
      status: patch.status ?? existing.status,
      // A reconciled terminal verdict speaks for the order directly. The
      // blended `states` above deliberately prefers the ORDER-level status for
      // the poller-tracked AWB, which is the stale value we just overrode —
      // feeding it back in would undo the reconciliation we just made.
      shipmentStatus: spineTerminal ?? rollupShipments(states),
    });
  } else if (m.overallStatusSeed) {
    // Zero children: Snowflake's OVERALL_STATUS is used verbatim (seed only).
    overallOverride = m.overallStatusSeed;
  }

  return applySyncPatch(existing, patch, events, "SYNCED_SNOWFLAKE", overallOverride);
}

/**
 * The watermark carried forward is the newest event stamp among the rows this
 * run saw, compared as true instants (not string sort) so a differing
 * fractional-seconds width can never misorder two rows.
 *
 * Reads SPINE_LAST_EVENT_TS, falling back to LAST_UPDATED only while the spine
 * has yet to expose it. The fallback direction is the safe one: the event
 * stamp is a GREATEST over a set that includes LAST_UPDATED, so it is always
 * >= it — a watermark stored from the old column is therefore always behind
 * the new one and can only cause rows to be RE-read, never skipped.
 *
 * Rows with no stamp at all don't move it. Every value goes through ntzValue
 * first: Snowflake hands back a NULL timestamp as the literal string "NULL"
 * under fetchAsString, which is truthy.
 * (Exported for the watermark regression tests only.) */
export function maxSpineEventTs(rows: DistributionRow[]): string | undefined {
  let best: { raw: string; instant: number } | undefined;
  for (const r of rows) {
    const raw = ntzValue(r.SPINE_LAST_EVENT_TS) ?? ntzValue(r.LAST_UPDATED);
    if (!raw) continue;
    const iso = isoFromIstNtz(raw);
    if (!iso) continue;
    const instant = Date.parse(iso);
    if (!best || instant > best.instant) best = { raw, instant };
  }
  return best?.raw;
}

// ---------------------------------------------------------------------------
// Cancellation backstop — orders cancelled on Unicommerce after the app had
// already ingested them.
//
// A genuine UC cancellation is NOT a status the app can read. order_base
// filters cancellations out at the SQL level, so the order's row vanishes from
// the spine entirely and the app is left holding a stale open order with
// nothing to reconcile it against. Fixing that upstream — letting cancelled
// rows through carrying their status — is the real repair and remains the
// preferred one; RETAIL_JOURNEY_SPINE is a Maplemonk-owned base table this app
// only reads, so that is a data-team change, not one this repo can make. Until
// it lands, absence is the only available signal.
//
// Absence is a NEGATIVE signal and is treated with the suspicion that deserves.
// Four conditions must hold together before an order is condemned, and each
// closes a distinct way absence can lie:
//
//   1. The spine floor must be readable. No floor (empty/unreadable spine) =>
//      nothing is cancelled. Silence is never evidence.
//   2. The order must be NEWER than that floor. Below it, absence means the
//      spine aged the row out, not that anyone cancelled it. This doubles as
//      the blast-radius cap: a truncated or half-rebuilt spine raises the floor
//      above the population and the backstop stops condemning anything.
//   3. overallStatus must be WH_PROCESSING. Confirmed with Malhar: UC does not
//      permit cancelling a completed order, so a real cancellation can only
//      ever be seen at the warehouse stage. An order that reached pickup or
//      transit and then went missing is a DATA problem, not a cancellation, and
//      is deliberately left alone and visible.
//   4. The order must not already be terminal — nothing to do.
//
// Measured on the live spine before shipping: 79 app-open orders had no spine
// row, and warehouse_sla_performance confirmed all 79 as cancelled upstream
// (every line CANCELLED, 0 partial), all 79 WH_PROCESSING with no AWB. The
// other three candidate explanations — aged out, excluded by marketplace/order
// type rule, name mismatch — scored zero, and no spine row matched those names
// on any key column.

/** The order fields the backstop's decision reads — nothing else. */
export interface CancelCandidate {
  soNumber: string;
  /** "YYYY-MM-DD" — compared lexically against the spine floor, same shape. */
  orderDate: string;
  status: OrderStatus;
  overallStatus: OverallStatus;
}

/**
 * Which candidates an absent spine row condemns as cancelled upstream.
 *
 * Pure and total, so the guards above are testable without Snowflake or a
 * database. `presentInSpine` holds UPPER(TRIM) order names.
 * (Exported for the cancellation-backstop tests.)
 */
export function cancelledUpstream(
  candidates: CancelCandidate[],
  presentInSpine: Set<string>,
  spineFloor: string | undefined,
): CancelCandidate[] {
  // Guard 1 — no floor means the spine told us nothing this run.
  if (!spineFloor) return [];
  return candidates.filter(
    (c) =>
      // 0 — a name the presence probe cannot safely put in a SQL literal is
      // DROPPED from that query, so it always comes back "absent". Absent for
      // want of asking is not evidence of cancellation, and without this test
      // the drop would silently condemn instead of sparing.
      isProbeableOrderName(c.soNumber) &&
      !presentInSpine.has(c.soNumber.trim().toUpperCase()) &&
      c.orderDate >= spineFloor && // 2 — above the retention floor
      c.overallStatus === "WH_PROCESSING" && // 3 — UC can only cancel here
      !TERMINAL_STATUSES.includes(c.status), // 4 — not already terminal
  );
}

/**
 * Apply the backstop: mark condemned orders CANCELLED, with an OrderEvent each.
 *
 * The write deliberately does NOT go through applySyncPatch, for one reason
 * that must stay explicit: applySyncPatch honours manual-wins, and this write
 * must not. Malhar's call — a Unicommerce cancellation OUTRANKS a manual
 * status, because a warehouse operator marking an order PACKING does not make
 * it exist to pick. Overriding an operator is a real thing to do quietly, so
 * every such case is named in its own event note rather than blended in.
 *
 * `manualFields` is left intact on purpose: it is the record that a human once
 * set this field, and CANCELLED is absorbing in guardedStatus anyway, so no
 * later sync can act on it.
 */
export async function reconcileCancelledUpstream(): Promise<{
  scanned: number;
  cancelled: number;
  overrodeManual: number;
}> {
  const db = prisma();
  const rows = await db.order.findMany({
    where: { overallStatus: "WH_PROCESSING", status: { notIn: TERMINAL_STATUSES } },
    select: { id: true, soNumber: true, orderDate: true, status: true, overallStatus: true, manualFields: true },
  });
  if (!rows.length) return { scanned: 0, cancelled: 0, overrodeManual: 0 };

  // Both reads are independent of the hourly pull on purpose: a row missing
  // from a WATERMARKED result set is unchanged, not gone, so the incremental
  // rows can never answer "does this order still exist upstream?".
  const [floor, present] = await Promise.all([
    spineOrderDateFloor(),
    spinePresentOrderNames(rows.map((r) => r.soNumber)),
  ]);

  const byKey = new Map(rows.map((r) => [r.soNumber, r]));
  const condemned = cancelledUpstream(
    rows.map((r) => ({
      soNumber: r.soNumber,
      // @db.Date comes back as UTC midnight of the stored calendar date — the
      // same conversion prisma-map uses, and the shape MIN(ORDER_DATE) returns.
      orderDate: r.orderDate.toISOString().slice(0, 10),
      status: r.status as OrderStatus,
      overallStatus: r.overallStatus as OverallStatus,
    })),
    present,
    floor,
  );

  let overrodeManual = 0;
  for (const c of condemned) {
    const row = byKey.get(c.soNumber)!;
    const manual = (row.manualFields ?? []).includes("status");
    if (manual) overrodeManual += 1;
    await db.$transaction([
      db.order.update({
        where: { id: row.id },
        data: { status: "CANCELLED", statusSource: "SYNCED_SNOWFLAKE", cancelledTs: new Date() },
      }),
      db.orderEvent.create({
        data: {
          orderId: row.id,
          field: "status",
          fromValue: row.status,
          toValue: "CANCELLED",
          source: "SYNCED_SNOWFLAKE",
          actorId: null,
          // The timestamp records DETECTION, not the upstream cancellation —
          // the spine keeps no record of an order it has dropped.
          note: manual
            ? `Cancelled on Unicommerce — the order left the spine. Overrides the manual status ${row.status}: an upstream cancellation outranks a manual value. Detected by the sync.`
            : "Cancelled on Unicommerce — the order left the spine. Detected by the sync.",
        },
      }),
    ]);
  }
  return { scanned: rows.length, cancelled: condemned.length, overrodeManual };
}

/** Watermark of the last successful Snowflake run, or undefined for "no
 *  successful run yet" — the caller falls back to the full 20-day window. */
async function getSnowflakeWatermark(): Promise<string | undefined> {
  const run = await prisma().syncRun.findFirst({
    where: { source: "SNOWFLAKE", ok: true, watermark: { not: null } },
    orderBy: { startedAt: "desc" },
  });
  return run?.watermark ?? undefined;
}

export async function runSnowflakeSync(opts: { reseed?: boolean } = {}): Promise<SyncSummary> {
  if (!databaseConfigured()) throw new Error("Snowflake sync requires DATABASE_URL");
  if (!snowflakeConfigured()) {
    throw new Error("Snowflake sync requires SNOWFLAKE_ACCOUNT / SNOWFLAKE_USERNAME / SNOWFLAKE_PRIVATE_KEY");
  }

  const run = await startRun("SNOWFLAKE");
  const summary: SyncSummary = { source: "SNOWFLAKE", ok: false, fetched: 0, upserted: 0, conflicts: 0, errors: [] };
  const db = prisma();
  const priorWatermark = opts.reseed ? undefined : await getSnowflakeWatermark();

  try {
    // Probed per run: the app starts riding the event stamp the hour it
    // appears upstream, with no redeploy. Until then it reads with the dated
    // sweep alone, which is a BACKSTOP and not the fix — anything older than
    // the sweep stays unreachable — so the degraded mode is recorded on the
    // run rather than passing silently as health.
    const hasEventTs = await spineHasEventTs();
    // Reported through the run NOTE, not errors: a missing column is a
    // degraded read, not a failed one. Pushing it to errors would flip the run
    // to ok:false, which in turn freezes the watermark — punishing the
    // transitional state by degrading it further.
    const degradedNote = hasEventTs
      ? undefined
      : `spine is missing SPINE_LAST_EVENT_TS — reading with the ${SPINE_SWEEP_DAYS}-day sweep ONLY. ` +
        `That is a backstop, not the incremental fix: rows older than the sweep whose LAST_UPDATED ` +
        `never moved stay unreachable until the column lands.`;
    if (degradedNote) console.error(`[sync:snowflake] ${degradedNote}`);

    const rows = await queryRetailJourneySpine(priorWatermark, hasEventTs);
    summary.fetched = rows.length;
    const mapped = mapDistributionRows(rows);

    const stores = (await db.store.findMany()).map(storeToDomain);
    // Whitespace/hyphen-tolerant join key — Snowflake STORE strings drift
    // ("QC  KALYAN NAGAR", "HSR LAYOUT-2") and must still hit one store.
    const norm = normStoreKey;
    const byFinalStore = new Map(stores.map((s) => [norm(s.finalStore), s]));
    const byChannelCode = new Map(
      stores.filter((s) => s.channelCode).map((s) => [norm(s.channelCode!), s]),
    );
    const unmatched: UnmatchedMap = new Map();
    const qcNotes = new Set<string>();

    // QC TAT inheritance reads the parent's rulebook row. Load the latest
    // rulebook snapshot lazily and once per run — the fetch is paid only when a
    // QC order that needs inheritance actually appears (0 in the live window
    // today). A fetch failure degrades to "no TAT inherited", never a crash.
    let rulebookRows: RulebookViewRow[] | undefined;
    const loadRulebook = async (): Promise<RulebookViewRow[]> => {
      if (rulebookRows === undefined) {
        try {
          rulebookRows = flattenRulebook((await readRulebookSnapshot()).rows);
        } catch (e) {
          rulebookRows = [];
          qcNotes.add(
            `QC TAT inheritance: rulebook fetch failed (${e instanceof Error ? e.message : String(e)}) — no TAT inherited this run`,
          );
        }
      }
      return rulebookRows;
    };

    for (const m of mapped) {
      try {
        const existingRow = await db.order.findUnique({ where: { soNumber: m.soNumber } });
        const store = m.storeKey
          ? (byFinalStore.get(norm(m.storeKey)) ?? byChannelCode.get(norm(m.storeKey)))
          : undefined;

        if (store?.isQuickCommerce) {
          if (shouldInheritQcTat(store, m.patch)) {
            await applyQcInheritance(m, store, stores, await loadRulebook(), qcNotes);
          } else if (existingRow?.tatInheritedFrom) {
            // Upstream now bakes the QC store's own rulebook TAT — the
            // inherited marker no longer applies.
            (m.patch as Record<string, unknown>).tatInheritedFrom = null;
          }
        }

        if (!existingRow) {
          if (!store) {
            // Admin review queue — an unmatched STORE is never dropped silently.
            noteUnmatched(unmatched, m.storeKey || "(no store)", m.soNumber);
            continue;
          }
          await createOrderFromSnowflake(m, store);
          summary.upserted += 1;
        } else {
          const existingChildren = (
            await db.orderShipment.findMany({ where: { soNumber: m.soNumber } })
          ).map(shipmentToDomain);
          const res = await syncSnowflakeOrder(m, orderToDomain(existingRow), existingChildren);
          if (res.changed || m.shipments.length) summary.upserted += 1;
          summary.conflicts += res.conflicts;
        }
      } catch (e) {
        summary.errors.push(`${m.soNumber}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await flushUnmatched(unmatched, (c) => {
      const k = norm(c);
      return byFinalStore.has(k) || byChannelCode.has(k);
    });

    // Cancellation backstop — only on a CLEAN pull. A run that already hit
    // errors saw an incomplete picture of the spine, and "incomplete" is
    // exactly the state in which absence lies.
    const cancelNotes: string[] = [];
    if (summary.errors.length === 0) {
      try {
        const c = await reconcileCancelledUpstream();
        if (c.cancelled) {
          summary.upserted += c.cancelled;
          cancelNotes.push(
            `cancelled upstream: ${c.cancelled} of ${c.scanned} WH orders left the spine and were closed as CANCELLED` +
              (c.overrodeManual ? ` (${c.overrodeManual} overrode a manual status)` : ""),
          );
        }
        console.log(`[sync:snowflake] cancellation backstop scanned=${c.scanned} cancelled=${c.cancelled}`);
      } catch (e) {
        // A NOTE, not an error, for the same reason the degraded read is one:
        // flipping ok:false freezes the watermark, punishing the whole order
        // sync for a failure in an auxiliary reconciliation.
        const msg = `cancellation backstop failed (${e instanceof Error ? e.message : String(e)}) — no order was cancelled this run`;
        cancelNotes.push(msg);
        console.error(`[sync:snowflake] ${msg}`);
      }
    }
    summary.ok = summary.errors.length === 0;
    // Advance only on a fully successful batch — a run with errors leaves the
    // stored watermark untouched so the failed slice is retried next time.
    const newWatermark = summary.ok ? (maxSpineEventTs(rows) ?? priorWatermark) : undefined;
    console.log(
      `[sync:snowflake] mode=${priorWatermark ? "incremental" : "full"}${hasEventTs ? "" : " DEGRADED(sweep-only)"} fetched=${summary.fetched} upserted=${summary.upserted} watermark ${priorWatermark ?? "∅"} → ${(summary.ok ? newWatermark : priorWatermark) ?? "∅"}`,
    );
    await finishRun(
      run.id,
      summary,
      // The degraded-read warning leads the note so it is the first thing an
      // operator sees on the Admin card, ahead of routine QC chatter.
      [...(degradedNote ? [degradedNote] : []), ...cancelNotes, ...qcNotes].join(" | ") || undefined,
      newWatermark,
    );
    return summary;
  } catch (e) {
    summary.errors.push(e instanceof Error ? e.message : String(e));
    summary.ok = false;
  }

  await finishRun(run.id, summary);
  return summary;
}

/**
 * Real-time webhook path (complements polling, does not replace it). Reuses the
 * exact mapping (mapShipment) and write rules (buildShipmentPatch/applySyncPatch)
 * of the polling sync. Each webhook POST gets a SyncRun row tagged
 * ESHIPZ_WEBHOOK; unmatched tracking numbers land in that row's errors — a
 * signal the LR wasn't captured on dispatch, never a silent drop.
 */
export async function runEshipzWebhook(shipments: EshipzShipment[]): Promise<SyncSummary> {
  if (!databaseConfigured()) throw new Error("webhook processing requires DATABASE_URL");

  const run = await startRun("ESHIPZ_WEBHOOK");
  const summary: SyncSummary = { source: "ESHIPZ_WEBHOOK", ok: false, fetched: shipments.length, upserted: 0, conflicts: 0, errors: [] };
  const db = prisma();

  for (const s of shipments) {
    try {
      const u = mapShipment(s);
      if (!u) {
        summary.errors.push("shipment payload without tracking_number/order_id");
        continue;
      }
      // Look up by LR first; fall back to order_id (as SO number, then as LR).
      let row = await db.order.findFirst({ where: { lrNumber: u.trackingNumber } });
      if (!row && s.order_id && s.order_id !== u.trackingNumber) {
        row = await db.order.findFirst({
          where: { OR: [{ soNumber: s.order_id }, { lrNumber: s.order_id }] },
        });
      }
      if (!row) {
        summary.errors.push(
          `unmatched: ${u.trackingNumber}${s.order_id && s.order_id !== u.trackingNumber ? ` (order_id ${s.order_id})` : ""} — no order with this LR`,
        );
        continue;
      }
      const o = orderToDomain(row);
      const { patch, events } = buildShipmentPatch(o, u);
      const conflictEvents = events.filter((e) => e.note === "sync conflict — manual value kept").length;
      const res = await applySyncPatch(o, patch, events);
      if (res.changed) summary.upserted += 1;
      summary.conflicts += res.conflicts + conflictEvents;
      await persistPickedUp(o.soNumber, u.trackingNumber, u.pickedUpTs);
    } catch (e) {
      summary.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  summary.ok = summary.errors.length === 0;

  await finishRun(run.id, summary);
  return summary;
}

// ---------------------------------------------------------------------------

/** The 15-min tick (eShipz poller). Snowflake runs on its OWN hourly
 *  cadence (instrumentation-node.ts) — never merged into this slot. */
export async function runAllSyncs(): Promise<SyncSummary[]> {
  const out: SyncSummary[] = [];
  if (eshipzConfigured()) out.push(await runEshipzSync());
  return out;
}

/** Admin sync-health data (empty when no database is configured). */
export async function getSyncHealth() {
  if (!databaseConfigured()) {
    return { lastRuns: {} as Record<SyncSource, undefined>, recentRuns: [], unmatched: [] };
  }
  const db = prisma();
  const [eshipz, webhook, snowflake, recentRuns, unmatched] = await Promise.all([
    db.syncRun.findFirst({ where: { source: "ESHIPZ" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "ESHIPZ_WEBHOOK" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "SNOWFLAKE" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    db.unmatchedChannel.findMany({ orderBy: { lastSeenAt: "desc" } }),
  ]);
  return {
    lastRuns: {
      ESHIPZ: eshipz ?? undefined,
      ESHIPZ_WEBHOOK: webhook ?? undefined,
      SNOWFLAKE: snowflake ?? undefined,
    },
    recentRuns,
    unmatched,
  };
}
