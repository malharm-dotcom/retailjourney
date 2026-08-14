// The queue filter model. These are the rules the URL, the filter bar and the
// server-side card list all read from, so a disagreement here is a board that
// shows something other than what its link says.

import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  filtersFromParams,
  isFiltered,
  matchesFilters,
  paramsFromFilters,
  type Filterable,
  type QueueFilters,
} from "./filters";
import type { OrderType } from "@/lib/types";

function card(over: Partial<Filterable> = {}): Filterable {
  return {
    so: "SO-1001",
    store: "SNITCH - FOCO - BOPAL",
    campaign: "SUMMER CAPSULE",
    type: "FRESH" as OrderType,
    channel: "OWN_STORE",
    ageDays: 3,
    ...over,
  };
}

const f = (over: Partial<QueueFilters> = {}): QueueFilters => ({ ...EMPTY_FILTERS, ...over });

describe("reading filters from the URL", () => {
  it("defaults to a neutral, unfiltered board", () => {
    expect(filtersFromParams({})).toEqual(EMPTY_FILTERS);
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
  });

  it("reads every facet", () => {
    expect(
      filtersFromParams({ q: "SO-1", store: "BOPAL", type: "RPL", age: "4-7", overdue: "1", channel: "OWN_STORE" }),
    ).toEqual({ q: "SO-1", store: "BOPAL", type: "RPL", age: "4-7", overdue: true, channel: "OWN_STORE" });
  });

  it("degrades a hand-edited URL to a broader board rather than throwing", () => {
    // An unknown age bucket must not 500 the page or silently match nothing.
    expect(filtersFromParams({ age: "nonsense" }).age).toBe("");
    expect(filtersFromParams({ overdue: "yes" }).overdue).toBe(false);
  });

  it("takes the first value when a param is repeated", () => {
    expect(filtersFromParams({ q: ["first", "second"] }).q).toBe("first");
  });

  it("round-trips back to a query string, omitting neutral values", () => {
    expect(paramsFromFilters(EMPTY_FILTERS)).toBe("");
    const round = f({ type: "RPL" as OrderType, overdue: true });
    expect(filtersFromParams(Object.fromEntries(new URLSearchParams(paramsFromFilters(round))))).toEqual(round);
  });
});

describe("matching", () => {
  it("passes everything when nothing is set", () => {
    expect(matchesFilters(card(), EMPTY_FILTERS)).toBe(true);
  });

  it("searches SO, store and campaign case-insensitively", () => {
    expect(matchesFilters(card(), f({ q: "so-10" }))).toBe(true);
    expect(matchesFilters(card(), f({ q: "bopal" }))).toBe(true);
    expect(matchesFilters(card(), f({ q: "summer" }))).toBe(true);
    expect(matchesFilters(card(), f({ q: "nowhere" }))).toBe(false);
  });

  it("does not fall over on a card with no campaign", () => {
    expect(matchesFilters(card({ campaign: undefined }), f({ q: "bopal" }))).toBe(true);
  });

  it("filters by store, type and channel exactly", () => {
    expect(matchesFilters(card(), f({ store: "SNITCH - FOCO - BOPAL" }))).toBe(true);
    expect(matchesFilters(card(), f({ store: "SNITCH - COCO - OTHER" }))).toBe(false);
    expect(matchesFilters(card(), f({ type: "RPL" as OrderType }))).toBe(false);
    expect(matchesFilters(card(), f({ channel: "FRANCHISE_STORE" }))).toBe(false);
  });

  it("reads the overdue flag rather than recomputing a deadline", () => {
    expect(matchesFilters(card({ due: "overdue" }), f({ overdue: true }))).toBe(true);
    expect(matchesFilters(card({ due: "today" }), f({ overdue: true }))).toBe(false);
    expect(matchesFilters(card({ due: undefined }), f({ overdue: true }))).toBe(false);
  });

  it("bounds age buckets inclusively at both ends", () => {
    expect(matchesFilters(card({ ageDays: 1 }), f({ age: "0-1" }))).toBe(true);
    expect(matchesFilters(card({ ageDays: 2 }), f({ age: "0-1" }))).toBe(false);
    expect(matchesFilters(card({ ageDays: 4 }), f({ age: "4-7" }))).toBe(true);
    expect(matchesFilters(card({ ageDays: 7 }), f({ age: "4-7" }))).toBe(true);
    expect(matchesFilters(card({ ageDays: 8 }), f({ age: "4-7" }))).toBe(false);
    // The open-ended bucket has no upper edge to fall off.
    expect(matchesFilters(card({ ageDays: 400 }), f({ age: "8+" }))).toBe(true);
  });

  it("ANDs the facets together", () => {
    const c = card({ type: "FRESH" as OrderType, due: "overdue", ageDays: 5 });
    expect(matchesFilters(c, f({ type: "FRESH" as OrderType, overdue: true, age: "4-7" }))).toBe(true);
    // One mismatched facet is enough to drop the card.
    expect(matchesFilters(c, f({ type: "FRESH" as OrderType, overdue: true, age: "0-1" }))).toBe(false);
  });
});
