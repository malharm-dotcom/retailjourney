// On-demand sync trigger (admin-only) — used by the Admin "Sync now" button's
// server action for UI flows and by curl for pipeline testing:
//   POST /api/sync/run          → run the 15-min sources (eShipz poller)
//   POST /api/sync/run {"source":"ESHIPZ"|"SNOWFLAKE"} → run one

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { buildAuthOptions } from "@/lib/auth";
import { recordFailedRun, runAllSyncs, runEshipzSync, runSnowflakeSync, type SyncSummary } from "@/lib/integrations/sync";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(buildAuthOptions());
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  let source: string | undefined;
  try {
    const body = (await req.json()) as { source?: string };
    source = body?.source;
  } catch {
    // empty body = run all
  }
  try {
    let summaries: SyncSummary[];
    if (source === "ESHIPZ") summaries = [await runEshipzSync()];
    else if (source === "SNOWFLAKE") summaries = [await runSnowflakeSync()];
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
