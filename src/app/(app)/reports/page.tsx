// Reports desk (PRD §10) — the Distribution 2.0 panels at a glance, then every
// leg's drill-down report.

import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { KpiCard } from "@/components/ui/kpi";
import { fmtDate } from "@/lib/ist";
import { REPORTS } from "@/lib/reports";
import { kpiTone, loadDashboard, type DashboardData } from "@/lib/reports-dashboard";
import { requireSession } from "@/lib/session";
import { snowflakeConfigured } from "@/lib/snowflake";
import { cn } from "@/lib/ui";

export const metadata = { title: "Reports" };

// Reads the facility cookie via requireSession, so it can never be statically
// rendered — one user's facility must not be baked into another's page.
export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const days = (v: number | null) => (v == null ? "—" : v.toFixed(1));

/** A table column: header, how to read a row, and whether it is a figure
 *  (right-aligned, tabular) or a label. */
interface Col<T> {
  h: string;
  v: (r: T) => string | number;
  label?: true;
}

function Panel<T>({
  title,
  sub,
  caption,
  cols,
  rows,
  empty,
}: {
  title: string;
  sub: string;
  caption?: string;
  cols: Col<T>[];
  rows: T[];
  empty: string;
}) {
  return (
    <section className="mb-5 overflow-hidden rounded-card bg-card shadow-card">
      <header className="border-b border-line px-5 py-4">
        <h2 className="font-display text-title font-bold leading-snug tracking-tight">{title}</h2>
        <p className="mt-1 text-dense leading-relaxed text-mute">{sub}</p>
        {caption ? (
          <p className="mt-2.5 flex items-start gap-1.5 rounded-control bg-paper px-3 py-2 text-dense leading-relaxed text-ink-soft">
            <Icon name="info-circle-bold-duotone" size={15} className="mt-[2px] shrink-0 text-mute" />
            <span>{caption}</span>
          </p>
        ) : null}
      </header>
      <div className="max-h-[52vh] overflow-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
              {cols.map((c) => (
                <th
                  key={c.h}
                  className={cn("bg-paper px-4 py-3 font-semibold first:px-5", !c.label && "text-right")}
                >
                  {c.h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length} className="px-6 py-10 text-center text-sm text-mute">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-b border-line text-dense last:border-b-0">
                  {cols.map((c) => (
                    <td
                      key={c.h}
                      className={cn(
                        "px-4 py-2.5 text-ink-soft first:px-5",
                        c.label ? "font-semibold text-ink" : "mono text-right",
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

function Dashboard({ data }: { data: DashboardData }) {
  return (
    <>
      <div className="mb-5 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
        {data.kpis.map((k) => (
          <KpiCard
            key={k.key}
            icon={k.icon}
            tone={kpiTone(k.pct)}
            label={k.label}
            value={pct(k.pct)}
            // The date is never "yesterday" as a word: IDEAL_DELIVERY_DATE has
            // no weekend rows, so the honest label is the day actually measured.
            sub={k.asOf ? `${fmtDate(k.asOf)} IST · ${k.n} rows` : "no data yet"}
          />
        ))}
      </div>

      <Panel
        title="Distribution Journey SLAs"
        sub="By ideal delivery date — the newest 14 delivery dates in your scope."
        caption="This table is anchored on IDEAL_DELIVERY_DATE, so only Perfect Order% should be read as a headline SLA here. The functional SLA% columns are journey-anchored, not function-anchored — read those from the tiles above."
        rows={data.trend}
        empty="No delivery dates in range."
        cols={[
          { h: "Ideal delivery date", v: (r) => fmtDate(r.idealDeliveryDate), label: true },
          { h: "Total orders", v: (r) => r.totalOrders },
          { h: "Order SLA%", v: (r) => pct(r.orderPct) },
          { h: "WH processing SLA%", v: (r) => pct(r.whPct) },
          { h: "Pickup SLA%", v: (r) => pct(r.pickupPct) },
          { h: "Delivery SLA%", v: (r) => pct(r.deliveryPct) },
          { h: "Perfect order%", v: (r) => pct(r.perfectPct) },
        ]}
      />

      <Panel
        title="Courier partner performance"
        sub={`Rolled up over the last ${data.windowDays} delivery dates.`}
        rows={data.couriers}
        empty="No shipments in range."
        cols={[
          { h: "Courier partner", v: (r) => r.courier, label: true },
          { h: "Total AWBs", v: (r) => r.awbs },
          { h: "Box count", v: (r) => r.boxes },
          { h: "Pickup SLA%", v: (r) => pct(r.pickupPct) },
          { h: "Delivery SLA%", v: (r) => pct(r.deliveryPct) },
          { h: "Breached", v: (r) => r.breached },
          { h: "P2D avg days", v: (r) => days(r.p2dAvg) },
          { h: "P2D ≤5d %", v: (r) => pct(r.p2dLe5Pct) },
          { h: "On-time attempt%", v: (r) => pct(r.onTimeAttemptPct) },
        ]}
      />

      <Panel
        title="Lane-wise performance"
        sub={`North Star view — lane × warehouse, last ${data.windowDays} delivery dates.`}
        rows={data.lanes}
        empty="No lanes in range."
        cols={[
          { h: "Lane", v: (r) => r.lane, label: true },
          { h: "Warehouse", v: (r) => r.warehouse, label: true },
          { h: "Box count", v: (r) => r.boxes },
          { h: "Total shipments", v: (r) => r.shipments },
          { h: "FASR%", v: (r) => pct(r.fasrPct) },
          { h: "On-time attempt%", v: (r) => pct(r.onTimeAttemptPct) },
          { h: "On-time delivery%", v: (r) => pct(r.onTimeDeliveryPct) },
          { h: "P50 days", v: (r) => days(r.p50) },
          { h: "P90 days", v: (r) => days(r.p90) },
          { h: "Perfect order%", v: (r) => pct(r.perfectPct) },
          { h: "Delivered%", v: (r) => pct(r.deliveredPct) },
        ]}
      />
    </>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <section className="mb-5 flex items-start gap-2.5 rounded-card bg-card px-5 py-4 shadow-card">
      <Icon name="danger-triangle-bold-duotone" size={18} className="mt-[1px] shrink-0 text-pending" />
      <div>
        <h2 className="font-display text-title font-bold leading-snug tracking-tight">
          At-a-glance panels unavailable
        </h2>
        <p className="mt-1 text-dense leading-relaxed text-mute">{reason}</p>
      </div>
    </section>
  );
}

export default async function ReportsPage() {
  const { user, scope } = await requireSession();
  // RETAIL_HEAD is narrowed to its own area manager everywhere else (see
  // scopedOrders); the spine carries AREA_MANAGER, so the same narrowing applies
  // here rather than this one surface showing them the whole country.
  const areaManager = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;

  // A Snowflake outage must degrade the panels, not take the whole Reports desk
  // down — the eight drill-down reports below run off Postgres and are fine.
  let panels: DashboardData | undefined;
  let failure: string | undefined;
  if (!snowflakeConfigured()) {
    failure = "Snowflake is not configured in this environment, so the Distribution 2.0 panels cannot be read.";
  } else {
    try {
      panels = await loadDashboard(scope, areaManager);
    } catch (e) {
      failure = `Could not read the spine: ${(e as Error).message}`;
    }
  }

  return (
    <>
      <PageHead
        title="Reports desk"
        sub="Distribution 2.0 at a glance, then filterable slices of the whole journey — scoped to your facility view."
      />
      {panels ? <Dashboard data={panels} /> : <Unavailable reason={failure!} />}

      <h2 className="mb-3.5 mt-7 font-display text-title font-bold leading-snug tracking-tight">
        Drill-down reports
      </h2>
      {/* No staggered entrance. Eight static tiles animating in on a 45ms cascade
          is choreography the reader has to wait out on every visit, and it told
          them nothing — the stagger implied an order that does not exist. The
          hover lift stays: these ARE links. */}
      <div className="grid gap-3.5 pb-8 sm:grid-cols-2 xl:grid-cols-4">
        {REPORTS.map((r) => (
          <Link
            key={r.slug}
            href={`/reports/${r.slug}`}
            className="group rounded-card bg-card p-5 shadow-card transition-[transform,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-lift motion-reduce:hover:translate-y-0"
          >
            <span className="grid h-10 w-10 place-items-center rounded-control bg-sage-soft text-sage transition-colors duration-150 ease-ui group-hover:bg-sage group-hover:text-white">
              <Icon name={r.icon} size={21} />
            </span>
            <h3 className="mt-3.5 font-display text-title font-bold leading-snug tracking-tight">{r.title}</h3>
            <p className="mt-1.5 text-dense leading-relaxed text-mute">{r.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
