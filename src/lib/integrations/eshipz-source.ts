// EshipzTrackingSource — the day-1 TrackingSource implementation (PRD §8b).
// Tracking API v2: POST {ESHIPZ_BASE_URL}/api/v2/trackings with X-API-TOKEN.
// track_id accepts comma-separated values, so open LR numbers are batched
// (chunks of 50 per request). Dates are RFC-1123 GMT strings → ISO via ist.ts.

import { isoFromRfc1123, istDateOf } from "../ist";
import type { TrackingCheckpoint } from "../types";
import { behaviourFor, pickupTsFromCheckpoints, statusForTag } from "./eshipz-map";
import type { TrackingSource, TrackingUpdate } from "./types";

// 20, not 50. eShipz's tracking endpoint costs roughly 1.4s per AWB under load,
// so a 50-AWB batch takes ~70s and trips THEIR nginx 60s gateway timeout — the
// 504 that failed every run on 2026-08-10. 20 keeps a batch near ~28s (measured
// live: 21 AWBs in 29s) with margin under that ceiling.
const CHUNK_SIZE = 20;
// Client-side ceiling, just above their 60s gateway timeout: we bound our own
// request rather than trusting their edge to do it. Without this a hung eShipz
// stalls the whole 15-min tick indefinitely.
const REQUEST_TIMEOUT_MS = 70_000;
const MAX_CHECKPOINTS = 20;

export function eshipzConfigured(): boolean {
  return Boolean(process.env.ESHIPZ_API_TOKEN);
}

export function eshipzWebhookConfigured(): boolean {
  return Boolean(process.env.ESHIPZ_WEBHOOK_SECRET);
}

function baseUrl(): string {
  return (process.env.ESHIPZ_BASE_URL ?? "https://app.eshipz.com").replace(/\/+$/, "");
}

interface EshipzCheckpoint {
  city?: string;
  state?: string;
  date?: string; // RFC-1123 GMT (polling) or ISO (webhook) — Date.parse handles both
  remark?: string;
  tag?: string;
  subtag?: string;
}

export interface EshipzShipment {
  tag?: string;
  subtag?: string;
  checkpoints?: EshipzCheckpoint[]; // newest first
  expected_delivery_date?: string;
  delivery_date?: string;
  pod_link?: string;
  slug?: string; // carrier
  tracking_number?: string;
  order_id?: string;
}

interface EshipzResponse {
  data?: EshipzShipment[];
  trackings?: EshipzShipment[];
}

/** Shared by the polling sync AND the webhook (same payload shape, so the two
 *  paths can never diverge in behaviour). Webhook dates are ISO; polling dates
 *  are RFC-1123 — isoFromRfc1123 uses Date.parse, which accepts both. */
export function mapShipment(s: EshipzShipment): TrackingUpdate | undefined {
  const trackingNumber = s.tracking_number ?? s.order_id;
  if (!trackingNumber) return undefined;

  const checkpoints: TrackingCheckpoint[] = (s.checkpoints ?? [])
    .slice(0, MAX_CHECKPOINTS)
    .map((c) => ({
      city: c.city,
      state: c.state,
      date: isoFromRfc1123(c.date) ?? "",
      remark: c.remark,
      tag: c.tag,
      subtag: c.subtag,
    }))
    .filter((c) => c.date !== "");

  // Live v2 payloads carry no top-level subtag — the latest checkpoint with the
  // same tag holds it (e.g. tag "Exception" → checkpoint subtag "PickupException").
  const latest = (s.checkpoints ?? [])[0];
  const subtag = s.subtag ?? (latest && latest.tag === s.tag ? latest.subtag : undefined);

  const behaviour = behaviourFor(s.tag, subtag);
  const deliveredIso = isoFromRfc1123(s.delivery_date);
  const expectedIso = isoFromRfc1123(s.expected_delivery_date);
  const latestException = checkpoints.find((c) => behaviourFor(c.tag, c.subtag) === "transit_exception");

  return {
    trackingNumber,
    status: statusForTag(s.tag, subtag), // pickup_pending / ignore → undefined
    tag: s.tag,
    subtag,
    checkpoints,
    expectedDate: expectedIso ? istDateOf(expectedIso) : undefined,
    // Pickup timestamp from the FULL scan history (survives past DELIVERED) —
    // a parallel extraction that never affects the status derived above.
    pickedUpTs: pickupTsFromCheckpoints(checkpoints),
    deliveredTs: deliveredIso,
    podLink: s.pod_link ?? undefined,
    carrier: s.slug,
    // Pickup exceptions (e.g. "PICKUP CANCELLED BY CALL") also surface on the
    // journey timeline even though they cause no shipment transition.
    exceptionNote:
      behaviour === "transit_exception"
        ? (latestException?.remark ?? subtag ?? "Transit exception")
        : behaviour === "pickup_pending" && (s.tag ?? "").toUpperCase().includes("EXCEPTION")
          ? (latest?.remark ?? subtag ?? "Pickup exception")
          : undefined,
  };
}

