// EshipzTrackingSource — the day-1 TrackingSource implementation (PRD §8b).
// Tracking API v2: POST {ESHIPZ_BASE_URL}/api/v2/trackings with X-API-TOKEN.
// track_id accepts comma-separated values, so open LR numbers are batched
// (chunks of 50 per request). Dates are RFC-1123 GMT strings → ISO via ist.ts.

import { isoFromRfc1123, istDateOf } from "../ist";
import type { TrackingCheckpoint } from "../types";
import { behaviourFor } from "./eshipz-map";
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
      date: isoFromRfc1123(c.date) ?? "",
      remark: c.remark,
      tag: c.tag,
      subtag: c.subtag,
    }))
    .filter((c) => c.date !== "");

  const behaviour = behaviourFor(s.tag, s.subtag);
  const deliveredIso = isoFromRfc1123(s.delivery_date);
  const expectedIso = isoFromRfc1123(s.expected_delivery_date);
  const latestException = checkpoints.find((c) => behaviourFor(c.tag, c.subtag) === "transit_exception");

  return {
    trackingNumber,
    status:
      behaviour === "in_transit" || behaviour === "transit_exception"
        ? "IN_TRANSIT"
        : behaviour === "ofd"
          ? "OUT_FOR_DELIVERY"
          : behaviour === "delivered"
            ? "DELIVERED"
            : behaviour === "ndr"
              ? "DELIVERY_FAILED"
              : undefined, // pickup_pending / ignore — no shipment transition
    tag: s.tag,
    subtag: s.subtag,
    checkpoints,
    expectedDate: expectedIso ? istDateOf(expectedIso) : undefined,
    deliveredTs: deliveredIso,
    podLink: s.pod_link,
    carrier: s.slug,
    exceptionNote:
      behaviour === "transit_exception"
        ? (latestException?.remark ?? s.subtag ?? "Transit exception")
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
      const res = await fetch(`${baseUrl()}/api/v2/trackings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-TOKEN": token },
        body: JSON.stringify({
          track_id: chunk.join(","),
          include_split: true,
          include_child_accounts: true,
        }),
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
