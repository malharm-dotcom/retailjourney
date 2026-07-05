// Per-leg SLA engine (PRD §4, §7) — native port of the SQL date math from
// warehouse_b2b_performance / b2b_journey. Rulebook is advisory, never blocking:
// this module only *colours* — it never gates a transition.

import { addDays, atIstCutoff, daysBetween, istToday, nowIso, weekdayOf } from "./ist";
import type { Order, RulebookEntry, Weekday } from "./types";
import { WEEKDAYS } from "./types";

export type SlaState = "FUTURE_SLA" | "WITHIN_SLA" | "BREACHED" | "BREACHED_PENDING";

export const SLA_LABEL: Record<SlaState, string> = {
  FUTURE_SLA: "Future SLA",
  WITHIN_SLA: "Within SLA",
  BREACHED: "Breached",
  BREACHED_PENDING: "Breached · Pending",
};

/** Legs map 1:1 to the SQL columns *_SLA. */
export type SlaLeg =
  | "PLACEMENT"
  | "HANDOVER"
  | "PICKUP"
  | "DELIVERY"
  | "LOGISTICS_DELIVERY"
  | "PERFECT_ORDER";

export const LEG_LABEL: Record<SlaLeg, string> = {
  PLACEMENT: "Creation / Placement",
  HANDOVER: "WH Handover",
  PICKUP: "Courier Pickup",
  DELIVERY: "Store Delivery",
  LOGISTICS_DELIVERY: "Logistics Delivery",
  PERFECT_ORDER: "Perfect Order",
};

export interface LegSla {
  leg: SlaLeg;
  targetTs?: string; // ISO — undefined when the rulebook has no target for this leg
  actualTs?: string; // ISO
  state: SlaState | null; // null = not applicable (no target)
}

export interface OrderSla {
  legs: LegSla[];
  perfectOrder: SlaState | null;
  /** Rulebook-derived milestones (PRD §7). */
  orderCutoffTs?: string;
  handoverDeadlineTs?: string;
  pickupTargetTs?: string;
  idealDeliveryDate?: string; // YYYY-MM-DD
  /** Days open since order (delivered orders: order → delivered). */
  ageing: number;
}

/** Next occurrence of `day` on/after `businessDate` (same-day counts). */
export function nextWeekday(businessDate: string, day: Weekday): string {
  const cur = WEEKDAYS.indexOf(weekdayOf(businessDate));
  const want = WEEKDAYS.indexOf(day);
  const delta = (want - cur + 7) % 7;
  return addDays(businessDate, delta);
}

/** Strictly-after variant — used when a leg must land after the previous one. */
function nextWeekdayAfter(businessDate: string, day: Weekday): string {
  const cur = WEEKDAYS.indexOf(weekdayOf(businessDate));
  const want = WEEKDAYS.indexOf(day);
  const delta = (want - cur + 7) % 7 || 7;
  return addDays(businessDate, delta);
}

/** 4-state SLA verdict (PRD §4). */
export function slaState(targetTs?: string, actualTs?: string, now: string = nowIso()): SlaState | null {
  if (!targetTs) return null;
  if (actualTs) return actualTs <= targetTs ? "WITHIN_SLA" : "BREACHED";
  return now > targetTs ? "BREACHED_PENDING" : "FUTURE_SLA";
}

