// Role gate invariants. These are the guarantees the login work rests on:
// a read-only role can never mutate, and a client-supplied facility is never
// trusted. Both are enforced server-side in app/actions.ts.

import { describe, expect, it } from "vitest";
import { ROLE_POLICY, assertCan, assertFacility, resolveScope } from "./rbac";
import type { Role } from "./types";

const VIEWER: Role = "RETAIL_HEAD"; // the read-only role
const EDITORS: Role[] = ["MERCHANDISING", "WH_SUPERVISOR", "WH_OPERATOR", "LOGISTICS"];

describe("role policy", () => {
  it("the read-only role holds no edit right at all", () => {
    const p = ROLE_POLICY[VIEWER];
    expect(p.readOnly).toBe(true);
    expect(p.canEditWarehouse).toBe(false);
    expect(p.canEditLogistics).toBe(false);
    expect(p.canEditMerch).toBe(false);
    expect(p.canEditReconciliation).toBe(false);
    expect(p.isAdmin).toBe(false);
  });

  it("every editor role can edit something, and none is an admin", () => {
    for (const role of EDITORS) {
      const p = ROLE_POLICY[role];
      expect(p.readOnly).toBe(false);
      expect(p.canEditWarehouse || p.canEditLogistics || p.canEditMerch || p.canEditReconciliation).toBe(true);
      expect(p.isAdmin).toBe(false);
    }
  });

  it("only ADMIN carries user management", () => {
    expect(ROLE_POLICY.ADMIN.isAdmin).toBe(true);
    for (const role of [VIEWER, ...EDITORS]) expect(ROLE_POLICY[role].isAdmin).toBe(false);
  });

  it("assertCan refuses the viewer and admits the right holder", () => {
    expect(() => assertCan({ role: VIEWER }, "canEditWarehouse")).toThrow(/Forbidden/);
    expect(() => assertCan({ role: "WH_SUPERVISOR" }, "canEditWarehouse")).not.toThrow();
    expect(() => assertCan({ role: "WH_SUPERVISOR" }, "canEditLogistics")).toThrow(/Forbidden/);
  });
});

describe("facility scope is never taken on trust", () => {
  const scoped = { role: "WH_OPERATOR" as Role, facilities: ["SAPL-WH1" as const], allView: false };

  it("downgrades a facility the user is not entitled to", () => {
    expect(resolveScope(scoped, "SAPL-WH2")).toBe("SAPL-WH1");
    expect(resolveScope(scoped, "ALL")).toBe("SAPL-WH1");
  });

  it("honours an entitled facility", () => {
    expect(resolveScope(scoped, "SAPL-WH1")).toBe("SAPL-WH1");
  });

  it("assertFacility throws outside the entitlement list", () => {
    expect(() => assertFacility(scoped, "SAPL-WH2")).toThrow(/Forbidden/);
    expect(() => assertFacility(scoped, "SAPL-WH1")).not.toThrow();
  });
});
