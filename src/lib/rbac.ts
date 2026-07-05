// RBAC + facility entitlements (PRD §3). Enforced server-side on every read
// and mutation — a client-supplied facility value is never trusted.

import type { Facility, FacilityScope, Role, User } from "./types";
import { FACILITIES } from "./types";

export interface RolePolicy {
  label: string;
  /** Whether the facility switcher is shown at all. */
  canSwitchFacility: boolean;
  /** Whether the "All facilities" union view is offered. */
  allView: boolean;
  /** Mutation rights. */
  canEditWarehouse: boolean;
  canEditLogistics: boolean;
  canEditMerch: boolean; // TYPE / PRIORITY / campaign tag
  canEditReconciliation: boolean;
  isAdmin: boolean;
  readOnly: boolean;
}

export const ROLE_POLICY: Record<Role, RolePolicy> = {
  ADMIN: {
    label: "Admin",
    canSwitchFacility: true,
    allView: true,
    canEditWarehouse: true,
    canEditLogistics: true,
    canEditMerch: true,
    canEditReconciliation: true,
    isAdmin: true,
    readOnly: false,
  },
  MERCHANDISING: {
    label: "Merchandising",
    canSwitchFacility: true,
    allView: true,
    canEditWarehouse: false,
    canEditLogistics: false,
    canEditMerch: true,
    canEditReconciliation: false,
    isAdmin: false,
    readOnly: false,
  },
  WH_SUPERVISOR: {
    label: "Warehouse Supervisor",
    canSwitchFacility: true, // across own WHs only
    allView: false,
    canEditWarehouse: true,
    canEditLogistics: false,
    canEditMerch: false,
    canEditReconciliation: false,
    isAdmin: false,
    readOnly: false,
  },
  WH_OPERATOR: {
    label: "Warehouse Operator",
    canSwitchFacility: false, // locked to one facility
    allView: false,
    canEditWarehouse: true,
    canEditLogistics: false,
    canEditMerch: false,
    canEditReconciliation: false,
    isAdmin: false,
    readOnly: false,
  },
  LOGISTICS: {
    label: "Logistics",
    canSwitchFacility: true,
    allView: true,
    canEditWarehouse: false,
    canEditLogistics: true,
    canEditMerch: false,
    canEditReconciliation: true,
    isAdmin: false,
    readOnly: false,
  },
  RETAIL_HEAD: {
    label: "Retail Head / AM",
    canSwitchFacility: true,
    allView: true,
    canEditWarehouse: false,
    canEditLogistics: false,
    canEditMerch: false,
    canEditReconciliation: false,
    isAdmin: false,
    readOnly: true,
  },
};

export function policyOf(role: Role): RolePolicy {
  return ROLE_POLICY[role];
}

/** Facilities a user may scope to (their entitlement list). */
export function entitledFacilities(user: Pick<User, "role" | "facilities">): Facility[] {
  return user.facilities.length ? user.facilities : [...FACILITIES];
}

/**
 * Resolve the effective facility scope for a request: the client-persisted
 * preference is validated against entitlements and silently downgraded when
 * out of bounds. "ALL" requires the allView entitlement.
 */
export function resolveScope(
  user: Pick<User, "role" | "facilities" | "allView">,
  requested?: string,
): FacilityScope {
  const p = ROLE_POLICY[user.role];
  const entitled = entitledFacilities(user);
  if (requested === "ALL") {
    return p.allView && user.allView ? "ALL" : entitled[0];
  }
  if (requested && (entitled as string[]).includes(requested)) return requested as Facility;
  if (p.allView && user.allView) return "ALL";
  return entitled[0];
}

export function assertCan(user: Pick<User, "role">, right: keyof RolePolicy): void {
  const p = ROLE_POLICY[user.role];
  if (!p[right]) {
    throw new Error(`Forbidden: role ${user.role} lacks ${String(right)}`);
  }
}

export function assertFacility(user: Pick<User, "role" | "facilities">, facility: Facility): void {
  if (!(entitledFacilities(user) as string[]).includes(facility)) {
    throw new Error(`Forbidden: no entitlement for facility ${facility}`);
  }
}
