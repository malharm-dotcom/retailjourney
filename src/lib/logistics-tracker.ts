// Logistics Tracker — the B2B logistics team's dispatch log, replacing their
// "B2B Forward Outstation" sheet. Pure pieces live here (field model,
// validation, live-order matching) so they can be tested; the reads and writes
// sit in the page and tracker-actions.ts.
//
// Columns are the ones the team still fills in (measured on the sheet's rows
// since 2026-08-25). The sheet's formula columns are not stored: the app
// computes what it needs, and the order's own status comes from the app live.

import type { OverallStatus, ShipmentStatus } from "./types";

/** Suggestions only (rendered as a datalist): the team can still type a value
 *  the sheet has never seen. Taken from the values actually in use. */
export const TRACKER_OPTIONS = {
  orderType: ["B2B Forward", "NSO"],
  dispatchType: ["PTL", "FTL"],
  shipmentStatus: ["In-Transit", "Out for Delivery", "DELIVERED", "Failed Delivered", "RTO"],
  allocationType: ["FRESH ALLOCATION", "RPL", "Q-Comm", "ACC", "NON TRADING", "NSO", "NSO ACC", "B2B CORPORATE", "PhotoShoot"],
  courierPartner: [
    "MUDITACARGO",
    "MUDITA-FORWARD",
    "BLUEDART",
    "MOVEMATE LOGISTICS PRIVATE LIMITED",
    "EKART_B2B_CARGO",
    "XP INDIA",
    "SELF",
    "PORTER",
  ],
  facility: ["SAPL-NORTH-TAURU", "SAPL-WH1", "SAPL-WH2"],
} as const;

/** What gets stored. Dates are IST business dates, YYYY-MM-DD. */
export interface TrackerFields {
  dispatchDate: string;
  dcNumber: string | null;
  lrNumber: string | null;
  quantity: number | null;
  boxes: number | null;
  storeName: string;
  storeCity: string | null;
  storeState: string | null;
  expectedDate: string | null;
  orderType: string | null;
  dispatchType: string | null;
  shipmentStatus: string | null;
  deliveredDate: string | null;
  orderPlacedDate: string | null;
  soNumber: string | null;
  facility: string | null;
  allocationType: string | null;
  courierPartner: string | null;
  remarks: string | null;
}

export type TrackerErrors = Partial<Record<keyof TrackerFields, string>>;

const TEXT_FIELDS = [
  "dcNumber",
  "lrNumber",
  "storeCity",
  "storeState",
  "orderType",
  "dispatchType",
  "shipmentStatus",
  "facility",
  "allocationType",
  "courierPartner",
] as const;
const DATE_FIELDS = ["expectedDate", "deliveredDate", "orderPlacedDate"] as const;
const MAX_TEXT = 200;
const MAX_REMARKS = 1000;

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function text(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s ? s : null;
}

/**
 * Validate a form submission into storable fields. Every value arrives as
 * untrusted input from the client; nothing here trusts a type.
 */
export function parseTrackerInput(
  raw: Record<string, unknown>,
): { ok: true; data: TrackerFields } | { ok: false; errors: TrackerErrors } {
  const errors: TrackerErrors = {};

  const dispatchDate = text(raw.dispatchDate);
  if (!dispatchDate) errors.dispatchDate = "Dispatch date is required";
  else if (!isDate(dispatchDate)) errors.dispatchDate = "Use a valid date";

  const storeName = text(raw.storeName);
  if (!storeName) errors.storeName = "Store is required";
  else if (storeName.length > MAX_TEXT) errors.storeName = `At most ${MAX_TEXT} characters`;

  const count = (k: "quantity" | "boxes"): number | null => {
    const s = text(raw[k]);
    if (s === null) return null;
    if (!/^\d+$/.test(s) || Number(s) > 1_000_000) {
      errors[k] = "Whole number, 0 or more";
      return null;
    }
    return Number(s);
  };
  const quantity = count("quantity");
  const boxes = count("boxes");

  const out: Record<string, string | null> = {};
  for (const k of TEXT_FIELDS) {
    const s = text(raw[k]);
    if (s && s.length > MAX_TEXT) errors[k] = `At most ${MAX_TEXT} characters`;
    out[k] = s;
  }
  for (const k of DATE_FIELDS) {
    const s = text(raw[k]);
    if (s && !isDate(s)) errors[k] = "Use a valid date";
    out[k] = s;
  }
  if (out.deliveredDate && dispatchDate && isDate(dispatchDate) && out.deliveredDate < dispatchDate) {
    errors.deliveredDate = "Delivered before it was dispatched";
  }

  // The SO and LR are the match keys against the app, so they are normalised
  // the way the app stores them: SOs upper-case, both without stray spaces.
  const so = text(raw.soNumber);
  const soNumber = so ? so.replace(/\s+/g, " ").toUpperCase() : null;
  if (soNumber && soNumber.length > MAX_TEXT) errors.soNumber = `At most ${MAX_TEXT} characters`;
  if (out.lrNumber) out.lrNumber = out.lrNumber.replace(/\s+/g, "");

  const remarks = text(raw.remarks);
  if (remarks && remarks.length > MAX_REMARKS) errors.remarks = `At most ${MAX_REMARKS} characters`;

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      dispatchDate: dispatchDate!,
      storeName: storeName!,
      quantity,
      boxes,
      soNumber,
      remarks,
      dcNumber: out.dcNumber,
      lrNumber: out.lrNumber,
      storeCity: out.storeCity,
      storeState: out.storeState,
      orderType: out.orderType,
      dispatchType: out.dispatchType,
      shipmentStatus: out.shipmentStatus,
      facility: out.facility,
      allocationType: out.allocationType,
      courierPartner: out.courierPartner,
      expectedDate: out.expectedDate,
      deliveredDate: out.deliveredDate,
      orderPlacedDate: out.orderPlacedDate,
    },
  };
}

/** The app's own view of the order a tracker row points at. */
export interface LiveOrder {
  soNumber: string;
  overallStatus: OverallStatus;
  shipmentStatus?: ShipmentStatus;
  deliveredDate?: string;
}

/**
 * The app order this tracker row refers to: by SO first (exact, the app's own
 * key), then by the LR/AWB against any AWB the app knows. Non-UC dispatches
 * ("CARRY BAG", "BRIGAD-ACC") match nothing, which is correct — the app has
 * never seen them, and the row shows only what the team entered.
 */
export function liveMatch(
  e: { soNumber?: string | null; lrNumber?: string | null },
  bySo: Map<string, LiveOrder>,
  byAwb: Map<string, LiveOrder>,
): LiveOrder | undefined {
  return (e.soNumber ? bySo.get(e.soNumber) : undefined) ?? (e.lrNumber ? byAwb.get(e.lrNumber) : undefined);
}
