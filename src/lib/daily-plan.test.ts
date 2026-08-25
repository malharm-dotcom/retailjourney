// Guards on the things that fail SILENTLY rather than loudly:
//   1. the day windows, which must stay on TODAY and not drift back to the
//      emailer's +1/+2 day offsets;
//   2. the out-of-rulebook TAT rule, which is what makes QC orders visible;
//   3. the "NULL"-string traps, which would paint every row green or every
//      row off-rulebook.

import { describe, expect, it } from "vitest";
import { handoverSql, planFacilities, planSection, processingSql, type PlanSourceRow } from "./daily-plan";
import type { User } from "./types";

const user = (facilities: string[]): Pick<User, "role" | "facilities"> =>
  ({ role: "WH_SUPERVISOR", facilities } as Pick<User, "role" | "facilities">);

const row = (over: Partial<PlanSourceRow> = {}): PlanSourceRow => ({
  ORDER_DATE: "2026-08-25",
  ORDER_NAME: "HENNUR16241",
  STORE: "SNITCH - COCO - HENNUR",
  WAREHOUSE_NAME: "SAPL-WH2",
  ORDER_TYPE: "RPL",
  QUANTITY: 179,
  WH_PROCESSING_TAT: "2026-08-25 18:00:00.000",
  PICKUP_TAT: "2026-08-26 23:59:59.000",
  HANDOVER_DATE: "2026-08-26",
  MANIFESTED_TIMESTAMP: null,
  LANE_CLASSIFICATION: "Milk Run Lane",
  TRACKING_NUMBER: null,
  COURIER_PARTNER: null,
  FINAL_STATUS: null,
  RULEBOOK_COVERED: true,
  ...over,
});

describe("facility scope", () => {
  it("keeps BOTH South warehouses — resolveScope would collapse them to one", () => {
    expect(planFacilities(user(["SAPL-WH1", "SAPL-WH2"]))).toEqual(["SAPL-WH1", "SAPL-WH2"]);
  });

  it("gives an unlisted user all three", () => {
    expect(planFacilities(user([]))).toEqual(["SAPL-NORTH-TAURU", "SAPL-WH1", "SAPL-WH2"]);
  });

  it("drops anything that is not one of the three known literals", () => {
    expect(planFacilities(user(["SAPL-WH1", "'; DROP TABLE --"]))).toEqual(["SAPL-WH1"]);
  });

  it("scopes both statements to the given facilities and nothing wider", () => {
    for (const sql of [processingSql(["SAPL-NORTH-TAURU"]), handoverSql(["SAPL-NORTH-TAURU"])]) {
      expect(sql).toContain("WAREHOUSE_NAME IN ('SAPL-NORTH-TAURU')");
      expect(sql).not.toContain("SAPL-WH1");
    }
  });
});

describe("today's windows", () => {
  // If these fail, the emailer's +1/+2 day offsets have crept back in and the
  // floor is being shown tomorrow's work as though it were today's.
  it("runs the processing window from today 05:00 to tomorrow 05:00", () => {
    const sql = processingSql(["SAPL-WH2"]);
    expect(sql).toContain("DATEADD(hour, 5, DATE_TRUNC('day', CURRENT_DATE))");
    expect(sql).toContain("DATEADD(hour, 5, DATEADD(day, 1, DATE_TRUNC('day', CURRENT_DATE)))");
    // The emailer's shifted lower bound must not reappear.
    expect(sql).not.toContain("DATEADD(hour, 5, DATEADD(day, 2,");
  });

  it("keys handover on today, not tomorrow", () => {
    const sql = handoverSql(["SAPL-WH2"]);
    expect(sql).toContain("= CURRENT_DATE");
    expect(sql).not.toContain("CURRENT_DATE + 1");
  });

  it("sorts by the warehouse's own deadline, earliest first", () => {
    expect(processingSql(["SAPL-WH2"])).toContain("ORDER BY WH_PROCESSING_TAT ASC, STORE ASC, ORDER_NAME ASC");
  });

  it("collapses to order grain so a split consignment cannot print twice", () => {
    expect(processingSql(["SAPL-WH2"])).toContain("PARTITION BY ORDER_NAME");
  });
});

describe("the out-of-rulebook TAT", () => {
  it("derives order date + 2 days at 18:00 only when there is no timeline at all", () => {
    const sql = processingSql(["SAPL-WH2"]);
    expect(sql).toContain("WHEN RULEBOOK_COVERED = FALSE AND PICKUP_TAT IS NULL");
    expect(sql).toContain("DATEADD(hour, 18, DATEADD(day, 2, TO_TIMESTAMP_NTZ(ORDER_DATE)))");
    // An out-of-rulebook order that HAS a pickup day keeps its own deadline.
    expect(sql).toContain("ELSE HANDOVER_DEADLINE_TS");
  });

  it("reads the spine, which is the only source carrying QC orders", () => {
    expect(processingSql(["SAPL-WH2"])).toContain("RETAIL_JOURNEY_SPINE");
    expect(processingSql(["SAPL-WH2"])).not.toContain("DISTRIBUTION_ANALYTICS");
  });

  it("keeps the two deadlines as separate columns", () => {
    const sql = processingSql(["SAPL-WH2"]);
    expect(sql).toContain("AS WH_PROCESSING_TAT");
    expect(sql).toContain("PICKUP_TAT                                AS PICKUP_TAT");
  });
});

describe("row flags", () => {
  it("counts a manifest stamp as picked up and its absence as pending", () => {
    const s = planSection([row(), row({ MANIFESTED_TIMESTAMP: "2026-08-24 14:10:06.000" })]);
    expect([s.total, s.manifested, s.pending]).toEqual([2, 1, 1]);
  });

  it("treats Snowflake's literal 'NULL' string as absent, not as a stamp", () => {
    const s = planSection([row({ MANIFESTED_TIMESTAMP: "NULL" }), row({ MANIFESTED_TIMESTAMP: "" })]);
    expect(s.manifested).toBe(0);
    expect(s.rows.every((r) => r.manifestedAt === undefined)).toBe(true);
  });

  it("flags an uncovered order off-rulebook, from either a boolean or a string", () => {
    const s = planSection([
      row({ RULEBOOK_COVERED: false }),
      row({ RULEBOOK_COVERED: "FALSE" }),
      row({ RULEBOOK_COVERED: true }),
    ]);
    expect(s.offRulebook).toBe(2);
  });

  it("fails safe on an unreadable coverage flag — never wrongly says off-rulebook", () => {
    const s = planSection([row({ RULEBOOK_COVERED: "NULL" }), row({ RULEBOOK_COVERED: null })]);
    expect(s.offRulebook).toBe(0);
  });

  it("carries a missing pickup TAT through as absent rather than as a date", () => {
    const [r] = planSection([row({ PICKUP_TAT: "NULL" })]).rows;
    expect(r.pickupTat).toBeUndefined();
    expect(r.whProcessingTat).toBe("2026-08-25 18:00:00.000");
  });
});
