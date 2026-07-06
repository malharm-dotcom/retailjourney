// Sync orchestration (M2 part 2). Requires a database — sync never runs on
// the in-memory repo. Every run writes a SyncRun row; every synced write goes
// through OrderEvents with source=SYNCED; fields last edited MANUAL are never
// overwritten (the conflict is logged instead — manual wins, PRD §2).

import { prisma, databaseConfigured } from "../db";
import { isoFromEpochMs, istDateOf, nowIso, addDays, istToday } from "../ist";
import { TERMINAL_STATUSES, WH_FLOW, canTransitionShipment, rollupOverall } from "../journey";
import { orderToDb, orderToDomain, storeToDomain } from "../prisma-map";
import type { Order, ShipmentStatus, Source, Store } from "../types";
import { EshipzTrackingSource, eshipzConfigured } from "./eshipz-source";
import { UcApiOrderSource } from "./uc-source";
import { ucConfigured } from "./uc-client";
import type { TrackingUpdate, UcOrderUpdate } from "./types";

export type SyncSource = "UC" | "ESHIPZ";

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

function eq(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
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
        source: "SYNCED",
        actorId: null,
        note: "sync conflict — manual value kept",
      });
      continue;
    }
    data[k] = v;
    if (!QUIET_FIELDS.has(key) && !alreadyLogged.has(k)) {
      events.push({ field: k, fromValue: prev == null ? null : val(prev), toValue: val(v), source: "SYNCED", actorId: null });
    }
  }

  if (Object.keys(data).length === 0 && events.length === 0) return { changed: false, conflicts };

  const merged = { ...o, ...(data as Partial<Order>) };
  data.overallStatus = rollupOverall(merged);

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
          trackingLatestLocation: u.checkpoints[0]?.city,
        }
      : {}),
    ...(u.expectedDate ? { expectedDate: u.expectedDate } : {}),
    ...(u.podLink ? { podLink: u.podLink } : {}),
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
    // Every order with an LR and a non-terminal shipment; SELF has no feed.
    const rows = await db.order.findMany({
      where: {
        lrNumber: { not: null },
        status: "DISPATCHED_TO_STORE",
        logisticsPartner: { not: "SELF" },
        OR: [{ shipmentStatus: null }, { shipmentStatus: { not: "DELIVERED" } }],
      },
    });
    const orders = rows.map(orderToDomain);
    const byLr = new Map(orders.map((o) => [o.lrNumber!, o]));
    summary.fetched = orders.length;

    if (orders.length) {
      const source = new EshipzTrackingSource();
      const updates = await source.fetchTracking([...byLr.keys()]);
      for (const u of updates) {
        const o = byLr.get(u.trackingNumber);
        if (!o) continue;
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
  const [uc, eshipz, recentRuns, unmatched] = await Promise.all([
    db.syncRun.findFirst({ where: { source: "UC" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({ where: { source: "ESHIPZ" }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    db.unmatchedChannel.findMany({ orderBy: { lastSeenAt: "desc" } }),
  ]);
  return { lastRuns: { UC: uc ?? undefined, ESHIPZ: eshipz ?? undefined }, recentRuns, unmatched };
}
