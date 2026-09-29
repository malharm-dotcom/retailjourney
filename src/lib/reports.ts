// Report builders (PRD §10) — pure functions over the scoped, SLA-computed
// order rows. Each returns a serializable table the client can render + export.

import type { OrderRow } from "./data";
import { daysBetween, istDateOf, istToday, weekdayOf } from "./ist";
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

/** Who a report is for — the landing page groups by this, so a reader finds
 *  their team's reports without reading every tile. */
export type ReportGroup = "lookup" | "warehouse" | "logistics" | "stores";

export const REPORT_GROUPS: { key: ReportGroup; title: string; blurb: string; icon: string }[] = [
  {
    key: "lookup",
    title: "Find an order",
    blurb: "Start here when someone asks about one specific order.",
    icon: "magnifer-zoom-in-bold-duotone",
  },
  {
    key: "warehouse",
    title: "Warehouse",
    blurb: "What left each warehouse, and whether it left on the rulebook's day.",
    icon: "box-bold-duotone",
  },
  {
    key: "logistics",
    title: "Logistics & couriers",
    blurb: "Shipments on the road — what is late, what is ageing, which partner is slipping.",
    icon: "delivery-bold-duotone",
  },
  {
    key: "stores",
    title: "Stores & leadership",
    blurb: "Store-level rollups, SLA health per leg, reconciliation and new openings.",
    icon: "shop-bold-duotone",
  },
];

/** The filters a report honours. A control the report would ignore is not
 *  shown — "Order date" on a live in-transit list only hid old shipments. */
export type ReportFilterKey = "date" | "type" | "courier" | "facility";

export interface ReportDef {
  slug: string;
  title: string;
  description: string;
  icon: string;
  group: ReportGroup;
  /** The question it answers, in the reader's words. */
  question: string;
  /** What one row is. */
  grain: string;
  filters: ReportFilterKey[];
  /** What the From/To dates filter on, when the report has them. */
  dateBasis?: string;
}

export interface ReportTableData {
  columns: string[];
  rows: (string | number)[][];
  /** Column index whose value is an SO number → linked to the journey view. */
  linkCol?: number;
}

const ALL_FILTERS: ReportFilterKey[] = ["date", "type", "courier", "facility"];

