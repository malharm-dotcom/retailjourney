// PrismaRepo — the Postgres-backed OrderRepo (M2). A faithful port of
// InMemoryRepo's semantics: same state-machine validation, required-capture
// checks, status timestamps and OrderEvent appends. Every mutation runs in a
// single transaction. MANUAL writes record the touched field names in
// `manualFields` so sync never overwrites them (manual wins, PRD §2).

import { prisma } from "./db";
import { istDateOf, nowIso } from "./ist";
import {
  REQUIRED_CAPTURES,
  STATUS_TIMESTAMPS,
  canTransition,
  canTransitionShipment,
  rollupOverall,
} from "./journey";
import {
  eventToDomain,
  orderToDb,
  orderToDomain,
  ruleToDomain,
  storeToDomain,
  userToDomain,
} from "./prisma-map";
import type { Actor, OrderRepo } from "./repo";
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

const val = (v: unknown): string => (v == null ? "" : String(v));

interface PendingEvent {
  field: string;
  fromValue: string | null;
  toValue: string;
  source: Source;
  actorId: string | null;
  actorName?: string;
  note?: string;
}

function ev(
  field: string,
  fromValue: string | null,
  toValue: string,
  source: Source,
  actor: Actor | null,
  note?: string,
): PendingEvent {
  return { field, fromValue, toValue, source, actorId: actor?.id ?? null, actorName: actor?.name, note };
}

function mergeManual(existing: string[], added: string[]): string[] {
  return [...new Set([...existing, ...added])];
}

export class PrismaRepo implements OrderRepo {
  async listOrders(scope: FacilityScope, areaManager?: string): Promise<Order[]> {
    const rows = await prisma().order.findMany({
      where: {
        ...(scope !== "ALL" ? { facility: scope } : {}),
        ...(areaManager ? { areaManager } : {}),
      },
      orderBy: { orderTimestamp: "desc" },
    });
    return rows.map(orderToDomain);
  }

  async getOrder(soNumber: string): Promise<Order | undefined> {
    const row = await prisma().order.findUnique({ where: { soNumber } });
    return row ? orderToDomain(row) : undefined;
  }

  async listEvents(orderId: string): Promise<OrderEvent[]> {
    const rows = await prisma().orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(eventToDomain);
  }

  async listAllEvents(): Promise<OrderEvent[]> {
    const rows = await prisma().orderEvent.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(eventToDomain);
  }

  async listStores(): Promise<Store[]> {
    const rows = await prisma().store.findMany({ orderBy: { rank: "asc" } });
    return rows.map(storeToDomain);
  }

  async listRules(): Promise<RulebookEntry[]> {
    const rows = await prisma().rulebookEntry.findMany();
    return rows.map(ruleToDomain);
  }

  async listUsers(): Promise<User[]> {
    const rows = await prisma().user.findMany({ orderBy: { name: "asc" } });
    return rows.map(userToDomain);
  }

  private async mustGet(soNumber: string): Promise<Order> {
    const o = await this.getOrder(soNumber);
    if (!o) throw new Error(`Order ${soNumber} not found`);
    return o;
  }

  /** Apply a domain patch + events atomically; returns the updated order. */
  private async commit(o: Order, patch: Partial<Order>, events: PendingEvent[]): Promise<Order> {
    const data = orderToDb(patch);
    const [row] = await prisma().$transaction([
      prisma().order.update({ where: { id: o.id }, data }),
      ...(events.length
        ? [prisma().orderEvent.createMany({ data: events.map((e) => ({ ...e, orderId: o.id })) })]
        : []),
    ]);
    return orderToDomain(row);
  }

