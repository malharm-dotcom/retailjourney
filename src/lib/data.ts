// Read-side composition: orders joined with their rulebook rule + computed SLA.
// Pages call this with the *validated* scope from requireSession().

import { repo } from "./repo";
import { computeOrderSla, isBreaching, ruleFor, type OrderSla } from "./sla";
import { transitAnchor, type TransitAnchor } from "./transit-anchor";
import type { FacilityScope, Order, RulebookEntry, User } from "./types";

export interface OrderRow {
  order: Order;
  rule?: RulebookEntry;
  sla: OrderSla;
  breaching: boolean;
  /** Where transit age is measured from — dispatch when known, else the WH
   *  manifest or the earliest child's pickup. Empty when nothing is known,
   *  which is a genuine spine gap rather than a zero-day transit. */
  anchor: TransitAnchor;
}

export async function scopedOrders(scope: FacilityScope, user: User): Promise<OrderRow[]> {
  const am = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;
  const [rules, orders] = await Promise.all([repo.listRules(), repo.listOrders(scope, am)]);
  // One batched query for the whole page — never one per row.
  const anchorShipments = await repo.listAnchorShipments(orders.map((o) => o.soNumber));
  return orders.map((order) => {
    const rule = ruleFor(rules, order.storeId, order.type, order.orderDate);
    // The children feed both the transit anchor and the SLA engine's HANDOVER
    // leg — same pickup, so the age and the verdict cannot disagree.
    const children = anchorShipments.get(order.soNumber);
    const sla = computeOrderSla(order, rule, undefined, children);
    return {
      order,
      rule,
      sla,
      breaching: isBreaching(sla),
      anchor: transitAnchor(order, children),
    };
  });
}

/**
 * One order by SO number, scoped exactly as `scopedOrders` scopes a board.
 *
 * The scope is a REQUIRED parameter rather than something the caller applies
 * afterwards: this used to be a bare lookup, so `/orders/<SO>` returned any
 * order in any facility to any signed-in user — the boards were scoped and the
 * detail page behind them was not. Taking the scope here means a call site
 * cannot forget it. Out of scope reads as "no such order" (undefined), never as
 * a partial or redacted row, so the caller's own notFound() is the whole story.
 */
export async function orderBySo(
  soNumber: string,
  scope: FacilityScope,
  user: User,
): Promise<OrderRow | undefined> {
  const order = await repo.getOrder(soNumber);
  if (!order) return undefined;
  // Same two predicates listOrders() applies, in the same order, so an order
  // visible on a board is visible here and nothing else is.
  if (scope !== "ALL" && order.facility !== scope) return undefined;
  const am = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;
  if (am && order.areaManager !== am) return undefined;
  const rule = ruleFor(await repo.listRules(), order.storeId, order.type, order.orderDate);
  const shipments = await repo.listShipments(soNumber);
  const sla = computeOrderSla(order, rule, undefined, shipments);
  return {
    order,
    rule,
    sla,
    breaching: isBreaching(sla),
    anchor: transitAnchor(order, shipments),
  };
}