export const REPORTS: ReportDef[] = [
  {
    slug: "order-lookup",
    title: "Order lookup",
    description: "Paste any SO, DC, LR or store name to get the order's record and a link to its timeline.",
    icon: "magnifer-zoom-in-bold-duotone",
    group: "lookup",
    question: "Where is this order right now?",
    grain: "One row per order",
    filters: ALL_FILTERS,
    dateBasis: "order date",
  },
  {
    slug: "wh-throughput",
    title: "Warehouse throughput",
    description: "Orders, pieces and boxes that left each warehouse, per day.",
    icon: "box-bold-duotone",
    group: "warehouse",
    question: "How much did each warehouse send out, day by day?",
    grain: "One row per day × warehouse",
    filters: ["date", "type", "facility"],
    dateBasis: "day it left the warehouse (dispatch, else manifest) — last 14 days if left blank",
  },
  {
    slug: "rulebook-adherence",
    title: "Rulebook adherence",
    description: "Did the order leave the warehouse, and reach the store, on the weekday the rulebook plans?",
    icon: "calendar-mark-bold-duotone",
    group: "warehouse",
    question: "Are we handing over and delivering on the planned day?",
    grain: "One row per order × leg (WH handover, store delivery)",
    filters: ALL_FILTERS,
    dateBasis: "order date",
  },
  {
    // Served by its own route (reports/logistics-followup/page.tsx), which
    // shadows [slug] — it needs column-mode and EDD-source controls the generic
    // report shell has no place for, so `buildReport` has no case for it.
    slug: "logistics-followup",
    title: "EDD breached follow-up",
    description: "Every in-transit AWB past its EDD, ready to paste into the courier mail — plus a store × EDD pivot.",
    icon: "clipboard-list-bold-duotone",
    group: "logistics",
    question: "Which shipments do I chase the courier about today?",
    grain: "One row per late AWB",
    filters: ["courier", "facility"],
  },
  {
    slug: "ageing",
    title: "In-transit ageing",
    description: "Every shipment still on the road, oldest first, bucketed by days since it left the warehouse.",
    icon: "hourglass-bold-duotone",
    group: "logistics",
    question: "Which shipments have been out the longest?",
    grain: "One row per open shipment (pickup pending or in transit)",
    filters: ["type", "courier", "facility"],
  },
  {
    slug: "courier-scorecard",
    title: "Courier scorecard",
    description: "On-time %, days to deliver, re-attempts and open shipments per courier partner.",
    icon: "delivery-bold-duotone",
    group: "logistics",
    question: "Which courier partner is performing, and which is slipping?",
    grain: "One row per courier partner",
    filters: ALL_FILTERS,
    dateBasis: "order date",
  },
  {
    slug: "store-slice",
    title: "Store / AM / merchandiser rollup",
    description: "Orders, pieces, delivered, breaching now and open reconciliation per store.",
    icon: "shop-bold-duotone",
    group: "stores",
    question: "How is each store — and each area manager's patch — doing?",
    grain: "One row per store",
    filters: ALL_FILTERS,
    dateBasis: "order date",
  },
  {
    slug: "sla-adherence",
    title: "SLA adherence per leg",
    description: "For each journey leg: how many orders are within SLA, still running, or breached.",
    icon: "stopwatch-bold-duotone",
    group: "stores",
    question: "Which leg of the journey is losing us the SLA?",
    grain: "One row per SLA leg",
    filters: ALL_FILTERS,
    dateBasis: "order date",
  },
  {
    slug: "shortage-excess",
    title: "Shortage / excess reconciliation",
    description: "Orders the store received short or excess, with the Logic adjustment and entry status.",
    icon: "clipboard-remove-bold-duotone",
    group: "stores",
    question: "Which receipts still have an open shortage or excess?",
    grain: "One row per order with a shortage or excess",
    filters: ALL_FILTERS,
    dateBasis: "order date",
  },
  {
    slug: "nso-openings",
    title: "New store openings (NSO)",
    description: "Store-opening orders on their own. No deadline column — an opening has no TAT to miss.",
    icon: "shop-2-bold-duotone",
    group: "stores",
    question: "How far along is each new store's opening stock?",
    grain: "One row per NSO order",
    filters: ["date", "facility"],
    dateBasis: "order date",
  },
];

export interface ReportRowFilter {
  from?: string;
  to?: string;
  types?: string[];
  couriers?: string[];
  /** Already intersected with the session's entitlement. Empty = no narrowing. */
  facilities?: string[];
}

const TERMINAL = new Set(["CANCELLED", "UNFULFILLABLE"]);

/** The day an order LEFT the warehouse — dispatch, else the manifest. The same
 *  fallback the handover SLA uses (phaseASla in sync.ts); the spine never
 *  carries a dispatch date, so dispatch alone is blank on synced orders. */
function whOutDate(r: OrderRow): string | undefined {
  return r.order.dispatchedDate ?? (r.order.manifestedTs ? istDateOf(r.order.manifestedTs) : undefined);
}

/**
 * Apply a report's filters to the scoped rows. Only the filters the report
 * declares are honoured, so a stale URL parameter can never silently narrow a
 * report whose screen no longer shows that control.
 *
 * Cancelled and unfulfillable orders are dropped from every report except the
 * lookup: they never shipped, so counting them inflated order totals and
 * breach counts (a cancelled order still carries leg verdicts).
 */
export function filterReportRows(def: ReportDef, rows: OrderRow[], f: ReportRowFilter): OrderRow[] {
  const has = (k: ReportFilterKey) => def.filters.includes(k);
  const types = has("type") ? f.types ?? [] : [];
  const couriers = has("courier") ? f.couriers ?? [] : [];
  const facilities = has("facility") ? f.facilities ?? [] : [];
  const dated = has("date");
  // Throughput is about the day stock LEFT, so its dates filter that day.
  const dateOf = (r: OrderRow) => (def.slug === "wh-throughput" ? r.anchor.date : r.order.orderDate);
  const inRange = (d?: string) => (!f.from || (!!d && d >= f.from)) && (!f.to || (!!d && d <= f.to));
  return rows.filter(
    (r) =>
      (def.slug === "order-lookup" || !TERMINAL.has(r.order.status)) &&
      (!types.length || types.includes(r.order.type)) &&
      (!couriers.length || couriers.includes(courierOf(r.order))) &&
      (!facilities.length || facilities.includes(r.order.facility)) &&
      (!dated || inRange(dateOf(r))),
  );
}

