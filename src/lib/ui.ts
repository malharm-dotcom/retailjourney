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
    // Now uses its own foreground rather than borrowing ink-soft: the old
    // pending hex was too light to sit on its own tint, which is why it had to.
    pill: "bg-pending-bg text-pending",
    tile: "bg-pending-bg text-pending",
    hex: "#59534A",
    gloss: "Waiting — no action taken yet",
  },
  handling: {
    pill: "bg-ofd-bg text-ofd",
    tile: "bg-ofd-bg text-ofd",
    hex: "#74481E",
    gloss: "Being handled right now",
  },
  staged: {
    pill: "bg-stage-bg text-stage",
    tile: "bg-stage-bg text-stage",
    hex: "#1D6054",
    gloss: "Warehouse done — waiting for pickup",
  },
  motion: {
    pill: "bg-transit-bg text-transit",
    tile: "bg-transit-bg text-transit",
    hex: "#2B577F",
    gloss: "In motion with the courier",
  },
  done: {
    pill: "bg-deliv-bg text-deliv",
    tile: "bg-deliv-bg text-deliv",
    hex: "#33603B",
    gloss: "Arrived and accounted for",
  },
  failed: {
    pill: "bg-breach-bg text-breach",
    tile: "bg-breach-bg text-breach",
    hex: "#922119",
    gloss: "Failed, breached or stopped",
  },
  paused: {
    pill: "bg-hold-bg text-hold",
    tile: "bg-hold-bg text-hold",
    hex: "#5A4B75",
    gloss: "Paused on purpose",
  },
};

export interface StatusVisual {
  icon: string; // solar icon name
  label: string;
  tone: Tone;
}

/**
 * The 40px square row-action button — tracking link, edit, update shipment,
 * view journey. It was written out as a literal in four places across the
 * board, the logistics table and JourneyLink, which is exactly how two of them
 * drifted to 32px and fell under the touch floor. One definition now.
 */
export const ROW_ACTION =
  "grid h-10 w-10 shrink-0 place-items-center rounded-control border border-line-control bg-paper text-ink-soft " +
  "transition-[transform,background-color,border-color,color] duration-150 ease-ui active:scale-[0.97] " +
  "hover:border-sage hover:bg-sage-soft hover:text-sage";

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

/**
 * Icon cut: these render at 13–15px inside pills and rows, so they use the
 * SOLID `-bold` variant, not `-bold-duotone`. Duotone paints a second, lighter
 * layer that collapses to mud below ~16px — this file's own SourceBadge comment
 * already said so and the pills used duotone anyway. Duotone stays where it
 * earns its detail: 19px nav and panel headers.
 */
export const OVERALL_VISUAL: Record<OverallStatus, StatusVisual> = {
  WH_PROCESSING: { icon: "box-bold", label: "WH Processing", tone: "pending" },
  // Was `hand-money`. A money glyph for "packed, waiting for the courier" —
  // the old set's worst semantic miss. A clock says what this actually is.
  PICKUP_PENDING: { icon: "clock-circle-bold", label: "Pickup Pending", tone: "pending" },
  IN_TRANSIT: { icon: "delivery-bold", label: "In Transit", tone: "motion" },
  DELIVERED: { icon: "check-circle-bold", label: "Delivered", tone: "done" },
  // Beyond delivered: the store has booked the stock in. Same "good, finished"
  // family, one step further.
  INWARDED: { icon: "archive-check-bold", label: "Inwarded", tone: "done" },
  // Off-ladder terminal, NOT a success: an RTO'd label or a delivery that
  // failed and was never re-attempted. The "failed" tone keeps it visually
  // apart from the two done states — this order stopped, it did not finish.
  CLOSED: { icon: "close-circle-bold", label: "Closed", tone: "failed" },
};

