// The order-search filter model — shared by the /orders page that renders it,
// the repos that apply it, and the tests that pin it.
//
// The whole point of this module is one rule: an EMPTY search paints the last
// 30 days, and ANY search lifts that window and reaches all of Postgres. The
// mask is a first-paint convenience, never a retention boundary — nothing that
// was ever synced becomes unfindable (Artifact C).

import { addDays } from "./ist";
import type { OrderStatus } from "./types";

/** How many days of orders the default (unsearched) list paints. */
export const DEFAULT_WINDOW_DAYS = 30;

export interface OrderSearch {
  /** SO number or store name, substring, case-insensitive. */
  q: string;
  /** Inclusive orderDate bounds, IST business dates (YYYY-MM-DD). */
  from: string;
  to: string;
  status: OrderStatus | "";
  /** Exact storeNameFormat, as the boards name a store. */
  store: string;
}

export const EMPTY_SEARCH: OrderSearch = { q: "", from: "", to: "", status: "", store: "" };

export const SEARCHABLE_STATUSES: OrderStatus[] = [
  "NOT_STARTED",
  "PICKING",
  "PACKING",
  "ON_HOLD",
  "READY_TO_DISPATCH",
  "RTS_LOGIC",
  "DISPATCHED_TO_STORE",
  "CANCELLED",
  "UNFULFILLABLE",
];

/** IST business date, YYYY-MM-DD. Anything else is treated as "not set" rather
 *  than thrown — a hand-edited URL should widen the list, never error it. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is the user actually searching? Drives the window lift, so it must be true
 *  for EVERY facet — narrowing by status alone still has to reach history. */
export function isSearching(s: OrderSearch): boolean {
  return Boolean(s.q || s.from || s.to || s.status || s.store);
}

/**
 * The lower `orderDate` bound to apply, or undefined for "no floor".
 *
 * Undefined on any search: that IS the lift. `from`/`to` then bound the query
 * on their own, and a search with neither scans all of Postgres by design.
 */
export function orderDateFloor(s: OrderSearch, today: string): string | undefined {
  return isSearching(s) ? undefined : addDays(today, -DEFAULT_WINDOW_DAYS);
}

export function searchFromParams(params: Record<string, string | string[] | undefined>): OrderSearch {
  const one = (k: string): string => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const date = (k: string): string => (DATE_RE.test(one(k)) ? one(k) : "");
  const status = one("status");
  return {
    q: one("q"),
    from: date("from"),
    to: date("to"),
    // An unknown status would empty the list with no way to tell that from a
    // genuinely empty result, so it degrades to "every status".
    status: (SEARCHABLE_STATUSES.includes(status as OrderStatus) ? status : "") as OrderStatus | "",
    store: one("store"),
  };
}

/** In-memory equivalent of the pushed-down predicate, for the seed repo. */
export function matchesSearch(
  o: { soNumber: string; storeNameFormat: string; orderDate: string; status: string },
  s: OrderSearch,
  floor?: string,
): boolean {
  if (floor && o.orderDate < floor) return false;
  if (s.from && o.orderDate < s.from) return false;
  if (s.to && o.orderDate > s.to) return false;
  if (s.status && o.status !== s.status) return false;
  if (s.store && o.storeNameFormat !== s.store) return false;
  if (s.q) {
    const needle = s.q.toLowerCase();
    if (![o.soNumber, o.storeNameFormat].some((v) => v.toLowerCase().includes(needle))) return false;
  }
  return true;
}
