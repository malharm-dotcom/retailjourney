// Pins the two things on the dashboard that are not allowed to drift: the
// server-side facility predicate, and the SLA definition every panel shares.

import { describe, expect, it } from "vitest";
import { KPI_AMBER, KPI_GREEN, kpiTone, scopeClause, slaPct } from "./reports-dashboard";

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

describe("slaPct — the shared SLA definition", () => {
  it("counts EARLY_CREATION as a pass on placement, and nowhere else", () => {
    expect(slaPct("ORDER_PLACEMENT_SLA")).toContain("'WITHIN_SLA','EARLY_CREATION'");
    for (const col of ["HANDOVER_SLA", "PICKUP_SLA", "DELIVERY_SLA", "PERFECT_ORDER_SLA"]) {
      expect(slaPct(col)).not.toContain("EARLY_CREATION");
      expect(slaPct(col)).toContain("'WITHIN_SLA'");
    }
  });

  it("keeps FUTURE SLA out of the denominator on every leg", () => {
    for (const col of ["ORDER_PLACEMENT_SLA", "HANDOVER_SLA", "PICKUP_SLA", "DELIVERY_SLA", "PERFECT_ORDER_SLA"]) {
      expect(slaPct(col)).toContain(`${col} <> 'FUTURE SLA'`);
    }
  });

  it("divides by NULLIF so an empty day reads as no data, not as 0%", () => {
    expect(slaPct("DELIVERY_SLA")).toContain("NULLIF(");
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
