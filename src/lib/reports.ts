// Report builders (PRD §10) — pure functions over the scoped, SLA-computed
// order rows. Each returns a serializable table the client can render + export.

import type { OrderRow } from "./data";
import { daysBetween, istToday, weekdayOf } from "./ist";
import { LEG_LABEL, SLA_LABEL, ageingBucket, type SlaLeg, type SlaState } from "./sla";
import { OVERALL_LABEL, STATUS_LABEL } from "./journey";

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
    description: "Open shipments bucketed by days on the road; breaching-soon first.",
    icon: "hourglass-bold-duotone",
  },
  {
    slug: "courier-scorecard",
    title: "Courier scorecard",
    description: "On-time %, transit TAT, attempts and NDRs per logistics partner.",
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
    description: "Orders, pieces and boxes dispatched per facility per day.",
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
        columns: ["SO", "Store", "Courier", "LR", "Dispatched", "Days out", "Bucket", "Breaching"],
        linkCol: 0,
        rows: open
          .map((r) => {
            const days = r.order.dispatchedDate ? daysBetween(r.order.dispatchedDate, today) : 0;
            return { r, days };
          })
          .sort((a, b) => b.days - a.days)
          .map(({ r, days }) => [
            r.order.soNumber,
            r.order.storeNameFormat,
            r.order.logisticsPartner ?? "—",
            r.order.lrNumber ?? "—",
            r.order.dispatchedDate ?? "—",
            days,
            ageingBucket(days),
            r.breaching ? "YES" : "—",
          ]),
      };
    }

    case "courier-scorecard": {
      const partners = new Map<string, OrderRow[]>();
      for (const r of rows) {
        if (!r.order.logisticsPartner) continue;
        const list = partners.get(r.order.logisticsPartner) ?? [];
        list.push(r);
        partners.set(r.order.logisticsPartner, list);
      }
      return {
        columns: ["Partner", "Shipments", "Delivered", "On-time %", "Avg transit days", "NDR shipments", "Open"],
        rows: [...partners.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([partner, list]) => {
            const delivered = list.filter((r) => r.order.deliveredDate);
            const onTime = delivered.filter(
              (r) => r.sla.legs.find((l) => l.leg === "LOGISTICS_DELIVERY")?.state === "WITHIN_SLA",
            );
            const tats = delivered
              .filter((r) => r.order.dispatchedDate)
              .map((r) => daysBetween(r.order.dispatchedDate!, r.order.deliveredDate!));
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
        if (!r.order.dispatchedDate) continue;
        if (daysBetween(r.order.dispatchedDate, today) > 14) continue;
        const key = `${r.order.dispatchedDate} · ${r.order.facility}`;
        const e = days.get(key) ?? { orders: 0, qty: 0, boxes: 0 };
        e.orders += 1;
        e.qty += r.order.fulfilledQty ?? r.order.qty;
        e.boxes += r.order.boxCount ?? 0;
        days.set(key, e);
      }
      return {
        columns: ["Dispatch day · facility", "Orders", "Pieces", "Boxes"],
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
