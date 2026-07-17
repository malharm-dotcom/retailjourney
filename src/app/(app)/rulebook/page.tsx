// Distribution Rulebook (PRD §6.6, §7) — the weekly schedule grid, store master
// and lane/zone view. Reads LIVE, view-only, from the Snowflake rulebook table
// (SNITCH_DB.MAPLEMONK.DISTRIBUTION_RULEBOOK) — a chosen monthly UPLOAD_DATE
// snapshot, flattened from the FRESH_/RPL_ columns into per-store × order-type
// rows. Advisory only, never blocking. No edit path (out of scope).

import { PageHead } from "@/components/shell/page-head";
import { flattenRulebook } from "@/lib/rulebook-map";
import { repo } from "@/lib/repo";
import { requireSession } from "@/lib/session";
import { snowflakeConfigured } from "@/lib/snowflake";
import { readRulebookSnapshot } from "@/lib/snowflake-rulebook";
import { RulebookTabs } from "./tabs";

export const metadata = { title: "Rulebook" };
export const dynamic = "force-dynamic";

export default async function RulebookPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { user, scope } = await requireSession();
  const { v } = await searchParams;
  const stores = (await repo.listStores())
    .filter((s) => scope === "ALL" || s.facility === scope)
    .filter((s) => (user.role === "RETAIL_HEAD" && user.areaManager ? s.areaManager === user.areaManager : true));

  // Live read — a specific version (?v=) or the latest snapshot. Degrades to an
  // empty state where the Snowflake source isn't configured (local dev).
  const snap = snowflakeConfigured()
    ? await readRulebookSnapshot(v)
    : { snapshots: [], uploadDate: null, rows: [] };
  const rules = flattenRulebook(snap.rows);

  return (
    <>
      <PageHead
        title="Distribution rulebook"
        sub={
          snap.uploadDate
            ? `Live from Snowflake · version ${snap.uploadDate} · ${snap.snapshots.length} snapshots retained. Suggested timelines per store × order type — advisory colouring only, the floor is never blocked.`
            : "The live rulebook source is not configured in this environment."
        }
      />
      <RulebookTabs
        stores={stores}
        rules={rules}
        snapshots={snap.snapshots}
        version={snap.uploadDate}
      />
    </>
  );
}
