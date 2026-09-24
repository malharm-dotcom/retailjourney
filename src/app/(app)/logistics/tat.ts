// The two derived columns on the Logistics table, as pure functions so they
// have somewhere to be tested from. Both are DISPLAY ONLY: neither feeds a
// verdict back into the SLA engine, which keeps its own authoritative legs.

import { daysBetween, weekdayOf } from "@/lib/ist";

/** The tracker's TAT colouring — delivery against the EDD already on the order. */
export type TatStatus = "early" | "ontime" | "late" | "pending";

export function tatStatusOf(
  edd: string | undefined,
  delivered: string | undefined,
  today: string,
): TatStatus | undefined {
  if (!edd) return undefined;
  // Not delivered yet is either "still has time" or "already past its date" —
  // and the second one must not read as on-time just because nothing landed.
  if (!delivered) return today > edd ? "late" : "pending";
  const drift = daysBetween(edd, delivered);
  return drift < 0 ? "early" : drift === 0 ? "ontime" : "late";
}

/**
 * Rulebook handover day vs the day the courier actually collected.
 *
 * The rulebook day is stored spelled out ("Sunday") and `weekdayOf` returns
 * "Sun", so the comparison is on the three-letter stem. Undefined — not "N" —
 * when either side is missing: 5% of orders carry no rulebook day and nothing
 * has been collected on a pending one, and neither is a rulebook miss.
 */
export function perRulebook(targetHandoverDay?: string, pickup?: string): boolean | undefined {
  if (!targetHandoverDay || !pickup) return undefined;
  return targetHandoverDay.trim().slice(0, 3).toLowerCase() === weekdayOf(pickup).slice(0, 3).toLowerCase();
}

/** Why a shipment is on the coordinator's to-do list, most urgent first. */
export type ActionReason = "failed" | "ndr" | "breached" | "at-risk";

export const ACTION_LABEL: Record<ActionReason, string> = {
  failed: "Delivery failed",
  ndr: "NDR — reattempt",
  breached: "Breached",
  "at-risk": "At risk",
};

/**
 * The one reason this shipment needs a person, or undefined when it is moving
 * on its own. Order matters — a failed delivery is also breached, and the
 * failure is what the coordinator has to act on.
 *
 * - failed:   the courier gave up, and nobody has decided RTO / reattempt yet
 *             (a MANUAL status means someone already did).
 * - ndr:      at least one failed attempt, still not delivered.
 * - breached: a leg is past its target and still open (pickup overdue too).
 * - at-risk:  due today and not out for delivery, or due tomorrow and not
 *             even collected — the last point where a call to the courier
 *             still changes the outcome.
 *
 * An inwarded order is done whatever its courier status says: the store has
 * booked the stock in.
 */
export function actionReason(r: {
  shipment?: string;
  overall?: string;
  source?: string;
  delivered?: string;
  attempts: number;
  breaching: boolean;
  edd?: string;
  courierEdd?: string;
}, today: string, tomorrow: string): ActionReason | undefined {
  if (r.delivered || r.overall === "INWARDED" || r.shipment === "DELIVERED" || r.shipment === "RETURN") return undefined;
  if (r.shipment === "DELIVERY_FAILED") return r.source === "MANUAL" ? undefined : "failed";
  if (r.attempts > 0) return "ndr";
  if (r.breaching) return "breached";
  const dueOn = (day: string) => r.edd === day || r.courierEdd === day;
  const collected = r.shipment && r.shipment !== "INFORECEIVED";
  if (dueOn(today) && r.shipment !== "OUT_FOR_DELIVERY") return "at-risk";
  if (dueOn(tomorrow) && !collected) return "at-risk";
  return undefined;
}