  async transitionStatus(
    soNumber: string,
    to: OrderStatus,
    actor: Actor,
    captures: Partial<Order> = {},
    note?: string,
  ): Promise<Order> {
    const o = await this.mustGet(soNumber);
    if (!canTransition(o.status, to)) {
      throw new Error(`Invalid transition ${o.status} → ${to}`);
    }
    for (const req of REQUIRED_CAPTURES[to] ?? []) {
      const v = captures[req.field] ?? o[req.field];
      if (!req.optional && (v == null || v === "")) {
        throw new Error(`Missing required field for ${to}: ${req.label}`);
      }
    }
    const now = nowIso();
    const patch: Partial<Order> = {};
    const events: PendingEvent[] = [];
    const touched: string[] = ["status"];
    for (const [k, v] of Object.entries(captures)) {
      if (v == null || v === "") continue;
      const prev = o[k as keyof Order];
      if (prev !== v) {
        events.push(ev(k, prev == null ? null : val(prev), val(v), "MANUAL", actor));
        (patch as Record<string, unknown>)[k] = v;
        touched.push(k);
      }
    }
    for (const tsField of STATUS_TIMESTAMPS[to] ?? []) {
      if (o[tsField] == null) (patch as Record<string, unknown>)[tsField] = now;
    }
    patch.status = to;
    patch.statusSource = "MANUAL";
    patch.overallStatus = rollupOverall({ ...o, status: to });
    patch.manualFields = mergeManual(o.manualFields ?? [], touched);
    events.push(ev("status", o.status, to, "MANUAL", actor, note));
    return this.commit(o, patch, events);
  }

  async transitionShipment(
    soNumber: string,
    to: ShipmentStatus,
    actor: Actor,
    source: Source,
    note?: string,
  ): Promise<Order> {
    const o = await this.mustGet(soNumber);
    if (o.status !== "DISPATCHED_TO_STORE") {
      throw new Error(`Order ${soNumber} is not dispatched yet`);
    }
    // Manual override is always available (PRD §2) — the transition map guards
    // sync flows; a manual actor may force any shipment status.
    if (source === "SYNCED" && !canTransitionShipment(o.shipmentStatus, to)) {
      throw new Error(`Invalid shipment transition ${o.shipmentStatus} → ${to}`);
    }
    const now = nowIso();
    const patch: Partial<Order> = { shipmentStatus: to, shipmentSource: source };
    if (to === "IN_TRANSIT" && !o.shippedTs) patch.shippedTs = now;
    if (to === "OUT_FOR_DELIVERY") {
      if (!o.firstOfdDate) patch.firstOfdDate = now;
      patch.latestOfdDate = now;
    }
    if (to === "DELIVERED") {
      patch.deliveredTs = now;
      patch.deliveredDate = istDateOf(now);
      // The successful delivery is itself an attempt — after an NDR this makes it 2+.
      patch.deliveryAttempts = o.deliveryAttempts + 1;
    }
    patch.overallStatus = rollupOverall({ ...o, shipmentStatus: to });
    if (source === "MANUAL") patch.manualFields = mergeManual(o.manualFields ?? [], ["shipmentStatus"]);
    return this.commit(o, patch, [ev("shipmentStatus", o.shipmentStatus ?? null, to, source, actor, note)]);
  }

  async recordNdrAttempt(soNumber: string, actor: Actor, note?: string): Promise<Order> {
    const o = await this.mustGet(soNumber);
    const attempts = o.deliveryAttempts + 1;
    const patch: Partial<Order> = {
      deliveryAttempts: attempts,
      shipmentStatus: "DELIVERY_FAILED",
      shipmentSource: "MANUAL",
      overallStatus: rollupOverall({ ...o, shipmentStatus: "DELIVERY_FAILED" }),
      manualFields: mergeManual(o.manualFields ?? [], ["shipmentStatus"]),
    };
    return this.commit(o, patch, [
      ev("shipmentStatus", o.shipmentStatus ?? null, "DELIVERY_FAILED", "MANUAL", actor, note ?? `NDR — attempt ${attempts}`),
    ]);
  }

  async updateFields(
    soNumber: string,
    patch: Partial<Order>,
    actor: Actor,
    source: Source,
    note?: string,
  ): Promise<Order> {
    const o = await this.mustGet(soNumber);
    const data: Partial<Order> = {};
    const events: PendingEvent[] = [];
    const touched: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const prev = o[k as keyof Order];
      if (prev === v || v === undefined) continue;
      events.push(ev(k, prev == null ? null : val(prev), val(v), source, actor, note));
      (data as Record<string, unknown>)[k] = v;
      touched.push(k);
    }
    if (source === "MANUAL" && touched.length) {
      data.manualFields = mergeManual(o.manualFields ?? [], touched);
    }
    data.overallStatus = rollupOverall({ ...o, ...data });
    return this.commit(o, data, events);
  }
}
