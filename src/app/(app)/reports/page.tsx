// Reports desk (PRD §10) — the Distribution 2.0 numbers at a glance, then the
// files and the drill-downs.
//
// Three things live here and they are deliberately kept apart on screen: the
// KPI strip (how are we doing), the panels (one at a time, because three
// stacked 11-column tables is a wall nobody reads), and then Files &
// drill-downs. The panel caveats are load-bearing and still ship with the
// panel — folded into a <details> rather than deleted, so the default view is
// numbers and the footnotes are one click away.

import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { KpiCard } from "@/components/ui/kpi";
import { Input, Select } from "@/components/ui/primitives";
import { LinkTabs } from "@/components/ui/tabs";
import { addDays, fmtDate, istToday } from "@/lib/ist";
import { REPORTS } from "@/lib/reports";
import { kpiTone, loadDashboard, type DashboardData } from "@/lib/reports-dashboard";
import {
  DEFAULT_WINDOW_DAYS,
  DOWNLOADS,
  selectableFacilities,
  type DownloadDef,
} from "@/lib/reports-download";
import { requireSession } from "@/lib/session";
import { snowflakeConfigured } from "@/lib/snowflake";
import type { Facility } from "@/lib/types";
import { cn } from "@/lib/ui";

export const metadata = { title: "Reports" };

// Reads the facility cookie via requireSession, so it can never be statically
// rendered — one user's facility must not be baked into another's page.
export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const days = (v: number | null) => (v == null ? "—" : v.toFixed(1));

const SECTION = "font-display text-sec font-bold text-ink";
const SECTION_SUB = "mt-1.5 max-w-[68ch] text-dense leading-relaxed text-mute";

/** A table column: header, how to read a row, and whether it is a figure
 *  (right-aligned, tabular) or a label. */
interface Col<T> {
  h: string;
  v: (r: T) => string | number;
  label?: true;
}

const PANELS = [
  { value: "sla", label: "Journey SLAs" },
  { value: "courier", label: "Couriers" },
  { value: "lane", label: "Lanes" },
] as const;

type PanelKey = (typeof PANELS)[number]["value"];