export function reportBySlug(slug: string): ReportDef | undefined {
  return REPORTS.find((r) => r.slug === slug);
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

/** Rows the lookup shows before anything is searched. */
export const LOOKUP_DEFAULT_ROWS = 50;

/**
 * `dated`: the caller already applied a From/To range. Only throughput cares —
 * its 14-day default window applies when no range was given, and must not cut
 * a range someone asked for.
 */
export function buildReport(slug: string, rows: OrderRow[], q?: string, dated = false): ReportTableData {
  const today = istToday();

  switch (slug) {
    case "order-lookup": {
      const needle = (q ?? "").trim().toLowerCase();
      const hits = needle
        ? rows.filter((r) =>
            [r.order.soNumber, r.order.dcNumber, r.order.lrNumber, r.order.finalStore, r.order.storeNameFormat]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(needle)),
          )
        : // Unsearched: the newest orders, not whatever 50 the snapshot held first.
          [...rows]
            .sort((a, b) => b.order.orderDate.localeCompare(a.order.orderDate) || a.order.soNumber.localeCompare(b.order.soNumber))
            .slice(0, LOOKUP_DEFAULT_ROWS);
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

    /**
     * NSO is watched as its own population, not filtered out of a list built
     * for orders that have deadlines.
     *
     * There is deliberately NO TAT, due-date or breach column here. An NSO
     * order has no rulebook timeline and no fulfilment TAT by definition —
     * delivery is driven by the store's actual opening date — so every one of
     * those columns would read "—" on every row, and any that did not would be
     * a fabricated deadline the floor is not working to.
     *
     * What replaces them is progress: how far the order has physically got,
     * and when it was anchored, which is the only question a store opening
     * actually asks.
     */
    case "nso-openings": {
      const nso = rows.filter((r) => r.order.type === "NSO");
      const needle = (q ?? "").trim().toLowerCase();
      const hits = needle
        ? nso.filter((r) =>
            [r.order.soNumber, r.order.storeNameFormat, r.order.finalStore]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(needle)),
          )
        : nso;
      return {
        columns: ["SO", "Store", "Facility", "Items", "Ordered", "WH status", "Overall", "Anchored on", "Anchor", "Delivered"],
        linkCol: 0,
        rows: hits
          // Newest opening first: the one being prepared now matters more than
          // one that shipped a month ago.
          .sort((a, b) => (a.order.orderDate < b.order.orderDate ? 1 : -1))
          .map((r) => [
            r.order.soNumber,
            r.order.storeNameFormat,
            r.order.facility,
            r.order.qty,
            r.order.orderDate,
            STATUS_LABEL[r.order.status],
            OVERALL_LABEL[r.order.overallStatus],
            r.anchor.date ?? "—",
            r.anchor.source ? ANCHOR_LABEL[r.anchor.source] : "—",
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
        if (!dated && daysBetween(anchor, today) > 14) continue;
        const key = `${anchor} · ${r.order.facility}`;
        const e = days.get(key) ?? { orders: 0, qty: 0, boxes: 0 };
        e.orders += 1;
        e.qty += r.order.fulfilledQty ?? r.order.qty;
        // boxCount is hand-entered only; synced orders carry their boxes on
        // the AWB children (r.boxes). Reading boxCount alone summed to 0.
        e.boxes += r.order.boxCount ?? r.boxes ?? 0;
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
        // Dispatch, else manifest — dispatchedDate alone is blank on every
        // spine order, which left this report delivery-only.
        const whOut = whOutDate(r);
        if (whOut && r.rule.targetHandoverDay)
          checks.push({
            leg: "WH handover",
            target: r.rule.targetHandoverDay,
            actual: weekdayOf(whOut),
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
              // Inwarded counts: the store booked the stock in, which is past
              // delivery. A deliveredDate alone missed every milk-run order
              // that was inwarded without a courier delivery scan.
              list.filter(
                (r) => r.order.deliveredDate || r.order.overallStatus === "DELIVERED" || r.order.overallStatus === "INWARDED",
              ).length,
              list.filter((r) => r.breaching).length,
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