/** Pick the rulebook version in effect on the order date (PRD §5 — versioned monthly). */
export function ruleFor(
  rules: RulebookEntry[],
  storeId: string,
  orderType: Order["type"],
  orderDate: string,
): RulebookEntry | undefined {
  return rules
    .filter(
      (r) =>
        r.storeId === storeId &&
        r.orderType === orderType &&
        r.effectiveFrom <= orderDate &&
        (!r.effectiveTo || r.effectiveTo >= orderDate),
    )
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

/**
 * Derive the rulebook milestones for an order, anchored on its order date
 * (port of ORDER_CUTOFF_TS / HANDOVER_DEADLINE_TS / IDEAL_DELIVERY_DATE):
 *   cutoff  = target order day (same-week, same-day counts) at the order cutoff time
 *   handover= next target handover day on/after cutoff, at the handover cutoff
 *   pickup  = next target pickup day on/after handover
 *   delivery= next target delivery day on/after pickup
 */
export function deriveTargets(orderDate: string, rule?: RulebookEntry) {
  if (!rule) return {};
  const cutoffDate = rule.targetOrderDay ? nextWeekday(orderDate, rule.targetOrderDay) : orderDate;
  const orderCutoffTs = atIstCutoff(cutoffDate, rule.targetOrderCutoff);
  const handoverDate = rule.targetHandoverDay
    ? nextWeekdayAfter(cutoffDate, rule.targetHandoverDay)
    : undefined;
  const handoverDeadlineTs = handoverDate
    ? atIstCutoff(handoverDate, rule.targetHandoverCutoff)
    : undefined;
  const pickupDate = rule.targetPickupDay
    ? nextWeekday(handoverDate ?? cutoffDate, rule.targetPickupDay)
    : undefined;
  const pickupTargetTs = pickupDate ? atIstCutoff(pickupDate) : undefined;
  const idealDeliveryDate = rule.targetDeliveryDay
    ? nextWeekdayAfter(pickupDate ?? handoverDate ?? cutoffDate, rule.targetDeliveryDay)
    : rule.bestTatDays != null
      ? addDays(cutoffDate, rule.bestTatDays)
      : undefined;
  return { orderCutoffTs, handoverDeadlineTs, pickupTargetTs, idealDeliveryDate };
}

/** Compute every leg's SLA for one order. */
export function computeOrderSla(order: Order, rule?: RulebookEntry, now: string = nowIso()): OrderSla {
  const t = deriveTargets(order.orderDate, rule);
  const idealDeliveryTs = t.idealDeliveryDate ? atIstCutoff(t.idealDeliveryDate) : undefined;
  const expectedTs = order.expectedDate ? atIstCutoff(order.expectedDate) : undefined;
  const deliveredTs =
    order.deliveredTs ?? (order.deliveredDate ? atIstCutoff(order.deliveredDate, "6PM") : undefined);
  const handoverActual =
    order.dispatchedTs ?? (order.dispatchedDate ? atIstCutoff(order.dispatchedDate, "6PM") : undefined);

  const legs: LegSla[] = [
    {
      leg: "PLACEMENT",
      targetTs: t.orderCutoffTs,
      actualTs: order.orderTimestamp,
      state: slaState(t.orderCutoffTs, order.orderTimestamp, now),
    },
    {
      leg: "HANDOVER",
      targetTs: t.handoverDeadlineTs,
      actualTs: handoverActual,
      state: slaState(t.handoverDeadlineTs, handoverActual, now),
    },
    {
      leg: "PICKUP",
      targetTs: t.pickupTargetTs,
      actualTs: order.shippedTs,
      state: slaState(t.pickupTargetTs, order.shippedTs, now),
    },
    {
      leg: "DELIVERY",
      targetTs: idealDeliveryTs,
      actualTs: deliveredTs,
      state: slaState(idealDeliveryTs, deliveredTs, now),
    },
    {
      leg: "LOGISTICS_DELIVERY",
      targetTs: expectedTs,
      actualTs: deliveredTs,
      state: slaState(expectedTs, deliveredTs, now),
    },
  ];

  const applicable = legs.filter((l) => l.state !== null);
  let perfectOrder: SlaState | null = null;
  if (applicable.length) {
    const clean = (order.shortageQty ?? 0) === 0 && (order.excessQty ?? 0) === 0;
    if (applicable.some((l) => l.state === "BREACHED" || (!clean && l.leg === "DELIVERY"))) {
      perfectOrder = "BREACHED";
    } else if (applicable.some((l) => l.state === "BREACHED_PENDING")) {
      perfectOrder = "BREACHED_PENDING";
    } else if (applicable.every((l) => l.state === "WITHIN_SLA")) {
      perfectOrder = clean ? "WITHIN_SLA" : "BREACHED";
    } else {
      perfectOrder = "FUTURE_SLA";
    }
  }

  const endDate = order.deliveredDate ?? istToday();
  const ageing = Math.max(0, daysBetween(order.orderDate, endDate));

  return { legs, perfectOrder, ...t, ageing };
}

/** Ageing buckets used by the In-Transit board and reports. */
export function ageingBucket(days: number): "0-2" | "3-5" | "6-9" | "10+" {
  if (days <= 2) return "0-2";
  if (days <= 5) return "3-5";
  if (days <= 9) return "6-9";
  return "10+";
}

/** True when any leg is BREACHED or BREACHED_PENDING right now. */
export function isBreaching(sla: OrderSla): boolean {
  return sla.legs.some((l) => l.state === "BREACHED" || l.state === "BREACHED_PENDING");
}
