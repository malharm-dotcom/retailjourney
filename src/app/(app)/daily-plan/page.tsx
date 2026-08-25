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
import { loadDailyPlan, planFacilities, type DailyPlan, type PlanRow, type PlanSection } from "@/lib/daily-plan";
import { fmtDate, fmtDateTime, isoFromIstNtz, istDateFromNtz } from "@/lib/ist";
import { requireSession } from "@/lib/session";
import { snowflakeConfigured } from "@/lib/snowflake";
import { cn } from "@/lib/ui";

export const metadata = { title: "Daily Plan" };

// Reads the session to scope facilities, so it must never be statically
// rendered — one team's work list must not be baked into another's page.
export const dynamic = "force-dynamic";

/** Snowflake NTZ strings are IST wall clock. Convert to the true instant first
 *  (isoFromIstNtz), then format in Asia/Kolkata — never a naive +5:30 on top of
 *  a value that has already been converted. */
const ts = (v?: string) => fmtDateTime(isoFromIstNtz(v));
const day = (v?: string) => fmtDate(istDateFromNtz(v));
const text = (v?: string) => v ?? "—";

/** The emailer's rule, unchanged: a manifest stamp means it was picked up. */
function PickupChip({ pickedUp }: { pickedUp: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-r-[3px] border-l-[3px] px-2 py-0.5 text-meta font-semibold",
        pickedUp ? "border-l-deliv bg-deliv-bg text-deliv" : "border-l-breach bg-breach-bg text-breach",
      )}
      title={pickedUp ? "Manifested — picked up" : "Not manifested — action required"}
    >
      <Icon name={pickedUp ? "check-circle-bold" : "danger-triangle-bold"} size={13} />
      {pickedUp ? "Picked up" : "Pending"}
    </span>
  );
}

const COLS: { h: string; v: (r: PlanRow) => React.ReactNode; label?: true }[] = [
  { h: "Status", v: (r) => <PickupChip pickedUp={r.pickedUp} />, label: true },
  { h: "Order date", v: (r) => day(r.orderDate), label: true },
  { h: "Order", v: (r) => r.orderName, label: true },
  { h: "Store", v: (r) => text(r.store), label: true },
  { h: "Warehouse", v: (r) => text(r.warehouse), label: true },
  { h: "Type", v: (r) => text(r.orderType), label: true },
  { h: "Qty", v: (r) => r.quantity ?? "—" },
  { h: "TAT", v: (r) => ts(r.tat), label: true },
  { h: "Handover date", v: (r) => day(r.handoverDate), label: true },
  { h: "Manifested", v: (r) => ts(r.manifestedAt), label: true },
  { h: "Lane", v: (r) => text(r.lane), label: true },
  { h: "AWB", v: (r) => text(r.tracking), label: true },
  { h: "Courier", v: (r) => text(r.courier), label: true },
  { h: "Final status", v: (r) => text(r.finalStatus), label: true },
];

function Counts({ s }: { s: PlanSection }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-dense font-semibold">
      <span className="text-ink">{s.total.toLocaleString("en-IN")} orders</span>
      <span className="text-deliv">{s.manifested.toLocaleString("en-IN")} picked up</span>
      <span className="text-breach">{s.pending.toLocaleString("en-IN")} pending</span>
    </div>
  );
}

function PlanTable({
  title,
  sub,
  s,
  empty,
}: {
  title: string;
  sub: string;
  s: PlanSection;
  empty: string;
}) {
  return (
    <section className="mb-5 overflow-hidden rounded-card bg-card shadow-card">
      <header className="border-b border-line px-5 py-4">
        <h2 className="font-display text-title font-bold leading-snug tracking-tight">{title}</h2>
        <p className="mt-1 text-dense leading-relaxed text-mute">{sub}</p>
        <Counts s={s} />
      </header>
      {/* Fourteen columns is what the email carries, so the table scrolls inside
          its own card rather than squeezing cells past legibility. */}
      <div className="max-h-[58vh] overflow-auto">
        <table className="w-full min-w-[1240px] border-collapse text-left">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
              {COLS.map((c) => (
                <th key={c.h} className={cn("bg-paper px-4 py-3 font-semibold first:px-5", !c.label && "text-right")}>
                  {c.h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.length === 0 ? (
              <tr>
                <td colSpan={COLS.length} className="px-6 py-10 text-center text-sm text-mute">
                  {empty}
                </td>
              </tr>
            ) : (
              s.rows.map((r, i) => (
                <tr key={`${r.orderName}-${i}`} className="border-b border-line text-dense last:border-b-0">
                  {COLS.map((c) => (
                    <td
                      key={c.h}
                      className={cn(
                        "px-4 py-2.5 text-ink-soft first:px-5",
                        c.label ? "" : "mono text-right",
                        c.h === "Order" && "font-semibold text-ink",
                      )}
                    >
                      {c.v(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

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
          Computed live against the same relative-date windows the 08:27 mail uses, so this shows the same orders
          all day and rolls over with the date — not at the time the mail was sent. The mail keeps running; this is
          the always-available copy of it.
        </span>
      </p>

      {plan ? (
        <>
          <PlanTable
            title="To process"
            sub="Orders whose warehouse TAT falls inside the emailer's window, earliest TAT first."
            s={plan.process}
            empty="Nothing due for processing in this window."
          />
          <PlanTable
            title="To handover"
            sub="Orders whose handover (pickup) date is the emailer's next-day boundary."
            s={plan.handover}
            empty="Nothing due for handover."
          />
        </>
      ) : (
        <Unavailable reason={failure!} />
      )}
    </>
  );
}
