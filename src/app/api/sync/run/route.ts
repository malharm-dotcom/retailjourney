// On-demand sync trigger (admin-only) — used by the Admin "Sync now" button's
// server action for UI flows and by curl for pipeline testing:
//   POST /api/sync/run          → run the 15-min sources (UC + eShipz)
//   POST /api/sync/run {"source":"UC"|"ESHIPZ"|"SNOWFLAKE"} → run one

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { buildAuthOptions } from "@/lib/auth";
import { runAllSyncs, runEshipzSync, runSnowflakeSync, runUcSync, type SyncSummary } from "@/lib/integrations/sync";

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
    if (source === "UC") summaries = [await runUcSync()];
    else if (source === "ESHIPZ") summaries = [await runEshipzSync()];
    else if (source === "SNOWFLAKE") summaries = [await runSnowflakeSync()];
    else summaries = await runAllSyncs();
    return NextResponse.json({ summaries });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sync failed" }, { status: 500 });
  }
}
