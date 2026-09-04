// The Logistics dispatch-date window.
//
// Both sides are YYYY-MM-DD IST business dates, never timestamps, so the
// comparison is a plain string compare — no Date parsing, and no chance of a
// UTC offset creeping in. These pin that, plus the two edges that matter: the
// bounds are INCLUSIVE, and an undated dispatch (a real spine gap) is excluded
// by either bound rather than sorting in as "very old".

import { describe, expect, it } from "vitest";

/** The predicate as the table applies it. */
const inWindow = (dispatch: string | undefined, from: string, to: string) => {
  if (from && (!dispatch || dispatch < from)) return false;
  if (to && (!dispatch || dispatch > to)) return false;
  return true;
};

describe("dispatch-date window", () => {
  it("includes both bounds", () => {
    expect(inWindow("2026-09-01", "2026-09-01", "2026-09-30")).toBe(true);
    expect(inWindow("2026-09-30", "2026-09-01", "2026-09-30")).toBe(true);
  });

  it("excludes either side of the window", () => {
    expect(inWindow("2026-08-31", "2026-09-01", "2026-09-30")).toBe(false);
    expect(inWindow("2026-10-01", "2026-09-01", "2026-09-30")).toBe(false);
  });

  it("treats one empty box as unbounded on that end", () => {
    expect(inWindow("2020-01-01", "", "2026-09-30")).toBe(true);
    expect(inWindow("2099-01-01", "2026-09-01", "")).toBe(true);
    expect(inWindow(undefined, "", "")).toBe(true);
  });

  it("drops an undated dispatch as soon as either bound is set", () => {
    // `dispatch` is undefined when the spine carried no anchor at all. That is
    // a data gap; it must not slip into a dated window in either direction.
    expect(inWindow(undefined, "2026-09-01", "")).toBe(false);
    expect(inWindow(undefined, "", "2026-09-30")).toBe(false);
  });

  it("compares lexicographically, which is chronological for this format", () => {
    expect(inWindow("2026-09-09", "2026-09-10", "")).toBe(false);
    expect(inWindow("2026-10-02", "2026-09-10", "")).toBe(true);
  });
});
