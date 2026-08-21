// Role gate invariants. These are the guarantees the login work rests on:
// a read-only role can never mutate, and a client-supplied facility is never
// trusted. Both are enforced server-side in app/actions.ts.

import { describe, expect, it } from "vitest";
import { ROLE_POLICY, assertCan, assertFacility, resolveScope } from "./rbac";
import type { Role } from "./types";

const READ_ONLY: Role[] = ["RETAIL_HEAD", "VIEWER"];
const VIEWER: Role = "RETAIL_HEAD"; // the original read-only role
const EDITORS: Role[] = ["MERCHANDISING", "WH_SUPERVISOR", "WH_OPERATOR", "LOGISTICS"];

describe("role policy", () => {
  it("no read-only role holds any edit right at all", () => {
    for (const role of READ_ONLY) {
      const p = ROLE_POLICY[role];
      expect(p.readOnly).toBe(true);
      expect(p.canEditWarehouse).toBe(false);
      expect(p.canEditLogistics).toBe(false);
      expect(p.canEditMerch).toBe(false);
      expect(p.canEditReconciliation).toBe(false);
      expect(p.isAdmin).toBe(false);
    }
  });

  // VIEWER is what a self-provisioned Google sign-in lands on, so it is the one
  // role a stranger can reach without an admin. It must never grow a right.
  it("VIEWER, the self-signup landing role, can do nothing but look", () => {
    const p = ROLE_POLICY.VIEWER;
    const rights = ["canEditWarehouse", "canEditLogistics", "canEditMerch", "canEditReconciliation", "isAdmin"] as const;
    for (const right of rights) {
      expect(p[right]).toBe(false);
      expect(() => assertCan({ role: "VIEWER" }, right)).toThrow(/Forbidden/);
    }
  });

  it("VIEWER sees every facility, read-only — the intended self-signup scope", () => {
    // facilities: [] means ALL (entitledFacilities), which is only safe because
    // the role above cannot write. If that ever changes, this pairing is a hole.
    const viewer = { role: "VIEWER" as Role, facilities: [], allView: true };
    expect(resolveScope(viewer, "ALL")).toBe("ALL");
    expect(resolveScope(viewer, "SAPL-WH2")).toBe("SAPL-WH2");
    expect(() => assertFacility(viewer, "SAPL-WH1")).not.toThrow();
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
    for (const role of [...READ_ONLY, ...EDITORS]) expect(ROLE_POLICY[role].isAdmin).toBe(false);
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
