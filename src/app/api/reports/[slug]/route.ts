// CSV download endpoint for the Reports desk.
//
// A route handler rather than a server action because the deliverable is a
// FILE: the browser's own download machinery wants a GET with a
// Content-Disposition, which lets the four forms on /reports be plain
// `<form method="get">` elements with no client JavaScript at all.
//
// Middleware already bounces unauthenticated traffic, but it is the coarse net
// and runs on the edge — this re-checks the session itself, the same way every
// other handler and action in the app does.

import type { NextRequest } from "next/server";
import { currentScope, currentUserOrNull } from "@/lib/session";
import { FilterError, buildDownload, downloadBySlug, downloadScope } from "@/lib/reports-download";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const user = await currentUserOrNull();
  // 401, not a redirect to the login HTML: the caller here is a download, and a
  // 307 to a page it cannot render is not something it can act on.
  if (!user) return new Response("Unauthorized", { status: 401 });

  const def = downloadBySlug(params.slug);
  if (!def) return new Response("No such report", { status: 404 });

  const q = req.nextUrl.searchParams;
  // The session's own scope is the ceiling; the facility parameter may only
  // narrow inside it. downloadScope enforces that — this handler never reads a
  // facility straight off the query string.
  const scope = downloadScope(user, await currentScope(user), q.get("facility") ?? undefined);

  try {
    const { filename, csv, rowCount } = await buildDownload(def.slug, scope, user, {
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
      courier: q.get("courier") ?? undefined,
      lane: q.get("lane") ?? undefined,
    });

    // The BOM is not optional: without it Excel on Windows decodes the file as
    // the system codepage and every non-ASCII store name arrives mangled.
    // Written as an escape because a bare U+FEFF in source is invisible.
    return new Response(`\uFEFF${csv}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        // A facility-scoped export must never be held by a shared cache.
        "cache-control": "no-store, private",
        "x-report-rows": String(rowCount),
      },
    });
  } catch (e) {
    if (e instanceof FilterError) return new Response(e.message, { status: 400 });
    console.error(`[reports] ${def.slug} download failed`, e);
    return new Response("Report failed — see server logs", { status: 500 });
  }
}
