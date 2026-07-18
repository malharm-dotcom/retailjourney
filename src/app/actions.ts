"use server";

// All mutations flow through here: assert RBAC + facility entitlement →
// validate against the state machine → mutate the repo (which appends
// OrderEvents) → revalidate. Rulebook stays advisory — never checked here.

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { databaseConfigured, prisma } from "@/lib/db";
import { runAllSyncs, runEshipzSync, runSnowflakeSync, type SyncSource, type SyncSummary } from "@/lib/integrations/sync";
import { assertCan, assertFacility, policyOf, resolveScope } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import { FACILITY_COOKIE, currentUser } from "@/lib/session";
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
    await repo.transitionStatus(soNumber, to, { id: user.id, name: user.name }, captures, note);
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
    await repo.transitionShipment(soNumber, to, { id: user.id, name: user.name }, "MANUAL", note);
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

export async function overrideOrderFields(
  soNumber: string,
  patch: Partial<Order>,
  note?: string,
): Promise<ActionResult> {
  try {
    const user = await currentUser();
    const policy = policyOf(user.role);
    if (!policy.isAdmin) {
      for (const field of Object.keys(patch)) {
        const right = FIELD_RIGHTS[field];
        if (!right) throw new Error(`Field ${field} is not manually editable`);
        assertCan(user, right);
      }
    }
    const order = await repo.getOrder(soNumber);
    if (!order) throw new Error(`Order ${soNumber} not found`);
    if (policy.canEditWarehouse && !policy.isAdmin) assertFacility(user, order.facility);
    await repo.updateFields(soNumber, patch, { id: user.id, name: user.name }, "MANUAL", note);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
