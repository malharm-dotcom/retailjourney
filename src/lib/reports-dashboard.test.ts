// Pins the things on the dashboard that are not allowed to drift: the
// server-side facility predicate, and the ported Metabase definitions.
//
// The SQL assertions look pedantic, and that is the point. Every one of them
// encodes a place where the upstream question does something surprising —
// FUTURE SLA passing, two adjacent columns using different denominators,
// Perfect Order% ignoring the PERFECT_ORDER_SLA column. A well-meaning
// "cleanup" of any of them silently desyncs this page from the dashboard it
// exists to mirror, and nothing else in the suite would notice.

import { describe, expect, it } from "vitest";
import {
  KPI_AMBER,
  KPI_GREEN,
  REPORT_TABLE,
  WINDOW_DAYS,
  kpiTone,
  scopeClause,
} from "./reports-dashboard";

describe("scopeClause — server-side facility scoping", () => {
  it("narrows to a single warehouse when the session resolves to one", () => {
    expect(scopeClause("SAPL-WH2")).toBe("WAREHOUSE_NAME = 'SAPL-WH2'");
  });

  it("does not constrain the warehouse when the session is entitled to all", () => {
    expect(scopeClause("ALL")).toBe("1 = 1");
    expect(scopeClause("ALL")).not.toContain("WAREHOUSE_NAME");
  });

  it("narrows a RETAIL_HEAD to their own area manager, on top of the facility", () => {
    expect(scopeClause("SAPL-WH1", "Ravi K")).toBe(
      "WAREHOUSE_NAME = 'SAPL-WH1' AND AREA_MANAGER = 'Ravi K'",
    );
  });

  it("escapes a quote in the area manager rather than closing the literal", () => {
    // "O'Brien" unescaped would terminate the string and leave `Brien' …` as SQL.
    const sql = scopeClause("ALL", "O'Brien");
    expect(sql).toBe("AREA_MANAGER = 'O''Brien'");
    // Quote count stays even — nothing escaped out of the literal.
    expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
  });
});

describe("source", () => {
  it("reads the table Metabase reads, not the app's own spine", () => {
    // Reading RETAIL_JOURNEY_SPINE here would be defensible and would NOT match
    // the dashboard — the spine keeps out-of-rulebook orders that
    // distribution_analytics drops. See the header comment before changing this.
    expect(REPORT_TABLE).toBe("SNITCH_DB.MAPLEMONK.DISTRIBUTION_ANALYTICS");
    expect(REPORT_TABLE).not.toContain("RETAIL_JOURNEY_SPINE");
  });

  it("uses upstream's 31-day trailing window", () => {
    expect(WINDOW_DAYS).toBe(31);
  });
});

describe("kpiTone", () => {
  it("colours by the stated thresholds", () => {
    expect(kpiTone(KPI_GREEN)).toBe("done");
    expect(kpiTone(99.9)).toBe("done");
    expect(kpiTone(KPI_AMBER)).toBe("handling");
    expect(kpiTone(KPI_GREEN - 0.1)).toBe("handling");
    expect(kpiTone(KPI_AMBER - 0.1)).toBe("failed");
    expect(kpiTone(0)).toBe("failed");
  });

  it("treats a metric with no applicable rows as pending, never as a failure", () => {
    expect(kpiTone(null)).toBe("pending");
  });
});
