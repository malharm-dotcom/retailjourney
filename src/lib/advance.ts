// The guarded single-order advance, extracted so the bulk action can reuse it
// instead of re-implementing it.
//
// This module deliberately does NOT carry "use server". Every export of a
// "use server" module becomes a client-callable endpoint, and advanceOne() takes
// the acting user as a parameter — exported from an action module it would let a
// caller name whatever actor they liked, which is the escalation the facility
// and role guards exist to stop. actions.ts and bulk-actions.ts are the action
// surfaces; this is plain server code they both call.

import { REQUIRED_CAPTURES, WH_FLOW } from "./journey";
import { assertFacility } from "./rbac";
import { repo } from "./repo";
import type { Order, OrderStatus, User } from "./types";

/**
 * The capture keys a given transition may carry — the transition's own prompt
 * list, nothing else.
 *
 * `captures` is typed `Partial<Order>`, and types are erased at runtime, so
 * every key the caller sent used to be written verbatim: a WH_OPERATOR holding
 * one warehouse right could set merch, logistics and reconciliation fields, or
 * `facility`, by naming them here. REQUIRED_CAPTURES is the right boundary
 * because those fields are intrinsic to the move the role is already entitled
 * to make — the warehouse legitimately records DC/LR/vehicle as a consignment
 * leaves, which is why FIELD_RIGHTS is NOT layered on top (it would reject
 * every dispatch, since those five fields are logistics-owned).
 *
 * STATUS_TIMESTAMPS are deliberately absent: transitionStatus writes them from
 * the server clock. Accepting them here would let a caller forge the very
 * anchors the SLA legs are measured from.
 */
export function allowedCaptures(to: OrderStatus, captures: Partial<Order>): Partial<Order> {
  const allowed = new Set<string>((REQUIRED_CAPTURES[to] ?? []).map((f) => String(f.field)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(captures)) {
    if (v === undefined) continue;
    if (!allowed.has(k)) throw new Error(`Field ${k} is not captured on this transition`);
    out[k] = v;
  }
  return out as Partial<Order>;
}

/**
 * Server-derived capture defaults, applied to the ALREADY-ALLOWLISTED captures.
 *
 * The RTS Logic quantity is optional on the modal and in the CSV import: the
 * confirmed quantity equals the ordered quantity on all but the short-shipped
 * orders, so making the floor retype it 290 times is the kind of busywork the
 * old Sheet was made of. Left blank it means "all of it", which is the
 * UC-synced `qty` already on the order.
 *
 * This lives HERE, not in either caller, so the modal and the importer cannot
 * drift into two different ideas of what blank means.
 *
 * Two things it deliberately does NOT do:
 *  - It never touches `qty`. That is the sync-owned ordered quantity behind the
 *    board's and Daily Plan's Qty column, and it has no FIELD_RIGHTS entry
 *    precisely so nothing can hand-edit it. `fulfilledQty` is the confirmed
 *    counterpart (reports.ts: `fulfilledQty ?? qty`).
 *  - It does not re-derive over a value the order already carries. An order
 *    walked back to Ready-to-Dispatch and re-advanced would otherwise have a
 *    hand-entered short-ship quantity silently reset to the ordered one on the
 *    second pass. Same "already on the order satisfies it" rule the required
 *    captures follow in transitionStatus.
 */
function withDerivedCaptures(order: Order, to: OrderStatus, captures: Partial<Order>): Partial<Order> {
  if (to === "RTS_LOGIC" && captures.fulfilledQty == null && order.fulfilledQty == null) {
    return { ...captures, fulfilledQty: order.qty };
  }
  return captures;
}

/**
 * Advance ONE order, fully guarded. The caller has already established the
 * actor and their canEditWarehouse right; everything that varies per order —
 * existence, facility entitlement, the capture allowlist, and the ladder /
 * terminal / required-field checks inside repo.transitionStatus — happens here.
 *
 * Throws on refusal. Callers decide what a refusal means: the single-order
 * action surfaces it, the bulk action classifies it as a skip or a failure.
 */
export async function advanceOne(
  user: Pick<User, "id" | "name" | "role" | "facilities">,
  soNumber: string,
  to: OrderStatus,
  captures: Partial<Order> = {},
  note?: string,
  /** An extra precondition, checked on the fetched order before the write.
   *  Used by the bulk path to add forward-only on top of the shared guards —
   *  see assertForward. Single-card moves pass nothing and keep the deliberate
   *  one-step reversals the card menu offers. */
  guard?: (order: Order) => void,
): Promise<void> {
  const order = await repo.getOrder(soNumber);
  if (!order) throw new Error(`Order ${soNumber} not found`);
  assertFacility(user, order.facility);
  guard?.(order);
  await repo.transitionStatus(
    soNumber,
    to,
    { id: user.id, name: user.name },
    // Allowlist FIRST, then derive: a forged key is still rejected, and the
    // server-derived default is not itself subject to a check it would pass.
    withDerivedCaptures(order, to, allowedCaptures(to, captures)),
    note,
  );
}

/**
 * Forward-only along WH_FLOW.
 *
 * WH_TRANSITIONS is a transition MAP, not a monotonic ladder: it deliberately
 * allows one-step reversals (PACKING → PICKING is the card menu's "Back to
 * Picking"), and the per-card UI derives its forward moves by filtering that map
 * against WH_FLOW order. That is right for one card chosen on purpose and wrong
 * for a sweep — selecting a column and pressing "advance" must never drag an
 * order that is already further along back down the flow. Off-flow targets
 * (ON_HOLD, CANCELLED, UNFULFILLABLE) are not bulk targets at all.
 */
export function assertForward(from: OrderStatus, to: OrderStatus): void {
  const here = WH_FLOW.indexOf(from);
  const there = WH_FLOW.indexOf(to);
  if (there < 0) throw new Error(`Invalid transition ${from} → ${to}`);
  if (here < 0 || there <= here) throw new Error(`Invalid transition ${from} → ${to}`);
}
