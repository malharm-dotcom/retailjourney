// Unicommerce saleOrderDTO → domain mapping. One file so the status tables
// can be extended as real payloads surface new codes.
//
// Order-level WH status = MIN progress across fulfillable items (an order is
// only as far along as its slowest item); UNFULFILLABLE/CANCELLED derive from
// the items' cancellation state. UC epoch-milli timestamps convert via ist.ts.

import { isoFromEpochMs, istDateOf } from "../ist";
import { WH_FLOW } from "../journey";
import type { Order, OrderStatus } from "../types";
import type { UcOrderUpdate } from "./types";

// ---------------------------------------------------------------------------
// Raw DTO shapes (loose — UC payloads carry much more; we type what we read).

export interface UcSaleOrderItem {
  statusCode?: string; // CREATED | FULFILLABLE | UNFULFILLABLE | PROCESSING | PICKED | PACKED | READY_TO_DISPATCH | MANIFESTED | DISPATCHED | SHIPPED | DELIVERED | CANCELLED ...
  facilityCode?: string;
  cancellable?: boolean;
}

export interface UcShippingPackage {
  code?: string;
  statusCode?: string;
  trackingNumber?: string;
  shippingProvider?: string;
  courier?: string;
  invoiceCode?: string;
  shippingManifestCode?: string;
  noOfBoxes?: number;
  weight?: number; // grams in UC
  dispatched?: number; // epoch ms
  delivered?: number; // epoch ms
}

export interface UcSaleOrderDTO {
  code: string;
  displayOrderCode?: string;
  status?: string; // PENDING_VERIFICATION | CREATED | PROCESSING | COMPLETE | CANCELLED
  channel?: string; // carries the STORE identifier on B2B retail orders
  created?: number; // epoch ms
  updated?: number;
  fulfillmentTat?: number;
  saleOrderItems?: UcSaleOrderItem[];
  shippingPackages?: UcShippingPackage[];
}

// ---------------------------------------------------------------------------
// Item statusCode → progress rank → our WH OrderStatus.

/** Item codes that mean the item is out of the fulfillable pool. */
const ITEM_DEAD_CODES = new Set(["CANCELLED", "UNFULFILLABLE", "NOT_FOUND", "MISSING"]);

/** Progress rank per fulfillable item code (min across items wins). */
const ITEM_RANK: Record<string, number> = {
  CREATED: 0,
  FULFILLABLE: 0,
  UNVERIFIED: 0,
  PROCESSING: 1,
  ALLOCATED: 1,
  PICKING: 1,
  PICKED: 2,
  PACKING: 2,
  PACKED: 3,
  READY_TO_DISPATCH: 3,
  MANIFESTED: 4,
  DISPATCHED: 5,
  SHIPPED: 5,
  DELIVERED: 6,
};

/** Rank → our WH status (READY_TO_DISPATCH = UC processing done, PRD §4). */
const RANK_STATUS: OrderStatus[] = [
  "NOT_STARTED", // 0
  "PICKING", // 1
  "PACKING", // 2
  "READY_TO_DISPATCH", // 3
  "RTS_LOGIC", // 4 (manifested)
  "DISPATCHED_TO_STORE", // 5
  "DISPATCHED_TO_STORE", // 6 (delivered — shipment layer owns DELIVERED)
];

export function deriveWhStatus(items: UcSaleOrderItem[]): {
  status: OrderStatus | undefined;
  fulfilledQty: number;
  unfulfillableQty: number;
} {
  const live = items.filter((i) => !ITEM_DEAD_CODES.has((i.statusCode ?? "").toUpperCase()));
  const dead = items.length - live.length;
  if (items.length > 0 && live.length === 0) {
    const allCancelled = items.every((i) => (i.statusCode ?? "").toUpperCase() === "CANCELLED");
    return { status: allCancelled ? "CANCELLED" : "UNFULFILLABLE", fulfilledQty: 0, unfulfillableQty: dead };
  }
  let min = Infinity;
  for (const i of live) {
    const rank = ITEM_RANK[(i.statusCode ?? "").toUpperCase()];
    if (rank === undefined) continue; // unknown code — ignore, keep table extensible
    if (rank < min) min = rank;
  }
  if (!Number.isFinite(min)) return { status: undefined, fulfilledQty: live.length, unfulfillableQty: dead };
  return { status: RANK_STATUS[Math.min(min, RANK_STATUS.length - 1)], fulfilledQty: live.length, unfulfillableQty: dead };
}

/** WH_FLOW position for the forward-only guard (terminal codes handled separately). */
export function whProgress(status: OrderStatus): number {
  return WH_FLOW.indexOf(status);
}

// ---------------------------------------------------------------------------
// DTO → domain patch.

export function mapSaleOrder(dto: UcSaleOrderDTO): UcOrderUpdate {
  const items = dto.saleOrderItems ?? [];
  const { status, fulfilledQty, unfulfillableQty } = deriveWhStatus(items);
  const pkg = (dto.shippingPackages ?? []).find((p) => p.trackingNumber) ?? dto.shippingPackages?.[0];

  const createdIso = isoFromEpochMs(dto.created);
  const dispatchedIso = isoFromEpochMs(pkg?.dispatched);
  const deliveredIso = isoFromEpochMs(pkg?.delivered);

  const patch: Partial<Order> = {
    ucStatus: dto.status,
    createdTs: createdIso,
    ...(status ? { status } : {}),
    fulfilledQty,
    ...(unfulfillableQty > 0 ? { unfulfillableQty } : {}),
    ...(pkg?.trackingNumber ? { trackingNumber: pkg.trackingNumber, lrNumber: pkg.trackingNumber } : {}),
    ...(pkg?.shippingProvider || pkg?.courier ? { courierPartner: pkg.shippingProvider ?? pkg.courier } : {}),
    ...(pkg?.invoiceCode ? { saleInvoiceNumber: pkg.invoiceCode } : {}),
    ...(pkg?.noOfBoxes ? { boxCount: pkg.noOfBoxes } : {}),
    ...(pkg?.weight ? { weightKg: Math.round(pkg.weight / 100) / 10 } : {}),
    ...(dispatchedIso ? { dispatchedTs: dispatchedIso, dispatchedDate: istDateOf(dispatchedIso) } : {}),
    ...(deliveredIso ? { deliveredTs: deliveredIso, deliveredDate: istDateOf(deliveredIso) } : {}),
  };

  return {
    soNumber: dto.code,
    ucChannel: dto.channel ?? "",
    facilityCode: items.find((i) => i.facilityCode)?.facilityCode,
    patch,
    qty: items.length,
    manifestCode: pkg?.shippingManifestCode,
  };
}
