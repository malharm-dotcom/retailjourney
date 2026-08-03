import { describe, expect, it } from "vitest";
import { spineQueryFor } from "./snowflake";

describe("spineQueryFor — incremental watermark clause", () => {
  it("falls back to the full 20-day window when no watermark is given (first run / manual reseed)", () => {
    const q = spineQueryFor();
    expect(q).toContain("ORDER_DATE >= DATEADD(day, -20, CURRENT_DATE)");
    expect(q).not.toContain("LAST_UPDATED >=");
  });

  it("filters on LAST_UPDATED when a watermark is given, dropping the 20-day bound", () => {
    const q = spineQueryFor("2026-07-30 03:04:07.000");
    expect(q).toContain("LAST_UPDATED >= TO_TIMESTAMP_NTZ('2026-07-30 03:04:07.000')");
    expect(q).not.toContain("ORDER_DATE >=");
  });

  it("uses >= (not >) so a row sharing the watermark's exact instant is re-fetched, never dropped", () => {
    const q = spineQueryFor("2026-07-30 03:04:07.000");
    expect(q).toMatch(/LAST_UPDATED >= TO_TIMESTAMP_NTZ/);
    expect(q).not.toMatch(/LAST_UPDATED > TO_TIMESTAMP_NTZ/);
  });

  it("always admits NULL LAST_UPDATED rows — upstream leaves new orders unstamped until its own job runs", () => {
    const q = spineQueryFor("2026-07-30 03:04:07.000");
    expect(q).toContain("OR LAST_UPDATED IS NULL");
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
