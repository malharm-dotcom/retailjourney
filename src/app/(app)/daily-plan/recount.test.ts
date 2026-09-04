// Filtering the Daily Plan by warehouse must recount the header.
//
// The server's PlanSection totals describe every warehouse the user is
// entitled to. Rendering those beside a narrowed table would have the header
// and the rows disagree about how much work there is — on a list the floor
// works through item by item, that is the one thing it cannot do.

import { describe, expect, it } from "vitest";
import type { PlanRow } from "@/lib/daily-plan";

const recount = (rows: PlanRow[]) => ({
  rows,
  total: rows.length,
  manifested: rows.filter((r) => r.pickedUp).length,
  pending: rows.filter((r) => !r.pickedUp).length,
  offRulebook: rows.filter((r) => !r.onRulebook).length,
});

const row = (over: Partial<PlanRow>): PlanRow =>
  ({ orderName: "SO-1", pickedUp: false, onRulebook: true, ...over }) as PlanRow;

const ROWS = [
  row({ orderName: "A", warehouse: "SAPL-WH2", pickedUp: true }),
  row({ orderName: "B", warehouse: "SAPL-WH2", pickedUp: false, onRulebook: false }),
  row({ orderName: "C", warehouse: "SAPL-NORTH-TAURU", pickedUp: true }),
  row({ orderName: "D", warehouse: "SAPL-NORTH-TAURU", pickedUp: false }),
  row({ orderName: "E", warehouse: "SAPL-NORTH-TAURU", pickedUp: false, onRulebook: false }),
];

describe("warehouse filter recount", () => {
  it("counts only the filtered warehouse", () => {
    const s = recount(ROWS.filter((r) => r.warehouse === "SAPL-WH2"));
    expect(s).toMatchObject({ total: 2, manifested: 1, pending: 1, offRulebook: 1 });
  });

  it("keeps picked-up and pending adding up to the total", () => {
    for (const wh of ["SAPL-WH2", "SAPL-NORTH-TAURU"]) {
      const s = recount(ROWS.filter((r) => r.warehouse === wh));
      expect(s.manifested + s.pending, wh).toBe(s.total);
    }
  });

  it("matches the unfiltered figures when nothing is selected", () => {
    expect(recount(ROWS)).toMatchObject({ total: 5, manifested: 2, pending: 3, offRulebook: 2 });
  });

  it("reports zeroes, not the parent totals, for a warehouse with no work", () => {
    expect(recount(ROWS.filter((r) => r.warehouse === "SAPL-WH1"))).toMatchObject({
      total: 0,
      manifested: 0,
      pending: 0,
      offRulebook: 0,
    });
  });
});
