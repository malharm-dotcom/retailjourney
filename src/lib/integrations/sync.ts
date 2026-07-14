// Sync orchestration (M2 part 2). Requires a database — sync never runs on
// the in-memory repo. Every run writes a SyncRun row; every synced write goes
// through OrderEvents with source=SYNCED; fields last edited MANUAL are never
// overwritten (the conflict is logged instead — manual wins, PRD §2).

import { mapDistributionRows, isPollableAwb, type MappedOrder } from "../distribution-map";
import { prisma, databaseConfigured } from "../db";
import { isoFromEpochMs, istDateOf, nowIso, addDays, istToday } from "../ist";
import { TERMINAL_STATUSES, WH_FLOW, canTransitionShipment, rollupOverall, rollupShipments } from "../journey";
import { orderToDb, orderToDomain, shipmentToDb, shipmentToDomain, storeToDomain } from "../prisma-map";
import { slaState } from "../sla";
import { queryDistributionAnalytics, snowflakeConfigured } from "../snowflake";
import { FACILITIES, type Order, type OrderShipment, type OrderStatus, type OverallStatus, type ShipmentStatus, type Source, type Store } from "../types";
import { EshipzTrackingSource, eshipzConfigured, fetchShipmentMeta, mapShipment, type EshipzShipment } from "./eshipz-source";
import { UcApiOrderSource } from "./uc-source";
import { ucConfigured } from "./uc-client";
import type { TrackingUpdate, UcOrderUpdate } from "./types";

export type SyncSource = "UC" | "ESHIPZ" | "ESHIPZ_WEBHOOK" | "SNOWFLAKE";

export interface SyncSummary {
  source: SyncSource;
  ok: boolean;
  fetched: number;
  upserted: number;
  conflicts: number;
  errors: string[];
}

const MAX_ERRORS_STORED = 25;
const FIRST_RUN_LOOKBACK_DAYS = 7;
const SWEEP_OVERLAP_DAYS = 1;

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

  if (Object.keys(data).length === 0 && events.length === 0) return { changed: false, conflicts };

  const merged = { ...o, ...(data as Partial<Order>) };
  data.overallStatus = overallStatusOverride ?? rollupOverall(merged);

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
    },
  });
}

// ---------------------------------------------------------------------------
// Unicommerce

/** Forward-only status guard: sync may never regress the floor's progress,
 *  pull an order out of ON_HOLD, or resurrect a terminal order. */
function guardedStatus(current: Order["status"], next?: Order["status"]): Order["status"] | undefined {
  if (!next || next === current) return undefined;
  if (TERMINAL_STATUSES.includes(current)) return undefined;
  if (TERMINAL_STATUSES.includes(next)) return next;
  if (current === "ON_HOLD") return undefined;
  const cur = WH_FLOW.indexOf(current);
  const nxt = WH_FLOW.indexOf(next);
  if (nxt <= cur) return undefined;
  return next;
}

async function recordUnmatchedChannel(channel: string, soNumber: string): Promise<void> {
  const db = prisma();
  const existing = await db.unmatchedChannel.findUnique({ where: { channel } });
  if (existing) {
    await db.unmatchedChannel.update({
      where: { channel },
      data: {
        lastSeenAt: new Date(),
        orderCount: { increment: 1 },
        ...(existing.sampleSoNumbers.includes(soNumber) || existing.sampleSoNumbers.length >= 10
          ? {}
          : { sampleSoNumbers: [...existing.sampleSoNumbers, soNumber] }),
      },
    });
  } else {
    await db.unmatchedChannel.create({
      data: { channel, orderCount: 1, sampleSoNumbers: [soNumber] },
    });
  }
}

async function createOrderFromUc(update: UcOrderUpdate, store: Store): Promise<void> {
  const createdIso = update.patch.createdTs ?? nowIso();
  const status = update.patch.status ?? "NOT_STARTED";
  const base: Partial<Order> = {
    soNumber: update.soNumber,
    orderDate: istDateOf(createdIso),
    orderTimestamp: createdIso,
    facility: store.facility,
    channel: store.channel,
    storeId: store.id,
    storeNameFormat: store.storeName,
    finalStore: store.finalStore,
    ownership: store.ownership,
    state: store.storeState,
    zone: store.zone,
    type: "OTHER", // merchandising sets TYPE/PRIORITY/campaign (PRD §3)
    qty: update.qty,
    merchandiser: store.merchandiser,
    areaManager: store.areaManager,
    ...update.patch,
    status,
    statusSource: "SYNCED",
    deliveryAttempts: 0,
    pickupAttempts: 0,
  };
  base.overallStatus = rollupOverall({ status, shipmentStatus: undefined });

  const db = prisma();
  const row = await db.order.create({ data: orderToDb(base) as never });
  await db.orderEvent.create({
    data: {
      orderId: row.id,
      field: "status",
      fromValue: null,
      toValue: status,
      source: "SYNCED",
      actorId: null,
      note: "B2B SO created in UC",
    },
  });
}