function Panel<T>({
  sub,
  notes,
  cols,
  rows,
  empty,
}: {
  sub: string;
  /** Load-bearing caveats about how to read the panel. Folded, never dropped. */
  notes?: string[];
  cols: Col<T>[];
  rows: T[];
  empty: string;
}) {
  return (
    <section className="overflow-hidden rounded-card bg-card shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <p className="max-w-[80ch] text-dense leading-relaxed text-mute">{sub}</p>
        {notes?.length ? (
          // <details>, not a modal and not three grey paragraphs above the
          // numbers: the caveats matter to whoever is about to quote a figure,
          // and to nobody else in the room.
          <details className="min-w-0 basis-full text-dense">
            <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-control px-2 py-1 font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:text-sage">
              <Icon name="info-circle-bold-duotone" size={15} className="shrink-0 text-mute" />
              How to read this ({notes.length})
            </summary>
            <div className="mt-2 space-y-2 rounded-control bg-paper px-3.5 py-3">
              {notes.map((n) => (
                <p key={n} className="max-w-[86ch] leading-relaxed text-ink-soft">
                  {n}
                </p>
              ))}
            </div>
          </details>
        ) : null}
      </header>
      <div className="max-h-[58vh] overflow-auto">
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
                <tr
                  key={i}
                  className="border-b border-line text-dense transition-colors duration-150 ease-ui last:border-b-0 hover:bg-paper"
                >
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

function Dashboard({ data, panel }: { data: DashboardData; panel: PanelKey }) {
  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
        {data.kpis.map((k) => (
          <KpiCard
            key={k.key}
            icon={k.icon}
            tone={kpiTone(k.pct)}
            label={k.label}
            value={pct(k.pct)}
            // Never labelled "yesterday". These are the totals row of the trend
            // table below — the same trailing window, ungrouped — which is what
            // the Metabase tiles measure too.
            sub={`last ${data.windowDays}d IST · ${data.totalOrders.toLocaleString("en-IN")} orders`}
          />
        ))}
      </div>

      {/* One panel at a time. All three are the same window over the same
          source; stacking them only ever meant scrolling past two tables to
          reach the one being asked about. */}
      <div className="mb-3.5 mt-7 flex flex-wrap items-center justify-between gap-3">
        <h2 className={SECTION}>At a glance</h2>
        <LinkTabs items={PANELS} active={panel} name="panel" />
      </div>

      {panel === "sla" ? (
        <Panel
          sub={`By ideal delivery date — the newest 14 delivery dates in the last ${data.windowDays} days, in your scope.`}
          notes={[
            "This table is anchored on IDEAL_DELIVERY_DATE, so only Perfect Order% should be read as a headline SLA here. The functional SLA% columns are journey-anchored, not function-anchored — read those from the tiles above.",
            "Perfect Order% is recomputed as all four legs strictly within SLA, over every order in the window — an order with a leg still running counts against it. It is not the PERFECT_ORDER_SLA column, and it runs far lower than one.",
          ]}
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
      ) : panel === "courier" ? (
        <Panel
          sub={`AWBs created in the last ${data.windowDays} days, one row per courier.`}
          notes={[
            "Metabase breaks these same figures out per ideal delivery date; this panel rolls the whole window into one row per courier. Each cell is the same expression over the same window — it is a window total, not one of those daily rows.",
          ]}
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
      ) : (
        <Panel
          sub={`North Star view — lane × warehouse, picked up in the last ${data.windowDays} days.`}
          notes={[
            "FASR% is same-day: delivered on the day it first went out for delivery. A lane whose shipments never get an out-for-delivery scan — self-delivery, most milk runs — reads 0% here. That is missing evidence, not a failure.",
          ]}
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
      )}
    </>
  );
}

const FIELD_LABEL = "mb-1 block text-meta font-semibold uppercase tracking-[0.06em] text-mute";

/**
 * One download: a filter form and a button, no result grid.
 *
 * A plain `<form method="get">` pointed at the route handler, so the browser's
 * own download machinery does the work — no client component, no fetch, no
 * blob, and the whole thing keeps working with JavaScript off. The facility
 * select offers only what the session already allows; the server narrows again
 * regardless, because a select is a suggestion, not a permission.
 */
function DownloadCard({
  def,
  facilities,
  couriers,
  lanes,
  defaultFrom,
  defaultTo,
}: {
  def: DownloadDef;
  facilities: Facility[];
  couriers: string[];
  lanes: string[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const options = def.filter === "courier" ? couriers : def.filter === "lane" ? lanes : [];
  return (
    <form
      method="get"
      action={`/api/reports/${def.slug}`}
      className="flex flex-col rounded-card bg-card p-4 shadow-card"
    >
      {/* Icon beside the title rather than stacked above it: four of these sit
          in a grid, and the stacked version made each one 40px taller than the
          information in it justified. */}
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-sage-soft text-sage">
          <Icon name={def.icon} size={19} />
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-title font-bold leading-snug tracking-tight">{def.title}</h3>
          <p className="mt-1 text-dense leading-relaxed text-mute">{def.description}</p>
        </div>
      </div>

      <div className="mt-3.5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <label>
          <span className={FIELD_LABEL}>From</span>
          <Input type="date" name="from" defaultValue={defaultFrom} max={defaultTo} />
        </label>
        <label>
          <span className={FIELD_LABEL}>To</span>
          <Input type="date" name="to" defaultValue={defaultTo} />
        </label>
        <label>
          <span className={FIELD_LABEL}>Facility</span>
          <Select name="facility" defaultValue={facilities.length === 1 ? facilities[0] : "ALL"}>
            {facilities.length > 1 ? <option value="ALL">All my facilities</option> : null}
            {facilities.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </label>
        {def.filter ? (
          <label>
            <span className={FIELD_LABEL}>{def.filter === "courier" ? "Courier" : "Lane"}</span>
            <Select name={def.filter} defaultValue="">
              <option value="">All</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>

      <button
        type="submit"
        className="mt-3.5 flex items-center justify-center gap-1.5 self-start rounded-control bg-ink px-4 py-2 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85 active:scale-[0.97]"
      >
        <Icon name="download-minimalistic-bold" size={14} />
        Download CSV
      </button>
    </form>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <section className="flex items-start gap-2.5 rounded-card bg-card px-5 py-4 shadow-card">
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

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: { panel?: string };
}) {
  const { user, scope } = await requireSession();
  // RETAIL_HEAD is narrowed to its own area manager everywhere else (see
  // scopedOrders); the spine carries AREA_MANAGER, so the same narrowing applies
  // here rather than this one surface showing them the whole country.
  const areaManager = user.role === "RETAIL_HEAD" ? user.areaManager : undefined;

  const panel = (PANELS.find((p) => p.value === searchParams.panel)?.value ?? "sla") as PanelKey;

  const today = istToday();
  const defaultFrom = addDays(today, -DEFAULT_WINDOW_DAYS);
  // Only what the session already allows. The handler narrows again on every
  // request — this list is a convenience, never the enforcement.
  const facilities = selectableFacilities(user, scope);

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
      {panels ? <Dashboard data={panels} panel={panel} /> : <Unavailable reason={failure!} />}

      <h2 className={cn(SECTION, "mt-9")}>Files</h2>
      <p className={SECTION_SUB}>
        Filter, then download — these produce a file, not a table on screen. Leave the dates alone and you get
        the last {DEFAULT_WINDOW_DAYS} days.
      </p>
      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        {DOWNLOADS.map((d) => (
          <DownloadCard
            key={d.slug}
            def={d}
            facilities={facilities}
            // Option lists come off the panels already on this page: no extra
            // query, and the form can never offer a courier or lane the data
            // does not actually contain.
            couriers={panels?.couriers.map((c) => c.courier) ?? []}
            lanes={[...new Set(panels?.lanes.map((l) => l.lane) ?? [])].sort()}
            defaultFrom={defaultFrom}
            defaultTo={today}
          />
        ))}
      </div>

      <h2 className={cn(SECTION, "mt-9")}>Drill-down reports</h2>
      {/* Not a footnote. The panels above read the same table Metabase reads, so
          they match the dashboard — and that table drops orders the rulebook
          does not cover, which the reports below deliberately keep. Anyone who
          notices the two counts differ is seeing something real. */}
      <p className={SECTION_SUB}>
        These run on RetailJourney&rsquo;s own order spine and include out-of-rulebook orders, so they will not
        always agree with the panels above on totals.
      </p>
      {/* No staggered entrance. Eight static tiles animating in on a 45ms cascade
          is choreography the reader has to wait out on every visit, and it told
          them nothing — the stagger implied an order that does not exist. The
          hover lift stays: these ARE links. */}
      <div className="mt-3.5 grid gap-2.5 pb-10 sm:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map((r) => (
          <Link
            key={r.slug}
            href={`/reports/${r.slug}`}
            className="group flex items-start gap-3 rounded-card bg-card p-4 shadow-card transition-[transform,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-lift motion-reduce:hover:translate-y-0"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-sage-soft text-sage transition-colors duration-150 ease-ui group-hover:bg-sage group-hover:text-white">
              <Icon name={r.icon} size={19} />
            </span>
            <span className="min-w-0">
              <span className="block font-display text-title font-bold leading-snug tracking-tight">
                {r.title}
              </span>
              <span className="mt-1 block text-dense leading-relaxed text-mute">{r.description}</span>
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}
