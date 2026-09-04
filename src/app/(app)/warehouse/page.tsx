// Warehouse Queue (PRD §6.3) — facility-scoped table across the Phase A flow.
// Rulebook due-today highlights are advisory colouring only, never blocking.
//
// Filtering is applied HERE, on the server, so the client receives an
// already-filtered row list instead of every order in the facility.
//
// There is no per-lane cap any more. The kanban capped each lane at 60 because
// seven lanes of unbounded cards was the shape that hurt; one flat table holds
// the whole queue — 208 rows across all facilities, unfiltered — which is
// comfortably inside what the In-Transit board already renders unvirtualised.
// A cap here would mean the table quietly showing fewer orders than its own
// count claims, which is worse than the rows it saves.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istDateOf, istToday } from "@/lib/ist";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import type { OrderStatus } from "@/lib/types";
import { QueueTable, type QueueRow } from "./table";
import { QUEUE_STAGES, filtersFromParams, matchesFilters } from "./filters";

export const metadata = { title: "Warehouse" };
export const dynamic = "force-dynamic";

export default async function WarehousePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { user, scope } = await requireSession();
  const rows = await scopedOrders(scope, user);
  const today = istToday();
  const policy = policyOf(user.role);
  const canEdit = policy.canEditWarehouse || policy.isAdmin;
  const filters = filtersFromParams(searchParams);

  const all: QueueRow[] = rows
    .filter((r) => QUEUE_STAGES.includes(r.order.status))
    // Dispatched only shows freshly-dispatched (still pickup-pending) so it reads as an outbox.
    .filter((r) => r.order.status !== "DISPATCHED_TO_STORE" || r.order.overallStatus === "PICKUP_PENDING")
    .map((r) => {
      const due = r.sla.handoverDeadlineTs ? istDateOf(r.sla.handoverDeadlineTs) : undefined;
      return {
        so: r.order.soNumber,
        store: r.order.storeNameFormat,
        // No local Store row (storeId ""). The order still carries the spine's
        // resolved store name, so the label above is real — this only flags
        // that the rulebook/AM enrichment behind it is missing. Advisory: it
        // never affects whether the row is here or what can be done to it.
        storeUnmapped: r.order.storeId === "",
        qty: r.order.qty,
        type: r.order.type,
        channel: r.order.channel,
        priority: r.order.priority,
        campaign: r.order.campaignTag,
        status: r.order.status,
        facility: r.order.facility,
        due: due ? (due < today ? "overdue" : due === today ? "today" : undefined) : undefined,
        // The two deadlines the Daily Plan prints, carried onto the row so the
        // floor can read them without opening a second tab. Both are already
        // computed above — `handoverDeadlineTs` is the very field the `due`
        // badge on the line above is derived from — so nothing here re-derives
        // an SLA or reaches for a value this page was not already fetching.
        whTatTs: r.sla.handoverDeadlineTs,
        // Daily Plan's HANDOVER_DATE is COALESCE(TO_DATE(PICKUP_TAT),
        // TO_DATE(WH_PROCESSING_TAT)); pickupTargetTs and handoverDeadlineTs
        // are those same two synced columns, so this is the same coalesce
        // rather than a second definition of "handover day".
        handoverDate: r.sla.pickupTargetTs
          ? istDateOf(r.sla.pickupTargetTs)
          : due,
        ageDays: r.sla.ageing,
        boxCount: r.order.boxCount,
        weightKg: r.order.weightKg,
        invoice: r.order.saleInvoiceNumber,
        // Already fetched: scopedOrders batch-joins the OrderShipment children
        // for the transit anchor and reduces them with primaryAwb() — the
        // furthest-forward LIVE child, never a dead label, exactly as the
        // In-Transit board names it. This only carries the answer onto the row.
        awb: r.awb,
        awbCount: r.awbCount,
        // Only an explicit false flags the row. Orders synced before the
        // spine have this undefined and must render exactly as before.
        outOfRulebook: r.order.rulebookCovered === false,
      };
    });

  // Facet options come from what is actually in scope, so the pickers never
  // offer a store that would return an empty table.
  const stores = [...new Set(all.map((c) => c.store))].sort();
  const types = [...new Set(all.map((c) => c.type))].sort();

  // Stage counts are deliberately computed with every OTHER facet applied but
  // the stage facet ignored: the pills have to keep saying how many orders sit
  // in the stages you are not currently looking at, or narrowing to one stage
  // would blank out the way back.
  const acrossStages = all.filter((c) => matchesFilters(c, { ...filters, stage: "" }));
  const stageCounts: Record<string, number> = {};
  for (const stage of QUEUE_STAGES) stageCounts[stage] = 0;
  for (const c of acrossStages) stageCounts[c.status] = (stageCounts[c.status] ?? 0) + 1;

  const shown = filters.stage ? acrossStages.filter((c) => c.status === filters.stage) : acrossStages;

  const terminal = rows.filter((r) => ["CANCELLED", "UNFULFILLABLE"].includes(r.order.status)).length;

  return (
    <>
      <PageHead
        title="Warehouse queue"
        sub={`Phase A floor view — advisory rulebook highlights, nothing here blocks the floor.${canEdit ? "" : " You have read-only access."}`}
      />
      <QueueTable
        rows={shown}
        canEdit={canEdit}
        terminalCount={terminal}
        filters={filters}
        stores={stores}
        types={types}
        stageCounts={stageCounts as Record<OrderStatus, number>}
        matchedTotal={shown.length}
        scopeTotal={all.length}
      />
    </>
  );
}
