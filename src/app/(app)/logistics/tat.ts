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
