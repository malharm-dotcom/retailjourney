// Integration adapter interfaces (PRD §8). The live tracking implementation is
// EshipzTrackingSource; the order spine is read from Snowflake
// (distribution_analytics) directly by runSnowflakeSync.

import type { ShipmentStatus, TrackingCheckpoint } from "../types";

/** One shipment's tracking state from the tracking provider. */
export interface TrackingUpdate {
  trackingNumber: string;
  status?: ShipmentStatus;
  /** Raw provider tag/subtag for provenance columns. */
  tag?: string;
  subtag?: string;
  checkpoints: TrackingCheckpoint[];
  expectedDate?: string; // YYYY-MM-DD IST
  /** Earliest in-transit scan = the pickup moment (ISO UTC). Extracted from the
   *  full checkpoint array so a delivered AWB still carries it. */
  pickedUpTs?: string;
  deliveredTs?: string; // ISO UTC
  podLink?: string;
  /** From v1 get-shipments enrichment (v2 tracking doesn't carry it). */
  trackingLink?: string;
  carrier?: string;
  /** Exception checkpoints that should surface on the journey timeline. */
  exceptionNote?: string;
}

export interface TrackingSource {
  fetchTracking(lrNumbers: string[]): Promise<TrackingUpdate[]>;
}
