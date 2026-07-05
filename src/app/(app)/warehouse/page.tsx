// Warehouse Queue (PRD §6.3) — facility-scoped kanban across the Phase A flow.
// Rulebook due-today highlights are advisory colouring only, never blocking.

import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { istDateOf, istToday } from "@/lib/ist";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { WH_FLOW } from "@/lib/journey";
import type { OrderStatus } from "@/lib/types";
import { Kanban, type KanbanCard } from "./kanban";

export const metadata = { title: "Warehouse" };
export const dynamic = "force-dynamic";

const LANES: OrderStatus[] = [...WH_FLOW, "ON_HOLD"];

export default async function WarehousePage() {
  const { user, scope } = await requireSession();
  const rows = scopedOrders(scope, user);
  const today = istToday();
  const policy = policyOf(user.role);
  const canEdit = policy.canEditWarehouse || policy.isAdmin;

  const cards: KanbanCard[] = rows
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
        priority: r.order.priority,
        campaign: r.order.campaignTag,
        status: r.order.status,
        facility: r.order.facility,
        due: due ? (due < today ? "overdue" : due === today ? "today" : undefined) : undefined,
        ageDays: r.sla.ageing,
        boxCount: r.order.boxCount,
        weightKg: r.order.weightKg,
        invoice: r.order.saleInvoiceNumber,
      };
    });

  const terminal = rows.filter((r) => ["CANCELLED", "UNFULFILLABLE"].includes(r.order.status)).length;

  return (
    <>
      <PageHead
        title="Warehouse queue"
        sub={`Phase A floor view — advisory rulebook highlights, nothing here blocks the floor.${canEdit ? "" : " You have read-only access."}`}
      />
      <Kanban cards={cards} canEdit={canEdit} terminalCount={terminal} />
    </>
  );
}
