// The In-Transit board measures ageing against the PROMISE, not the road.
//
// `pastEdd` is days past `idealDeliveryDate ?? expectedDate` — positive once
// today is past it, negative while it is still to come, and UNDEFINED when the
// order carries no EDD at all (~15% of in-transit). That last case is the one
// worth pinning: an order nobody promised a date for is not an on-time order,
// and treating it as 0 would file it among them.

import { describe, expect, it } from "vitest";
import { daysBetween } from "@/lib/ist";

/** The board's own derivation (in-transit/page.tsx), isolated. */
function pastEddOf(
  o: { idealDeliveryDate?: string; expectedDate?: string },
  today: string,
): number | undefined {
  const edd = o.idealDeliveryDate ?? o.expectedDate;
  return edd ? daysBetween(edd, today) : undefined;
}

/** The board's sort comparator (breaches first, then latest, no-EDD last). */
const bySort = (
  a: { breaching: boolean; pastEdd?: number; ageing: number },
  b: { breaching: boolean; pastEdd?: number; ageing: number },
) =>
  Number(b.breaching) - Number(a.breaching) ||
  (b.pastEdd ?? -Infinity) - (a.pastEdd ?? -Infinity) ||
  b.ageing - a.ageing;

const TODAY = "2026-09-04";

describe("pastEdd derivation", () => {
  it("prefers the rulebook EDD over the courier's", () => {
    expect(pastEddOf({ idealDeliveryDate: "2026-09-01", expectedDate: "2026-08-20" }, TODAY)).toBe(3);
  });

  it("falls back to the courier EDD when there is no rulebook one", () => {
    expect(pastEddOf({ expectedDate: "2026-09-02" }, TODAY)).toBe(2);
  });

  it("is negative while the EDD is still ahead", () => {
    expect(pastEddOf({ idealDeliveryDate: "2026-09-07" }, TODAY)).toBe(-3);
  });

  it("is 0 on the EDD itself", () => {
    expect(pastEddOf({ idealDeliveryDate: TODAY }, TODAY)).toBe(0);
  });

  it("is undefined — never 0 — when no EDD exists at all", () => {
    expect(pastEddOf({}, TODAY)).toBeUndefined();
  });
});

describe("board sort", () => {
  const row = (over: Partial<{ so: string; breaching: boolean; pastEdd?: number; ageing: number }>) => ({
    so: "X",
    breaching: false,
    ageing: 0,
    ...over,
  });

  it("puts breaches first regardless of lateness", () => {
    const late = row({ so: "LATE", pastEdd: 9 });
    const breach = row({ so: "BREACH", breaching: true, pastEdd: -5 });
    expect([late, breach].sort(bySort)[0].so).toBe("BREACH");
  });

  it("orders by how late, latest first", () => {
    const rows = [row({ so: "A", pastEdd: 1 }), row({ so: "C", pastEdd: 12 }), row({ so: "B", pastEdd: 4 })];
    expect(rows.sort(bySort).map((r) => r.so)).toEqual(["C", "B", "A"]);
  });

  it("sinks no-EDD rows below every dated row, including not-yet-due ones", () => {
    const rows = [
      row({ so: "NONE", pastEdd: undefined }),
      row({ so: "NOTDUE", pastEdd: -8 }),
      row({ so: "LATE", pastEdd: 2 }),
    ];
    expect(rows.sort(bySort).map((r) => r.so)).toEqual(["LATE", "NOTDUE", "NONE"]);
  });

  it("falls back to transit age between two rows with no EDD", () => {
    const rows = [row({ so: "NEW", ageing: 1 }), row({ so: "OLD", ageing: 20 })];
    expect(rows.sort(bySort).map((r) => r.so)).toEqual(["OLD", "NEW"]);
  });
});