export async function runUcSync(): Promise<SyncSummary> {
  if (!databaseConfigured()) throw new Error("UC sync requires DATABASE_URL");
  if (!ucConfigured()) throw new Error("UC sync requires UC_BASE_URL / UC_USERNAME / UC_PASSWORD");

  const run = await startRun("UC");
  const summary: SyncSummary = { source: "UC", ok: false, fetched: 0, upserted: 0, conflicts: 0, errors: [] };
  const source = new UcApiOrderSource();
  const db = prisma();

  try {
    const lastOk = await db.syncRun.findFirst({
      where: { source: "UC", ok: true },
      orderBy: { startedAt: "desc" },
    });
    const since = lastOk
      ? addDays(istDateOf(lastOk.startedAt.toISOString()), -SWEEP_OVERLAP_DAYS)
      : addDays(istToday(), -FIRST_RUN_LOOKBACK_DAYS);

    const codes = await source.fetchChangedOrderCodes(since);
    summary.fetched = codes.length;

    const stores = (await db.store.findMany({ where: { channelCode: { not: null } } })).map(storeToDomain);
    const byChannel = new Map(stores.map((s) => [s.channelCode!, s]));

    for (const code of codes) {
      try {
        const update = await source.fetchOrder(code);
        if (!update) continue;

        const existingRow = await db.order.findUnique({ where: { soNumber: update.soNumber } });
        if (existingRow) {
          const existing = orderToDomain(existingRow);
          const patch = { ...update.patch };
          patch.status = guardedStatus(existing.status, update.patch.status);
          if (patch.status) patch.statusSource = "SYNCED";
          // Never let UC clobber the shipment layer's delivery timeline.
          if (existing.shipmentStatus) {
            delete patch.deliveredTs;
            delete patch.deliveredDate;
          }
          const res = await applySyncPatch(existing, patch);
          if (res.changed) summary.upserted += 1;
          summary.conflicts += res.conflicts;
        } else {
          const store = update.ucChannel ? byChannel.get(update.ucChannel) : undefined;
          if (!store) {
            await recordUnmatchedChannel(update.ucChannel || "(no channel)", update.soNumber);
            continue; // held in the Admin review queue — never dropped silently
          }
          await createOrderFromUc(update, store);
          summary.upserted += 1;
        }
      } catch (e) {
        summary.errors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`);
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
// eShipz

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
      const updates = await source.fetchTracking(awbs);

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

/** Order-level Phase-B fields owned by the poller on pollable shipments. */
const ORDER_TRANSIT_FIELDS: (keyof Order)[] = [
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
 *  only when the order has NO pollable shipment (self-delivery/porter). */
function transitPatchFromChild(o: Order, s: OrderShipment): Partial<Order> {
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
      shipmentStatus: rollupShipments(states),
    });
  } else if (m.overallStatusSeed) {
    // Zero children: Snowflake's OVERALL_STATUS is used verbatim (seed only).
    overallOverride = m.overallStatusSeed;
  }

  return applySyncPatch(existing, patch, events, "SYNCED_SNOWFLAKE", overallOverride);
}

export async function runSnowflakeSync(): Promise<SyncSummary> {
  if (!databaseConfigured()) throw new Error("Snowflake sync requires DATABASE_URL");
  if (!snowflakeConfigured()) {
    throw new Error("Snowflake sync requires SNOWFLAKE_ACCOUNT / SNOWFLAKE_USERNAME / SNOWFLAKE_PRIVATE_KEY");
  }

  const run = await startRun("SNOWFLAKE");
  const summary: SyncSummary = { source: "SNOWFLAKE", ok: false, fetched: 0, upserted: 0, conflicts: 0, errors: [] };
  const db = prisma();

  try {
    const rows = await queryDistributionAnalytics();
    summary.fetched = rows.length;
    const mapped = mapDistributionRows(rows);

    const stores = (await db.store.findMany()).map(storeToDomain);
    const norm = (s: string) => s.trim().toUpperCase();
    const byFinalStore = new Map(stores.map((s) => [norm(s.finalStore), s]));
    const byChannelCode = new Map(
      stores.filter((s) => s.channelCode).map((s) => [norm(s.channelCode!), s]),
    );

    for (const m of mapped) {
      try {
        const existingRow = await db.order.findUnique({ where: { soNumber: m.soNumber } });
        const store = m.storeKey
          ? (byFinalStore.get(norm(m.storeKey)) ?? byChannelCode.get(norm(m.storeKey)))
          : undefined;

        if (!existingRow) {
          if (!store) {
            // Admin review queue — an unmatched STORE is never dropped silently.
            await recordUnmatchedChannel(m.storeKey || "(no store)", m.soNumber);
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
    summary.ok = summary.errors.length === 0;
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
    } catch (e) {
      summary.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  summary.ok = summary.errors.length === 0;

  await finishRun(run.id, summary);
  return summary;
}

// ---------------------------------------------------------------------------

/** The 15-min tick (UC + eShipz poller). Snowflake runs on its OWN hourly
 *  cadence (instrumentation-node.ts) — never merged into this slot. */
export async function runAllSyncs(): Promise<SyncSummary[]> {
  const out: SyncSummary[] = [];
  if (ucConfigured()) out.push(await runUcSync());
  if (eshipzConfigured()) out.push(await runEshipzSync());
  return out;
}

/** Admin sync-health data (empty when no database is configured). */
export async function getSyncHealth() {
  if (!databaseConfigured()) {
    return { lastRuns: {} as Record<SyncSource, undefined>, recentRuns: [], unmatched: [] };
  }
  const db = prisma();
  const [uc, eshipz, webhook, snowflake, recentRuns, unmatched] = await Promise.all([
    db.syncRun.findFirst({ where: { source: "UC" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "ESHIPZ" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "ESHIPZ_WEBHOOK" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "SNOWFLAKE" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    db.unmatchedChannel.findMany({ orderBy: { lastSeenAt: "desc" } }),
  ]);
  return {
    lastRuns: {
      UC: uc ?? undefined,
      ESHIPZ: eshipz ?? undefined,
      ESHIPZ_WEBHOOK: webhook ?? undefined,
      SNOWFLAKE: snowflake ?? undefined,
    },
    recentRuns,
    unmatched,
  };
}
