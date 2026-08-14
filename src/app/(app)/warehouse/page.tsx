// Warehouse Queue (PRD §6.3) — facility-scoped kanban across the Phase A flow.
// Rulebook due-today highlights are advisory colouring only, never blocking.
//
// Filtering and the per-lane cap are applied HERE, on the server, so the client
// receives a bounded, already-filtered card list instead of every order in the
// facility. Not-Started alone runs past 100 at live volume.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istDateOf, istToday } from "@/lib/ist";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { WH_FLOW } from "@/lib/journey";
import type { OrderStatus } from "@/lib/types";
import { Kanban, type KanbanCard } from "./kanban";
import { filtersFromParams, matchesFilters } from "./filters";

export const metadata = { title: "Warehouse" };
export const dynamic = "force-dynamic";

const LANES: OrderStatus[] = [...WH_FLOW, "ON_HOLD"];

/** Cards sent to the client per lane. The lane header still reports the TRUE
 *  filtered total, so a capped lane says how much it is holding back rather
 *  than quietly lying about its size. */
const LANE_CAP = 60;

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

  const all: KanbanCard[] = rows
    .filter((r) => LANES.includes(r.order.status))
    // Dispatched lane only shows freshly-dispatched (still pickup-pending) so it reads as an outbox.
    .filter((r) => r.order.status !== "DISPATCHED_TO_STORE" || r.order.overallStatus === "PICKUP_PENDING")
    .map((r) => {
      const due = r.sla.handoverDeadlineTs ? istDateOf(r.sla.handoverDeadlineTs) : undefined;
      return {
        so: r.order.soNumber,
        store: r.order.storeNameFormat,
        qty: r.order.qty,
        type: r.order.type,
        channel: r.order.channel,
        priority: r.order.priority,
        campaign: r.order.campaignTag,
        status: r.order.status,
        facility: r.order.facility,
        due: due ? (due < today ? "overdue" : due === today ? "today" : undefined) : undefined,
        ageDays: r.sla.ageing,
        boxCount: r.order.boxCount,
        weightKg: r.order.weightKg,
        invoice: r.order.saleInvoiceNumber,
        // Only an explicit false flags the card. Orders synced before the
        // spine have this undefined and must render exactly as before.
        outOfRulebook: r.order.rulebookCovered === false,
      };
    });

  // Facet options come from what is actually in scope, so the pickers never
  // offer a store that would return an empty board.
  const stores = [...new Set(all.map((c) => c.store))].sort();
  const types = [...new Set(all.map((c) => c.type))].sort();

  const matched = all.filter((c) => matchesFilters(c, filters));

  // Cap per lane AFTER filtering, and report the true totals alongside, so the
  // client can say "showing 60 of 143" without holding 143 cards.
  const laneTotals: Record<string, number> = {};
  const cards: KanbanCard[] = [];
  for (const lane of LANES) {
    const inLane = matched.filter((c) => c.status === lane);
    laneTotals[lane] = inLane.length;
    cards.push(...inLane.slice(0, LANE_CAP));
  }

  const terminal = rows.filter((r) => ["CANCELLED", "UNFULFILLABLE"].includes(r.order.status)).length;

  return (
    <>
      <PageHead
        title="Warehouse queue"
        sub={`Phase A floor view — advisory rulebook highlights, nothing here blocks the floor.${canEdit ? "" : " You have read-only access."}`}
      />
      <Kanban
        cards={cards}
        canEdit={canEdit}
        terminalCount={terminal}
        filters={filters}
        stores={stores}
        types={types}
        laneTotals={laneTotals}
        matchedTotal={matched.length}
        scopeTotal={all.length}
        laneCap={LANE_CAP}
      />
    </>
  );
}
