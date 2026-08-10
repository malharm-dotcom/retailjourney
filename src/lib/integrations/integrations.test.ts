// Unit tests for the integration mapping layer — the logic we must trust
// before real eShipz payloads flow (no live calls here).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { behaviourFor, pickupTsFromCheckpoints } from "./eshipz-map";
import { EshipzTrackingSource, mapShipment } from "./eshipz-source";

describe("eshipz-map behaviourFor", () => {
  it("maps the primary tags", () => {
    // InfoReceived and PickedUp each own a ladder rung now. They used to
    // collapse into "pickup_pending" (no status at all) and "in_transit"
    // respectively, which lost the distinction between a label that exists,
    // a parcel that has been collected, and a parcel that is moving.
    expect(behaviourFor("InfoReceived")).toBe("inforeceived");
    // Subtags are only consulted for the Exception tag, so these stay put.
    expect(behaviourFor("InfoReceived", "PickupRegistered")).toBe("inforeceived");
    expect(behaviourFor("InfoReceived", "OutForPickup")).toBe("inforeceived");
    expect(behaviourFor("PickedUp")).toBe("picked_up");
    expect(behaviourFor("InTransit")).toBe("in_transit");
    // Still genuinely stateless — the carrier has said nothing yet.
    expect(behaviourFor("Pending")).toBe("pickup_pending");
    expect(behaviourFor("OutForDelivery")).toBe("ofd");
    expect(behaviourFor("Delivered")).toBe("delivered");
  });

  it("splits exceptions into pickup vs NDR vs transit", () => {
    // Live Bluedart example (AWB 53667523140): pickup cancelled before transit.
    expect(behaviourFor("Exception", "PickupException")).toBe("pickup_pending");
    expect(behaviourFor("Exception", "PickupAttemptFailed")).toBe("pickup_pending");
    expect(behaviourFor("Exception", "Undelivered")).toBe("ndr");
    expect(behaviourFor("Exception", "DeliveryAttemptFailed")).toBe("ndr");
    expect(behaviourFor("Exception", "ConsigneeUnavailable")).toBe("ndr");
    expect(behaviourFor("Exception", "InTransitException")).toBe("transit_exception");
    expect(behaviourFor("Exception", "VehicleDelayed")).toBe("transit_exception");
    // Unknown exceptions keep the shipment moving but surface on the timeline.
    expect(behaviourFor("Exception", "SomethingNew")).toBe("transit_exception");
  });

  it("ignores unknown tags", () => {
    expect(behaviourFor("Whatever")).toBe("ignore");
    expect(behaviourFor(undefined)).toBe("ignore");
  });
});

describe("eshipz-source mapShipment", () => {
  it("handles ISO dates (webhook) and RFC-1123 dates (polling) identically", () => {
    const base = {
      tag: "Delivered",
      tracking_number: "LR777",
      pod_link: "https://pod.example/1",
      checkpoints: [{ city: "Gurugram", remark: "Delivered", tag: "Delivered", date: "" }],
    };
    const iso = mapShipment({ ...base, delivery_date: "2026-07-05T09:30:00.000Z", checkpoints: [{ ...base.checkpoints[0], date: "2026-07-05T09:30:00.000Z" }] });
    const rfc = mapShipment({ ...base, delivery_date: "Sun, 05 Jul 2026 09:30:00 GMT", checkpoints: [{ ...base.checkpoints[0], date: "Sun, 05 Jul 2026 09:30:00 GMT" }] });
    expect(iso?.status).toBe("DELIVERED");
    expect(iso?.deliveredTs).toBe("2026-07-05T09:30:00.000Z");
    expect(rfc?.deliveredTs).toBe(iso?.deliveredTs);
    expect(rfc?.checkpoints[0].date).toBe(iso?.checkpoints[0].date);
    expect(iso?.podLink).toBe("https://pod.example/1");
  });

  it("resolves exception subtags from the latest checkpoint (live v2 shape)", () => {
    // Real v2 payloads carry no top-level subtag — it lives on the checkpoint.
    const u = mapShipment({
      tag: "Exception",
      tracking_number: "53667523140",
      checkpoints: [
        { city: "NEW DELHI", state: "DELHI", date: "Thu, 02 Jul 2026 16:19:00 GMT", remark: "PICKUP CANCELLED BY CALL", tag: "Exception", subtag: "PickupException" },
        { city: "NEW DELHI", state: "DELHI", date: "Wed, 01 Jul 2026 17:54:00 GMT", remark: "PICKUP HAS BEEN REGISTERED", tag: "InfoReceived", subtag: "PickupRegistered" },
      ],
    });
    expect(u?.status).toBeUndefined(); // pickup exception ≠ IN_TRANSIT
    expect(u?.subtag).toBe("PickupException");
    expect(u?.exceptionNote).toBe("PICKUP CANCELLED BY CALL");
    expect(u?.checkpoints[0].state).toBe("DELHI");
  });

  it("falls back to order_id and drops undated checkpoints", () => {
    const u = mapShipment({ tag: "InTransit", order_id: "SO900", checkpoints: [{ remark: "no date" }] });
    expect(u?.trackingNumber).toBe("SO900");
    expect(u?.status).toBe("IN_TRANSIT");
    expect(u?.checkpoints).toEqual([]);
    expect(mapShipment({ tag: "InTransit" })).toBeUndefined();
  });

  it("still yields the pickup timestamp when the latest scan is DELIVERED", () => {
    // Latest scan says Delivered; the PickedUp scan survives deeper in the array.
    const u = mapShipment({
      tag: "Delivered",
      tracking_number: "53667523140",
      delivery_date: "Sat, 05 Jul 2026 09:30:00 GMT",
      checkpoints: [
        { date: "Sat, 05 Jul 2026 09:30:00 GMT", remark: "DELIVERED", tag: "Delivered" },
        { date: "Sat, 05 Jul 2026 07:10:00 GMT", remark: "OUT FOR DELIVERY", tag: "OutForDelivery" },
        { date: "Fri, 04 Jul 2026 22:04:00 GMT", remark: "IN TRANSIT", tag: "InTransit" },
        { date: "Thu, 02 Jul 2026 18:20:00 GMT", remark: "SHIPMENT PICKED UP", tag: "PickedUp" },
        { date: "Wed, 01 Jul 2026 17:54:00 GMT", remark: "REGISTERED", tag: "InfoReceived", subtag: "PickupRegistered" },
      ],
    });
    expect(u?.status).toBe("DELIVERED");
    // Earliest in-transit scan (PickedUp), not the latest (Delivered) or the
    // oldest overall (InfoReceived/pickup_pending).
    expect(u?.pickedUpTs).toBe("2026-07-02T18:20:00.000Z");
  });
});

