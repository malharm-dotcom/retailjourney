// Domain <-> Prisma row mapping, in one place. The domain layer (types.ts)
// keeps ISO-8601 UTC strings for timestamps and "YYYY-MM-DD" strings for IST
// business dates; Postgres stores DateTime / @db.Date. Used by PrismaRepo and
// the seed script — imports are relative so tsx can run this outside Next.

import type {
  Order as DbOrder,
  OrderEvent as DbOrderEvent,
  OrderShipment as DbOrderShipment,
  RulebookEntry as DbRulebookEntry,
  Store as DbStore,
  User as DbUser,
} from "../generated/prisma/client";
import type {
  Facility,
  Order,
  OrderEvent,
  OrderShipment,
  RulebookEntry,
  Store,
  TrackingCheckpoint,
  User,
  Weekday,
  Zone,
} from "./types";

/** Order fields stored as DateTime (UTC instants) — ISO strings in the domain. */
export const ORDER_TS_FIELDS = [
  "orderTimestamp",
  "createdTs",
  "pickingTs",
  "pickedTs",
  "packedTs",
  "rtsTs",
  "manifestedTs",
  "dispatchedTs",
  "shippedTs",
  "deliveredTs",
  "cancelledTs",
  "firstOfdDate",
  "latestOfdDate",
  "orderCutoffTs",
  "handoverDeadlineTs",
  "pickupTat",
  "deliveryTat",
  "createdAt",
  "updatedAt",
] as const;

/** Order fields stored as @db.Date — "YYYY-MM-DD" IST business dates in the domain. */
export const ORDER_DATE_FIELDS = [
  "orderDate",
  "rtsLogicDate",
  "rtdDate",
  "dispatchedDate",
  "expectedDate",
  "deliveredDate",
  "orderReceivedDate",
  "inwardedDate",
  "idealDeliveryDate",
] as const;

const TS_SET = new Set<string>(ORDER_TS_FIELDS);
const DATE_SET = new Set<string>(ORDER_DATE_FIELDS);

const iso = (d: Date): string => d.toISOString();
/** @db.Date comes back as UTC midnight of the stored calendar date. */
const day = (d: Date): string => d.toISOString().slice(0, 10);
const toDay = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

function undef<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

export function orderToDomain(r: DbOrder): Order {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null) continue; // domain uses optional/undefined
    if (v instanceof Date) o[k] = TS_SET.has(k) ? iso(v) : DATE_SET.has(k) ? day(v) : iso(v);
    else o[k] = v;
  }
  // Non-optional domain fields that must survive even when empty.
  o.deliveryAttempts = r.deliveryAttempts;
  o.pickupAttempts = r.pickupAttempts;
  o.manualFields = r.manualFields;
  o.checkpoints = (r.checkpoints as TrackingCheckpoint[] | null) ?? undefined;
  return o as unknown as Order;
}

/**
 * Domain patch -> Prisma data. Skips undefined keys; converts string
 * timestamps/dates to Date. Pass `full: true` when building a complete row
 * (seed / create) so explicit empty values survive.
 */
export function orderToDb(patch: Partial<Order>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (typeof v === "string" && TS_SET.has(k)) row[k] = new Date(v);
    else if (typeof v === "string" && DATE_SET.has(k)) row[k] = toDay(v);
    else row[k] = v;
  }
  return row;
}

/** OrderShipment fields stored as DateTime — ISO strings in the domain. */
export const SHIPMENT_TS_FIELDS = [
  "logisticsCreatedTs",
  "trackingPickTs",
  "deliveredTs",
  "firstOfdTs",
  "latestOfdTs",
  "createdAt",
  "lastSyncedAt",
] as const;

/** OrderShipment fields stored as @db.Date — "YYYY-MM-DD" in the domain. */
export const SHIPMENT_DATE_FIELDS = ["expectedDeliveryDate"] as const;

const SHIPMENT_TS_SET = new Set<string>(SHIPMENT_TS_FIELDS);
const SHIPMENT_DATE_SET = new Set<string>(SHIPMENT_DATE_FIELDS);

export function shipmentToDomain(r: DbOrderShipment): OrderShipment {
  const s: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null) continue;
    if (v instanceof Date) s[k] = SHIPMENT_TS_SET.has(k) ? iso(v) : SHIPMENT_DATE_SET.has(k) ? day(v) : iso(v);
    else s[k] = v;
  }
  return s as unknown as OrderShipment;
}

/** Domain shipment patch -> Prisma data (skips undefined; string dates -> Date). */
export function shipmentToDb(patch: Partial<OrderShipment>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (typeof v === "string" && SHIPMENT_TS_SET.has(k)) row[k] = new Date(v);
    else if (typeof v === "string" && SHIPMENT_DATE_SET.has(k)) row[k] = toDay(v);
    else row[k] = v;
  }
  return row;
}

export function eventToDomain(r: DbOrderEvent): OrderEvent {
  return {
    id: r.id,
    orderId: r.orderId,
    field: r.field,
    fromValue: r.fromValue,
    toValue: r.toValue,
    source: r.source,
    actorId: r.actorId,
    actorName: undef(r.actorName),
    note: undef(r.note),
    createdAt: iso(r.createdAt),
  };
}

export function storeToDomain(r: DbStore): Store {
  return {
    id: r.id,
    branchCode: r.branchCode,
    storeName: r.storeName,
    finalStore: r.finalStore,
    ownership: (undef(r.ownership) ?? "COCO") as Store["ownership"],
    channel: r.channel as Store["channel"],
    storeCity: r.storeCity ?? "",
    storeState: r.storeState ?? "",
    zone: (r.zone ?? "UNMAPPED") as Zone,
    facility: r.facility as Facility,
    areaManager: undef(r.areaManager),
    merchandiser: undef(r.merchandiser),
    rank: undef(r.rank),
    sales30d: undef(r.sales30d),
    channelCode: undef(r.channelCode),
  };
}

export function ruleToDomain(r: DbRulebookEntry): RulebookEntry {
  return {
    id: r.id,
    storeId: r.storeId,
    orderType: r.orderType,
    laneClassification: undef(r.laneClassification),
    zone: undef(r.zone) as Zone | undefined,
    bestTatDays: undef(r.bestTatDays),
    targetOrderDay: undef(r.targetOrderDay) as Weekday | undefined,
    targetOrderCutoff: undef(r.targetOrderCutoff),
    targetHandoverDay: undef(r.targetHandoverDay) as Weekday | undefined,
    targetHandoverCutoff: undef(r.targetHandoverCutoff),
    targetPickupDay: undef(r.targetPickupDay) as Weekday | undefined,
    targetDeliveryDay: undef(r.targetDeliveryDay) as Weekday | undefined,
    effectiveFrom: day(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? day(r.effectiveTo) : undefined,
  };
}

export function ruleToDb(r: RulebookEntry): Record<string, unknown> {
  return {
    ...r,
    effectiveFrom: toDay(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? toDay(r.effectiveTo) : null,
  };
}

export function userToDomain(r: DbUser): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    facilities: r.facilities as Facility[],
    allView: r.allView,
    areaManager: undef(r.areaManager),
    active: r.active,
  };
}
