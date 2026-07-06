// Read-side composition: orders joined with their rulebook rule + computed SLA.
// Pages call this with the *validated* scope from requireSession().

import { repo } from "./repo";
import { computeOrderSla, isBreaching, ruleFor, type OrderSla } from "./sla";
import type { FacilityScope, Order, RulebookEntry, User } from "./types";

export interface OrderRow {
  order: Order;
  rule?: RulebookEntry;
  sla: OrderSla;
  breaching: boolean;
}

export async function scopedOrders(scope: FacilityScope, user: User): Promise<OrderRow[]> {
  const am = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;
  const [rules, orders] = await Promise.all([repo.listRules(), repo.listOrders(scope, am)]);
  return orders.map((order) => {
    const rule = ruleFor(rules, order.storeId, order.type, order.orderDate);
    const sla = computeOrderSla(order, rule);
    return { order, rule, sla, breaching: isBreaching(sla) };
  });
}

export async function orderBySo(soNumber: string): Promise<OrderRow | undefined> {
  const order = await repo.getOrder(soNumber);
  if (!order) return undefined;
  const rule = ruleFor(await repo.listRules(), order.storeId, order.type, order.orderDate);
  const sla = computeOrderSla(order, rule);
  return { order, rule, sla, breaching: isBreaching(sla) };
}
