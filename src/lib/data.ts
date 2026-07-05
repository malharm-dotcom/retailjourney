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

export function scopedOrders(scope: FacilityScope, user: User): OrderRow[] {
  const am = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;
  const rules = repo.listRules();
  return repo.listOrders(scope, am).map((order) => {
    const rule = ruleFor(rules, order.storeId, order.type, order.orderDate);
    const sla = computeOrderSla(order, rule);
    return { order, rule, sla, breaching: isBreaching(sla) };
  });
}

export function orderBySo(soNumber: string): OrderRow | undefined {
  const order = repo.getOrder(soNumber);
  if (!order) return undefined;
  const rule = ruleFor(repo.listRules(), order.storeId, order.type, order.orderDate);
  const sla = computeOrderSla(order, rule);
  return { order, rule, sla, breaching: isBreaching(sla) };
}
