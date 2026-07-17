// Flatten the columnar rulebook source (FRESH_* / RPL_* families, per
// STORE_NAME × WH) into the app's per-store × order-type row shape — the same
// shape the Rulebook tab and the SLA engine already speak. The FRESH/RPL →
// target mapping reproduces exactly what distribution_analytics bakes into each
// order row (verified against live DA rows), so the view matches the SLA the
// engine actually applies:
//   targetOrderDay + targetOrderCutoff  ← split of *_ORDER_CUTOFF ("Friday 9 AM")
//   targetHandoverDay + targetHandoverCutoff ← split of *_TAT     ("Friday 6 PM")
//   targetPickupDay   ← *_HANDOVER_DAY
//   targetDeliveryDay ← *_DELIVERY_DAY
// The source has no OTHER type — only FRESH and RPL carry a rulebook.

import { toWeekday } from "./qc-tat";
import type { RulebookSourceRow } from "./snowflake-rulebook";
import type { Weekday, Zone } from "./types";

export type RulebookOrderType = "FRESH" | "RPL";

/** WH group a serving facility belongs to — the rulebook splits North/South. */
export type WhGroup = "NORTH" | "SOUTH";

/** One flattened rulebook row: a store × WH × (FRESH|RPL) schedule, in the
 *  per-order-type shape the grid and SLA math consume. */
export interface RulebookViewRow {
  storeKey: string; // normalized STORE_NAME (join key to app stores)
  storeName: string; // raw STORE_NAME
  wh: string; // "North WH" | "South WH" — surfaced, never collapsed
  whGroup?: WhGroup;
  orderType: RulebookOrderType;
  laneClassification?: string;
  zone?: Zone;
  bestTatDays?: number;
  bestCourier?: string;
  city?: string;
  pincode?: number;
  targetOrderDay?: Weekday;
  targetOrderCutoff?: string;
  targetHandoverDay?: Weekday;
  targetHandoverCutoff?: string;
  targetPickupDay?: Weekday;
  targetDeliveryDay?: Weekday;
}

/** Normalized join key — same rules as qc-tat.normStoreKey, kept local to
 *  avoid a cycle (qc-tat imports nothing from here). */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").toUpperCase();
}

function mapZone(z?: string | null): Zone | undefined {
  if (!z) return undefined;
  const u = z.trim().toUpperCase();
  return (["NORTH", "SOUTH", "EAST", "WEST", "UNMAPPED"] as const).includes(u as Zone)
    ? (u as Zone)
    : undefined;
}

export function whGroupOf(wh?: string | null): WhGroup | undefined {
  if (!wh) return undefined;
  return /north/i.test(wh) ? "NORTH" : /south/i.test(wh) ? "SOUTH" : undefined;
}

/** Which rulebook WH group serves this facility (TAURU = North, WH1/WH2 = South). */
export function facilityWhGroup(facility?: string | null): WhGroup | undefined {
  if (!facility) return undefined;
  return /north|tauru/i.test(facility) ? "NORTH" : /wh[12]/i.test(facility) ? "SOUTH" : undefined;
}

/** Split "Friday 9 AM" → { day: "Fri", time: "9 AM" }. A leading weekday is
 *  required to place a grid marker; anything else yields no day. */
function splitDayTime(v?: string | null): { day?: Weekday; time?: string } {
  if (!v) return {};
  const m = v.trim().match(/^([A-Za-z]+)\s+(.+)$/);
  if (m) {
    const day = toWeekday(m[1]);
    if (day) return { day, time: m[2].trim() };
  }
  const day = toWeekday(v);
  return day ? { day } : {};
}

function flattenType(r: RulebookSourceRow, type: RulebookOrderType): RulebookViewRow {
  const cutoff = type === "FRESH" ? r.FRESH_ORDER_CUTOFF : r.RPL_ORDER_CUTOFF;
  const tat = type === "FRESH" ? r.FRESH_TAT : r.RPL_TAT;
  const handoverDay = type === "FRESH" ? r.FRESH_HANDOVER_DAY : r.RPL_HANDOVER_DAY;
  const deliveryDay = type === "FRESH" ? r.FRESH_DELIVERY_DAY : r.RPL_DELIVERY_DAY;
  const order = splitDayTime(cutoff);
  const handover = splitDayTime(tat);
  return {
    storeKey: norm(r.STORE_NAME ?? ""),
    storeName: r.STORE_NAME ?? "",
    wh: r.WH ?? "",
    whGroup: whGroupOf(r.WH),
    orderType: type,
    laneClassification: r.LANE_CLASSIFICATION ?? undefined,
    zone: mapZone(r.ZONE),
    bestTatDays: r.BEST_TAT ?? undefined,
    bestCourier: r.BEST_COURIER_PARTNER ?? undefined,
    city: r.CITY ?? undefined,
    pincode: r.PINCODE ?? undefined,
    targetOrderDay: order.day,
    targetOrderCutoff: order.time,
    targetHandoverDay: handover.day,
    targetHandoverCutoff: handover.time,
    targetPickupDay: toWeekday(handoverDay),
    targetDeliveryDay: toWeekday(deliveryDay),
  };
}

/** Flatten a snapshot's rows into per-store × WH × (FRESH|RPL) view rows. */
export function flattenRulebook(rows: RulebookSourceRow[]): RulebookViewRow[] {
  const out: RulebookViewRow[] = [];
  for (const r of rows) {
    if (!r.STORE_NAME) continue;
    out.push(flattenType(r, "FRESH"), flattenType(r, "RPL"));
  }
  return out;
}

/** Static TAT template a QC order inherits from its parent's rulebook row —
 *  the parent's serving-WH row wins, falling back to any WH for that
 *  store × type. Returns undefined when the parent has no rulebook row. */
export function rulebookTemplateFor(
  rows: RulebookViewRow[],
  parentFinalStore: string,
  orderType: RulebookOrderType,
  parentFacility?: string | null,
): RulebookViewRow | undefined {
  const key = norm(parentFinalStore);
  const candidates = rows.filter((r) => r.storeKey === key && r.orderType === orderType);
  if (candidates.length === 0) return undefined;
  const wh = facilityWhGroup(parentFacility);
  return candidates.find((r) => r.whGroup === wh) ?? candidates[0];
}
