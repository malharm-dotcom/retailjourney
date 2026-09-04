// Report builders (PRD §10) — pure functions over the scoped, SLA-computed
// order rows. Each returns a serializable table the client can render + export.

import type { OrderRow } from "./data";
import { daysBetween, istToday, weekdayOf } from "./ist";
import { LEG_LABEL, SLA_LABEL, ageingBucket, type SlaLeg, type SlaState } from "./sla";
import { OVERALL_LABEL, STATUS_LABEL, courierOf } from "./journey";
import type { AnchorSource } from "./transit-anchor";

/**
 * Age/throughput reports measure from `OrderRow.anchor`, not `dispatchedDate`.
 * The spine carries no dispatch column, so dispatchedDate is null on every
 * spine-sourced order — these reports were returning zeroed ages (ageing),
 * "—" (courier TAT) or nothing at all (WH throughput). The anchor resolves
 * dispatch → WH manifest → earliest child pickup, order-level, identical to
 * the boards.
 *
 * Every such report NAMES its anchor in the output: a manifest-anchored age is
 * never presented as time since dispatch. Wording matches the logistics
 * table's age sub-line. (Duplicated rather than shared because that map lives
 * in a "use client" component and this module is pure/server-side.)
 */
const ANCHOR_LABEL: Record<AnchorSource, string> = {
  DISPATCHED: "dispatch",
  MANIFESTED: "manifest",
  PICKED_UP: "pickup",
  TRACKING_PICK: "pickup",
};

export interface ReportDef {
  slug: string;
  title: string;
  description: string;
  icon: string;
}

export interface ReportTableData {
  columns: string[];
  rows: (string | number)[][];
  /** Column index whose value is an SO number → linked to the journey view. */
  linkCol?: number;
}

export const REPORTS: ReportDef[] = [
  {
    slug: "order-lookup",
    title: "Order lookup / journey",
    description: "Any SO, DC or LR → the full record and a jump to its timeline.",
    icon: "magnifer-zoom-in-bold-duotone",
  },
  {
    slug: "sla-adherence",
    title: "SLA adherence per leg",
    description: "Within / future / breached / breached-pending split for every leg.",
    icon: "stopwatch-bold-duotone",
  },
  {
    slug: "ageing",
    title: "Live in-transit ageing",
    description:
      "Open shipments bucketed by days out, anchored on dispatch where known, else the WH manifest.",
    icon: "hourglass-bold-duotone",
  },
  {
    // Served by its own route (reports/logistics-followup/page.tsx), which
    // shadows [slug] — it needs column-mode and EDD-source controls the generic
    // report shell has no place for, so `buildReport` has no case for it.
    slug: "logistics-followup",
    title: "Logistics follow-up pivot",
    description:
      "In-transit AWBs as Store × EDD or Store × days-past-EDD, with totals — the file couriers get chased with.",
    icon: "clipboard-list-bold-duotone",
  },
  {
    slug: "courier-scorecard",
    title: "Courier scorecard",
    description:
      "On-time %, days to deliver from the WH-out anchor, attempts and NDRs per logistics partner.",
    icon: "delivery-bold-duotone",
  },
  {
    slug: "shortage-excess",
    title: "Shortage / excess reconciliation",
    description: "Open vs closed recon entries with quantities and Logic adjustment.",
    icon: "clipboard-remove-bold-duotone",
  },
  {
    slug: "wh-throughput",
    title: "WH throughput",
    description:
      "Orders, pieces and boxes leaving each facility per day (dispatch date, else the WH manifest).",
    icon: "box-bold-duotone",
  },
  {
    slug: "rulebook-adherence",
    title: "Rulebook adherence",
    description: "Actual leg weekday vs the rulebook's target day, per store.",
    icon: "calendar-mark-bold-duotone",
  },
  {
    slug: "store-slice",
    title: "Store / AM / merchandiser slice",
    description: "Self-serve rollup for leadership — orders, breaches, open recon.",
    icon: "shop-bold-duotone",
  },
];

