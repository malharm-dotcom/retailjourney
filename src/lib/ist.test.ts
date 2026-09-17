import { describe, expect, it } from "vitest";
import { isoFromRfc1123, istDateOf } from "./ist";

/**
 * The shapes that actually arrive on eShipz date fields. The DD-MM-YYYY case is
 * the one that cost us: a bare Date.parse read "12-09-2026" as 9 December, so
 * an order delivered on 12 September was stored with a delivered date 83 days
 * in the future and never aged off the In-Transit board.
 */
describe("isoFromRfc1123", () => {
  it("reads DD-MM-YYYY as the day-first date it is, in IST", () => {
    // 12 Sep 2026, IST midnight — NOT 9 December.
    expect(isoFromRfc1123("12-09-2026")).toBe("2026-09-11T18:30:00.000Z");
    expect(istDateOf(isoFromRfc1123("12-09-2026")!)).toBe("2026-09-12");
    // The live values that pinned rows to the board.
    expect(istDateOf(isoFromRfc1123("11-09-2026")!)).toBe("2026-09-11");
    expect(istDateOf(isoFromRfc1123("05-08-2026")!)).toBe("2026-08-05");
  });

  it("keeps a day past the 12th unambiguous", () => {
    expect(istDateOf(isoFromRfc1123("30-06-2026")!)).toBe("2026-06-30");
    expect(istDateOf(isoFromRfc1123("13-09-2026")!)).toBe("2026-09-13");
  });

  it("carries a time of day when one is present", () => {
    expect(isoFromRfc1123("12-09-2026 18:30:00")).toBe("2026-09-12T13:00:00.000Z");
  });

  it("accepts slashes as well as dashes", () => {
    expect(istDateOf(isoFromRfc1123("12/09/2026")!)).toBe("2026-09-12");
  });

  it("still reads the RFC-1123 that polling actually sends", () => {
    expect(isoFromRfc1123("Tue, 28 Jun 2022 13:58:26 GMT")).toBe("2022-06-28T13:58:26.000Z");
  });

  it("still reads the ISO the webhook sends", () => {
    expect(isoFromRfc1123("2026-09-12T10:03:11Z")).toBe("2026-09-12T10:03:11.000Z");
    // A bare ISO date is not day-first and must not be swapped.
    expect(istDateOf(isoFromRfc1123("2026-09-12")!)).toBe("2026-09-12");
  });

  it("falls through rather than dropping a month that cannot be DD-MM", () => {
    // 13 is not a month, so this can only be MM-DD-YYYY — Date.parse handles it.
    expect(istDateOf(isoFromRfc1123("09-13-2026")!)).toBe("2026-09-13");
  });

  it("returns undefined for nothing and for junk", () => {
    expect(isoFromRfc1123(undefined)).toBeUndefined();
    expect(isoFromRfc1123(null)).toBeUndefined();
    expect(isoFromRfc1123("")).toBeUndefined();
    expect(isoFromRfc1123("not a date")).toBeUndefined();
  });
});
