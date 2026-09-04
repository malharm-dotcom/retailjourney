// Logistics Queue (PRD §6.4) — everything at DISPATCHED_TO_STORE and beyond:
// courier/LR/DC assignment, shipment transitions, NDR attempts, delivery + POD.
//
// Shaped like the logistics team's own spreadsheet tracker: one row per
// dispatch, dispatch-date led, their column names. Curated, not replicated —
// the tracker's ~30 columns would rebuild exactly the wall the Warehouse
// redesign removed, so the columns the team ACTS on are the grid and the rest
// live on row-expand and in the order-level CSV on the Reports desk.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istDateOf, istToday, daysBetween, weekdayOf } from "@/lib/ist";
import { courierOf, isSelfDelivery } from "@/lib/journey";
import type { AnchorSource } from "@/lib/transit-anchor";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { SLA_LABEL } from "@/lib/sla";
import { LogisticsTable, type LogisticsRow } from "./table";
import { perRulebook, tatStatusOf } from "./tat";

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
      // The internal promise is the primary EDD. `idealDeliveryDate` is the
      // rulebook-derived date (93% of dispatched orders), with the spine's own
      // delivery target already behind it for out-of-rulebook orders. The
      // courier's EDD — `expectedDate`, present on 59% — is on row-expand.
      const edd = o.idealDeliveryDate;
      // This queue fixed the NULL-logisticsPartner problem locally; the same
      // fix now lives in journey.ts and every screen reads it from there.
      const courier = courierOf(o);
      const delivery = r.sla.legs.find((l) => l.leg === "DELIVERY")?.state;
      const logisticsDelivery = r.sla.legs.find((l) => l.leg === "LOGISTICS_DELIVERY")?.state;
      return {
        so: o.soNumber,
        dispatch: r.anchor.date,
        invoice: o.saleInvoiceNumber,
        type: o.type,
        store: o.storeNameFormat,
        facility: o.facility,
        zone: o.zone,
        lane: o.laneClassification,
        courier,
        self: isSelfDelivery(o),
        awb: r.awb ?? o.trackingNumber,
        awbCount: r.awbCount,
        pickup,
        sincePickup: pickup ? Math.max(0, daysBetween(pickup, o.deliveredDate ?? today)) : undefined,
        edd,
        eddDay: edd ? weekdayOf(edd) : undefined,
        courierEdd: o.expectedDate,
        courierEddDay: o.expectedDate ? weekdayOf(o.expectedDate) : undefined,
        shipment: o.shipmentStatus,
        source: o.shipmentSource ?? o.statusSource,
        delivered: o.deliveredDate,
        tat: tatStatusOf(edd, o.deliveredDate, today),
        perRulebook: perRulebook(o.targetHandoverDay, pickup),
        rulebookDay: o.targetHandoverDay,
        // The SLA engine's own verdicts, verbatim, and named for the legs they
        // come from (LEG_LABEL) rather than relabelled — one verdict per EDD:
        // DELIVERY measures against our own target, LOGISTICS_DELIVERY against
        // the courier's.
        storeDeliverySla: delivery ? SLA_LABEL[delivery] : undefined,
        logisticsDeliverySla: logisticsDelivery ? SLA_LABEL[logisticsDelivery] : undefined,
        dc: o.dcNumber,
        lr: o.lrNumber,
        vehicle: o.vehicleNumber,
        eway: o.eWayBill,
        boxes: r.boxes,
        qty: o.qty,
        city: o.receiverCity ?? o.lastCheckpointCity,
        attempts: o.deliveryAttempts,
        pod: o.podLink,
        trackingLink: o.trackingLink,
        msg: o.trackingLatestMessage,
        breaching: r.breaching,
      };
    })
    // Newest dispatch first — the tracker's own order. Undated dispatches (no
    // anchor at all: a genuine spine gap) sort last rather than to the top.
    .sort((a, b) => (b.dispatch ?? "").localeCompare(a.dispatch ?? "") || a.so.localeCompare(b.so));

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
