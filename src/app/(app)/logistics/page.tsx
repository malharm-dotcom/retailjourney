// Logistics Queue (PRD §6.4) — everything at DISPATCHED_TO_STORE and beyond:
// courier/LR/DC assignment, shipment transitions, NDR attempts, delivery + POD.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istDateOf, istToday, daysBetween } from "@/lib/ist";
import type { AnchorSource } from "@/lib/transit-anchor";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { LogisticsTable, type LogisticsRow } from "./table";

export const metadata = { title: "Logistics" };
export const dynamic = "force-dynamic";

/** The order's pickup date, or undefined when nothing has actually been
 *  collected yet. Order-grain `shippedTs` first (it is what a manual pickup
 *  edit writes, and what the courier-pickup SLA leg reads), then the transit
 *  anchor — but ONLY when the anchor is itself a pickup. A MANIFESTED or
 *  DISPATCHED anchor is a warehouse event, not a collection, and must not be
 *  shown in a column headed "Picked up". */
function pickupDateOf(
  o: { shippedTs?: string },
  anchor: { date?: string; source?: AnchorSource },
): string | undefined {
  if (o.shippedTs) return istDateOf(o.shippedTs);
  if (anchor.source === "PICKED_UP" || anchor.source === "TRACKING_PICK") return anchor.date;
  return undefined;
}

export default async function LogisticsPage() {
  const { user, scope } = await requireSession();
  const rows = await scopedOrders(scope, user);
  const today = istToday();
  const policy = policyOf(user.role);
  const canEdit = policy.canEditLogistics || policy.isAdmin;

  const table: LogisticsRow[] = rows
    .filter((r) => r.order.status === "DISPATCHED_TO_STORE")
    .filter(
      (r) =>
        r.order.overallStatus !== "DELIVERED" ||
        (r.order.deliveredDate && daysBetween(r.order.deliveredDate, today) <= 7),
    )
    .map((r) => {
      const o = r.order;
      const pickup = pickupDateOf(o, r.anchor);
      return {
        so: o.soNumber,
        store: o.storeNameFormat,
        facility: o.facility,
        zone: o.zone,
        dc: o.dcNumber,
        lr: o.lrNumber,
        courier: o.logisticsPartner,
        self: o.logisticsPartner === "SELF",
        vehicle: o.vehicleNumber,
        eway: o.eWayBill,
        // Replaces the old DISPATCHED column. dispatchedDate is null on every
        // live order (the spine has no dispatch column), so that column read
        // "—" in every row and carried a "Nd since manifest" sub-line that
        // measured from a warehouse event the SLA fix already stopped
        // trusting. Pickup is the honest anchor and the actionable number.
        pickup,
        // Days since collection — the staleness signal. Undefined when nothing
        // has been picked up yet: that is "not picked up", not "0 days", and
        // the two must not render the same.
        sincePickup: pickup ? Math.max(0, daysBetween(pickup, o.deliveredDate ?? today)) : undefined,
        expected: o.expectedDate,
        delivered: o.deliveredDate,
        shipment: o.shipmentStatus,
        source: o.shipmentSource ?? o.statusSource,
        attempts: o.deliveryAttempts,
        pod: o.podLink,
        msg: o.trackingLatestMessage,
        breaching: r.breaching,
      };
    })
    // Live before delivered; then never-collected first (they are the ones
    // needing a courier chased), then oldest pickup first.
    .sort(
      (a, b) =>
        Number(!!a.delivered) - Number(!!b.delivered) ||
        Number(a.sincePickup !== undefined) - Number(b.sincePickup !== undefined) ||
        (b.sincePickup ?? 0) - (a.sincePickup ?? 0),
    );

  const selfCount = table.filter((t) => t.self && !t.delivered).length;

  return (
    <>
      <PageHead
        title="Logistics queue"
        // The action lens: courier, paperwork, attempts, proof. Where In-Transit
        // says where a shipment is, this one is where you do something about it.
        sub={`Courier, paperwork and proof — the shipments that need something done to them.${selfCount ? ` ${selfCount} self-delivery shipments have no eShipz feed, so their status only moves when you move it.` : ""}${canEdit ? "" : " You have read-only access."}`}
      />
      <LogisticsTable rows={table} canEdit={canEdit} />
    </>
  );
}
