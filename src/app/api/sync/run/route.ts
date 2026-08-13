// On-demand sync trigger (admin-only) — used by the Admin "Sync now" button's
// server action for UI flows and by curl for pipeline testing:
//   POST /api/sync/run          → run the 15-min sources (eShipz poller)
//   POST /api/sync/run {"source":"ESHIPZ"|"SNOWFLAKE"} → run one
//   POST /api/sync/run {"source":"SNOWFLAKE","reseed":true} → ignore the
//     stored watermark and force the full 20-day window (manual reseed)

import { NextResponse } from "next/server";
import { policyOf } from "@/lib/rbac";
import { currentUserOrNull } from "@/lib/session";
import { recordFailedRun, runAllSyncs, runEshipzSync, runSnowflakeSync, type SyncSummary } from "@/lib/integrations/sync";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Was a bare getServerSession + role compare, which was the one protected
  // route that skipped the `active` re-read every currentUser() call performs —
  // so a deactivated admin kept sync and full-reseed rights for the life of
  // their token. Same source of truth as every page now, still a 403 rather
  // than a redirect because the callers here are curl and fetch().
  const user = await currentUserOrNull();
  if (!user || !policyOf(user.role).isAdmin) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  let source: string | undefined;
  let reseed = false;
  try {
    const body = (await req.json()) as { source?: string; reseed?: boolean };
    source = body?.source;
    reseed = body?.reseed === true;
  } catch {
    // empty body = run all
  }
  try {
    let summaries: SyncSummary[];
    if (source === "ESHIPZ") summaries = [await runEshipzSync()];
    else if (source === "SNOWFLAKE") summaries = [await runSnowflakeSync({ reseed })];
    else summaries = await runAllSyncs();
    return NextResponse.json({ summaries });
  } catch (e) {
    // A throw before startRun (unconfigured source, dead connection) would
    // otherwise leave no SyncRun row at all — a failed manual trigger must
    // still turn the freshness strip red.
    const msg = e instanceof Error ? e.message : "sync failed";
    await recordFailedRun(source === "SNOWFLAKE" ? "SNOWFLAKE" : "ESHIPZ", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
