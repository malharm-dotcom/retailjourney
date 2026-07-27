import { describe, expect, it } from "vitest";

import { transitAgeDays, transitAnchor, type AnchorShipment } from "./transit-anchor";

// Minimal order shapes — transitAnchor only reads the three dispatch fields.
type O = Parameters<typeof transitAnchor>[0];
const order = (o: Partial<O> = {}): O => ({ ...o });

describe("transit anchor resolution", () => {
  it("prefers a real dispatch timestamp over everything else", () => {
    const a = transitAnchor(
      order({
        dispatchedTs: "2026-07-20T06:00:00.000Z", // 11:30 IST on the 20th
        dispatchedDate: "2026-07-19",
        manifestedTs: "2026-07-18T06:00:00.000Z",
      }),
      [{ pickedUpTs: "2026-07-17T06:00:00.000Z" }],
    );
    expect(a).toEqual({ date: "2026-07-20", source: "DISPATCHED" });
  });

  it("uses dispatchedDate when only the business date is known", () => {
    expect(transitAnchor(order({ dispatchedDate: "2026-07-19", manifestedTs: "2026-07-18T06:00:00.000Z" })))
      .toEqual({ date: "2026-07-19", source: "DISPATCHED" });
  });

  it("falls back to the WH manifest — the spine's only order-level anchor", () => {
    expect(transitAnchor(order({ manifestedTs: "2026-07-18T06:00:00.000Z" })))
      .toEqual({ date: "2026-07-18", source: "MANIFESTED" });
  });

  it("keeps the manifest ahead of pickup so the WH→pickup dwell stays measured", () => {
    // Manifested 18th 11:30 IST, picked up 19th — age must count from the 18th.
    const a = transitAnchor(order({ manifestedTs: "2026-07-18T06:00:00.000Z" }), [
      { pickedUpTs: "2026-07-19T06:00:00.000Z" },
    ]);
    expect(a.source).toBe("MANIFESTED");
    expect(a.date).toBe("2026-07-18");
  });

  it("falls back to child pickup, then to the spine pick date", () => {
    expect(transitAnchor(order(), [{ pickedUpTs: "2026-07-19T06:00:00.000Z" }]))
      .toEqual({ date: "2026-07-19", source: "PICKED_UP" });
    expect(transitAnchor(order(), [{ trackingPickTs: "2026-07-19T06:00:00.000Z" }]))
      .toEqual({ date: "2026-07-19", source: "TRACKING_PICK" });
  });

  it("returns an empty anchor when nothing is known — a real spine gap", () => {
    expect(transitAnchor(order(), [])).toEqual({});
    expect(transitAgeDays(order(), [], "2026-07-25")).toBeUndefined();
  });

  it("IST-converts timestamps that straddle midnight UTC", () => {
    // 2026-07-18T20:00Z = 2026-07-19 01:30 IST — the anchor is the 19th.
    expect(transitAnchor(order({ manifestedTs: "2026-07-18T20:00:00.000Z" })).date).toBe("2026-07-19");
  });
});

describe("multi-AWB (split dispatch) grain", () => {
  // Dispatch is order-level, pickup is shipment-level: the order left the
  // warehouse when its FIRST box did, so the later AWB must not shorten age.
  const split: AnchorShipment[] = [
    { pickedUpTs: "2026-07-22T06:00:00.000Z", trackingPickTs: "2026-07-22T06:00:00.000Z" },
    { pickedUpTs: "2026-07-19T06:00:00.000Z", trackingPickTs: "2026-07-19T06:00:00.000Z" },
    { pickedUpTs: undefined, trackingPickTs: "2026-07-21T06:00:00.000Z" },
  ];

  it("resolves a split order on its earliest child, whatever the row order", () => {
    expect(transitAnchor(order(), split)).toEqual({ date: "2026-07-19", source: "PICKED_UP" });
    expect(transitAnchor(order(), [...split].reverse())).toEqual({ date: "2026-07-19", source: "PICKED_UP" });
  });

  it("does not mix links — trackingPickTs is only consulted once no child has a pickup", () => {
    const noPickups = split.map((s) => ({ trackingPickTs: s.trackingPickTs }));
    expect(transitAnchor(order(), noPickups)).toEqual({ date: "2026-07-19", source: "TRACKING_PICK" });
  });

  it("ages a delivered split order from the first box out, not the last", () => {
    // Delivered 2026-07-24: earliest child 19th → 5d, latest child 22nd → 2d.
    expect(transitAgeDays(order(), split, "2026-07-24")).toBe(5);
  });

  it("never returns a negative age when the anchor post-dates the end date", () => {
    expect(transitAgeDays(order({ manifestedTs: "2026-07-26T06:00:00.000Z" }), [], "2026-07-24")).toBe(0);
  });
});

describe("transit age against the reported symptom", () => {
  it("a delivered spine order no longer reads 0d", () => {
    // Spine shape: no dispatch fields at all, manifest present, delivered later.
    const o = order({ manifestedTs: "2026-07-20T04:00:00.000Z" });
    expect(transitAgeDays(o, [], "2026-07-24")).toBe(4);
  });
});
