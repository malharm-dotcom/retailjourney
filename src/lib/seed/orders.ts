// Deterministic order seed (PRD §12 M1) — ~120 orders spanning every phase,
// facility, type and courier so each UI state is demonstrable. Lifecycles are
// simulated hour-by-hour so timestamps, statuses and OrderEvents stay coherent.
// Dates are anchored on the real "today" so ageing/due-today views are alive.

import { addDays, istDateOf, istToday, nowIso } from "../ist";
import { rollupOverall } from "../journey";
import type { Order, OrderEvent, OrderStatus, OrderType, ShipmentStatus, Store } from "../types";
import { STORES } from "./stores";

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(260705);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));

const HOUR = 3600 * 1000;

const CATEGORIES = ["Shirts", "T-Shirts", "Jeans", "Trousers", "Co-ords", "Polos", "Shorts"];
const CAMPAIGNS = [
  undefined,
  undefined,
  undefined,
  "YUVRAJ - SUMMER CAPSULE",
  "PRIYANKA - EOSS PUSH",
  "ANISH - NEW LAUNCH DROP",
  undefined,
];

const COURIER_BY_ZONE: Record<string, string[]> = {
  NORTH: ["MUDITACARGO", "MUDITACARGO", "SELF"],
  WEST: ["MOVEMATE", "MOVEMATE", "BLUEDART"],
  SOUTH: ["MOVEMATE", "EKART B2B", "SELF"],
  EAST: ["BLUEDART", "BLUEDART", "EKART B2B"],
};

const TRANSIT_DAYS: Record<string, [number, number]> = {
  NORTH: [2, 4],
  WEST: [2, 5],
  SOUTH: [1, 3],
  EAST: [4, 7],
};

function lrFor(courier: string, i: number): string {
  const n = String(400 + i).padStart(5, "0");
  switch (courier) {
    case "MOVEMATE":
      return `BNG26CST${n}`;
    case "BLUEDART":
      return `5366${String(7000000 + i * 137).slice(0, 7)}`;
    case "MUDITACARGO":
      return `9064${String(1200 + i)}`;
    case "EKART B2B":
      return `EKB2B${String(88000 + i * 3)}`;
    default:
      return `SELF-${String(i).padStart(3, "0")}`;
  }
}

const TRANSIT_MSGS: [string, string][] = [
  ["SHIPMENT ARRIVED", "NAGPUR HUB"],
  ["SHIPMENT FURTHER CONNECTED", "BHIWANDI GATEWAY"],
  ["IN TRANSIT TO DESTINATION", "DELHI HUB"],
  ["SHIPMENT RECEIVED AT FACILITY", "HYDERABAD HUB"],
  ["LINEHAUL DEPARTED", "BENGALURU GATEWAY"],
];

/** Phase plan for the ~120 seed orders. */
type Plan =
  | { kind: "wh"; status: OrderStatus }
  | { kind: "pickup_pending" }
  | { kind: "shipment"; status: ShipmentStatus; ndr?: boolean }
  | { kind: "delivered"; receipt?: "RECEIVED" | "INWARDED" | "CLOSED"; exShort?: boolean };

const PLANS: [Plan, number][] = [
  [{ kind: "wh", status: "NOT_STARTED" }, 8],
  [{ kind: "wh", status: "PICKING" }, 8],
  [{ kind: "wh", status: "PACKING" }, 6],
  [{ kind: "wh", status: "READY_TO_DISPATCH" }, 5],
  [{ kind: "wh", status: "RTS_LOGIC" }, 4],
  [{ kind: "wh", status: "ON_HOLD" }, 3],
  [{ kind: "wh", status: "CANCELLED" }, 2],
  [{ kind: "wh", status: "UNFULFILLABLE" }, 2],
  [{ kind: "pickup_pending" }, 13],
  [{ kind: "shipment", status: "IN_TRANSIT" }, 9],
  [{ kind: "shipment", status: "IN_TRANSIT", ndr: true }, 2],
  [{ kind: "shipment", status: "OUT_FOR_DELIVERY" }, 4],
  [{ kind: "shipment", status: "DELIVERY_FAILED" }, 3],
  [{ kind: "delivered" }, 13],
  [{ kind: "delivered", receipt: "RECEIVED" }, 8],
  [{ kind: "delivered", receipt: "INWARDED", exShort: true }, 4],
  [{ kind: "delivered", receipt: "INWARDED" }, 4],
  [{ kind: "delivered", receipt: "CLOSED", exShort: true }, 2],
  [{ kind: "delivered", receipt: "CLOSED" }, 18],
];

