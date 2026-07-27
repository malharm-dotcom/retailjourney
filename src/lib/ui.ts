// Status → presentation mapping.
//
// Colour answers exactly one question here: WHERE IS THE BATON. Nothing else.
// Every status resolves to one of seven tones, and a tone owns its pill, its
// rail hex and its icon tile — so a status cannot be amber in a pill and sage in
// a KPI tile the way Pickup Pending used to be.
//
// Colour is never the only channel: every status renders as icon + label, and
// mutable values additionally carry a ● synced / ✎ manual source badge.

import type { OrderStatus, OverallStatus, ShipmentStatus } from "./types";
import type { SlaState } from "./sla";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The seven tones. `sage` is deliberately absent — it is chrome (active nav,
 * focus, selection, primary affordance) and was previously doing double duty as
 * READY_TO_DISPATCH, RTS_LOGIC, INWARDED and the Pickup-Pending tile, which is
 * why colour alone could never tell you anything.
 */
export type Tone =
  /** Waiting. Nothing is being done to this order yet, and that is fine. */
  | "pending"
  /** Someone's hands are on it right now — in the WH, or on the last mile. */
  | "handling"
  /** The warehouse is finished; the baton is set down waiting to be taken. */
  | "staged"
  /** Moving, in a courier's custody. */
  | "motion"
  /** Arrived, booked in, closed, inside SLA. */
  | "done"
  /** Failed, breached, cancelled, unfulfillable. */
  | "failed"
  /** Deliberately paused by a person. */
  | "paused";

interface ToneStyle {
  /** Pill background + foreground. Every pairing clears 4.5:1 at 11px. */
  pill: string;
  /** Tinted icon tile (KPI cards, panel headers). Same hue as the pill. */
  tile: string;
  /** Rail / dot / accent hex, for `--rail` and inline SVG-free dots. */
  hex: string;
  /** Plain-language gloss, for tooltips and the status legend. */
  gloss: string;
}

export const TONE: Record<Tone, ToneStyle> = {
  pending: {
    pill: "bg-pending-bg text-ink-soft",
    tile: "bg-pending-bg text-ink-soft",
    hex: "#9A9080",
    gloss: "Waiting — no action taken yet",
  },
  handling: {
    pill: "bg-ofd-bg text-ofd",
    tile: "bg-ofd-bg text-ofd",
    hex: "#855C21",
    gloss: "Being handled right now",
  },
  staged: {
    pill: "bg-stage-bg text-stage",
    tile: "bg-stage-bg text-stage",
    hex: "#2A6F67",
    gloss: "Warehouse done — waiting for pickup",
  },
  motion: {
    pill: "bg-transit-bg text-transit",
    tile: "bg-transit-bg text-transit",
    hex: "#416984",
    gloss: "In motion with the courier",
  },
  done: {
    pill: "bg-deliv-bg text-deliv",
    tile: "bg-deliv-bg text-deliv",
    hex: "#396F54",
    gloss: "Arrived and accounted for",
  },
  failed: {
    pill: "bg-breach-bg text-breach",
    tile: "bg-breach-bg text-breach",
    hex: "#A34737",
    gloss: "Failed, breached or stopped",
  },
  paused: {
    pill: "bg-hold-bg text-hold",
    tile: "bg-hold-bg text-hold",
    hex: "#705A88",
    gloss: "Paused on purpose",
  },
};

export interface StatusVisual {
  icon: string; // solar icon name
  label: string;
  tone: Tone;
}

/** Pill classes for a status. */
export const pillOf = (v: StatusVisual) => TONE[v.tone].pill;
/** Tinted icon-tile classes for a status. */
export const tileOf = (v: StatusVisual) => TONE[v.tone].tile;
/** Rail / dot hex for a status — feeds the `--rail` custom property. */
export const railOf = (v: StatusVisual) => TONE[v.tone].hex;

/**
 * Emphasis for a transit-age figure, keyed by `ageingBucket()` from ./sla.
 *
 * The board used to hardcode `ageing >= 5` as its red threshold while the
 * product's real buckets (2 / 5 / 9) lived in `ageingBucket` and were used only
 * by the reports — so the board and the report disagreed about when an order is
 * old. One vocabulary now. Age is emphasis, not status: it never borrows a pill.
 */
export const AGE_EMPHASIS: Record<"0-2" | "3-5" | "6-9" | "10+", { className: string; note: string }> = {
  "0-2": { className: "text-ink", note: "on track" },
  "3-5": { className: "text-ofd", note: "watch" },
  "6-9": { className: "text-breach", note: "overdue" },
  "10+": { className: "text-breach", note: "critical" },
};

/** The legend, so the palette is documented in the product and not just here. */
export const TONE_LEGEND: { tone: Tone; gloss: string }[] = (
  ["pending", "handling", "staged", "motion", "done", "failed", "paused"] as Tone[]
).map((tone) => ({ tone, gloss: TONE[tone].gloss }));

