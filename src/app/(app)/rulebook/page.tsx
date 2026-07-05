// Distribution Rulebook (PRD §6.6, §7) — the weekly schedule grid, store
// master and lane/zone view. Versioned monthly; advisory only, never blocking.

import { PageHead } from "@/components/shell/page-head";
import { repo } from "@/lib/repo";
import { requireSession } from "@/lib/session";
import { istToday } from "@/lib/ist";
import { RULEBOOK_VERSIONS } from "@/lib/seed/rulebook";
import { RulebookTabs } from "./tabs";

export const metadata = { title: "Rulebook" };
export const dynamic = "force-dynamic";

export default async function RulebookPage() {
  const { user, scope } = await requireSession();
  const today = istToday();
  const stores = repo
    .listStores()
    .filter((s) => scope === "ALL" || s.facility === scope)
    .filter((s) => (user.role === "RETAIL_HEAD" && user.areaManager ? s.areaManager === user.areaManager : true));
  const rules = repo
    .listRules()
    .filter((r) => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo >= today));
  const current = RULEBOOK_VERSIONS[RULEBOOK_VERSIONS.length - 1];

  return (
    <>
      <PageHead
        title="Distribution rulebook"
        hashAfterWord={1}
        sub={`Suggested timelines per store × order type — advisory colouring only, the floor is never blocked. Version effective ${current.from}, ${RULEBOOK_VERSIONS.length} monthly versions retained.`}
      />
      <RulebookTabs stores={stores} rules={rules} isAdmin={user.role === "ADMIN"} />
    </>
  );
}
