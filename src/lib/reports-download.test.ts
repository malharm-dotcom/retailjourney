// The download layer's two load-bearing guards: the facility ceiling, and the
// date range that becomes literal SQL text.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_DAYS,
  DOWNLOADS,
  FilterError,
  downloadBySlug,
  downloadScope,
  resolveRange,
  selectableFacilities,
} from "./reports-download";
import { addDays, istToday } from "./ist";
import type { User } from "./types";

const admin: Pick<User, "role" | "facilities" | "allView"> = {
  role: "ADMIN",
  facilities: [],
  allView: true,
};
const operator: Pick<User, "role" | "facilities" | "allView"> = {
  role: "WH_OPERATOR",
  facilities: ["SAPL-WH1"],
  allView: false,
};

describe("downloadScope — the session is the ceiling", () => {
  it("lets an all-facility session narrow to one warehouse", () => {
    expect(downloadScope(admin, "ALL", "SAPL-WH2")).toBe("SAPL-WH2");
  });

  it("keeps the session scope when no facility is requested", () => {
    expect(downloadScope(admin, "ALL")).toBe("ALL");
    expect(downloadScope(operator, "SAPL-WH1")).toBe("SAPL-WH1");
  });

  it("cannot be widened to ALL by a parameter", () => {
    expect(downloadScope(operator, "SAPL-WH1", "ALL")).toBe("SAPL-WH1");
  });

  it("cannot be moved sideways to another warehouse by a parameter", () => {
    // The session has already resolved to WH1. A download asking for WH2 is
    // answered with WH1 — the parameter may narrow, never relocate.
    expect(downloadScope(operator, "SAPL-WH1", "SAPL-WH2")).toBe("SAPL-WH1");
  });

  it("re-checks entitlement even when the session is ALL", () => {
    // allView user whose entitlement list does not include the request.
    const limited = { role: "WH_SUPERVISOR" as const, facilities: ["SAPL-WH2" as const], allView: false };
    expect(downloadScope(limited, "ALL", "SAPL-WH1")).toBe("SAPL-WH2");
  });

  it("ignores a facility that is not a facility at all", () => {
    expect(downloadScope(admin, "ALL", "'; DROP TABLE--")).toBe("ALL");
    expect(downloadScope(admin, "ALL", "SAPL-WH9")).toBe("ALL");
  });
});

describe("selectableFacilities", () => {
  it("offers the entitlement list when the session is ALL", () => {
    expect(selectableFacilities(admin, "ALL")).toEqual([
      "SAPL-NORTH-TAURU",
      "SAPL-WH1",
      "SAPL-WH2",
    ]);
  });

  it("offers only the session's own facility when it is already narrowed", () => {
    expect(selectableFacilities(admin, "SAPL-WH2")).toEqual(["SAPL-WH2"]);
    expect(selectableFacilities(operator, "SAPL-WH1")).toEqual(["SAPL-WH1"]);
  });
});

describe("resolveRange", () => {
  it("defaults to the trailing window when nothing is supplied", () => {
    const today = istToday();
    expect(resolveRange({})).toEqual({ from: addDays(today, -DEFAULT_WINDOW_DAYS), to: today });
  });

  it("honours an explicit range", () => {
    expect(resolveRange({ from: "2026-07-01", to: "2026-07-31" })).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("backfills the other bound when only one is given", () => {
    expect(resolveRange({ to: "2026-07-31" }).from).toBe(addDays("2026-07-31", -DEFAULT_WINDOW_DAYS));
    expect(resolveRange({ from: "2026-07-01" }).to).toBe(istToday());
  });

  it("rejects a malformed date instead of silently defaulting", () => {
    // A stale bookmark quietly returning the last 30 days instead of the
    // quarter someone asked for is worse than an error saying so. It is also
    // the guard that keeps non-dates out of literal SQL text.
    expect(() => resolveRange({ from: "01-07-2026" })).toThrow(FilterError);
    expect(() => resolveRange({ to: "2026-07-32x" })).toThrow(FilterError);
    expect(() => resolveRange({ from: "2026-07-01' OR 1=1--" })).toThrow(FilterError);
  });

  it("rejects an inverted range", () => {
    expect(() => resolveRange({ from: "2026-08-01", to: "2026-07-01" })).toThrow(FilterError);
  });
});

describe("DOWNLOADS", () => {
  it("exposes the four reports, each resolvable by slug", () => {
    expect(DOWNLOADS.map((d) => d.slug)).toEqual([
      "order-detail",
      "courier-performance",
      "lane-performance",
      "dispatch-summary",
    ]);
    for (const d of DOWNLOADS) expect(downloadBySlug(d.slug)).toBe(d);
    expect(downloadBySlug("nope")).toBeUndefined();
  });

  it("puts the extra filter only on the reports that can support it", () => {
    expect(downloadBySlug("courier-performance")?.filter).toBe("courier");
    expect(downloadBySlug("lane-performance")?.filter).toBe("lane");
    expect(downloadBySlug("order-detail")?.filter).toBeUndefined();
    expect(downloadBySlug("dispatch-summary")?.filter).toBeUndefined();
  });
});
