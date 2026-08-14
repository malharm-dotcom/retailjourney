// Validation for Admin → Users & entitlements edits. Kept out of actions.ts and
// out of rbac.ts: rbac.ts answers "what may this role do", which the guards and
// read precedence depend on, and nothing here should be able to perturb that.
//
// The two rules that matter are lockout rules. Accounts are few and there is no
// self-signup, so an admin who demotes the wrong row has no in-app way back —
// recovery means shelling into the box and running scripts/seed-admin.mts.

import { ROLE_POLICY } from "./rbac";
import { FACILITIES } from "./types";
import type { Facility, Role, User } from "./types";

export interface UserAccessPatch {
  role: Role;
  facilities: Facility[];
  allView: boolean;
  areaManager?: string;
  active: boolean;
}

export interface UserCreateInput extends UserAccessPatch {
  name: string;
  email: string;
}

const ROLES = Object.keys(ROLE_POLICY) as Role[];

/** The only address space that can ever sign in — Google SSO enforces the same
 *  suffix on the verified claim (auth.ts), so provisioning anything else
 *  creates a row that no provider will ever authenticate. */
const EMAIL_DOMAIN = "@snitch.com";

/**
 * Roles whose entire purpose is being pinned to specific warehouses. An empty
 * facilities list does NOT mean "no access" — entitledFacilities() reads it as
 * the full set — so accepting [] here would provision a floor operator onto
 * every facility, which is the exact opposite of what the admin just tried to
 * do. The broad roles keep [] because all-facilities is their intended scope.
 */
const FACILITY_SCOPED_ROLES: Role[] = ["WH_OPERATOR", "WH_SUPERVISOR"];

/** Minimum credential length. Longer for ADMIN: the blast radius of that one
 *  account is every other account, and a break-glass credential is registered
 *  in production, so it is the one password worth making unwieldy. */
export function minCredentialLength(role: Role): number {
  return role === "ADMIN" ? 16 : 12;
}

export function assertCredentialPolicy(role: Role, password: string): void {
  const min = minCredentialLength(role);
  if (password.length < min) {
    throw new Error(
      role === "ADMIN"
        ? `An admin credential needs at least ${min} characters.`
        : `Use at least ${min} characters.`,
    );
  }
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Validation for a brand-new account. Creating an ACTIVE row is what puts an
 * address on the SSO allowlist (auth.ts signIn refuses anyone without one), so
 * this is an access grant and is validated like one.
 */
export function assertUserCreate(opts: {
  input: UserCreateInput;
  /** Every existing user, for the uniqueness check. */
  all: Pick<User, "email">[];
}): void {
  const { input, all } = opts;
  const email = normaliseEmail(input.email);

  if (!input.name.trim()) throw new Error("A name is required.");
  if (!email.endsWith(EMAIL_DOMAIN)) throw new Error(`Email must be a ${EMAIL_DOMAIN} address.`);
  // Guard the local part too: "@snitch.com" alone clears the suffix check.
  if (email.length <= EMAIL_DOMAIN.length) throw new Error("A valid email is required.");
  if (all.some((u) => normaliseEmail(u.email) === email)) {
    throw new Error(`${email} already has an account — edit that row instead.`);
  }

  assertRoleAndFacilities(input.role, input.facilities);

  if (FACILITY_SCOPED_ROLES.includes(input.role) && input.facilities.length === 0) {
    throw new Error(
      `${ROLE_POLICY[input.role].label} needs at least one facility — an empty list grants all of them.`,
    );
  }
  if (input.role === "RETAIL_HEAD" && !input.areaManager?.trim()) {
    throw new Error("A Retail Head / AM needs an AM scope — without one they see every store.");
  }
}

function assertRoleAndFacilities(role: Role, facilities: Facility[]): void {
  if (!ROLES.includes(role)) throw new Error(`Unknown role ${role}`);
  for (const f of facilities) {
    if (!(FACILITIES as readonly string[]).includes(f)) throw new Error(`Unknown facility ${f}`);
  }
}

/** The audit `diff`: changed access fields only, as { field: { from, to } }.
 *  Credential values never reach this function — a reset is recorded by its
 *  action name alone. */
export function diffAccess(
  before: Pick<User, "role" | "facilities" | "allView" | "areaManager" | "active">,
  after: UserAccessPatch,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const put = (k: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) out[k] = { from: from ?? null, to: to ?? null };
  };
  put("role", before.role, after.role);
  put("facilities", [...before.facilities].sort(), [...after.facilities].sort());
  put("allView", before.allView, after.allView);
  put("areaManager", before.areaManager, after.areaManager?.trim() || null);
  put("active", before.active, after.active);
  return out;
}

export function assertUserAccessPatch(opts: {
  actor: Pick<User, "id" | "role">;
  target: Pick<User, "id" | "role" | "active">;
  patch: UserAccessPatch;
  /** Every user, so the admin floor can be counted. */
  all: Pick<User, "id" | "role" | "active">[];
}): void {
  const { actor, target, patch, all } = opts;

  assertRoleAndFacilities(patch.role, patch.facilities);

  const losesAdmin = target.role === "ADMIN" && (patch.role !== "ADMIN" || !patch.active);

  // Editing your own row is fine — dropping your own admin rights is not, and
  // a confirm dialog is the wrong place to enforce it (the action is callable
  // directly, and a client cannot be trusted to have shown one).
  if (actor.id === target.id && losesAdmin) {
    throw new Error("You cannot remove your own admin access — ask another admin to do it.");
  }

  if (losesAdmin) {
    // Only active admins count: a deactivated one cannot sign in to undo this,
    // so treating it as cover would be a false safety net.
    const remaining = all.filter((u) => u.role === "ADMIN" && u.active && u.id !== target.id).length;
    if (remaining === 0) {
      throw new Error("This is the last active admin — promote another admin first.");
    }
  }
}
