// Daily Plan — the WH Processing Emailer's two work lists, in the app.
//
// Named "Daily Plan" and NOT "Rulebook": /rulebook is already the distribution
// rulebook snapshot viewer (per-store targets, read from DISTRIBUTION_RULEBOOK)
// and taking that name would have overwritten a live tab. This sits under
// "The floor" beside Warehouse, because it is a shift's work list, not
// reference material.
//
// Read-only, and it does NOT replace the emailer — the 08:27 mail keeps
// running. See daily-plan.ts for why the queries are transcribed verbatim.

import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { loadDailyPlan, planFacilities, type DailyPlan } from "@/lib/daily-plan";
import { requireSession } from "@/lib/session";
import { snowflakeConfigured } from "@/lib/snowflake";
import { PlanBoard } from "./plan-board";

export const metadata = { title: "Daily Plan" };

// Reads the session to scope facilities, so it must never be statically
// rendered — one team's work list must not be baked into another's page.
export const dynamic = "force-dynamic";

function Unavailable({ reason }: { reason: string }) {
  return (
    <section className="mb-5 flex items-start gap-2.5 rounded-card bg-card px-5 py-4 shadow-card">
      <Icon name="danger-triangle-bold-duotone" size={18} className="mt-[1px] shrink-0 text-pending" />
      <div>
        <h2 className="font-display text-title font-bold leading-snug tracking-tight">Daily Plan unavailable</h2>
        <p className="mt-1 text-dense leading-relaxed text-mute">{reason}</p>
      </div>
    </section>
  );
}

export default async function DailyPlanPage() {
  const { user } = await requireSession();
  // Server-side, from the session user's entitlements — never a request
  // parameter, and deliberately not the single-facility cookie, which would
  // hide half of a South supervisor's warehouses. See planFacilities().
  const facilities = planFacilities(user);

  let plan: DailyPlan | undefined;
  let failure: string | undefined;
  if (!snowflakeConfigured()) {
    failure = "Snowflake is not configured in this environment, so the daily lists cannot be read.";
  } else {
    try {
      plan = await loadDailyPlan(facilities);
    } catch (e) {
      failure = `Could not read distribution_analytics: ${(e as Error).message}`;
    }
  }

  return (
    <>
      <PageHead
        title="Daily Plan"
        sub={`The same two lists the WH processing mail sends every morning — what to process and what to hand over — for ${facilities.join(", ")}.`}
      />

      {/* Load-bearing. Someone who opens this at 4pm and sees the morning's list
          needs to know that is correct, not stale. */}
      <p className="mb-5 flex items-start gap-1.5 rounded-control bg-card px-3.5 py-2.5 text-dense leading-relaxed text-ink-soft shadow-card">
        <Icon name="info-circle-bold-duotone" size={15} className="mt-[2px] shrink-0 text-mute" />
        <span>
          Today&rsquo;s work, on a 5am-to-5am operating day — the list is the same all day and rolls over at 5am,
          not when a mail was sent. Orders with no rulebook timeline, including every quick-commerce (QC) order,
          are included on a derived TAT of order date + 2 days and tagged <b className="font-semibold">off rulebook</b>.
          The 08:27 mail keeps running and covers a different day, so the two will not match.
        </span>
      </p>

      {plan ? (
        <PlanBoard plan={plan} />
      ) : (
        <Unavailable reason={failure!} />
      )}
    </>
  );
}
