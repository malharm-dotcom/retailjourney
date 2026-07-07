// eShipz webhook (real-time push — complements the polling sync). v2 tracking
// payload with ISO date/time; mapped by the SAME mapShipment/buildShipmentPatch
// path as polling so the two channels can never diverge. Authenticated by the
// X-Webhook-Secret header against ESHIPZ_WEBHOOK_SECRET (never logged) — this
// route is on the middleware allowlist, NOT behind session auth. Receipts and
// errors land in SyncRun rows tagged ESHIPZ_WEBHOOK (Admin sync health).

import { timingSafeEqual, createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { databaseConfigured } from "@/lib/db";
import type { EshipzShipment } from "@/lib/integrations/eshipz-source";
import { runEshipzWebhook } from "@/lib/integrations/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(got: string | null): boolean {
  const expected = process.env.ESHIPZ_WEBHOOK_SECRET;
  if (!expected || !got) return false;
  // Constant-time compare (hash first so lengths always match).
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Accept a single shipment object, a bare array, or {data|trackings: [...]}. */
function extractShipments(body: unknown): EshipzShipment[] {
  if (Array.isArray(body)) return body as EshipzShipment[];
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data as EshipzShipment[];
    if (Array.isArray(o.trackings)) return o.trackings as EshipzShipment[];
    return [body as EshipzShipment];
  }
  return [];
}

export async function POST(req: NextRequest) {
  if (!process.env.ESHIPZ_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }
  // Next.js header lookup is case-insensitive.
  if (!secretMatches(req.headers.get("x-webhook-secret"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!databaseConfigured()) {
    // Non-2xx so eShipz retries instead of the update being lost.
    return NextResponse.json({ error: "database not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const shipments = extractShipments(body);
  if (shipments.length === 0) {
    return NextResponse.json({ error: "no shipments in payload" }, { status: 400 });
  }

  // At current volume the mapping is applied inline (no queue) — still fast.
  const summary = await runEshipzWebhook(shipments);
  return NextResponse.json({
    received: summary.fetched,
    applied: summary.upserted,
    conflicts: summary.conflicts,
    unmatched: summary.errors.filter((e) => e.startsWith("unmatched:")).length,
  });
}
