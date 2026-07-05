// Data access layer. `OrderRepo` is the seam the PRD's adapter strategy hangs
// off — M1 ships `InMemoryRepo` on seed data; M2 swaps in a Prisma-backed
// implementation without touching callers. Every mutation appends OrderEvents.

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
  listOrders(scope: FacilityScope, areaManager?: string): Order[];
  getOrder(soNumber: string): Order | undefined;
  listEvents(orderId: string): OrderEvent[];
  listAllEvents(): OrderEvent[];
  listStores(): Store[];
  listRules(): RulebookEntry[];
  listUsers(): User[];
  transitionStatus(soNumber: string, to: OrderStatus, actor: Actor, captures?: Partial<Order>, note?: string): Order;
  transitionShipment(soNumber: string, to: ShipmentStatus, actor: Actor, source: Source, note?: string): Order;
  recordNdrAttempt(soNumber: string, actor: Actor, note?: string): Order;
  updateFields(soNumber: string, patch: Partial<Order>, actor: Actor, source: Source, note?: string): Order;
}

interface Db {
  orders: Map<string, Order>; // keyed by soNumber
  events: OrderEvent[];
  evSeq: number;
}

// globalThis singleton so the store survives Next.js HMR / route module reloads.
const g = globalThis as unknown as { __relayDb?: Db };

function db(): Db {
  if (!g.__relayDb) {
    const { orders, events } = seedData();
    g.__relayDb = {
      orders: new Map(orders.map((o) => [o.soNumber, o])),
      events: [...events],
      evSeq: events.length,
    };
  }
  return g.__relayDb;
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

/** Fields merchandising / logistics / admin may hand-edit with source tracking. */
const val = (v: unknown): string => (v == null ? "" : String(v));

class InMemoryRepo implements OrderRepo {
  listOrders(scope: FacilityScope, areaManager?: string): Order[] {
    let all = [...db().orders.values()];
    if (scope !== "ALL") all = all.filter((o) => o.facility === scope);
    if (areaManager) all = all.filter((o) => o.areaManager === areaManager);
    return all.sort((a, b) => (a.orderTimestamp < b.orderTimestamp ? 1 : -1));
  }

  getOrder(soNumber: string): Order | undefined {
    return db().orders.get(soNumber);
  }

  listEvents(orderId: string): OrderEvent[] {
    return db()
      .events.filter((e) => e.orderId === orderId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  listAllEvents(): OrderEvent[] {
    return [...db().events];
  }

  listStores(): Store[] {
    return STORES;
  }

  listRules(): RulebookEntry[] {
    return RULEBOOK;
  }

  listUsers(): User[] {
    return USERS;
  }

  transitionStatus(
    soNumber: string,
    to: OrderStatus,
    actor: Actor,
    captures: Partial<Order> = {},
    note?: string,
  ): Order {
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

  transitionShipment(soNumber: string, to: ShipmentStatus, actor: Actor, source: Source, note?: string): Order {
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
      o.deliveryAttempts = Math.max(1, o.deliveryAttempts);
    }
    o.overallStatus = rollupOverall(o);
    o.updatedAt = now;
    pushEvent(d, o.id, "shipmentStatus", from, to, source, actor, note);
    return o;
  }

  recordNdrAttempt(soNumber: string, actor: Actor, note?: string): Order {
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

  updateFields(soNumber: string, patch: Partial<Order>, actor: Actor, source: Source, note?: string): Order {
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

export const repo: OrderRepo = new InMemoryRepo();
