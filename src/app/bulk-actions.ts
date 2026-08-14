"use server";

// Bulk advance for the Warehouse queue. The floor moves a truck's worth of
// orders at a time; doing that one card at a time is why the old Google Sheet
// still felt faster.
//
// This is a WRAPPER, not a second write path. Every order goes through
// advanceOne() — the same facility assert, the same REQUIRED_CAPTURES
// allowlist, the same repo.transitionStatus with its ladder check, terminal
// lock and server-derived timestamps. Forking any of that would re-open the
// mass-assignment hole those guards were added to close.

import { revalidatePath } from "next/cache";
import { advanceOne, allowedCaptures, assertForward } from "@/lib/advance";
import { assertCan } from "@/lib/rbac";
import { currentUser } from "@/lib/session";
import type { Order, OrderStatus } from "@/lib/types";

export type BulkOutcome = "ok" | "skipped" | "failed";

export interface BulkOrderResult {
  soNumber: string;
  outcome: BulkOutcome;
  /** Why, verbatim from the guard that refused. Shown per order in the UI. */
  reason?: string;
}

export type BulkResult =
  | {
      ok: true;
      toStatus: OrderStatus;
      total: number;
      advanced: number;
      skipped: number;
      failed: number;
      results: BulkOrderResult[];
    }
  | { ok: false; error: string };

/**
 * Refusals that are a normal part of sweeping a selection rather than a fault.
 *
 * A supervisor selecting a whole column will routinely catch orders that
 * another terminal already moved, that sit outside their facility, or that have
 * not had their per-order values captured yet. None of those is an error worth
 * failing the run over — they are reported and the rest proceed.
 *
 * Matched on the message because the guards throw plain Errors; anything that
 * does not match is treated as a genuine failure, so a new refusal shows up
 * loudly rather than being silently swallowed as a skip.
 */
const SKIP_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /^Order .* not found$/, label: "no longer exists" },
  { re: /^Forbidden: no entitlement for facility/, label: "outside your facility" },
  // canTransition() refuses both a backwards move and a move out of a terminal
  // status (DISPATCHED_TO_STORE / CANCELLED / UNFULFILLABLE all allow nothing).
  { re: /^Invalid transition/, label: "already at or past this step" },
  { re: /^Missing required field/, label: "missing a required value" },
];

function classify(e: unknown): { outcome: BulkOutcome; reason: string } {
  const msg = e instanceof Error ? e.message : "Something went wrong";
  for (const p of SKIP_PATTERNS) {
    if (p.re.test(msg)) return { outcome: "skipped", reason: msg };
  }
  return { outcome: "failed", reason: msg };
}

/** Hard ceiling on one call. A selection larger than a warehouse ever dispatches
 *  at once is a runaway client, not a workflow. */
const MAX_BULK = 500;

/**
 * Advance many orders to the same status in one round trip.
 *
 * `sharedCaptures` is the one-truck case: the five dispatch fields are entered
 * once and applied to every selected order. It is validated against the
 * transition's allowlist ONCE, up front, so a forged key fails the whole
 * request before anything is written rather than producing 200 identical
 * per-order failures.
 *
 * Per-order results mirror the eShipz partial-success shape: a run with skips
 * is a success, not a regression.
 */
export async function advanceOrdersBulk(input: {
  orderIds: string[];
  toStatus: OrderStatus;
  sharedCaptures?: Partial<Order>;
  note?: string;
}): Promise<BulkResult> {
  try {
    const user = await currentUser();
    // Role-level right is all-or-nothing, so it fails the call rather than
    // every order in it. Facility entitlement is per-order and lives below.
    assertCan(user, "canEditWarehouse");

    // De-duplicate: a shift-click range and a "select all in column" overlap
    // constantly, and advancing the same order twice would append two events.
    const orderIds = [...new Set(input.orderIds.filter((s) => typeof s === "string" && s.trim()))];
    if (orderIds.length === 0) throw new Error("Select at least one order.");
    if (orderIds.length > MAX_BULK) throw new Error(`Select at most ${MAX_BULK} orders at once.`);

    // Validate the shared captures against THIS transition's allowlist before
    // touching anything. advanceOne re-runs the same check per order; this pass
    // exists so a rejected key is one clean error, not N.
    const captures = allowedCaptures(input.toStatus, input.sharedCaptures ?? {});

    const results: BulkOrderResult[] = [];
    // Sequential on purpose: these are guarded read-modify-writes that append
    // events, and a parallel fan-out over a whole column would both hammer the
    // pool and scramble event ordering for no wall-clock win that matters here.
    for (const soNumber of orderIds) {
      try {
        await advanceOne(user, soNumber, input.toStatus, captures, input.note, (order) =>
          assertForward(order.status, input.toStatus),
        );
        results.push({ soNumber, outcome: "ok" });
      } catch (e) {
        results.push({ soNumber, ...classify(e) });
      }
    }

    const advanced = results.filter((r) => r.outcome === "ok").length;
    // One revalidate for the whole batch, not one per order.
    if (advanced > 0) revalidatePath("/", "layout");

    return {
      ok: true,
      toStatus: input.toStatus,
      total: results.length,
      advanced,
      skipped: results.filter((r) => r.outcome === "skipped").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      results,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}