describe("pickupTsFromCheckpoints", () => {
  it("returns the earliest in-transit scan and ignores pickup/exception scans", () => {
    // newest-first; InTransit later, PickedUp is the true pickup moment.
    expect(
      pickupTsFromCheckpoints([
        { date: "2026-07-04T22:04:00.000Z", tag: "InTransit" },
        { date: "2026-07-02T18:20:00.000Z", tag: "PickedUp" },
        { date: "2026-07-01T12:00:00.000Z", tag: "Exception", subtag: "PickupException" },
        { date: "2026-07-01T09:00:00.000Z", tag: "InfoReceived", subtag: "PickupRegistered" },
      ]),
    ).toBe("2026-07-02T18:20:00.000Z");
  });

  it("is undefined while still pickup-pending", () => {
    expect(
      pickupTsFromCheckpoints([{ date: "2026-07-01T09:00:00.000Z", tag: "InfoReceived", subtag: "PickupRegistered" }]),
    ).toBeUndefined();
    expect(pickupTsFromCheckpoints([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chunk resilience. Regression cover for 2026-08-10, when eShipz's gateway
// returned 504 on 50-AWB batches and one bad chunk threw away the whole run's
// writes (120 fetched / 0 upserted, three runs straight).

describe("EshipzTrackingSource.fetchTracking chunk resilience", () => {
  const AWB_TOKEN = "test-token";
  let originalToken: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalToken = process.env.ESHIPZ_API_TOKEN;
    originalFetch = globalThis.fetch;
    process.env.ESHIPZ_API_TOKEN = AWB_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.ESHIPZ_API_TOKEN;
    else process.env.ESHIPZ_API_TOKEN = originalToken;
  });

  /** One shipment per requested AWB, so a chunk's yield is countable. */
  const okBody = (trackIds: string[]) => ({
    data: trackIds.map((id) => ({ tag: "InTransit", tracking_number: id, checkpoints: [] })),
  });

  const gatewayTimeout = () =>
    new Response("<html><head><title>504 Gateway Time-out</title></head></html>", { status: 504 });

  /** track_id values from a stubbed fetch call's request body. */
  const trackIdsOf = (init: RequestInit): string[] =>
    (JSON.parse(String(init.body)) as { track_id: string }).track_id.split(",");

  const awbs = (n: number) => Array.from({ length: n }, (_, i) => `LR${String(i).padStart(3, "0")}`);

  it("keeps the surviving chunks' updates when one chunk fails", async () => {
    // 30 AWBs at CHUNK_SIZE 20 = two chunks. The first 504s, the second is fine.
    let call = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) return gatewayTimeout();
      return Response.json(okBody(trackIdsOf(init)));
    }) as unknown as typeof globalThis.fetch;

    const errors: string[] = [];
    const updates = await new EshipzTrackingSource().fetchTracking(awbs(30), (m) => errors.push(m));

    // The critical assertion: the good chunk's 10 shipments SURVIVE the bad
    // chunk. Before the fix this was 0 — the throw discarded everything.
    expect(updates.length).toBe(10);
    expect(updates.map((u) => u.trackingNumber)).toContain("LR020");
    expect(errors).toHaveLength(1);
    // The error names the chunk's size and AWB range, not just the status.
    expect(errors[0]).toContain("20 AWBs, LR000..LR019");
    expect(errors[0]).toContain("HTTP 504");
  });

  it("throws when every chunk fails", async () => {
    globalThis.fetch = (async () => gatewayTimeout()) as unknown as typeof globalThis.fetch;

    const errors: string[] = [];
    await expect(
      new EshipzTrackingSource().fetchTracking(awbs(30), (m) => errors.push(m)),
    ).rejects.toThrow(/all 2 chunk\(s\) failed/);
    // Each failure is still reported individually before the hard throw.
    expect(errors).toHaveLength(2);
  });

  it("does not throw on an empty candidate set (zero chunks is not 'all failed')", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json(okBody([]));
    }) as unknown as typeof globalThis.fetch;

    await expect(new EshipzTrackingSource().fetchTracking([])).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("batches in 20s so a request stays under the upstream 60s gateway timeout", async () => {
    const sizes: number[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const ids = trackIdsOf(init);
      sizes.push(ids.length);
      return Response.json(okBody(ids));
    }) as unknown as typeof globalThis.fetch;

    await new EshipzTrackingSource().fetchTracking(awbs(45));
    expect(sizes).toEqual([20, 20, 5]);
  });

  it("bounds each request with a client-side timeout signal", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Response.json(okBody(trackIdsOf(init)));
    }) as unknown as typeof globalThis.fetch;

    await new EshipzTrackingSource().fetchTracking(awbs(1));
    // We bound ourselves rather than trusting their edge to time us out.
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
