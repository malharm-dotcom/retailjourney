// Integration adapter interfaces (PRD §8). Day-1 implementations are
// UcApiOrderSource and EshipzTrackingSource; a Snowflake/Metabase reader can
// be dropped in behind the same interfaces later without touching callers.

import type { Order, ShipmentStatus, TrackingCheckpoint } from "../types";

/** A UC order discovered/refreshed by a sweep — a domain patch keyed by soNumber. */
export interface UcOrderUpdate {
  soNumber: string;
  /** Raw UC channel value — resolved to a Store via Store.channelCode. */
  ucChannel: string;
  /** UC facility code, when the DTO carries one. */
  facilityCode?: string;
  /** Field patch derived from the saleOrderDTO (source=SYNCED on write). */
  patch: Partial<Order>;
  /** Total/fulfillable quantity for new-order creation. */
  qty: number;
  /** UC shipping manifest code — enables the manifest detail fetch. */
  manifestCode?: string;
}

export interface OrderSource {
  /** Discover B2B SO codes created/changed since `sinceIst` (YYYY-MM-DD). */
  fetchChangedOrderCodes(sinceIst: string): Promise<string[]>;
  /** Full detail for one SO across our facilities. */
  fetchOrder(soNumber: string): Promise<UcOrderUpdate | undefined>;
}

/** One shipment's tracking state from the tracking provider. */
export interface TrackingUpdate {
  trackingNumber: string;
  status?: ShipmentStatus;
  /** Raw provider tag/subtag for provenance columns. */
  tag?: string;
  subtag?: string;
  checkpoints: TrackingCheckpoint[];
  expectedDate?: string; // YYYY-MM-DD IST
  deliveredTs?: string; // ISO UTC
  podLink?: string;
  carrier?: string;
  /** Exception checkpoints that should surface on the journey timeline. */
  exceptionNote?: string;
}

export interface TrackingSource {
  fetchTracking(lrNumbers: string[]): Promise<TrackingUpdate[]>;
}