export class EshipzTrackingSource implements TrackingSource {
  /**
   * Fetch tracking for every AWB, in batches.
   *
   * PARTIAL SUCCESS IS THE POINT. A chunk that fails no longer discards the
   * chunks that succeeded — it is reported through onChunkError and the sweep
   * continues. Before this, one transient 504 on any single chunk threw out of
   * the loop and zeroed the entire run (live on 2026-08-10: chunk 3 returned 21
   * good shipments that were thrown away with the two that timed out).
   *
   * A total outage still fails hard: if EVERY attempted chunk failed we throw,
   * so the run is recorded failed exactly as before. Zero chunks (no candidate
   * AWBs) is NOT "all failed" — it is simply nothing to do, and returns [].
   */
  async fetchTracking(
    lrNumbers: string[],
    onChunkError?: (message: string) => void,
  ): Promise<TrackingUpdate[]> {
    const token = process.env.ESHIPZ_API_TOKEN;
    if (!token) throw new Error("ESHIPZ_API_TOKEN is not set");

    const updates: TrackingUpdate[] = [];
    let attempted = 0;
    let failed = 0;
    let lastError = "";

    for (let i = 0; i < lrNumbers.length; i += CHUNK_SIZE) {
      const chunk = lrNumbers.slice(i, i + CHUNK_SIZE);
      attempted += 1;
      // Identify the chunk by size and AWB range so a recurring failure can be
      // pinned to specific shipments, not just "a chunk failed".
      const where = `chunk ${attempted} (${chunk.length} AWBs, ${chunk[0]}..${chunk[chunk.length - 1]})`;
      try {
        // Body is track_id ONLY (comma-separated batch) — verified live 2026-07-08:
        // adding include_split/include_child_accounts makes the API return [].
        const res = await fetch(`${baseUrl()}/api/v2/trackings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-TOKEN": token },
          body: JSON.stringify({ track_id: chunk.join(",") }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
        }
        const body = (await res.json()) as EshipzResponse | EshipzShipment[];
        const shipments = Array.isArray(body) ? body : (body.data ?? body.trackings ?? []);
        for (const s of shipments) {
          const u = mapShipment(s);
          if (u) updates.push(u);
        }
      } catch (e) {
        failed += 1;
        lastError = e instanceof Error ? e.message : String(e);
        const message = `eShipz trackings failed: ${where}: ${lastError}`;
        if (onChunkError) onChunkError(message);
        else console.error(`[eshipz] ${message}`);
      }
    }

    if (attempted > 0 && failed === attempted) {
      throw new Error(
        `eShipz trackings failed: all ${attempted} chunk(s) failed, last error: ${lastError}`,
      );
    }
    return updates;
  }
}

// ---------------------------------------------------------------------------
// Shipment-metadata enrichment (v1) — used ONLY for fields the v2 tracking
// payload doesn't carry (trackingLink). One batched call via db_filters $in.

interface EshipzV1Shipment {
  awb?: string;
  tracking_link?: string;
}

/** trackingLink (and future metadata) per AWB, best-effort. */
export async function fetchShipmentMeta(awbs: string[]): Promise<Map<string, { trackingLink?: string }>> {
  const token = process.env.ESHIPZ_API_TOKEN;
  const out = new Map<string, { trackingLink?: string }>();
  if (!token || awbs.length === 0) return out;

  for (let i = 0; i < awbs.length; i += CHUNK_SIZE) {
    const chunk = awbs.slice(i, i + CHUNK_SIZE);
    const filters = encodeURIComponent(JSON.stringify({ awb: { $in: chunk } }));
    const res = await fetch(`${baseUrl()}/api/v1/get-shipments?db_filters=${filters}`, {
      headers: { "Content-Type": "application/json", "X-API-TOKEN": token },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`eShipz get-shipments failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as EshipzV1Shipment[] | { data?: EshipzV1Shipment[] };
    const records = Array.isArray(body) ? body : (body.data ?? []);
    for (const r of records) {
      if (r.awb) out.set(r.awb, { trackingLink: r.tracking_link || undefined });
    }
  }
  return out;
}
