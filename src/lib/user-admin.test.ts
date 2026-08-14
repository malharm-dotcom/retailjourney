// Guards on the Admin "grant access" screen. The dangerous edits here are the
// ones that remove access rather than add it: with a handful of accounts, one
// careless demotion can leave the console with nobody who can undo it.

import { describe, expect, it } from "vitest";
import {
  assertCredentialPolicy,
  assertUserAccessPatch,
  assertUserCreate,
  diffAccess,
  minCredentialLength,
  type UserAccessPatch,
  type UserCreateInput,
} from "./user-admin";
import type { Facility, Role, User } from "./types";

function u(over: Partial<User> = {}): User {
  return {
    id: "usr_target",
    name: "Target",
    email: "target@snitch.com",
    role: "LOGISTICS" as Role,
    facilities: [],
    allView: false,
    active: true,
    ...over,
  };
}

const ADMIN = u({ id: "usr_admin", email: "admin@snitch.com", role: "ADMIN", allView: true });
const OTHER_ADMIN = u({ id: "usr_admin2", email: "admin2@snitch.com", role: "ADMIN", allView: true });

function patch(over: Partial<UserAccessPatch> = {}): UserAccessPatch {
  return { role: "LOGISTICS" as Role, facilities: [], allView: false, active: true, ...over };
}

function check(target: User, p: UserAccessPatch, all: User[], actor: User = ADMIN) {
  return () => assertUserAccessPatch({ actor, target, patch: p, all });
}

describe("field validation", () => {
  it("rejects a role outside the enum", () => {
    expect(check(u(), patch({ role: "SUPERUSER" as Role }), [ADMIN, u()])).toThrow(/role/i);
  });

  it("rejects a facility outside the known set", () => {
    expect(check(u(), patch({ facilities: ["SAPL-WH9" as Facility] }), [ADMIN, u()])).toThrow(/facility/i);
  });

  it("accepts a valid role and facility list", () => {
    expect(check(u(), patch({ role: "WH_OPERATOR" as Role, facilities: ["SAPL-WH1"] }), [ADMIN, u()])).not.toThrow();
  });
});

describe("self-lockout", () => {
  it("refuses to let an admin drop their own admin role", () => {
    expect(check(ADMIN, patch({ role: "RETAIL_HEAD" as Role, allView: true }), [ADMIN, OTHER_ADMIN])).toThrow(
      /your own/i,
    );
  });

  it("refuses to let an admin deactivate themselves", () => {
    expect(check(ADMIN, patch({ role: "ADMIN" as Role, allView: true, active: false }), [ADMIN, OTHER_ADMIN])).toThrow(
      /your own/i,
    );
  });

  it("allows an admin to edit their own non-role fields", () => {
    expect(
      check(ADMIN, patch({ role: "ADMIN" as Role, allView: true, areaManager: "Sonit Tandon" }), [ADMIN, OTHER_ADMIN]),
    ).not.toThrow();
  });
});

describe("last active admin", () => {
  it("refuses to demote the only remaining active admin", () => {
    // Actor is a *different* admin, so the self-lockout rule does not fire —
    // this is the case that rule alone would miss.
    expect(check(OTHER_ADMIN, patch({ role: "LOGISTICS" as Role }), [ADMIN, OTHER_ADMIN], ADMIN)).not.toThrow();

    const soleAdmin = u({ id: "usr_sole", role: "ADMIN" });
    expect(check(soleAdmin, patch({ role: "LOGISTICS" as Role }), [soleAdmin, u()], ADMIN)).toThrow(/last active admin/i);
  });

  it("refuses to deactivate the only remaining active admin", () => {
    const soleAdmin = u({ id: "usr_sole", role: "ADMIN" });
    expect(check(soleAdmin, patch({ role: "ADMIN" as Role, active: false }), [soleAdmin, u()], ADMIN)).toThrow(
      /last active admin/i,
    );
  });

  it("counts only ACTIVE admins toward the floor", () => {
    // A deactivated admin cannot sign in, so it cannot be the account that
    // rescues you — treating it as a second admin would be a false safety net.
    const dormant = u({ id: "usr_dormant", role: "ADMIN", active: false });
    const soleAdmin = u({ id: "usr_sole", role: "ADMIN" });
    expect(check(soleAdmin, patch({ role: "LOGISTICS" as Role }), [soleAdmin, dormant], ADMIN)).toThrow(
      /last active admin/i,
    );
  });

  it("allows promoting a new admin", () => {
    expect(check(u(), patch({ role: "ADMIN" as Role, allView: true }), [ADMIN, u()])).not.toThrow();
  });
});

