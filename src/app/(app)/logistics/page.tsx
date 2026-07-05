// Logistics Queue (PRD §6.4) — everything at DISPATCHED_TO_STORE and beyond:
// courier/LR/DC assignment, shipment transitions, NDR attempts, delivery + POD.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istToday, daysBetween } from "@/lib/ist";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { LogisticsTable, type LogisticsRow } from "./table";

export const metadata = { title: "Logistics" };
export const dynamic = "force-dynamic";

export default async function LogisticsPage() {
  const { user, scope } = await requireSession();
  const rows = scopedOrders(scope, user);
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
        dispatched: o.dispatchedDate,
        expected: o.expectedDate,
        delivered: o.deliveredDate,
        shipment: o.shipmentStatus,
        source: o.shipmentSource ?? o.statusSource,
        attempts: o.deliveryAttempts,
        pod: o.podLink,
        msg: o.trackingLatestMessage,
        breaching: r.breaching,
        ageing: o.dispatchedDate ? daysBetween(o.dispatchedDate, o.deliveredDate ?? today) : 0,
      };
    })
    .sort((a, b) => Number(!!a.delivered) - Number(!!b.delivered) || b.ageing - a.ageing);

  const selfCount = table.filter((t) => t.self && !t.delivered).length;

  return (
    <>
      <PageHead
        title="Logistics queue"
        sub={`Dispatch handoffs and live shipments.${selfCount ? ` ${selfCount} self-delivery shipments have no eShipz feed — keep them updated manually.` : ""}${canEdit ? "" : " You have read-only access."}`}
      />
      <LogisticsTable rows={table} canEdit={canEdit} />
    </>
  );
}
