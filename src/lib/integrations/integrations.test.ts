// Unit tests for the integration mapping layer — the logic we must trust
// before real eShipz payloads flow (no live calls here).

import { describe, expect, it } from "vitest";
import { behaviourFor, pickupTsFromCheckpoints } from "./eshipz-map";
import { mapShipment } from "./eshipz-source";

describe("eshipz-map behaviourFor", () => {
  it("maps the primary tags", () => {
    expect(behaviourFor("InfoReceived")).toBe("pickup_pending");
    expect(behaviourFor("InfoReceived", "PickupRegistered")).toBe("pickup_pending");
    expect(behaviourFor("InfoReceived", "OutForPickup")).toBe("pickup_pending");
    expect(behaviourFor("PickedUp")).toBe("in_transit");
    expect(behaviourFor("InTransit")).toBe("in_transit");
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
