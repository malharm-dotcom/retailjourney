// EshipzTrackingSource — the day-1 TrackingSource implementation (PRD §8b).
// Tracking API v2: POST {ESHIPZ_BASE_URL}/api/v2/trackings with X-API-TOKEN.
// track_id accepts comma-separated values, so open LR numbers are batched
// (chunks of 50 per request). Dates are RFC-1123 GMT strings → ISO via ist.ts.

import { isoFromRfc1123, istDateOf } from "../ist";
import type { TrackingCheckpoint } from "../types";
import { behaviourFor, pickupTsFromCheckpoints, statusForTag } from "./eshipz-map";
import type { TrackingSource, TrackingUpdate } from "./types";

const CHUNK_SIZE = 50;
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
  async fetchTracking(lrNumbers: string[]): Promise<TrackingUpdate[]> {
    const token = process.env.ESHIPZ_API_TOKEN;
    if (!token) throw new Error("ESHIPZ_API_TOKEN is not set");

    const updates: TrackingUpdate[] = [];
    for (let i = 0; i < lrNumbers.length; i += CHUNK_SIZE) {
      const chunk = lrNumbers.slice(i, i + CHUNK_SIZE);
      // Body is track_id ONLY (comma-separated batch) — verified live 2026-07-08:
      // adding include_split/include_child_accounts makes the API return [].
      const res = await fetch(`${baseUrl()}/api/v2/trackings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-TOKEN": token },
        body: JSON.stringify({ track_id: chunk.join(",") }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`eShipz trackings failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      const body = (await res.json()) as EshipzResponse | EshipzShipment[];
      const shipments = Array.isArray(body) ? body : (body.data ?? body.trackings ?? []);
      for (const s of shipments) {
        const u = mapShipment(s);
        if (u) updates.push(u);
      }
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
