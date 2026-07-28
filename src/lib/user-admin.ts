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

const ROLES = Object.keys(ROLE_POLICY) as Role[];

export function assertUserAccessPatch(opts: {
  actor: Pick<User, "id" | "role">;
  target: Pick<User, "id" | "role" | "active">;
  patch: UserAccessPatch;
  /** Every user, so the admin floor can be counted. */
  all: Pick<User, "id" | "role" | "active">[];
}): void {
  const { actor, target, patch, all } = opts;

  if (!ROLES.includes(patch.role)) throw new Error(`Unknown role ${patch.role}`);
  for (const f of patch.facilities) {
    if (!(FACILITIES as readonly string[]).includes(f)) throw new Error(`Unknown facility ${f}`);
  }

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
