// Two guards, both on things that fail SILENTLY rather than loudly:
//   1. the emailer's boundary math, which someone will eventually try to "fix";
//   2. the "NULL"-string trap, which would paint every row green.

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
  TAT: "2026-08-26 18:00:00.000",
  HANDOVER_DATE: "2026-08-27",
  MANIFESTED_TIMESTAMP: null,
  LANE_CLASSIFICATION: "Milk Run Lane",
  TRACKING_NUMBER: null,
  COURIER_PARTNER: null,
  FINAL_STATUS: null,
  ...over,
});

describe("facility scope", () => {
  it("keeps BOTH South warehouses — resolveScope would collapse them to one", () => {
    expect(planFacilities(user(["SAPL-WH1", "SAPL-WH2"]))).toEqual(["SAPL-WH1", "SAPL-WH2"]);
  });

  it("gives an unlisted user the emailer's own three", () => {
    expect(planFacilities(user([]))).toEqual(["SAPL-NORTH-TAURU", "SAPL-WH1", "SAPL-WH2"]);
  });

  it("drops anything that is not one of the three known literals", () => {
    expect(planFacilities(user(["SAPL-WH1", "'; DROP TABLE --"]))).toEqual(["SAPL-WH1"]);
  });

  it("scopes both statements to the given facilities and nothing wider", () => {
    for (const sql of [processingSql(["SAPL-NORTH-TAURU"]), handoverSql(["SAPL-NORTH-TAURU"])]) {
      expect(sql).toContain("warehouse_name IN ('SAPL-NORTH-TAURU')");
      expect(sql).not.toContain("SAPL-WH1");
    }
  });
});

describe("the emailer's windows, verbatim", () => {
  // If these fail, someone has "corrected" the +1/+2 day offsets and the app
  // has silently stopped agreeing with the morning mail. Fix n8n, not this.
  it("keeps the PROCESSING boundaries at +1 day and +2 days, both at 05:00", () => {
    const sql = processingSql(["SAPL-WH2"]);
    expect(sql).toContain("DATEADD(hour, 5, DATEADD(day, 1, DATE_TRUNC('day', CURRENT_DATE))) AS today_5am");
    expect(sql).toContain("DATEADD(hour, 5, DATEADD(day, 2, DATE_TRUNC('day', CURRENT_DATE))) AS tomorrow_5am");
    expect(sql).toContain("handover_deadline_ts > l.today_5am");
    expect(sql).toContain("handover_deadline_ts <= l.tomorrow_5am");
  });

  it("keeps HANDOVER on the next-day boundary and the derived pickup date", () => {
    const sql = handoverSql(["SAPL-WH2"]);
    expect(sql).toContain("COALESCE(TO_DATE(pickup_tat), TO_DATE(handover_deadline_ts)) AS HANDOVER_DATE");
    expect(sql).toContain("WHERE HANDOVER_DATE = CURRENT_DATE + 1");
  });

  it("sorts by TAT ascending, as the mail does", () => {
    expect(processingSql(["SAPL-WH2"])).toContain("ORDER BY TAT ASC, STORE ASC, ORDER_NAME ASC");
  });
});

describe("picked-up rule", () => {
  it("counts a manifest stamp as picked up and its absence as pending", () => {
    const s = planSection([row(), row({ MANIFESTED_TIMESTAMP: "2026-08-24 14:10:06.000" })]);
    expect([s.total, s.manifested, s.pending]).toEqual([2, 1, 1]);
  });

  it("treats Snowflake's literal 'NULL' string as absent, not as a stamp", () => {
    // fetchAsString: ["Date"] hands a NULL timestamp back as "NULL". A raw
    // truthiness test here would mark the whole list green.
    const s = planSection([row({ MANIFESTED_TIMESTAMP: "NULL" }), row({ MANIFESTED_TIMESTAMP: "" })]);
    expect(s.manifested).toBe(0);
    expect(s.rows.every((r) => r.manifestedAt === undefined)).toBe(true);
  });
});
