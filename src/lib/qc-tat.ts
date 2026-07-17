// Store-key normalization + QC TAT inheritance — pure functions, no DB.
//
// QC (quick-commerce) stores operate out of a parent store's premises and
// share its branchCode. They have no rulebook row upstream, so their
// distribution_analytics rows carry no TAT/deadline columns. Rule: a QC
// order inherits its PARENT store's TAT — the parent's static rulebook
// pattern (target days/cutoffs, baked into the parent's own rows) re-anchored
// on the QC order's order date via the existing deriveTargets() date math.
// Inheritance is visible, never silent: the order records tatInheritedFrom.

import { deriveTargets } from "./sla";
import type { Order, Store, Weekday } from "./types";
import { WEEKDAYS } from "./types";

/** Normalized join key for STORE strings. Snowflake is the runtime authority,
 *  but its strings drift on whitespace ("QC  KALYAN NAGAR") and hyphen spacing
 *  ("HSR LAYOUT - 2" vs "HSR LAYOUT-2") — collapse both so one physical store
 *  never forks into two keys. */
export function normStoreKey(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").toUpperCase();
}

/** Warehouse/corporate nodes that appear as STORE values but are not stores —
 *  never create Store rows for them (branch code 0 in the branch-code file). */
export const EXCLUDED_STORE_KEYS = new Set(["B2BCORPORATE", "SAPL - NORTH - TAURU"].map(normStoreKey));

export function isExcludedStoreKey(key: string): boolean {
  return EXCLUDED_STORE_KEYS.has(normStoreKey(key));
}

/** "SNITCH - COFO - QC KALYAN NAGAR" → ownership COFO, storeName "COFO - QC KALYAN NAGAR".
 *  "SNITCH - MFC - HYDERABAD" → ownership MFC (normal store, normal rulebook lookup).
 *  "SUVIDHA STORES - SONIPAT" → ownership SUVIDHA (external destination, still tracked). */
export function parseStoreKey(key: string): { ownership?: string; storeName: string } {
  const m = key.match(/^SNITCH\s*-\s*(COCO|COFO|FOCO|MFC)\s*-\s*(.+)$/i);
  if (m) return { ownership: m[1].toUpperCase(), storeName: `${m[1].toUpperCase()} - ${m[2].trim()}` };
  if (/^SUVIDHA\b/i.test(key.trim())) return { ownership: "SUVIDHA", storeName: key.trim() };
  return { storeName: key.replace(/^SNITCH\s*-\s*/i, "").trim() };
}

/** QC = the store name carries the "QC" prefix after the ownership segment. */
export function isQcStoreKey(key: string): boolean {
  const { storeName } = parseStoreKey(normStoreKey(key));
  return /^(?:COCO|COFO|FOCO)\s*-\s*QC\s/i.test(storeName) || /^QC\s/i.test(storeName);
}

export type QcParentResolution =
  | { parent: Store }
  | { parent?: undefined; reason: "NO_PARENT" | "AMBIGUOUS"; candidates: Store[] };

/** The parent of a QC store is the non-QC store sharing its branchCode. */
export function resolveQcParent(store: Store, stores: Store[]): QcParentResolution {
  const candidates = stores.filter(
    (s) => !s.isQuickCommerce && s.id !== store.id && s.branchCode === store.branchCode,
  );
  if (candidates.length === 1) return { parent: candidates[0] };
  return { reason: candidates.length === 0 ? "NO_PARENT" : "AMBIGUOUS", candidates };
}

/** Static per-store TAT pattern, as carried on the parent's own order rows. */
export interface TatTemplate {
  targetOrderDay?: string;
  targetOrderCutoff?: string;
  targetHandoverDay?: string;
  targetHandoverCutoff?: string;
  targetPickupDay?: string;
  targetDeliveryDay?: string;
  bestTat?: number;
  laneClassification?: string;
  zone?: string;
}

/** Snowflake carries both short ("Mon") and full ("Monday") day names. */
export function toWeekday(v?: string | null): Weekday | undefined {
  if (!v) return undefined;
  const short = (v.trim().slice(0, 1).toUpperCase() + v.trim().slice(1, 3).toLowerCase()) as Weekday;
  return WEEKDAYS.includes(short) ? short : undefined;
}

/** True when the mapped patch carries its own rulebook deadlines (the store
 *  has a rulebook row upstream) — inheritance must then stay out of the way. */
export function hasOwnDeadlines(patch: Partial<Order>): boolean {
  return Boolean(
    patch.orderCutoffTs ||
      patch.handoverDeadlineTs ||
      patch.pickupTat ||
      patch.deliveryTat ||
      patch.idealDeliveryDate ||
      patch.targetDeliveryDay,
  );
}

/** The inheritance gate: only quick-commerce stores, and only when the row
 *  carries no deadlines of its own — non-QC orders are never touched, and a
 *  QC store that gains its own rulebook row upstream wins over inheritance. */
export function shouldInheritQcTat(store: Store, patch: Partial<Order>): boolean {
  return store.isQuickCommerce && !hasOwnDeadlines(patch);
}

/**
 * Deadline patch inherited from the parent's TAT pattern, anchored on the QC
 * order's own order date. Returns undefined when the template has no usable
 * pattern (the order then surfaces as "no target" — never a false breach).
 */
export function buildInheritedTat(orderDate: string, t: TatTemplate): Partial<Order> | undefined {
  const rule = {
    targetOrderDay: toWeekday(t.targetOrderDay),
    targetOrderCutoff: t.targetOrderCutoff,
    targetHandoverDay: toWeekday(t.targetHandoverDay),
    targetHandoverCutoff: t.targetHandoverCutoff,
    targetPickupDay: toWeekday(t.targetPickupDay),
    targetDeliveryDay: toWeekday(t.targetDeliveryDay),
    bestTatDays: t.bestTat,
  };
  if (!rule.targetOrderDay && !rule.targetDeliveryDay && rule.bestTatDays == null) return undefined;

  const d = deriveTargets(orderDate, rule as never);
  return {
    targetOrderDay: t.targetOrderDay,
    targetOrderCutoff: t.targetOrderCutoff,
    targetHandoverDay: t.targetHandoverDay,
    targetHandoverCutoff: t.targetHandoverCutoff,
    targetPickupDay: t.targetPickupDay,
    targetDeliveryDay: t.targetDeliveryDay,
    bestTat: t.bestTat,
    orderCutoffTs: d.orderCutoffTs,
    handoverDeadlineTs: d.handoverDeadlineTs,
    pickupTat: d.pickupTargetTs,
    idealDeliveryDate: d.idealDeliveryDate,
  };
}
