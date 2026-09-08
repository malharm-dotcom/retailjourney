// The masking contract, pinned: an empty search paints 30 days, ANY search
// lifts the window to all of history. If these pass, no historical order can
// become unfindable through this module.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_DAYS,
  EMPTY_SEARCH,
  isSearching,
  matchesSearch,
  orderDateFloor,
  searchFromParams,
} from "./order-search";

const TODAY = "2026-09-08";
const row = (over: Partial<Parameters<typeof matchesSearch>[0]> = {}) => ({
  soNumber: "ANSAPL16017",
  storeNameFormat: "COFO - DAHISAR",
  orderDate: "2026-09-01",
  status: "DISPATCHED_TO_STORE",
  type: "RPL",
  ...over,
});

describe("orderDateFloor", () => {
  it("floors an unsearched list at 30 days", () => {
    expect(orderDateFloor(EMPTY_SEARCH, TODAY)).toBe("2026-08-09");
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
  });

  it("lifts the floor for EVERY facet, not just the text box", () => {
    for (const s of [
      { q: "ANSAPL" },
      { from: "2024-01-01" },
      { to: "2024-06-30" },
      { status: "CANCELLED" as const },
      { store: "COFO - DAHISAR" },
      { type: "NSO" as const },
    ]) {
      expect(orderDateFloor({ ...EMPTY_SEARCH, ...s }, TODAY)).toBeUndefined();
      expect(isSearching({ ...EMPTY_SEARCH, ...s })).toBe(true);
    }
  });
});

describe("matchesSearch", () => {
  it("hides an old order on first paint but finds it on search", () => {
    const old = row({ orderDate: "2023-04-11" });
    const floor = orderDateFloor(EMPTY_SEARCH, TODAY);
    expect(matchesSearch(old, EMPTY_SEARCH, floor)).toBe(false);

    // Masked, never gone: the same row on any search, with no floor.
    const search = { ...EMPTY_SEARCH, q: "ansapl16017" };
    expect(matchesSearch(old, search, orderDateFloor(search, TODAY))).toBe(true);
  });

  it("matches SO and store case-insensitively", () => {
    expect(matchesSearch(row(), { ...EMPTY_SEARCH, q: "dahisar" }, undefined)).toBe(true);
    expect(matchesSearch(row(), { ...EMPTY_SEARCH, q: "nope" }, undefined)).toBe(false);
  });

  it("treats the date range as inclusive on both bounds", () => {
    const s = { ...EMPTY_SEARCH, from: "2026-09-01", to: "2026-09-01" };
    expect(matchesSearch(row(), s, undefined)).toBe(true);
    expect(matchesSearch(row({ orderDate: "2026-08-31" }), s, undefined)).toBe(false);
    expect(matchesSearch(row({ orderDate: "2026-09-02" }), s, undefined)).toBe(false);
  });

  it("isolates NSO, which is the reason the type facet exists", () => {
    const nso = row({ type: "NSO" });
    const s = { ...EMPTY_SEARCH, type: "NSO" as const };
    expect(matchesSearch(nso, s, undefined)).toBe(true);
    expect(matchesSearch(row(), s, undefined)).toBe(false);
    // …and it reaches history like every other facet: a store opening from
    // last year must still be findable.
    expect(orderDateFloor(s, TODAY)).toBeUndefined();
    expect(matchesSearch(row({ type: "NSO", orderDate: "2025-02-02" }), s, undefined)).toBe(true);
  });

  it("narrows on status and store exactly", () => {
    expect(matchesSearch(row(), { ...EMPTY_SEARCH, status: "CANCELLED" }, undefined)).toBe(false);
    expect(matchesSearch(row(), { ...EMPTY_SEARCH, store: "COFO - DAHISAR" }, undefined)).toBe(true);
    expect(matchesSearch(row(), { ...EMPTY_SEARCH, store: "COCO - JASOLA" }, undefined)).toBe(false);
  });
});

describe("searchFromParams", () => {
  it("degrades junk to a wider list rather than throwing", () => {
    const s = searchFromParams({ from: "yesterday", status: "NOT_A_STAGE", q: "  x  " });
    expect(s.from).toBe("");
    expect(s.status).toBe("");
    expect(s.q).toBe("x");
  });

  it("reads a real search out of the URL", () => {
    const s = searchFromParams({ from: "2024-01-01", to: "2024-12-31", status: "CANCELLED" });
    expect(s).toMatchObject({ from: "2024-01-01", to: "2024-12-31", status: "CANCELLED" });
    expect(isSearching(s)).toBe(true);
  });
});