interface Built {
  orders: Order[];
  events: OrderEvent[];
}

function build(): Built {
  const orders: Order[] = [];
  const events: OrderEvent[] = [];
  const today = istToday();
  const nowMs = Date.now();
  let seq = 0;
  let evSeq = 0;

  const pushEvent = (
    orderId: string,
    field: string,
    fromValue: string | null,
    toValue: string,
    source: "SYNCED" | "MANUAL",
    atMs: number,
    actor?: { id: string; name: string },
    note?: string,
  ) => {
    evSeq += 1;
    events.push({
      id: `ev_${String(evSeq).padStart(5, "0")}`,
      orderId,
      field,
      fromValue,
      toValue,
      source,
      actorId: actor?.id ?? null,
      actorName: actor?.name,
      note,
      createdAt: new Date(atMs).toISOString(),
    });
  };

  const flat: Plan[] = PLANS.flatMap(([p, n]) => Array(n).fill(p));

  for (const plan of flat) {
    seq += 1;
    const store: Store = pick(STORES);
    const type: OrderType =
      rand() < 0.42 ? "FRESH" : rand() < 0.65 ? "RPL" : pick(["OTHER", "Q_COMM", "ACC", "NON_TRADING"] as const);

    // Age the order enough for its target phase to be plausible.
    const ageDays =
      plan.kind === "wh"
        ? int(0, 4)
        : plan.kind === "pickup_pending"
          ? int(2, 6)
          : plan.kind === "shipment"
            ? int(3, 9)
            : int(6, 20);
    const orderDate = addDays(today, -ageDays);
    const orderMs = Date.parse(`${orderDate}T04:30:00.000Z`) + between(0, 8) * HOUR; // ~10:00–18:00 IST
    const soNumber = `SO${orderDate.slice(2, 4)}${orderDate.slice(5, 7)}${orderDate.slice(8, 10)}-${String(seq).padStart(3, "0")}`;
    const id = `ord_${String(seq).padStart(3, "0")}`;
    const qty = int(24, 520);
    const supervisor =
      store.facility === "SAPL-NORTH-TAURU"
        ? { id: "u_whsup_north", name: "Deepak Sharma" }
        : { id: "u_whsup_blr", name: "Ravi Kumar" };
    const logistics = { id: "u_logistics", name: "Logistics Desk" };

    const o: Order = {
      id,
      soNumber,
      orderDate,
      orderTimestamp: new Date(orderMs).toISOString(),
      facility: store.facility,
      channel: store.channel,
      storeId: store.id,
      storeNameFormat: store.storeName,
      finalStore: store.finalStore,
      ownership: store.ownership,
      state: store.storeState,
      zone: store.zone,
      type,
      qty,
      priority: rand() < 0.18 ? "HIGH" : undefined,
      campaignTag: pick(CAMPAIGNS),
      merchandiser: store.merchandiser,
      areaManager: store.areaManager,
      category: pick(CATEGORIES),
      status: "NOT_STARTED",
      statusSource: "SYNCED",
      overallStatus: "WH_PROCESSING",
      ucStatus: "CREATED",
      createdTs: new Date(orderMs).toISOString(),
      deliveryAttempts: 0,
      pickupAttempts: 0,
      createdAt: new Date(orderMs).toISOString(),
      updatedAt: new Date(orderMs).toISOString(),
    };
    pushEvent(id, "status", null, "NOT_STARTED", "SYNCED", orderMs, undefined, "B2B SO created in UC");
    // Quick-commerce orders demo the inherited-TAT banner (prod: set by the
    // Snowflake sync when a QC store resolves its parent by branch code).
    if (type === "Q_COMM") o.tatInheritedFrom = store.finalStore;

    // Simulate the WH pipeline hour-by-hour up to the planned stopping point.
    let t = orderMs;
    const advance = (
      status: OrderStatus,
      hoursLo: number,
      hoursHi: number,
      apply?: (at: number) => void,
    ) => {
      t += between(hoursLo, hoursHi) * HOUR;
      if (t > nowMs) t = nowMs - between(0.2, 2) * HOUR;
      pushEvent(id, "status", o.status, status, status === "RTS_LOGIC" || status === "DISPATCHED_TO_STORE" ? "MANUAL" : "SYNCED", t, status === "RTS_LOGIC" || status === "DISPATCHED_TO_STORE" ? supervisor : undefined);
      o.status = status;
      apply?.(t);
    };

    const targetWh: OrderStatus =
      plan.kind === "wh" ? plan.status : "DISPATCHED_TO_STORE";
    const pipeline: OrderStatus[] = ["PICKING", "PACKING", "READY_TO_DISPATCH", "RTS_LOGIC", "DISPATCHED_TO_STORE"];
    const stopAt =
      targetWh === "NOT_STARTED" || targetWh === "ON_HOLD" || targetWh === "CANCELLED" || targetWh === "UNFULFILLABLE"
        ? int(0, targetWh === "NOT_STARTED" ? 0 : 2) // holds/cancels happen early-ish
        : pipeline.indexOf(targetWh) + 1;

    for (let i = 0; i < stopAt; i += 1) {
      const s = pipeline[i];
      if (s === "PICKING") {
        advance("PICKING", 3, 26, (at) => {
          o.pickingTs = new Date(at).toISOString();
          o.ucStatus = "PICKING";
        });
      } else if (s === "PACKING") {
        advance("PACKING", 3, 20, (at) => {
          o.pickedTs = new Date(at).toISOString();
          o.pickedQty = qty - (rand() < 0.15 ? int(1, 6) : 0);
          o.ucStatus = "PICKED";
        });
      } else if (s === "READY_TO_DISPATCH") {
        advance("READY_TO_DISPATCH", 2, 12, (at) => {
          o.packedTs = new Date(at).toISOString();
          o.rtsTs = new Date(at).toISOString();
          o.boxCount = Math.max(1, Math.round((o.pickedQty ?? qty) / int(24, 40)));
          o.weightKg = Math.round((o.pickedQty ?? qty) * between(0.28, 0.42) * 10) / 10;
          o.fulfilledQty = o.pickedQty;
          o.ucStatus = "READY_TO_SHIP";
        });
      } else if (s === "RTS_LOGIC") {
        advance("RTS_LOGIC", 2, 18, (at) => {
          o.manifestedTs = new Date(at).toISOString();
          o.saleInvoiceNumber = `SI${orderDate.replace(/-/g, "").slice(2)}${String(seq).padStart(3, "0")}`;
          o.rtsLogicDate = istDateOf(new Date(at).toISOString());
        });
      } else if (s === "DISPATCHED_TO_STORE") {
        advance("DISPATCHED_TO_STORE", 4, 28, (at) => {
          const courier = pick(COURIER_BY_ZONE[store.zone] ?? ["MOVEMATE"]);
          o.dispatchedTs = new Date(at).toISOString();
          o.dispatchedDate = istDateOf(o.dispatchedTs);
          o.rtdDate = o.rtsLogicDate;
          o.dcNumber = `DC${orderDate.replace(/-/g, "").slice(2)}${String(seq).padStart(3, "0")}`;
          o.logisticsPartner = courier;
          o.courierPartner = courier;
          o.lrNumber = lrFor(courier, seq);
          o.trackingNumber = o.lrNumber;
          o.vehicleNumber = courier === "SELF" || rand() < 0.5 ? `KA01AB${int(1000, 9999)}` : undefined;
          o.eWayBill = `EWB${int(100000000000, 999999999999)}`;
          o.dispatchType = courier === "SELF" ? "SELF" : "PTL";
          const [lo, hi] = TRANSIT_DAYS[store.zone] ?? [2, 5];
          o.expectedDate = addDays(o.dispatchedDate, int(lo, hi));
          if (courier !== "SELF") {
            o.trackingLink = `https://track.eshipz.com/${o.lrNumber}`;
            o.eshipStatus = "InfoReceived";
            o.trackingStatus = "InfoReceived";
            o.trackingLatestMessage = `Information Received By ${courier.charAt(0) + courier.slice(1).toLowerCase()}`;
            o.lastCheckpointCity = store.facility === "SAPL-NORTH-TAURU" ? "GURUGRAM" : "BENGALURU";
          }
          pushEvent(id, "lrNumber", null, o.lrNumber!, "MANUAL", at, supervisor, `Handed over to ${courier}`);
        });
      }
    }

    // Divergent WH endings.
    if (plan.kind === "wh") {
      if (plan.status === "ON_HOLD") {
        t += between(1, 6) * HOUR;
        if (t > nowMs) t = nowMs - HOUR;
        pushEvent(id, "status", o.status, "ON_HOLD", "MANUAL", t, supervisor, "B2C sale surge — floor reprioritised");
        o.status = "ON_HOLD";
      } else if (plan.status === "CANCELLED") {
        t += between(2, 10) * HOUR;
        if (t > nowMs) t = nowMs - HOUR;
        pushEvent(id, "status", o.status, "CANCELLED", "MANUAL", t, { id: "u_yuvraj", name: "Yuvraj" }, "Store request — order withdrawn");
        o.status = "CANCELLED";
        o.cancelledTs = new Date(t).toISOString();
      } else if (plan.status === "UNFULFILLABLE") {
        t += between(2, 10) * HOUR;
        if (t > nowMs) t = nowMs - HOUR;
        pushEvent(id, "status", o.status, "UNFULFILLABLE", "SYNCED", t, undefined, "UC: inventory not found at facility");
        o.status = "UNFULFILLABLE";
        o.unfulfillableQty = qty;
        o.ucStatus = "UNFULFILLABLE";
      }
    }

    // Phase B — shipment progression.
    if (plan.kind === "shipment" || plan.kind === "delivered") {
      const self = o.logisticsPartner === "SELF";
      const src = self ? ("MANUAL" as const) : ("SYNCED" as const);
      const actor = self ? logistics : undefined;

      t += between(6, 36) * HOUR; // courier pickup scan
      if (t > nowMs) t = nowMs - 4 * HOUR;
      o.shippedTs = new Date(t).toISOString();
      o.shipmentStatus = "IN_TRANSIT";
      o.shipmentSource = src;
      o.trackingStatus = "InTransit";
      o.eshipStatus = "InTransit";
      const msg = pick(TRANSIT_MSGS);
      o.trackingLatestMessage = msg[0];
      o.lastCheckpointCity = msg[1];
      o.trackingLatestLocation = msg[1];
      pushEvent(id, "shipmentStatus", null, "IN_TRANSIT", src, t, actor, self ? "Self-delivery vehicle departed" : "First courier movement scan");

      const ndrHere = (plan.kind === "shipment" && (plan.ndr || plan.status === "DELIVERY_FAILED")) || (plan.kind === "delivered" && rand() < 0.08);
      if (ndrHere) {
        t += between(20, 60) * HOUR;
        if (t > nowMs) t = nowMs - 3 * HOUR;
        o.deliveryAttempts += 1;
        o.firstOfdDate = o.firstOfdDate ?? new Date(t - 6 * HOUR).toISOString();
        o.latestOfdDate = new Date(t - 6 * HOUR).toISOString();
        pushEvent(id, "shipmentStatus", "IN_TRANSIT", "DELIVERY_FAILED", src, t, actor, "NDR: consignee unavailable / store closed");
        o.shipmentStatus = "DELIVERY_FAILED";
        o.trackingStatus = "Exception";
        o.trackingLatestMessage = "DELIVERY ATTEMPTED - STORE CLOSED";
        if (!(plan.kind === "shipment" && plan.status === "DELIVERY_FAILED")) {
          t += between(6, 18) * HOUR;
          if (t > nowMs) t = nowMs - 2 * HOUR;
          pushEvent(id, "shipmentStatus", "DELIVERY_FAILED", "IN_TRANSIT", src, t, actor, "Reattempt scheduled");
          o.shipmentStatus = "IN_TRANSIT";
          o.trackingStatus = "InTransit";
        }
      }

      if (plan.kind === "shipment" && plan.status === "OUT_FOR_DELIVERY") {
        t += between(10, 40) * HOUR;
        if (t > nowMs) t = nowMs - 1.5 * HOUR;
        o.firstOfdDate = o.firstOfdDate ?? new Date(t).toISOString();
        o.latestOfdDate = new Date(t).toISOString();
        pushEvent(id, "shipmentStatus", o.shipmentStatus!, "OUT_FOR_DELIVERY", src, t, actor);
        o.shipmentStatus = "OUT_FOR_DELIVERY";
        o.trackingStatus = "OutForDelivery";
        o.trackingLatestMessage = "OUT FOR DELIVERY";
        o.lastCheckpointCity = store.storeCity.toUpperCase();
      }

      if (plan.kind === "delivered") {
        t += between(18, 90) * HOUR;
        if (t > nowMs) t = nowMs - 1 * HOUR;
        o.firstOfdDate = o.firstOfdDate ?? new Date(t - 5 * HOUR).toISOString();
        o.latestOfdDate = new Date(t - 5 * HOUR).toISOString();
        // The successful delivery is itself an attempt — after an NDR this makes it 2+.
        o.deliveryAttempts += 1;
        pushEvent(id, "shipmentStatus", o.shipmentStatus!, "DELIVERED", src, t, actor, self ? "POD collected by driver" : undefined);
        o.shipmentStatus = "DELIVERED";
        o.trackingStatus = "Delivered";
        o.trackingSubStatus = "Delivered";
        o.trackingLatestMessage = "Delivered";
        o.lastCheckpointCity = store.storeCity.toUpperCase();
        o.deliveredTs = new Date(t).toISOString();
        o.deliveredDate = istDateOf(o.deliveredTs);
        if (!self) o.podLink = `https://pod.eshipz.com/${o.lrNumber}.pdf`;

        // Phase C — receipt / reconciliation.
        if (plan.receipt) {
          let rt = t + between(4, 20) * HOUR;
          if (rt > nowMs) rt = nowMs - 0.8 * HOUR;
          o.receiptStatus = "RECEIVED";
          o.orderReceivedDate = istDateOf(new Date(rt).toISOString());
          o.boxesReceived = o.boxCount;
          o.totalCount = o.fulfilledQty ?? qty;
          pushEvent(id, "receiptStatus", null, "RECEIVED", "MANUAL", rt, { id: "u_store", name: store.storeName }, `${o.boxesReceived} boxes received at store`);
          if (plan.receipt === "INWARDED" || plan.receipt === "CLOSED") {
            rt += between(12, 50) * HOUR;
            if (rt > nowMs) rt = nowMs - 0.5 * HOUR;
            o.receiptStatus = "INWARDED";
            o.inwardedDate = istDateOf(new Date(rt).toISOString());
            o.stiBillNo = `STI${o.inwardedDate.replace(/-/g, "").slice(2)}${String(seq).padStart(3, "0")}`;
            o.receivingPv = `PV-${int(40000, 69999)}`;
            if (plan.exShort) {
              if (rand() < 0.6) {
                o.shortageQty = int(1, 8);
                o.excessQty = 0;
              } else {
                o.shortageQty = 0;
                o.excessQty = int(1, 5);
              }
              o.shortageExcessFileUrl = `https://drive.google.com/retailjourney-exshort/${soNumber}`;
              o.adjustmentOnLogic = rand() < 0.5;
              pushEvent(id, "shortageQty", null, String(o.shortageQty || -(o.excessQty ?? 0)), "MANUAL", rt, logistics, o.shortageQty ? "Shortage flagged at inward" : "Excess flagged at inward");
            } else {
              o.shortageQty = 0;
              o.excessQty = 0;
            }
            o.entryStatus = "OPEN";
            pushEvent(id, "receiptStatus", "RECEIVED", "INWARDED", "MANUAL", rt, logistics, `STI ${o.stiBillNo}`);
            if (plan.receipt === "CLOSED") {
              rt += between(6, 30) * HOUR;
              if (rt > nowMs) rt = nowMs - 0.3 * HOUR;
              o.receiptStatus = "CLOSED";
              o.entryStatus = "CLOSED";
              if (plan.exShort) o.adjustmentOnLogic = true;
              pushEvent(id, "receiptStatus", "INWARDED", "CLOSED", "MANUAL", rt, logistics, "Reconciliation closed");
            }
            t = rt;
          }
        }
      }
    }

    o.overallStatus = rollupOverall(o);
    o.updatedAt = new Date(Math.min(t, nowMs)).toISOString();
    orders.push(o);
  }

  return { orders, events };
}

let cache: Built | null = null;

export function seedData(): Built {
  if (!cache) cache = build();
  return cache;
}

export { nowIso as seedGeneratedAt };
