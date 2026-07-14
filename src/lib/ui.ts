// Status → presentation mapping. Colour is never used alone: every status
// renders as icon + label + (optionally) source badge.

import type { OrderStatus, OverallStatus, ShipmentStatus } from "./types";
import type { SlaState } from "./sla";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface StatusVisual {
  icon: string; // solar icon name
  label: string;
  pill: string; // pill classes
  rail: string; // CSS colour for the row rail / kanban accents
}

export const OVERALL_VISUAL: Record<OverallStatus, StatusVisual> = {
  WH_PROCESSING: {
    icon: "box-bold-duotone",
    label: "WH Processing",
    pill: "bg-pending-bg text-ink-soft",
    rail: "#9A9080",
  },
  PICKUP_PENDING: {
    icon: "hand-money-bold-duotone",
    label: "Pickup Pending",
    pill: "bg-pending-bg text-ink-soft",
    rail: "#9A9080",
  },
  IN_TRANSIT: {
    icon: "delivery-bold-duotone",
    label: "In Transit",
    pill: "bg-transit-bg text-transit",
    rail: "#4C7A99",
  },
  DELIVERED: {
    icon: "check-circle-bold-duotone",
    label: "Delivered",
    pill: "bg-deliv-bg text-deliv",
    rail: "#3E7A5C",
  },
};

export const SHIPMENT_VISUAL: Record<ShipmentStatus, StatusVisual> = {
  IN_TRANSIT: OVERALL_VISUAL.IN_TRANSIT,
  OUT_FOR_DELIVERY: {
    icon: "scooter-bold-duotone",
    label: "Out for Delivery",
    pill: "bg-ofd-bg text-ofd",
    rail: "#B67F2E",
  },
  DELIVERED: OVERALL_VISUAL.DELIVERED,
  DELIVERY_FAILED: {
    icon: "danger-triangle-bold-duotone",
    label: "Delivery Failed",
    pill: "bg-breach-bg text-breach",
    rail: "#BE5340",
  },
  RETURN: {
    icon: "rewind-back-bold-duotone",
    label: "Return",
    pill: "bg-pending-bg text-ink-soft",
    rail: "#9A9080",
  },
};

export const WH_STATUS_VISUAL: Record<OrderStatus, StatusVisual> = {
  NOT_STARTED: {
    icon: "sleeping-square-bold-duotone",
    label: "Not Started",
    pill: "bg-pending-bg text-ink-soft",
    rail: "#9A9080",
  },
  PICKING: {
    icon: "cart-check-bold-duotone",
    label: "Picking",
    pill: "bg-transit-bg text-transit",
    rail: "#4C7A99",
  },
  PACKING: {
    icon: "box-minimalistic-bold-duotone",
    label: "Packing",
    pill: "bg-ofd-bg text-ofd",
    rail: "#B67F2E",
  },
  ON_HOLD: {
    icon: "pause-circle-bold-duotone",
    label: "On Hold",
    pill: "bg-hold-bg text-hold",
    rail: "#8A6FA8",
  },
  READY_TO_DISPATCH: {
    icon: "checklist-minimalistic-bold-duotone",
    label: "Ready to Dispatch",
    pill: "bg-sage-soft text-sage",
    rail: "#3E5D4C",
  },
  RTS_LOGIC: {
    icon: "document-add-bold-duotone",
    label: "RTS Logic",
    pill: "bg-sage-soft text-sage",
    rail: "#3E5D4C",
  },
  DISPATCHED_TO_STORE: {
    icon: "delivery-bold-duotone",
    label: "Dispatched",
    pill: "bg-transit-bg text-transit",
    rail: "#4C7A99",
  },
  CANCELLED: {
    icon: "close-circle-bold-duotone",
    label: "Cancelled",
    pill: "bg-breach-bg text-breach",
    rail: "#BE5340",
  },
  UNFULFILLABLE: {
    icon: "ghost-bold-duotone",
    label: "Unfulfillable",
    pill: "bg-breach-bg text-breach",
    rail: "#BE5340",
  },
};

export const SLA_VISUAL: Record<SlaState, StatusVisual> = {
  FUTURE_SLA: {
    icon: "hourglass-bold-duotone",
    label: "Future SLA",
    pill: "bg-pending-bg text-ink-soft",
    rail: "#9A9080",
  },
  WITHIN_SLA: {
    icon: "check-circle-bold-duotone",
    label: "Within SLA",
    pill: "bg-deliv-bg text-deliv",
    rail: "#3E7A5C",
  },
  BREACHED: {
    icon: "danger-triangle-bold-duotone",
    label: "Breached",
    pill: "bg-breach-bg text-breach",
    rail: "#BE5340",
  },
  BREACHED_PENDING: {
    icon: "alarm-bold-duotone",
    label: "Breached · Pending",
    pill: "bg-breach-bg text-breach",
    rail: "#BE5340",
  },
};

export const RECEIPT_VISUAL = {
  RECEIVED: {
    icon: "inbox-in-bold-duotone",
    label: "Received",
    pill: "bg-transit-bg text-transit",
    rail: "#4C7A99",
  },
  INWARDED: {
    icon: "archive-check-bold-duotone",
    label: "Inwarded",
    pill: "bg-sage-soft text-sage",
    rail: "#3E5D4C",
  },
  CLOSED: {
    icon: "check-circle-bold-duotone",
    label: "Closed",
    pill: "bg-deliv-bg text-deliv",
    rail: "#3E7A5C",
  },
} as const;
