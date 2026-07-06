// Data access layer. `OrderRepo` is the seam the PRD's adapter strategy hangs
// off — M2: methods are async and `repo` delegates lazily to a Postgres-backed
// PrismaRepo when DATABASE_URL is set, else to the in-memory seed store (local
// UI work without a DB). Every mutation appends OrderEvents.

import { databaseConfigured } from "./db";
import { PrismaRepo } from "./repo-prisma";
import { istDateOf, nowIso } from "./ist";
import {
  REQUIRED_CAPTURES,
  STATUS_TIMESTAMPS,
  canTransition,
  canTransitionShipment,
  rollupOverall,
} from "./journey";
import type {
  FacilityScope,
  Order,
  OrderEvent,
  OrderStatus,
  RulebookEntry,
  ShipmentStatus,
  Source,
  Store,
  User,
} from "./types";
import { seedData } from "./seed/orders";
import { RULEBOOK } from "./seed/rulebook";
import { STORES } from "./seed/stores";
import { USERS } from "./seed/users";

export interface Actor {
  id: string;
  name: string;
}

export interface OrderRepo {
  listOrders(scope: FacilityScope, areaManager?: string): Promise<Order[]>;
  getOrder(soNumber: string): Promise<Order | undefined>;
  listEvents(orderId: string): Promise<OrderEvent[]>;
  listAllEvents(): Promise<OrderEvent[]>;
  listStores(): Promise<Store[]>;
  listRules(): Promise<RulebookEntry[]>;
  listUsers(): Promise<User[]>;
  transitionStatus(soNumber: string, to: OrderStatus, actor: Actor, captures?: Partial<Order>, note?: string): Promise<Order>;
  transitionShipment(soNumber: string, to: ShipmentStatus, actor: Actor, source: Source, note?: string): Promise<Order>;
  recordNdrAttempt(soNumber: string, actor: Actor, note?: string): Promise<Order>;
  updateFields(soNumber: string, patch: Partial<Order>, actor: Actor, source: Source, note?: string): Promise<Order>;
}

interface Db {
  orders: Map<string, Order>; // keyed by soNumber
  events: OrderEvent[];
  evSeq: number;
}

// globalThis singleton so the store survives Next.js HMR / route module reloads.
const g = globalThis as unknown as { __retailjourneyDb?: Db; __retailjourneyRepoWarned?: boolean };

function db(): Db {
  if (!g.__retailjourneyDb) {
    const { orders, events } = seedData();
    g.__retailjourneyDb = {
      orders: new Map(orders.map((o) => [o.soNumber, o])),
      events: [...events],
      evSeq: events.length,
    };
  }
  return g.__retailjourneyDb;
}

function pushEvent(
  d: Db,
  orderId: string,
  field: string,
  fromValue: string | null,
  toValue: string,
  source: Source,
  actor: Actor | null,
  note?: string,
) {
  d.evSeq += 1;
  d.events.push({
    id: `ev_${String(d.evSeq).padStart(5, "0")}`,
    orderId,
    field,
    fromValue,
    toValue,
    source,
    actorId: actor?.id ?? null,
    actorName: actor?.name,
    note,
    createdAt: nowIso(),
  });
}

function mustGet(d: Db, soNumber: string): Order {
  const o = d.orders.get(soNumber);
  if (!o) throw new Error(`Order ${soNumber} not found`);
  return o;
}

const val = (v: unknown): string => (v == null ? "" : String(v));

class InMemoryRepo implements OrderRepo {
  async listOrders(scope: FacilityScope, areaManager?: string): Promise<Order[]> {
    let all = [...db().orders.values()];
    if (scope !== "ALL") all = all.filter((o) => o.facility === scope);
    if (areaManager) all = all.filter((o) => o.areaManager === areaManager);
    return all.sort((a, b) => (a.orderTimestamp < b.orderTimestamp ? 1 : -1));
  }

  async getOrder(soNumber: string): Promise<Order | undefined> {
    return db().orders.get(soNumber);
  }

