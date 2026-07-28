// Guards on the Admin "grant access" screen. The dangerous edits here are the
// ones that remove access rather than add it: with a handful of accounts, one
// careless demotion can leave the console with nobody who can undo it.

import { describe, expect, it } from "vitest";
import { assertUserAccessPatch, type UserAccessPatch } from "./user-admin";
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
