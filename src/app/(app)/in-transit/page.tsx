// Live In-Transit Board (PRD §6.2) — the headline screen. Every shipment on
// the road right now: one glance, no follow-ups.

import { PageHead } from "@/components/shell/page-head";
import { KpiCard } from "@/components/ui/kpi";
import { scopedOrders } from "@/lib/data";
import { istToday, daysBetween } from "@/lib/ist";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { TransitBoard, type TransitRow } from "./board";

export const metadata = { title: "In-Transit" };
export const dynamic = "force-dynamic";

export default async function InTransitPage() {
  const { user, scope } = await requireSession();
  const rows = await scopedOrders(scope, user);
  const today = istToday();
  const canEdit = policyOf(user.role).canEditLogistics || policyOf(user.role).isAdmin;

  const wh = rows.filter((r) => r.order.overallStatus === "WH_PROCESSING" && !["CANCELLED", "UNFULFILLABLE"].includes(r.order.status));
  const whBreaching = wh.filter((r) => r.breaching).length;
  const pickup = rows.filter((r) => r.order.overallStatus === "PICKUP_PENDING");
  const transit = rows.filter((r) => r.order.overallStatus === "IN_TRANSIT");
  const ofd = transit.filter((r) => r.order.shipmentStatus === "OUT_FOR_DELIVERY").length;
  const deliveredToday = rows.filter((r) => r.order.deliveredDate === today);
  const withinPct = deliveredToday.length
    ? Math.round(
        (deliveredToday.filter((r) => r.sla.legs.find((l) => l.leg === "DELIVERY")?.state !== "BREACHED").length /
          deliveredToday.length) *
          100,
      )
    : null;

  // Board rows: everything dispatched-not-delivered, plus recent deliveries.
  const board: TransitRow[] = rows
    .filter(
      (r) =>
        r.order.overallStatus === "PICKUP_PENDING" ||
        r.order.overallStatus === "IN_TRANSIT" ||
        (r.order.overallStatus === "DELIVERED" &&
          r.order.deliveredDate &&
          daysBetween(r.order.deliveredDate, today) <= 2),
    )
    .map((r) => {
      const o = r.order;
      const transitAge = o.dispatchedDate
        ? daysBetween(o.dispatchedDate, o.deliveredDate ?? today)
        : r.sla.ageing;
      return {
        so: o.soNumber,
        store: o.storeNameFormat,
        zone: o.zone,
        lane: o.laneClassification ?? r.rule?.laneClassification,
        type: o.type,
        qty: o.qty,
        lr: o.lrNumber,
        courier: o.logisticsPartner,
        self: o.logisticsPartner === "SELF",
        overall: o.overallStatus,
        shipment: o.shipmentStatus,
        source: o.shipmentSource ?? (o.overallStatus === "PICKUP_PENDING" ? o.statusSource : undefined),
        msg: o.trackingLatestMessage,
        city: o.lastCheckpointCity,
        ageing: transitAge,
        breaching: r.breaching,
        am: o.areaManager,
        expected: o.expectedDate,
        trackingLink: o.trackingLink,
        attempts: o.deliveryAttempts,
      };
    });

  return (
    <>
      <PageHead
        title="In-transit board"
        sub="Every shipment on the road right now — one glance, no follow-ups."
        right={
          <div className="flex items-center gap-2 rounded-[11px] bg-card px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft shadow-card">
            <span className="h-2 w-2 animate-pulse2 rounded-full bg-deliv" />
            Seed data · eShipz sync lands in M5
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard
          icon="box-bold-duotone"
          iconClass="bg-pending-bg text-ink-soft"
          label="WH Processing"
          value={wh.length}
          sub={whBreaching ? `${whBreaching} breaching today` : "all within SLA"}
        />
        <KpiCard
          icon="hand-money-bold-duotone"
          iconClass="bg-sage-soft text-sage"
          label="Pickup Pending"
          value={pickup.length}
          sub="awaiting courier scan"
        />
        <KpiCard
          icon="delivery-bold-duotone"
          iconClass="bg-transit-bg text-transit"
          label="In Transit"
          value={transit.length}
          sub={ofd ? `${ofd} out for delivery` : "none out for delivery"}
        />
        <KpiCard
          icon="check-circle-bold-duotone"
          iconClass="bg-deliv-bg text-deliv"
          label="Delivered Today"
          value={deliveredToday.length}
          sub={withinPct != null ? `${withinPct}% within SLA` : "none yet today"}
        />
      </div>

      <TransitBoard rows={board} canEdit={canEdit} scopeLabel={scope === "ALL" ? "All" : scope} />
    </>
  );
}
