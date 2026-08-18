import { describe, expect, it } from "vitest";
import { SPINE_SWEEP_DAYS, ntzValue, spineQueryFor } from "./snowflake";

const WM = "2026-07-30 03:04:07.000";

describe("spineQueryFor — incremental watermark clause", () => {
  it("falls back to the full window when no watermark is given (first run / manual reseed)", () => {
    const q = spineQueryFor();
    expect(q).toContain(`ORDER_DATE >= DATEADD(day, -${SPINE_SWEEP_DAYS}, CURRENT_DATE)`);
    expect(q).not.toContain("SPINE_LAST_EVENT_TS >=");
  });

  it("rides SPINE_LAST_EVENT_TS, not LAST_UPDATED, for the incremental bound", () => {
    // LAST_UPDATED is stamped at manifest and never bumped for the logistics
    // half of the row, so an incremental pull keyed on it could never see an
    // AWB, a delivery or a POD land. Measured live: it predated the AWB's own
    // creation on 6,081 of 6,149 AWB-bearing rows.
    const q = spineQueryFor(WM);
    expect(q).toContain(`SPINE_LAST_EVENT_TS >= TO_TIMESTAMP_NTZ('${WM}')`);
    expect(q).not.toContain(`LAST_UPDATED >= TO_TIMESTAMP_NTZ('${WM}')`);
  });

  it("uses >= (not >) so a row sharing the watermark's exact instant is re-fetched, never dropped", () => {
    const q = spineQueryFor(WM);
    expect(q).toMatch(/SPINE_LAST_EVENT_TS >= TO_TIMESTAMP_NTZ/);
    expect(q).not.toMatch(/SPINE_LAST_EVENT_TS > TO_TIMESTAMP_NTZ/);
  });

  it("keeps the LAST_UPDATED IS NULL guard verbatim", () => {
    // Upstream leaves freshly-created orders unstamped until its own job runs.
    expect(spineQueryFor(WM)).toContain("OR LAST_UPDATED IS NULL");
  });

  it("also admits rows with no event stamp at all", () => {
    expect(spineQueryFor(WM)).toContain("SPINE_LAST_EVENT_TS IS NULL");
  });

  it("always carries the dated sweep as a backstop alongside the watermark", () => {
    // The watermark is the fix; the sweep is what guarantees an in-flight
    // order is revisited even if its stamp somehow never moves.
    const q = spineQueryFor(WM);
    expect(q).toContain(`ORDER_DATE >= DATEADD(day, -${SPINE_SWEEP_DAYS}, CURRENT_DATE)`);
  });

  it("sweeps DELIVERED rows in — no status filter anywhere", () => {
    // "It delivered" is exactly the transition the app is missing on the
    // orders this exists to rescue, so filtering delivered rows out would
    // defeat the whole mechanism.
    for (const q of [spineQueryFor(), spineQueryFor(WM), spineQueryFor(WM, false)]) {
      expect(q).not.toMatch(/STATUS\s*(=|!=|<>|NOT\s+IN|IN)\s*\(?'/i);
    }
  });

  it("degrades to the old predicate plus the sweep when the spine lacks the column", () => {
    const q = spineQueryFor(WM, false);
    expect(q).toContain(`LAST_UPDATED >= TO_TIMESTAMP_NTZ('${WM}')`);
    expect(q).not.toContain("SPINE_LAST_EVENT_TS");
    // Still swept, so the degraded mode is narrower but never blind.
    expect(q).toContain(`ORDER_DATE >= DATEADD(day, -${SPINE_SWEEP_DAYS}, CURRENT_DATE)`);
  });

  it("selects the event column only when the spine has it", () => {
    expect(spineQueryFor(WM)).toMatch(/SPINE_LAST_EVENT_TS\s*\nFROM/);
    expect(spineQueryFor(WM, false)).not.toContain("SPINE_LAST_EVENT_TS");
  });

  it("rejects a malformed watermark rather than interpolating it unchecked into SQL", () => {
    expect(() => spineQueryFor("'; DROP TABLE x; --")).toThrow(/invalid Snowflake watermark/);
    expect(() => spineQueryFor("not-a-timestamp")).toThrow(/invalid Snowflake watermark/);
  });

  it("accepts the exact IST NTZ shapes Snowflake renders (with and without fractional seconds)", () => {
    expect(() => spineQueryFor("2026-07-30 03:04:07")).not.toThrow();
    expect(() => spineQueryFor("2026-07-30 03:04:07.000")).not.toThrow();
  });
});

describe("ntzValue — the fetchAsString NULL-string landmine", () => {
  it('treats the literal string "NULL" as absent', () => {
    // Snowflake renders a NULL TIMESTAMP_NTZ as the STRING "NULL" under
    // fetchAsString:["Date"], which is truthy. Every comparison over a spine
    // timestamp must normalise through this first.
    expect(ntzValue("NULL")).toBeUndefined();
    expect(ntzValue(null)).toBeUndefined();
    expect(ntzValue(undefined)).toBeUndefined();
    expect(ntzValue("  ")).toBeUndefined();
  });

  it("passes a real timestamp through untouched", () => {
    expect(ntzValue("2026-08-13 19:05:40.000")).toBe("2026-08-13 19:05:40.000");
  });
});
