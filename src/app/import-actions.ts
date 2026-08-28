"use server";

// The CSV import surface for the two per-order-detail transitions.
//
// Two actions, both taking the SAME file text: preview validates and writes
// NOTHING, run re-validates and writes. The confirm step deliberately re-sends
// the file rather than the preview's parsed rows — a client that could hand
// back doctored rows would be a way around every check the preview just made,
// and re-parsing costs nothing next to the writes.
//
// This is a THIRD CALLER of advanceOne, not a second write path. Same facility
// assert, same REQUIRED_CAPTURES allowlist, same repo.transitionStatus with its
// ladder check and server-derived timestamps, same assertForward the bulk sweep
// adds. Nothing about the guards changes because a row arrived in a file.

import { revalidatePath } from "next/cache";
import { advanceOne, assertForward } from "@/lib/advance";
import { MAX_IMPORT_ROWS, parseImportRows, stageRefusal, type ImportTarget } from "@/lib/csv-import";
import { assertCan, entitledFacilities } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import { currentUser } from "@/lib/session";
import type { Order, OrderStatus, User } from "@/lib/types";

/** Server-action payloads are capped by Next at 1MB; this refuses a file long
 *  before the framework does, with a sentence an operator can act on. 500 rows
 *  of these columns is well under 100KB. */
const MAX_TEXT_BYTES = 512 * 1024;

export interface ImportPreviewRow {
  line: number;
  soNumber: string;
  /** ready = will be attempted. skip = a normal refusal (wrong stage, already
   *  advanced, out of scope). error = the row itself is wrong. */
  verdict: "ready" | "skip" | "error";
  reason?: string;
  /** Context so the operator can recognise the order without leaving the
   *  dialog. Absent when the SO was not found. */
  store?: string;
  currentStage?: OrderStatus;
}

export type ImportPreview =
  | { ok: true; to: ImportTarget; rows: ImportPreviewRow[]; ready: number; skipped: number; invalid: number }
  | { ok: false; error: string };

export interface ImportRowResult {
  soNumber: string;
  success: boolean;
  error: string | null;
}

export type ImportRun =
  | { ok: true; to: ImportTarget; moved: number; skipped: number; results: ImportRowResult[] }
  | { ok: false; error: string };

/**
 * The shared front half: who is asking, may they, and what does the file say.
 *
 * Both actions run this so a file that previews clean cannot be confirmed
 * through a different set of checks.
 */
async function plan(to: ImportTarget, csvText: string) {
  const user = await currentUser();
  // Role right is all-or-nothing — it fails the call, not each row. Facility
  // entitlement is per-order and is checked below AND again in advanceOne.
  assertCan(user, "canEditWarehouse");
  if (typeof csvText !== "string" || csvText.trim() === "") throw new Error("That file is empty.");
  if (csvText.length > MAX_TEXT_BYTES) {
    throw new Error(`That file is too large — import at most ${MAX_IMPORT_ROWS} rows at a time.`);
  }
  const parsed = parseImportRows(to, csvText);
  if (parsed.error) throw new Error(parsed.error);
  return { user, rows: parsed.rows };
}

/**
 * The order-dependent verdict for one parsed row: does the SO exist, is it in
 * the caller's scope, and is it at the stage this import moves from.
 *
 * Facility is judged on ENTITLEMENT, not on the facility cookie: the cookie is
 * a view preference that resolveScope already clamps, while entitlement is what
 * advanceOne will actually enforce on the write. Judging the preview by
 * anything looser would promise a move the write then refuses.
 */
function scopeOf(user: Pick<User, "role" | "facilities">): Set<string> {
  return new Set<string>(entitledFacilities(user));
}

function verdictFor(
  to: ImportTarget,
  order: Order | undefined,
  scope: Set<string>,
): { verdict: "ready" | "skip"; reason?: string } {
  if (!order) return { verdict: "skip", reason: "SO not found" };
  if (!scope.has(order.facility)) return { verdict: "skip", reason: "out of scope" };
  const refusal = stageRefusal(to, order.status);
  return refusal ? { verdict: "skip", reason: refusal } : { verdict: "ready" };
}

/**
 * DRY RUN. Reads orders, writes nothing, and reports every row with the reason
 * it will or will not move. Nothing is written until runCsvImport is called.
 */
export async function previewCsvImport(input: { to: ImportTarget; csvText: string }): Promise<ImportPreview> {
  try {
    const { user, rows } = await plan(input.to, input.csvText);
    const scope = scopeOf(user);

    const out: ImportPreviewRow[] = [];
    // ponytail: one getOrder per row, sequentially — the same N reads the write
    // pass does anyway, and there is no batch read on the repo interface to
    // reuse. Add repo.getOrders(sos) if a 500-row preview ever feels slow.
    for (const r of rows) {
      if (r.error) {
        out.push({ line: r.line, soNumber: r.soNumber, verdict: "error", reason: r.error });
        continue;
      }
      const order = await repo.getOrder(r.soNumber);
      const { verdict, reason } = verdictFor(input.to, order, scope);
      out.push({
        line: r.line,
        soNumber: r.soNumber,
        verdict,
        reason,
        store: order?.finalStore,
        currentStage: order?.status,
      });
    }

    return {
      ok: true,
      to: input.to,
      rows: out,
      ready: out.filter((r) => r.verdict === "ready").length,
      skipped: out.filter((r) => r.verdict === "skip").length,
      invalid: out.filter((r) => r.verdict === "error").length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}

/**
 * THE WRITE. Every row goes through advanceOne independently: one row failing
 * reports itself and the batch carries on, exactly as the bulk sweep does.
 *
 * Rows the preview would have refused are reported rather than attempted, and
 * anything that changed between preview and confirm is caught by advanceOne's
 * own guards — the verdict here is re-derived, never taken from the client.
 */
export async function runCsvImport(input: { to: ImportTarget; csvText: string }): Promise<ImportRun> {
  try {
    const { user, rows } = await plan(input.to, input.csvText);
    const scope = scopeOf(user);

    const results: ImportRowResult[] = [];
    // Sequential for the same reason the bulk sweep is: these are guarded
    // read-modify-writes that append events, and fanning them out would
    // scramble event ordering and hammer the pool for no useful win.
    for (const r of rows) {
      if (r.error) {
        results.push({ soNumber: r.soNumber || `row ${r.line}`, success: false, error: r.error });
        continue;
      }
      const order = await repo.getOrder(r.soNumber);
      const { verdict, reason } = verdictFor(input.to, order, scope);
      if (verdict !== "ready") {
        results.push({ soNumber: r.soNumber, success: false, error: reason ?? "skipped" });
        continue;
      }
      try {
        await advanceOne(user, r.soNumber, input.to, r.captures, r.note, (o) =>
          assertForward(o.status, input.to),
        );
        results.push({ soNumber: r.soNumber, success: true, error: null });
      } catch (e) {
        results.push({
          soNumber: r.soNumber,
          success: false,
          error: e instanceof Error ? e.message : "Something went wrong",
        });
      }
    }

    const moved = results.filter((r) => r.success).length;
    // One revalidate for the whole file, not one per row.
    if (moved > 0) revalidatePath("/", "layout");
    return { ok: true, to: input.to, moved, skipped: results.length - moved, results };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}
