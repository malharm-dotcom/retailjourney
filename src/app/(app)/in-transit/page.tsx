// Live In-Transit Board (PRD §6.2) — the headline screen. Every shipment on
// the road right now: one glance, no follow-ups.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istToday, daysBetween } from "@/lib/ist";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { TONE, type Tone } from "@/lib/ui";
import { TransitBoard, type TransitRow } from "./board";

export const metadata = { title: "In-Transit" };
export const dynamic = "force-dynamic";

/**
 * One figure in the board's summary strip. A 3px tone bar rather than a tinted
 * icon tile: the tile idiom belongs to the Control Tower's cards, and repeating
 * it here is what made the two screens read as the same screen. The bar ties the
 * figure to the rows it counts, which share that colour.
 */
function BoardStat({ tone, label, value, sub }: { tone: Tone; label: string; value: number; sub: string }) {
  return (
    <div className="sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <dt className="flex items-center gap-2 text-cap font-semibold uppercase tracking-[0.04em] text-mute">
        <span aria-hidden className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: TONE[tone].hex }} />
        {label}
      </dt>
      <dd className="mono mt-1 font-display text-[26px] font-bold leading-none">{value}</dd>
      <dd className="mt-1 text-cap text-mute">{sub}</dd>
    </div>
  );
}

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
      // Anchor on dispatch when it exists, else the WH manifest / earliest
      // child pickup — spine orders carry no dispatch date, and falling
      // straight through to order ageing overstated the road time. Only an
      // order with no anchor at all keeps the old order-age behaviour.
      const transitAge = r.anchor.date
        ? Math.max(0, daysBetween(r.anchor.date, o.deliveredDate ?? today))
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
      {/* No status badge here. This screen carried a hardcoded "Seed data ·
          eShipz sync lands in M5" pill — with the app's only infinite animation
          on it — long after the poller went live. Freshness now comes from the
          board's own refresh stamp and the per-source strip in the chrome, both
          of which are real. */}
      <PageHead
        title="In-transit board"
        sub="Every shipment on the road right now — one glance, no follow-ups."
      />

      {/* A summary STRIP, not four cards. This route used to open with the same
          four KPI cards as the Control Tower — identical icons and labels — which
          restated the screen you had just left and pushed the board itself past
          400px of chrome on a phone. The figures are worth keeping; a second
          card grid competing with the board is not. */}
      <dl className="mb-5 grid grid-cols-2 gap-x-5 gap-y-4 rounded-card bg-card px-5 py-4 shadow-card sm:grid-cols-4 sm:gap-x-0 sm:divide-x sm:divide-line">
        <BoardStat tone="pending" label="WH Processing" value={wh.length} sub={whBreaching ? `${whBreaching} breaching today` : "all within SLA"} />
        <BoardStat tone="pending" label="Pickup Pending" value={pickup.length} sub="awaiting courier scan" />
        <BoardStat tone="motion" label="In Transit" value={transit.length} sub={ofd ? `${ofd} out for delivery` : "none out for delivery"} />
        <BoardStat tone="done" label="Delivered Today" value={deliveredToday.length} sub={withinPct != null ? `${withinPct}% within SLA` : "none yet today"} />
      </dl>

      <TransitBoard rows={board} canEdit={canEdit} scopeLabel={scope === "ALL" ? "All" : scope} />
    </>
  );
}