  async listEvents(orderId: string): Promise<OrderEvent[]> {
    return db()
      .events.filter((e) => e.orderId === orderId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async listAllEvents(): Promise<OrderEvent[]> {
    return [...db().events];
  }

  async listStores(): Promise<Store[]> {
    return STORES;
  }

  async listRules(): Promise<RulebookEntry[]> {
    return RULEBOOK;
  }

  async listUsers(): Promise<User[]> {
    return USERS;
  }

  async transitionStatus(
    soNumber: string,
    to: OrderStatus,
    actor: Actor,
    captures: Partial<Order> = {},
    note?: string,
  ): Promise<Order> {
    const d = db();
    const o = mustGet(d, soNumber);
    if (!canTransition(o.status, to)) {
      throw new Error(`Invalid transition ${o.status} → ${to}`);
    }
    for (const req of REQUIRED_CAPTURES[to] ?? []) {
      const v = captures[req.field] ?? o[req.field];
      if (!req.optional && (v == null || v === "")) {
        throw new Error(`Missing required field for ${to}: ${req.label}`);
      }
    }
    const from = o.status;
    const now = nowIso();
    for (const [k, v] of Object.entries(captures)) {
      if (v == null || v === "") continue;
      const prev = o[k as keyof Order];
      if (prev !== v) {
        pushEvent(d, o.id, k, prev == null ? null : val(prev), val(v), "MANUAL", actor);
        (o as unknown as Record<string, unknown>)[k] = v;
      }
    }
    for (const tsField of STATUS_TIMESTAMPS[to] ?? []) {
      if (o[tsField] == null) (o as unknown as Record<string, unknown>)[tsField] = now;
    }
    o.status = to;
    o.statusSource = "MANUAL";
    o.overallStatus = rollupOverall(o);
    o.updatedAt = now;
    pushEvent(d, o.id, "status", from, to, "MANUAL", actor, note);
    return o;
  }

  async transitionShipment(soNumber: string, to: ShipmentStatus, actor: Actor, source: Source, note?: string): Promise<Order> {
    const d = db();
    const o = mustGet(d, soNumber);
    if (o.status !== "DISPATCHED_TO_STORE") {
      throw new Error(`Order ${soNumber} is not dispatched yet`);
    }
    // Manual override is always available (PRD §2) — the transition map guards
    // sync flows; a manual actor may force any shipment status.
    if (source === "SYNCED" && !canTransitionShipment(o.shipmentStatus, to)) {
      throw new Error(`Invalid shipment transition ${o.shipmentStatus} → ${to}`);
    }
    const from = o.shipmentStatus ?? null;
    const now = nowIso();
    o.shipmentStatus = to;
    o.shipmentSource = source;
    if (to === "IN_TRANSIT" && !o.shippedTs) o.shippedTs = now;
    if (to === "OUT_FOR_DELIVERY") {
      if (!o.firstOfdDate) o.firstOfdDate = now;
      o.latestOfdDate = now;
    }
    if (to === "DELIVERED") {
      o.deliveredTs = now;
      o.deliveredDate = istDateOf(now);
      // The successful delivery is itself an attempt — after an NDR this makes it 2+.
      o.deliveryAttempts += 1;
    }
    o.overallStatus = rollupOverall(o);
    o.updatedAt = now;
    pushEvent(d, o.id, "shipmentStatus", from, to, source, actor, note);
    return o;
  }

  async recordNdrAttempt(soNumber: string, actor: Actor, note?: string): Promise<Order> {
    const d = db();
    const o = mustGet(d, soNumber);
    const from = o.shipmentStatus ?? null;
    const now = nowIso();
    o.deliveryAttempts += 1;
    o.shipmentStatus = "DELIVERY_FAILED";
    o.shipmentSource = "MANUAL";
    o.overallStatus = rollupOverall(o);
    o.updatedAt = now;
    pushEvent(d, o.id, "shipmentStatus", from, "DELIVERY_FAILED", "MANUAL", actor, note ?? `NDR — attempt ${o.deliveryAttempts}`);
    return o;
  }

  async updateFields(soNumber: string, patch: Partial<Order>, actor: Actor, source: Source, note?: string): Promise<Order> {
    const d = db();
    const o = mustGet(d, soNumber);
    const now = nowIso();
    for (const [k, v] of Object.entries(patch)) {
      const prev = o[k as keyof Order];
      if (prev === v || v === undefined) continue;
      pushEvent(d, o.id, k, prev == null ? null : val(prev), val(v), source, actor, note);
      (o as unknown as Record<string, unknown>)[k] = v;
    }
    o.overallStatus = rollupOverall(o);
    o.updatedAt = now;
    return o;
  }
}

// ---------------------------------------------------------------------------
// Lazy repo selection — DATABASE_URL must be read per-call, never at module
// load (PRD §11: Coolify injects runtime env after evaluation).

const inMemory = new InMemoryRepo();
let prismaRepo: OrderRepo | undefined;

function impl(): OrderRepo {
  if (databaseConfigured()) {
    if (!prismaRepo) prismaRepo = new PrismaRepo();
    return prismaRepo;
  }
  if (!g.__retailjourneyRepoWarned) {
    g.__retailjourneyRepoWarned = true;
    console.warn("[repo] DATABASE_URL not set — using in-memory seed data (state resets on restart)");
  }
  return inMemory;
}

export const repo: OrderRepo = {
  listOrders: (scope, areaManager) => impl().listOrders(scope, areaManager),
  getOrder: (soNumber) => impl().getOrder(soNumber),
  listEvents: (orderId) => impl().listEvents(orderId),
  listAllEvents: () => impl().listAllEvents(),
  listStores: () => impl().listStores(),
  listRules: () => impl().listRules(),
  listUsers: () => impl().listUsers(),
  transitionStatus: (soNumber, to, actor, captures, note) => impl().transitionStatus(soNumber, to, actor, captures, note),
  transitionShipment: (soNumber, to, actor, source, note) => impl().transitionShipment(soNumber, to, actor, source, note),
  recordNdrAttempt: (soNumber, actor, note) => impl().recordNdrAttempt(soNumber, actor, note),
  updateFields: (soNumber, patch, actor, source, note) => impl().updateFields(soNumber, patch, actor, source, note),
};