export function reportBySlug(slug: string): ReportDef | undefined {
  return REPORTS.find((r) => r.slug === slug);
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

export function buildReport(slug: string, rows: OrderRow[], q?: string): ReportTableData {
  const today = istToday();

  switch (slug) {
    case "order-lookup": {
      const needle = (q ?? "").trim().toLowerCase();
      const hits = needle
        ? rows.filter((r) =>
            [r.order.soNumber, r.order.dcNumber, r.order.lrNumber, r.order.finalStore]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(needle)),
          )
        : rows.slice(0, 50);
      return {
        columns: ["SO", "Store", "DC", "LR", "WH status", "Overall", "Ordered", "Delivered"],
        linkCol: 0,
        rows: hits.map((r) => [
          r.order.soNumber,
          r.order.storeNameFormat,
          r.order.dcNumber ?? "—",
          r.order.lrNumber ?? "—",
          STATUS_LABEL[r.order.status],
          OVERALL_LABEL[r.order.overallStatus],
          r.order.orderDate,
          r.order.deliveredDate ?? "—",
        ]),
      };
    }

    case "sla-adherence": {
      const legs: SlaLeg[] = ["PLACEMENT", "HANDOVER", "PICKUP", "DELIVERY", "LOGISTICS_DELIVERY", "PERFECT_ORDER"];
      const states: SlaState[] = ["WITHIN_SLA", "FUTURE_SLA", "BREACHED", "BREACHED_PENDING"];
      return {
        columns: ["Leg", ...states.map((s) => SLA_LABEL[s]), "Applicable", "Within %"],
        rows: legs.map((leg) => {
          const verdicts = rows
            .map((r) => (leg === "PERFECT_ORDER" ? r.sla.perfectOrder : r.sla.legs.find((l) => l.leg === leg)?.state))
            .filter((s): s is SlaState => s != null);
          const count = (s: SlaState) => verdicts.filter((v) => v === s).length;
          return [
            LEG_LABEL[leg],
            ...states.map(count),
            verdicts.length,
            pct(count("WITHIN_SLA"), verdicts.length),
          ];
        }),
      };
    }

    case "ageing": {
      const open = rows.filter((r) => ["PICKUP_PENDING", "IN_TRANSIT"].includes(r.order.overallStatus));
      return {
        columns: ["SO", "Store", "Courier", "LR", "Anchored on", "Anchor", "Days out", "Bucket", "Breaching"],
        linkCol: 0,
        rows: open
          .map((r) => ({
            r,
            // undefined, not 0 — an order with no anchor at all is a data gap,
            // not a shipment that left today.
            days: r.anchor.date ? Math.max(0, daysBetween(r.anchor.date, today)) : undefined,
          }))
          // Oldest first; anchorless rows sort to the bottom rather than
          // masquerading as freshly-dispatched.
          .sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
          .map(({ r, days }) => [
            r.order.soNumber,
            r.order.storeNameFormat,
            courierOf(r.order),
            r.order.lrNumber ?? "—",
            r.anchor.date ?? "—",
            r.anchor.source ? ANCHOR_LABEL[r.anchor.source] : "—",
            days ?? "—",
            days === undefined ? "—" : ageingBucket(days),
            r.breaching ? "YES" : "—",
          ]),
      };
    }

    case "courier-scorecard": {
      const partners = new Map<string, OrderRow[]>();
      for (const r of rows) {
        // Was `if (!r.order.logisticsPartner) continue`, which skipped EVERY
        // order — that field is NULL on all of them — so this scorecard
        // rendered zero rows in production. Group on the resolved carrier and
        // drop only the orders that genuinely have none.
        const partner = courierOf(r.order);
        if (partner === "—") continue;
        const list = partners.get(partner) ?? [];
        list.push(r);
        partners.set(partner, list);
      }
      return {
        // "Avg days to deliver" rather than "Avg transit days": for a
        // manifest-anchored order this spans the WH→pickup dwell as well as
        // the road time, so calling it transit would overstate the courier.
        columns: ["Partner", "Shipments", "Delivered", "On-time %", "Avg days to deliver", "NDR shipments", "Open"],
        rows: [...partners.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([partner, list]) => {
            const delivered = list.filter((r) => r.order.deliveredDate);
            const onTime = delivered.filter(
              (r) => r.sla.legs.find((l) => l.leg === "LOGISTICS_DELIVERY")?.state === "WITHIN_SLA",
            );
            const tats = delivered
              .filter((r) => r.anchor.date)
              .map((r) => Math.max(0, daysBetween(r.anchor.date!, r.order.deliveredDate!)));
            return [
              partner,
              list.length,
              delivered.length,
              pct(onTime.length, delivered.length),
              tats.length ? (tats.reduce((a, b) => a + b, 0) / tats.length).toFixed(1) : "—",
              list.filter((r) => r.order.deliveryAttempts > 1).length,
              list.filter((r) => !r.order.deliveredDate).length,
            ];
          }),
      };
    }

    case "shortage-excess": {
      const recon = rows.filter((r) => (r.order.shortageQty ?? 0) > 0 || (r.order.excessQty ?? 0) > 0);
      return {
        columns: ["SO", "Store", "STI bill", "Short", "Excess", "Logic adj.", "Entry", "File"],
        linkCol: 0,
        rows: recon.map((r) => [
          r.order.soNumber,
          r.order.storeNameFormat,
          r.order.stiBillNo ?? "—",
          r.order.shortageQty ?? 0,
          r.order.excessQty ?? 0,
          r.order.adjustmentOnLogic == null ? "—" : r.order.adjustmentOnLogic ? "done" : "pending",
          r.order.entryStatus ?? "OPEN",
          r.order.shortageExcessFileUrl ? "linked" : "—",
        ]),
      };
    }

    case "wh-throughput": {
      const days = new Map<string, { orders: number; qty: number; boxes: number }>();
      for (const r of rows) {
        // Orders with no anchor at all stay excluded — there is no day to
        // attribute their throughput to. (Live spine: zero such orders.)
        const anchor = r.anchor.date;
        if (!anchor) continue;
        if (daysBetween(anchor, today) > 14) continue;
        const key = `${anchor} · ${r.order.facility}`;
        const e = days.get(key) ?? { orders: 0, qty: 0, boxes: 0 };
        e.orders += 1;
        e.qty += r.order.fulfilledQty ?? r.order.qty;
        e.boxes += r.order.boxCount ?? 0;
        days.set(key, e);
      }
      return {
        // "WH-out day": the day the order left the warehouse — its dispatch
        // date when known, else its manifest day. Not necessarily a dispatch.
        columns: ["WH-out day · facility", "Orders", "Pieces", "Boxes"],
        rows: [...days.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .map(([k, e]) => [k, e.orders, e.qty, e.boxes]),
      };
    }

    case "rulebook-adherence": {
      const checks: { leg: string; target?: string; actual?: string; store: string; so: string }[] = [];
      for (const r of rows) {
        if (!r.rule) continue;
        if (r.order.dispatchedDate && r.rule.targetHandoverDay)
          checks.push({
            leg: "WH handover",
            target: r.rule.targetHandoverDay,
            actual: weekdayOf(r.order.dispatchedDate),
            store: r.order.storeNameFormat,
            so: r.order.soNumber,
          });
        if (r.order.deliveredDate && r.rule.targetDeliveryDay)
          checks.push({
            leg: "Store delivery",
            target: r.rule.targetDeliveryDay,
            actual: weekdayOf(r.order.deliveredDate),
            store: r.order.storeNameFormat,
            so: r.order.soNumber,
          });
      }
      return {
        columns: ["SO", "Store", "Leg", "Rulebook day", "Actual day", "On plan"],
        linkCol: 0,
        rows: checks.map((c) => [c.so, c.store, c.leg, c.target!, c.actual!, c.target === c.actual ? "YES" : "off-day"]),
      };
    }

    case "store-slice": {
      const stores = new Map<string, OrderRow[]>();
      for (const r of rows) {
        const key = `${r.order.storeNameFormat}|${r.order.areaManager ?? "—"}|${r.order.merchandiser ?? "—"}`;
        const list = stores.get(key) ?? [];
        list.push(r);
        stores.set(key, list);
      }
      return {
        columns: ["Store", "Area manager", "Merchandiser", "Orders", "Pieces", "Delivered", "Breaching", "Recon open"],
        rows: [...stores.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([key, list]) => {
            const [store, am, merch] = key.split("|");
            return [
              store,
              am,
              merch,
              list.length,
              list.reduce((a, r) => a + r.order.qty, 0),
              list.filter((r) => r.order.deliveredDate).length,
              list.filter((r) => r.breaching && r.order.overallStatus !== "DELIVERED").length,
              list.filter(
                (r) => ((r.order.shortageQty ?? 0) > 0 || (r.order.excessQty ?? 0) > 0) && r.order.entryStatus !== "CLOSED",
              ).length,
            ];
          }),
      };
    }

    default:
      return { columns: [], rows: [] };
  }
}
