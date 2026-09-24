// Read-side composition: orders joined with their rulebook rule + computed SLA.
// Pages call this with the *validated* scope from requireSession().

import type { OrderSearch } from "./order-search";
import { repo } from "./repo";
import { computeOrderSla, isBreaching, ruleFor, type OrderSla } from "./sla";
import { primaryAwb, transitAnchor, type BoardShipment, type TransitAnchor } from "./transit-anchor";
import type { FacilityScope, Order, RulebookEntry, User } from "./types";
import { dataGeneration, syncGeneration } from "./db";
import { ORDERS_PAGE_SIZE, type OrderSort } from "./order-search";

export interface OrderRow {
  order: Order;
  rule?: RulebookEntry;
  sla: OrderSla;
  breaching: boolean;
  /** Where transit age is measured from — dispatch when known, else the WH
   *  manifest or the earliest child's pickup. Empty when nothing is known,
   *  which is a genuine spine gap rather than a zero-day transit. */
  anchor: TransitAnchor;
  /** The AWB to show for this order — furthest-forward live child, never a
   *  dead label. Absent when no child carries one (still in WH). */
  awb?: string;
  /** How many AWBs the order has, so a board can say "+1 more". */
  awbCount: number;
  /** Boxes across the order's AWBs. Order-grain `boxCount` is NULL on every
   *  spine order — the count only exists at child grain — so this sums the
   *  children. Undefined when no child carries one, which is not zero boxes. */
  boxes?: number;
}

/** Boxes across an order's AWBs — undefined when no child carries a count. */
function boxesOf(children: BoardShipment[] = []): number | undefined {
  const counted = children.filter((c) => c.packageCount != null);
  return counted.length ? counted.reduce((a, c) => a + (c.packageCount ?? 0), 0) : undefined;
}

/**
 * `search` is opt-in. Omitted — every board and every report — the read is
 * exactly what it always was: unwindowed, so no CSV export or KPI count is
 * silently truncated. Passed (even empty) it applies the /orders list's
 * 30-day default window and its search lift.
 */
export async function scopedOrders(
  scope: FacilityScope,
  user: User,
  search?: OrderSearch,
): Promise<OrderRow[]> {
  const am = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;
  if (search) return buildRows(scope, am, search);
  // The same two predicates listOrders() applies, over the shared snapshot.
  // filter() always copies, so a caller sorting its rows never reorders it.
  return (await boardSnapshot()).filter(
    (r) => (scope === "ALL" || r.order.facility === scope) && (!am || r.order.areaManager === am),
  );
}

/**
 * Every board reads the same thing — every order with its SLA — and building
 * it costs ~2.5s (10k orders, the shipment join, the SLA engine per row). One
 * snapshot serves every board and user for BOARD_TTL_MS, and is dropped the
 * moment a repo write or a finished sync run bumps the data generation, so a
 * manual edit shows on the very next render. Concurrent requests share one
 * in-flight build.
 */
//
// Two kinds of staleness, two answers. A person's own write (data generation)
// is served fresh — the next render waits for the rebuild. Age and a finished
// background sync (sync generation) are stale-while-revalidate: the current
// board keeps serving while one rebuild runs behind it. Each rebuild pulls
// ~23 MB (11.7k orders, 2026-09-24), so the TTL is minutes, not seconds; the
// only thing it bounds is how long a time-based verdict ("due today") can lag.
// ponytail: one in-process snapshot; move to a shared cache if the app ever runs as >1 instance.
const BOARD_TTL_MS = 5 * 60_000;
type Snapshot = { gen: number; syncGen: number; at: number; rows: Promise<OrderRow[]> };
let snapshot: Snapshot | undefined;
let refreshing = false;

function build(gen: number, syncGen: number): Snapshot {
  const entry = { gen, syncGen, at: Date.now(), rows: buildRows("ALL") };
  entry.rows.catch(() => {
    if (snapshot === entry) snapshot = undefined;
  });
  return entry;
}

function boardSnapshot(): Promise<OrderRow[]> {
  const gen = dataGeneration();
  const syncGen = syncGeneration();
  if (snapshot && snapshot.gen === gen) {
    const stale = snapshot.syncGen !== syncGen || Date.now() - snapshot.at >= BOARD_TTL_MS;
    if (stale && !refreshing) {
      refreshing = true;
      const next = build(gen, syncGen);
      next.rows
        .then(() => {
          // A write landed mid-rebuild: that path already built its own.
          if (dataGeneration() === gen) snapshot = next;
        })
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    }
    return snapshot.rows;
  }
  snapshot = build(gen, syncGen);
  return snapshot.rows;
}

async function buildRows(scope: FacilityScope, am?: string, search?: OrderSearch): Promise<OrderRow[]> {
  const [rules, orders] = await Promise.all([repo.listRules(), repo.listOrders(scope, am, search)]);
  // One batched query for the whole page — never one per row.
  const anchorShipments = await repo.listAnchorShipments(orders.map((o) => o.soNumber));
  return orders.map((order) => {
    const rule = ruleFor(rules, order.storeId, order.type, order.orderDate);
    // The children feed both the transit anchor and the SLA engine's HANDOVER
    // leg — same pickup, so the age and the verdict cannot disagree.
    const children = anchorShipments.get(order.soNumber);
    const sla = computeOrderSla(order, rule, undefined, children);
    const { awb, count } = primaryAwb(children);
    return {
      order,
      rule,
      sla,
      breaching: isBreaching(sla, order),
      anchor: transitAnchor(order, children),
      awb,
      awbCount: count,
      boxes: boxesOf(children),
    };
  });
}

/**
 * The /orders list: plain orders, no rulebook join, no SLA, no shipment
 * batch-join. A search can reach every order ever synced, and paying the
 * board's per-row enrichment across all of history to render six columns
 * would be the one thing that makes historical search too slow to use.
 *
 * Scoped through the SAME two predicates as `scopedOrders` — the facility
 * comes from the validated session scope, never from a client param, and a
 * Retail Head still sees only their own area.
 */
export async function searchOrders(
  scope: FacilityScope,
  user: User,
  search: OrderSearch,
  page: number,
  sort?: OrderSort,
): Promise<{ orders: Order[]; total: number }> {
  const am = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;
  return repo.searchOrders(scope, am, search, (page - 1) * ORDERS_PAGE_SIZE, ORDERS_PAGE_SIZE, sort);
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
  const { awb, count } = primaryAwb(shipments);
  return {
    order,
    rule,
    sla,
    breaching: isBreaching(sla, order),
    anchor: transitAnchor(order, shipments),
    awb,
    awbCount: count,
    boxes: boxesOf(shipments),
  };
}
