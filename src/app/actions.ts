"use server";

// All mutations flow through here: assert RBAC + facility entitlement →
// validate against the state machine → mutate the repo (which appends
// OrderEvents) → revalidate. Rulebook stays advisory — never checked here.

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { hash } from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";
import { databaseConfigured, prisma } from "@/lib/db";
import { REQUIRED_CAPTURES } from "@/lib/journey";
import { runAllSyncs, runEshipzSync, runSnowflakeSync, type SyncSource, type SyncSummary } from "@/lib/integrations/sync";
import { assertCan, assertFacility, policyOf, resolveScope } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import { FACILITY_COOKIE, currentUser } from "@/lib/session";
import {
  assertCredentialPolicy,
  assertUserAccessPatch,
  assertUserCreate,
  diffAccess,
  normaliseEmail,
  type UserAccessPatch,
  type UserCreateInput,
} from "@/lib/user-admin";
import type { Order, OrderStatus, ShipmentStatus } from "@/lib/types";

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(e: unknown): ActionResult {
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
}

export async function setFacilityScope(requested: string): Promise<ActionResult> {
  try {
    const user = await currentUser();
    const scope = resolveScope(user, requested); // silently clamps to entitlements
    cookies().set(FACILITY_COOKIE, scope, { path: "/", maxAge: 60 * 60 * 24 * 90 });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The capture keys a given transition may carry — the transition's own prompt
 * list, nothing else.
 *
 * `captures` is typed `Partial<Order>`, and types are erased at runtime, so
 * every key the caller sent used to be written verbatim: a WH_OPERATOR holding
 * one warehouse right could set merch, logistics and reconciliation fields, or
 * `facility`, by naming them here. REQUIRED_CAPTURES is the right boundary
 * because those fields are intrinsic to the move the role is already entitled
 * to make — the warehouse legitimately records DC/LR/vehicle as a consignment
 * leaves, which is why FIELD_RIGHTS is NOT layered on top (it would reject
 * every dispatch, since those five fields are logistics-owned).
 *
 * STATUS_TIMESTAMPS are deliberately absent: transitionStatus writes them from
 * the server clock. Accepting them here would let a caller forge the very
 * anchors the SLA legs are measured from.
 */
function allowedCaptures(to: OrderStatus, captures: Partial<Order>): Partial<Order> {
  const allowed = new Set<string>((REQUIRED_CAPTURES[to] ?? []).map((f) => String(f.field)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(captures)) {
    if (v === undefined) continue;
    if (!allowed.has(k)) throw new Error(`Field ${k} is not captured on this transition`);
    out[k] = v;
  }
  return out as Partial<Order>;
}

export async function advanceOrderStatus(
  soNumber: string,
  to: OrderStatus,
  captures: Partial<Order> = {},
  note?: string,
): Promise<ActionResult> {
  try {
    const user = await currentUser();
    assertCan(user, "canEditWarehouse");
    const order = await repo.getOrder(soNumber);
    if (!order) throw new Error(`Order ${soNumber} not found`);
    assertFacility(user, order.facility);
    await repo.transitionStatus(soNumber, to, { id: user.id, name: user.name }, allowedCaptures(to, captures), note);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setShipmentStatus(
  soNumber: string,
  to: ShipmentStatus,
  note?: string,
): Promise<ActionResult> {
  try {
    const user = await currentUser();
    assertCan(user, "canEditLogistics");
    // The right says "may edit logistics"; it does not say "on any facility".
    // A narrowed entitlement has to bite here as it does on the hand-edit
    // below — an action is callable directly, without the row ever having been
    // rendered on the caller's board.
    const order = await repo.getOrder(soNumber);
    if (!order) throw new Error(`Order ${soNumber} not found`);
    assertFacility(user, order.facility);
    await repo.transitionShipment(soNumber, to, { id: user.id, name: user.name }, "MANUAL", note);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * The Logistics lens's hand-edit. The client sends whatever it likes; the
 * forward-only ladder check, the delivered lock and the set-once pickup are all
 * enforced in the repo — nothing here trusts the caller's idea of what a legal
 * next stage is.
 */
export async function updateShipmentManually(
  soNumber: string,
  input: { to?: ShipmentStatus; pickupDate?: string },
  note?: string,
): Promise<ActionResult> {
  try {
    const user = await currentUser();
    assertCan(user, "canEditLogistics");
    const order = await repo.getOrder(soNumber);
    if (!order) throw new Error(`Order ${soNumber} not found`);
    assertFacility(user, order.facility);
    await repo.manualShipmentUpdate(
      soNumber,
      { to: input.to, pickupDate: input.pickupDate || undefined },
      { id: user.id, name: user.name },
      note,
    );
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function recordNdr(soNumber: string, note?: string): Promise<ActionResult> {
  try {
    const user = await currentUser();
    assertCan(user, "canEditLogistics");
    const order = await repo.getOrder(soNumber);
    if (!order) throw new Error(`Order ${soNumber} not found`);
    assertFacility(user, order.facility);
    await repo.recordNdrAttempt(soNumber, { id: user.id, name: user.name }, note);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Field groups → the RBAC right that unlocks manual override on them. */
const FIELD_RIGHTS: Record<string, "canEditMerch" | "canEditWarehouse" | "canEditLogistics" | "canEditReconciliation"> = {
  type: "canEditMerch",
  priority: "canEditMerch",
  campaignTag: "canEditMerch",

  boxCount: "canEditWarehouse",
  weightKg: "canEditWarehouse",
  pickedQty: "canEditWarehouse",
  fulfilledQty: "canEditWarehouse",
  unfulfillableQty: "canEditWarehouse",
  saleInvoiceNumber: "canEditWarehouse",
  rtsLogicDate: "canEditWarehouse",

  dcNumber: "canEditLogistics",
  lrNumber: "canEditLogistics",
  newLrNo: "canEditLogistics",
  logisticsPartner: "canEditLogistics",
  courierPartner: "canEditLogistics",
  vehicleNumber: "canEditLogistics",
  eWayBill: "canEditLogistics",
  expectedDate: "canEditLogistics",
  podLink: "canEditLogistics",
  logisticsComments: "canEditLogistics",
  trackingLatestMessage: "canEditLogistics",
  lastCheckpointCity: "canEditLogistics",

  orderReceivedDate: "canEditReconciliation",
  boxesReceived: "canEditReconciliation",
  totalCount: "canEditReconciliation",
  inwardedDate: "canEditReconciliation",
  stiBillNo: "canEditReconciliation",
  receivingPv: "canEditReconciliation",
  shortageQty: "canEditReconciliation",
  excessQty: "canEditReconciliation",
  shortageExcessFileUrl: "canEditReconciliation",
  adjustmentOnLogic: "canEditReconciliation",
  entryStatus: "canEditReconciliation",
  receiptStatus: "canEditReconciliation",
};

/** Admin: run the sync pipeline on demand (Admin "Sync now" button). */
export async function runSyncNow(source?: SyncSource): Promise<ActionResult & { summaries?: SyncSummary[] }> {
  try {
    const user = await currentUser();
    if (policyOf(user.role).isAdmin !== true) throw new Error("Admin only");
    let summaries: SyncSummary[];
    if (source === "ESHIPZ") summaries = [await runEshipzSync()];
    else if (source === "SNOWFLAKE") summaries = [await runSnowflakeSync()];
    else summaries = await runAllSyncs();
    revalidatePath("/", "layout");
    return { ok: true, summaries };
  } catch (e) {
    return fail(e);
  }
}

/** Admin: resolve an unmatched channel to a Store (sets Store.channelCode,
 *  clears the review-queue row). The next sync sweep ingests the held orders. */
export async function mapChannelToStore(channel: string, storeId: string): Promise<ActionResult> {
  try {
    const user = await currentUser();
    if (policyOf(user.role).isAdmin !== true) throw new Error("Admin only");
    if (!databaseConfigured()) throw new Error("Channel mapping requires the database");
    if (!channel || !storeId) throw new Error("Channel and store are both required");
    const db = prisma();
    await db.$transaction([
      db.store.update({ where: { id: storeId }, data: { channelCode: channel } }),
      db.unmatchedChannel.deleteMany({ where: { channel } }),
    ]);
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** BCrypt cost, kept in step with scripts/seed-admin.mts so a credential set
 *  from the console and one seeded from the box are equally expensive. */
const BCRYPT_ROUNDS = 12;

type AuditAction = "create" | "update" | "deactivate" | "reactivate" | "cred-reset";

/** Every Admin → Users mutation leaves a row. Written inside the caller's
 *  transaction where there is one, so a mutation can never land without its
 *  trail. `diff` carries changed access fields only — never a credential. */
async function auditUserAccess(
  tx: Prisma.TransactionClient,
  entry: {
    actor: { id: string; email: string };
    target: { id: string; email: string };
    action: AuditAction;
    diff?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.userAccessAudit.create({
    data: {
      actorId: entry.actor.id,
      actorEmail: entry.actor.email,
      targetUserId: entry.target.id,
      targetEmail: entry.target.email,
      action: entry.action,
      // Cast at the boundary: the diff is built from plain scalars, arrays and
      // nulls, which Prisma's structural Json input type cannot infer from a
      // Record signature.
      diff:
        entry.diff && Object.keys(entry.diff).length ? (entry.diff as Prisma.InputJsonObject) : undefined,
    },
  });
}

/** The shared preamble for every user-management action: admin right, a real
 *  database, and the full user list the lockout floor is counted against. */
async function requireUserAdmin() {
  const actor = await currentUser();
  if (policyOf(actor.role).isAdmin !== true) throw new Error("Admin only");
  if (!databaseConfigured()) throw new Error("User management requires the database");
  return { actor, all: await repo.listUsers() };
}

/**
 * The one write path for an access change. updateUserAccess, deactivateUser and
 * reactivateUser all land here, so the lockout rules and the audit row cannot
 * be reached around by adding another entry point later.
 */
async function applyAccessPatch(userId: string, patch: UserAccessPatch, action: AuditAction): Promise<ActionResult> {
  const { actor, all } = await requireUserAdmin();
  const target = all.find((u) => u.id === userId);
  if (!target) throw new Error("User not found");
  assertUserAccessPatch({ actor, target, patch, all });

  const diff = diffAccess(target, patch);
  await prisma().$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        role: patch.role,
        facilities: patch.facilities,
        allView: patch.allView,
        // "" from an emptied text input means "no AM scope", not a user whose
        // scope is the empty string — that would match no store and read as a
        // silent lockout on every board.
        areaManager: patch.areaManager?.trim() || null,
        active: patch.active,
      },
    });
    await auditUserAccess(tx, { actor, target, action, diff });
  });
  // The sidebar, facility switcher and every board read off the session's
  // role, so a revoke has to invalidate the whole layout, not just /admin.
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Admin: set another account's role, facility entitlements and active flag.
 *  Grants and revokes both land here — see lib/user-admin.ts for the lockout
 *  rules, which are enforced server-side because this action is callable
 *  without ever rendering the screen that would have warned about them. */
export async function updateUserAccess(userId: string, patch: UserAccessPatch): Promise<ActionResult> {
  try {
    return await applyAccessPatch(userId, patch, "update");
  } catch (e) {
    return fail(e);
  }
}

/**
 * Admin: provision a new account. This IS the SSO allowlist entry — auth.ts
 * refuses any Google sign-in whose address has no active User row — so an
 * active row created here is what lets someone log in for the first time. No
 * credential is set: that is a separate, deliberate act (setUserCredential).
 */
export async function createUser(input: UserCreateInput): Promise<ActionResult & { id?: string }> {
  try {
    const { actor, all } = await requireUserAdmin();
    assertUserCreate({ input, all });

    const email = normaliseEmail(input.email);
    // areaManager only means anything for RETAIL_HEAD (lib/data.ts reads it for
    // that role alone); storing it on any other role is dead data that would
    // start scoping the day someone's role changed.
    const areaManager = input.role === "RETAIL_HEAD" ? input.areaManager?.trim() || null : null;

    const created = await prisma().$transaction(async (tx) => {
      const row = await tx.user.create({
        data: {
          name: input.name.trim(),
          email,
          role: input.role,
          facilities: input.facilities,
          allView: input.allView,
          areaManager,
          active: input.active,
        },
      });
      await auditUserAccess(tx, {
        actor,
        target: row,
        action: "create",
        // The whole initial grant, not a delta — there is no "before".
        diff: {
          role: row.role,
          facilities: row.facilities,
          allView: row.allView,
          areaManager,
          active: row.active,
        },
      });
      return row;
    });

    revalidatePath("/", "layout");
    return { ok: true, id: created.id };
  } catch (e) {
    return fail(e);
  }
}

/** Admin: revoke access. There is no hard-delete anywhere in this surface —
 *  deactivation is reversible, keeps the audit trail attached to a real row,
 *  and takes effect on the next request (the session callback fails closed on
 *  an inactive user). Subject to the same self / last-active-admin lockouts. */
export async function deactivateUser(userId: string): Promise<ActionResult> {
  try {
    return await setActive(userId, false);
  } catch (e) {
    return fail(e);
  }
}

export async function reactivateUser(userId: string): Promise<ActionResult> {
  try {
    return await setActive(userId, true);
  } catch (e) {
    return fail(e);
  }
}

/** Flip `active` while carrying every other field through unchanged — built
 *  from the stored row, never from client input, so this cannot be used as a
 *  back door to edit a role. */
async function setActive(userId: string, active: boolean): Promise<ActionResult> {
  const target = (await repo.listUsers()).find((u) => u.id === userId);
  if (!target) throw new Error("User not found");
  return applyAccessPatch(
    userId,
    {
      role: target.role,
      facilities: target.facilities,
      allView: target.allView,
      areaManager: target.areaManager,
      active,
    },
    active ? "reactivate" : "deactivate",
  );
}

/**
 * Admin: set or reset the break-glass credential. Only the bcrypt hash is
 * persisted — the plaintext is never returned, never logged, and never enters
 * the domain User type (lib/users.ts keeps the hash out of it deliberately).
 * The audit row records that a reset happened, never what was set.
 */
export async function setUserCredential(userId: string, password: string): Promise<ActionResult> {
  try {
    const { actor, all } = await requireUserAdmin();
    const target = all.find((u) => u.id === userId);
    if (!target) throw new Error("User not found");
    // Length floor is the TARGET's role, not the actor's: the credential
    // protects the target's rights.
    assertCredentialPolicy(target.role, password);

    const passwordHash = await hash(password, BCRYPT_ROUNDS);
    await prisma().$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await auditUserAccess(tx, { actor, target, action: "cred-reset" });
    });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function overrideOrderFields(
  soNumber: string,
  patch: Partial<Order>,
  note?: string,
): Promise<ActionResult> {
  try {
    const user = await currentUser();
    const policy = policyOf(user.role);
    // Read-only roles are refused up front rather than relying on every field
    // happening to have a FIELD_RIGHTS entry — a new editable field must never
    // become writable by a viewer just because its mapping was forgotten.
    if (policy.readOnly) throw new Error("Forbidden: your role is read-only and cannot override order fields");
    // Admins run the same loop as everyone else. Skipping it gave the admin
    // path no column allowlist at all — every right in FIELD_RIGHTS is true for
    // ADMIN anyway, so the loop costs an admin nothing, while the unknown-key
    // rejection stops an override payload naming id/soNumber/facility or any
    // other column that is not a manually editable field.
    for (const field of Object.keys(patch)) {
      const right = FIELD_RIGHTS[field];
      if (!right) throw new Error(`Field ${field} is not manually editable`);
      assertCan(user, right);
    }
    const order = await repo.getOrder(soNumber);
    if (!order) throw new Error(`Order ${soNumber} not found`);
    // Every non-admin, not only the warehouse-editing ones. Gating this on
    // canEditWarehouse let LOGISTICS and MERCHANDISING through with no facility
    // check at all — the two roles whose fields (couriers, LR/DC numbers, POD
    // links, campaign tags) are the most useful to write on someone else's
    // orders. Entitlement is about which orders, not about which fields.
    if (!policy.isAdmin) assertFacility(user, order.facility);
    await repo.updateFields(soNumber, patch, { id: user.id, name: user.name }, "MANUAL", note);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
