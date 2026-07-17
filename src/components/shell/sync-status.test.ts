// Sync-freshness health verdicts: a failed or overdue run must never render
// as a healthy timestamp.

import { describe, expect, it } from "vitest";
import { healthOf } from "./sync-status-client";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const min = (n: number) => n * 60000;

describe("healthOf", () => {
  it("fresh: last run within 2x cadence", () => {
    expect(healthOf({ failed: false, atMs: NOW - min(12), cadenceMin: 15 }, NOW)).toBe("fresh");
    expect(healthOf({ failed: false, atMs: NOW - min(75), cadenceMin: 60 }, NOW)).toBe("fresh");
  });
  it("stale: overdue past 2x cadence, or never ran", () => {
    expect(healthOf({ failed: false, atMs: NOW - min(31), cadenceMin: 15 }, NOW)).toBe("stale");
    expect(healthOf({ failed: false, atMs: NOW - min(130), cadenceMin: 60 }, NOW)).toBe("stale");
    expect(healthOf({ failed: false, atMs: null, cadenceMin: 15 }, NOW)).toBe("stale");
  });
  it("failed beats everything — an errored run is never shown as fresh", () => {
    expect(healthOf({ failed: true, atMs: NOW - min(1), cadenceMin: 15 }, NOW)).toBe("failed");
  });
});