// Creating an ACTIVE row is what puts an address on the SSO allowlist —
// auth.ts refuses any Google sign-in without one — so these are the checks
// standing between a typo and a working login.
describe("createUser validation", () => {
  function input(over: Partial<UserCreateInput> = {}): UserCreateInput {
    return {
      name: "New Person",
      email: "new@snitch.com",
      role: "LOGISTICS" as Role,
      facilities: [],
      allView: false,
      active: true,
      ...over,
    };
  }
  const create = (over: Partial<UserCreateInput> = {}, all: Pick<User, "email">[] = [ADMIN]) =>
    () => assertUserCreate({ input: input(over), all });

  it("accepts a well-formed new account", () => {
    expect(create()).not.toThrow();
  });

  it("requires a name", () => {
    expect(create({ name: "   " })).toThrow(/name/i);
  });

  it("refuses an address outside the sign-in domain", () => {
    // SSO enforces the same suffix on the verified claim, so any other domain
    // creates a row no provider will ever authenticate.
    expect(create({ email: "someone@gmail.com" })).toThrow(/snitch\.com/i);
  });

  it("refuses a bare domain with no local part", () => {
    expect(create({ email: "@snitch.com" })).toThrow(/valid email/i);
  });

  it("refuses a duplicate address regardless of case or padding", () => {
    expect(create({ email: "  Admin@Snitch.com " }, [ADMIN])).toThrow(/already has an account/i);
  });

  it("rejects a role outside the enum and a facility outside the known set", () => {
    expect(create({ role: "SUPERUSER" as Role })).toThrow(/role/i);
    expect(create({ facilities: ["SAPL-WH9" as Facility] })).toThrow(/facility/i);
  });

  // The finding that drove this rule: entitledFacilities() reads [] as the
  // FULL set, so an empty list on a floor role grants every facility.
  it("refuses an empty facility list for the facility-scoped roles", () => {
    expect(create({ role: "WH_OPERATOR" as Role, facilities: [] })).toThrow(/at least one facility/i);
    expect(create({ role: "WH_SUPERVISOR" as Role, facilities: [] })).toThrow(/at least one facility/i);
    expect(create({ role: "WH_OPERATOR" as Role, facilities: ["SAPL-WH1"] })).not.toThrow();
  });

  it("still allows an empty list for roles whose scope really is everything", () => {
    expect(create({ role: "LOGISTICS" as Role, facilities: [] })).not.toThrow();
    expect(create({ role: "ADMIN" as Role, facilities: [], allView: true })).not.toThrow();
  });

  it("requires an AM scope for RETAIL_HEAD only", () => {
    expect(create({ role: "RETAIL_HEAD" as Role })).toThrow(/AM scope/i);
    expect(create({ role: "RETAIL_HEAD" as Role, areaManager: "Sonit Tandon" })).not.toThrow();
    // Other roles never read areaManager (lib/data.ts gates on RETAIL_HEAD).
    expect(create({ role: "LOGISTICS" as Role, areaManager: undefined })).not.toThrow();
  });
});

describe("credential policy", () => {
  it("floors ordinary accounts at 12 characters", () => {
    expect(minCredentialLength("LOGISTICS" as Role)).toBe(12);
    expect(() => assertCredentialPolicy("LOGISTICS" as Role, "x".repeat(11))).toThrow(/12/);
    expect(() => assertCredentialPolicy("LOGISTICS" as Role, "x".repeat(12))).not.toThrow();
  });

  it("floors ADMIN at 16 — that account's blast radius is every other account", () => {
    expect(minCredentialLength("ADMIN" as Role)).toBe(16);
    expect(() => assertCredentialPolicy("ADMIN" as Role, "x".repeat(15))).toThrow(/16/);
    expect(() => assertCredentialPolicy("ADMIN" as Role, "x".repeat(16))).not.toThrow();
  });

  it("does not let a 12-char password through on an admin row", () => {
    // The floor keys on the TARGET's role, so this is the case that matters.
    expect(() => assertCredentialPolicy("ADMIN" as Role, "x".repeat(12))).toThrow(/admin credential/i);
  });
});

describe("audit diff", () => {
  it("records only what changed, as from/to", () => {
    const before = u({ role: "WH_OPERATOR" as Role, facilities: ["SAPL-WH1"], active: true });
    const d = diffAccess(before, patch({ role: "WH_SUPERVISOR" as Role, facilities: ["SAPL-WH1"], active: true }));
    expect(d).toEqual({ role: { from: "WH_OPERATOR", to: "WH_SUPERVISOR" } });
  });

  it("is empty for a no-op save", () => {
    const before = u({ role: "LOGISTICS" as Role, facilities: [], allView: false, active: true });
    expect(diffAccess(before, patch())).toEqual({});
  });

  it("ignores facility reordering but catches membership changes", () => {
    const before = u({ facilities: ["SAPL-WH1", "SAPL-WH2"] });
    expect(diffAccess(before, patch({ facilities: ["SAPL-WH2", "SAPL-WH1"] }))).toEqual({});
    expect(diffAccess(before, patch({ facilities: ["SAPL-WH1"] }))).toHaveProperty("facilities");
  });

  it("treats a blanked AM scope as null, not as the empty string", () => {
    const before = u({ areaManager: "Sasmit" });
    expect(diffAccess(before, patch({ areaManager: "  " }))).toEqual({
      areaManager: { from: "Sasmit", to: null },
    });
  });

  it("records deactivation", () => {
    expect(diffAccess(u({ active: true }), patch({ active: false }))).toHaveProperty("active");
  });
});