export const OVERALL_VISUAL: Record<OverallStatus, StatusVisual> = {
  WH_PROCESSING: { icon: "box-bold-duotone", label: "WH Processing", tone: "pending" },
  PICKUP_PENDING: { icon: "hand-money-bold-duotone", label: "Pickup Pending", tone: "pending" },
  IN_TRANSIT: { icon: "delivery-bold-duotone", label: "In Transit", tone: "motion" },
  DELIVERED: { icon: "check-circle-bold-duotone", label: "Delivered", tone: "done" },
  // Beyond delivered: the store has booked the stock in. Same "good, finished"
  // family, one step further.
  INWARDED: { icon: "clipboard-check-bold-duotone", label: "Inwarded", tone: "done" },
};

export const SHIPMENT_VISUAL: Record<ShipmentStatus, StatusVisual> = {
  IN_TRANSIT: OVERALL_VISUAL.IN_TRANSIT,
  // The courier has it in hand for the last mile — hands-on, not merely moving.
  OUT_FOR_DELIVERY: { icon: "scooter-bold-duotone", label: "Out for Delivery", tone: "handling" },
  DELIVERED: OVERALL_VISUAL.DELIVERED,
  DELIVERY_FAILED: { icon: "danger-triangle-bold-duotone", label: "Delivery Failed", tone: "failed" },
  // Coming back to us: nothing is happening to it until it lands.
  RETURN: { icon: "rewind-back-bold-duotone", label: "Return", tone: "pending" },
};

export const WH_STATUS_VISUAL: Record<OrderStatus, StatusVisual> = {
  NOT_STARTED: { icon: "sleeping-square-bold-duotone", label: "Not Started", tone: "pending" },
  // Was transit-blue, which also meant IN_TRANSIT and DISPATCHED. A picker's
  // trolley is not a courier's van; blue now means courier custody only.
  PICKING: { icon: "cart-check-bold-duotone", label: "Picking", tone: "handling" },
  PACKING: { icon: "box-minimalistic-bold-duotone", label: "Packing", tone: "handling" },
  ON_HOLD: { icon: "pause-circle-bold-duotone", label: "On Hold", tone: "paused" },
  // Both were sage, i.e. indistinguishable from the active nav item.
  READY_TO_DISPATCH: { icon: "checklist-minimalistic-bold-duotone", label: "Ready to Dispatch", tone: "staged" },
  RTS_LOGIC: { icon: "document-add-bold-duotone", label: "RTS Logic", tone: "staged" },
  DISPATCHED_TO_STORE: { icon: "delivery-bold-duotone", label: "Dispatched", tone: "motion" },
  CANCELLED: { icon: "close-circle-bold-duotone", label: "Cancelled", tone: "failed" },
  UNFULFILLABLE: { icon: "ghost-bold-duotone", label: "Unfulfillable", tone: "failed" },
};

export const SLA_VISUAL: Record<SlaState, StatusVisual> = {
  FUTURE_SLA: { icon: "hourglass-bold-duotone", label: "Future SLA", tone: "pending" },
  WITHIN_SLA: { icon: "check-circle-bold-duotone", label: "Within SLA", tone: "done" },
  BREACHED: { icon: "danger-triangle-bold-duotone", label: "Breached", tone: "failed" },
  BREACHED_PENDING: { icon: "alarm-bold-duotone", label: "Breached · Pending", tone: "failed" },
};

/**
 * Reverse lookup: a status LABEL back to its visual.
 *
 * The reports surface renders `ReportTableData.rows` typed `(string | number)[][]`,
 * so a report cell has no way to carry a `StatusVisual` — which is why eight
 * reports rendered every SLA verdict as uniform grey text, on the one surface
 * leadership uses to decide. Rather than restructure twenty-two row builders, the
 * table matches a cell against this map on an exact label hit and renders a pill.
 * A store name or a courier will never collide with "Breached" or "Out for
 * Delivery"; anything unmatched is left exactly as it was.
 */
export function visualByLabel(value: unknown): StatusVisual | null {
  if (typeof value !== "string") return null;
  return LABEL_INDEX.get(value) ?? null;
}

export const RECEIPT_VISUAL = {
  // The store has the boxes but has not booked them in — that is a task
  // sitting on someone's desk, so it reads as hands-on, not as "in motion".
  RECEIVED: { icon: "inbox-in-bold-duotone", label: "Received", tone: "handling" },
  INWARDED: { icon: "archive-check-bold-duotone", label: "Inwarded", tone: "done" },
  CLOSED: { icon: "check-circle-bold-duotone", label: "Closed", tone: "done" },
} as const satisfies Record<string, StatusVisual>;

/**
 * Built last, from every map above. Earlier definitions win on a duplicate label
 * (e.g. "Inwarded" and "Delivered" appear in two maps with the same tone), so the
 * order here is deliberate rather than incidental.
 */
const LABEL_INDEX: Map<string, StatusVisual> = new Map(
  [
    ...Object.values(OVERALL_VISUAL),
    ...Object.values(SHIPMENT_VISUAL),
    ...Object.values(WH_STATUS_VISUAL),
    ...Object.values(SLA_VISUAL),
    ...Object.values(RECEIPT_VISUAL),
  ].map((v) => [v.label, v as StatusVisual]),
);