export const SHIPMENT_VISUAL: Record<ShipmentStatus, StatusVisual> = {
  // Rung 0. The label exists and the carrier has acknowledged it, but nothing
  // has been collected — so this shares the Pickup Pending look rather than
  // inventing a sixth thing for a user to learn. It is the same fact.
  INFORECEIVED: OVERALL_VISUAL.PICKUP_PENDING,
  // Rung 1. Collected, but no transit scan yet. Motion has started — the
  // in-transit tone, with a glyph that says "handed over" rather than "moving".
  PICKED_UP: { icon: "export-bold", label: "Picked Up", tone: "motion" },
  IN_TRANSIT: OVERALL_VISUAL.IN_TRANSIT,
  // The courier has it in hand for the last mile — hands-on, not merely moving.
  OUT_FOR_DELIVERY: { icon: "scooter-bold", label: "Out for Delivery", tone: "handling" },
  DELIVERED: OVERALL_VISUAL.DELIVERED,
  DELIVERY_FAILED: { icon: "danger-triangle-bold", label: "Delivery Failed", tone: "failed" },
  // Coming back to us: nothing is happening to it until it lands.
  RETURN: { icon: "undo-left-bold", label: "Return", tone: "pending" },
};

export const WH_STATUS_VISUAL: Record<OrderStatus, StatusVisual> = {
  // Was `sleeping-square`. A sleeping face in an operations queue reads as a
  // toy; this state just means nobody has touched the order yet.
  NOT_STARTED: { icon: "minus-circle-bold", label: "Not Started", tone: "pending" },
  // Was transit-blue, which also meant IN_TRANSIT and DISPATCHED. A picker's
  // trolley is not a courier's van; blue now means courier custody only.
  PICKING: { icon: "cart-large-minimalistic-bold", label: "Picking", tone: "handling" },
  PACKING: { icon: "box-minimalistic-bold", label: "Packing", tone: "handling" },
  ON_HOLD: { icon: "pause-circle-bold", label: "On Hold", tone: "paused" },
  // Both were sage, i.e. indistinguishable from the active nav item.
  READY_TO_DISPATCH: { icon: "checklist-minimalistic-bold", label: "Ready to Dispatch", tone: "staged" },
  // This step generates the sale invoice — an "add document" glyph did not say
  // that, and a bill does.
  RTS_LOGIC: { icon: "bill-list-bold", label: "RTS Logic", tone: "staged" },
  // Was byte-identical to IN_TRANSIT: two different states rendering the same
  // glyph on the same screen. This one is the moment it LEAVES us.
  DISPATCHED_TO_STORE: { icon: "export-bold", label: "Dispatched", tone: "motion" },
  CANCELLED: { icon: "close-circle-bold", label: "Cancelled", tone: "failed" },
  // Was `ghost`, on a state that means written-off stock.
  UNFULFILLABLE: { icon: "forbidden-circle-bold", label: "Unfulfillable", tone: "failed" },
};

/**
 * SLA verdicts share a shield family so they are legible AS verdicts. Both of
 * the middle two used to be exact duplicates of a delivery state — WITHIN_SLA
 * rendered the Delivered glyph and BREACHED rendered the Delivery Failed one —
 * so an SLA column and a status column showed the same icons meaning different
 * things.
 */
export const SLA_VISUAL: Record<SlaState, StatusVisual> = {
  FUTURE_SLA: { icon: "hourglass-bold", label: "Future SLA", tone: "pending" },
  WITHIN_SLA: { icon: "shield-check-bold", label: "Within SLA", tone: "done" },
  BREACHED: { icon: "shield-cross-bold", label: "Breached", tone: "failed" },
  BREACHED_PENDING: { icon: "alarm-bold", label: "Breached · Pending", tone: "failed" },
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
  RECEIVED: { icon: "inbox-in-bold", label: "Received", tone: "handling" },
  INWARDED: { icon: "archive-check-bold", label: "Inwarded", tone: "done" },
  // Distinct from DELIVERED's check-circle: "closed" is the ledger being ruled
  // off, not the parcel arriving.
  CLOSED: { icon: "check-square-bold", label: "Closed", tone: "done" },
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
