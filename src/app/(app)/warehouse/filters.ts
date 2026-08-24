// Warehouse queue filter model. Pure functions over the card list, shared by
// the server component that applies them and the client bar that renders them,
// so the URL, the bar and the board cannot drift apart.
//
// URL-param-backed on purpose: a supervisor sending "the overdue FRESH ones at
// WH-1" to a colleague sends a link, not a description.

import { WH_FLOW } from "@/lib/journey";
import type { OrderStatus, OrderType } from "@/lib/types";

/**
 * Every stage the queue holds, in flow order.
 *
 * Single source of truth for both the server list and the table's stage
 * quick-filter, so a lane that exists in one and not the other is impossible.
 * ON_HOLD trails the flow: it is a real stage an order sits in, but it is off
 * the happy path and never a bulk target.
 */
export const QUEUE_STAGES: OrderStatus[] = [...WH_FLOW, "ON_HOLD"];

/** Age buckets, in days since the order landed. */
export const AGE_BUCKETS = [
  { key: "0-1", label: "0–1 days", min: 0, max: 1 },
  { key: "2-3", label: "2–3 days", min: 2, max: 3 },
  { key: "4-7", label: "4–7 days", min: 4, max: 7 },
  { key: "8+", label: "8+ days", min: 8, max: Infinity },
] as const;

export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"];

export interface QueueFilters {
  /** SO · store · campaign. */
  q: string;
  store: string;
  type: OrderType | "";
  age: AgeBucketKey | "";
  /** Only orders whose handover deadline has already passed. */
  overdue: boolean;
  channel: string;
  /** One queue stage, or "" for every stage. Replaces the kanban's columns:
   *  narrowing to a stage is now a filter, not a horizontal scroll. */
  stage: OrderStatus | "";
}

export const EMPTY_FILTERS: QueueFilters = {
  q: "",
  store: "",
  type: "",
  age: "",
  overdue: false,
  channel: "",
  stage: "",
};

/** Anything the filters can be applied to — the card shape, narrowed to the
 *  fields that participate, so this stays usable from both sides. */
export interface Filterable {
  so: string;
  store: string;
  campaign?: string;
  type: OrderType;
  channel?: string;
  ageDays: number;
  due?: "today" | "overdue";
  status: OrderStatus;
}

/** Read filters out of Next's searchParams. Unknown values fall back to the
 *  neutral default rather than throwing — a hand-edited URL should degrade to
 *  a broader board, never to an error page. */
export function filtersFromParams(params: Record<string, string | string[] | undefined>): QueueFilters {
  const one = (k: string): string => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const age = one("age");
  const stage = one("stage");
  return {
    q: one("q"),
    store: one("store"),
    type: (one("type") as OrderType) || "",
    age: (AGE_BUCKETS.some((b) => b.key === age) ? age : "") as AgeBucketKey | "",
    overdue: one("overdue") === "1",
    channel: one("channel"),
    // A stage outside the queue would filter the table down to nothing with no
    // way to tell that from an empty warehouse, so it degrades to "all stages".
    stage: (QUEUE_STAGES.includes(stage as OrderStatus) ? stage : "") as OrderStatus | "",
  };
}

/** Back to a query string, omitting neutral values so a default board has a
 *  clean URL. */
export function paramsFromFilters(f: QueueFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.store) p.set("store", f.store);
  if (f.type) p.set("type", f.type);
  if (f.age) p.set("age", f.age);
  if (f.overdue) p.set("overdue", "1");
  if (f.channel) p.set("channel", f.channel);
  if (f.stage) p.set("stage", f.stage);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function isFiltered(f: QueueFilters): boolean {
  return Boolean(f.q || f.store || f.type || f.age || f.overdue || f.channel || f.stage);
}

export function matchesFilters(c: Filterable, f: QueueFilters): boolean {
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [c.so, c.store, c.campaign].filter(Boolean) as string[];
    if (!hay.some((v) => v.toLowerCase().includes(needle))) return false;
  }
  if (f.stage && c.status !== f.stage) return false;
  if (f.store && c.store !== f.store) return false;
  if (f.type && c.type !== f.type) return false;
  if (f.channel && c.channel !== f.channel) return false;
  // Consumed, never recomputed: the handover verdict is the SLA engine's, and
  // this board only reads the flag the server already derived from it.
  if (f.overdue && c.due !== "overdue") return false;
  if (f.age) {
    const b = AGE_BUCKETS.find((x) => x.key === f.age)!;
    if (c.ageDays < b.min || c.ageDays > b.max) return false;
  }
  return true;
}
