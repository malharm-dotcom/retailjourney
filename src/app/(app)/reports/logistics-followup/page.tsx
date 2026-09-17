// Logistics follow-up (PRD §10) — two views over ONE row set of in-transit
// dockets, so switching view can never change the count.
//
//   Breached list (default) — the flat block the team sends a courier: the
//     columns of their own shared sheet, in their order, worst-overdue first,
//     with a Copy button because the workflow is copy → paste into the mail.
//   Pivot — store × EDD (or × days past EDD), for seeing where the chases pile
//     up rather than for sending.
//
// A route of its own rather than a `/reports/[slug]` drill-down: it needs the
// view, EDD-source and column-mode controls, and the generic report shell has
// one fixed filter bar it shares with eight other reports. This static segment
// shadows [slug] for the same slug, so the tile on /reports still links here.

import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { Input, Select } from "@/components/ui/primitives";
import { LinkTabs } from "@/components/ui/tabs";
import { scopedOrders } from "@/lib/data";
import { addDays, fmtDate, istToday } from "@/lib/ist";
import { courierOf } from "@/lib/journey";
import {
  breachedRows,
  buildPivot,
  eddOf,
  inTransitDockets,
  NO_EDD,
  type ColumnMode,
  type EddSource,
} from "@/lib/logistics-followup";
import { downloadScope, selectableFacilities } from "@/lib/reports-download";
import { requireSession } from "@/lib/session";
import { cn } from "@/lib/ui";
import { BreachedActions, ExportButton } from "./export-button";

export const metadata = { title: "Logistics follow-up" };
export const dynamic = "force-dynamic";

/** Column window for EDD mode. Two weeks either side of today covers the
 *  overdue tail the follow-up chases and the promises about to come due,
 *  without ever letting the column axis run unbounded. */
const WINDOW_DAYS = 14;

const VIEWS = [
  { value: "breached", label: "EDD breached list" },
  { value: "pivot", label: "Store × EDD pivot" },
] as const;

const FIELD_LABEL = "mb-1 block text-meta font-semibold uppercase tracking-[0.06em] text-mute";

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const many = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** dd/MM/yyyy — what the courier sheet carries, so the screen and the pasted
 *  block read the same. */
const eddCell = (iso: string) => iso.split("-").reverse().join("/");

function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 flex max-w-[80ch] items-start gap-1.5 rounded-control bg-card px-3 py-2 text-dense leading-relaxed text-ink-soft">
      <Icon name="info-circle-bold-duotone" size={15} className="mt-[2px] shrink-0 text-mute" />
      <span>{children}</span>
    </p>
  );
}

export default async function LogisticsFollowupPage({ searchParams }: { searchParams: Search }) {
  const { user, scope: sessionScope } = await requireSession();
  // The session's scope is the ceiling; a `facility` parameter may only narrow
  // inside it. Same enforcement the CSV route handler uses — a select is a
  // suggestion, never a permission.
  const facilityParam = one(searchParams.facility);
  const scope = downloadScope(user, sessionScope, facilityParam);
  const facilities = selectableFacilities(user, sessionScope);

  const view = one(searchParams.view) === "pivot" ? "pivot" : "breached";
  const mode: ColumnMode = one(searchParams.mode) === "ageing" ? "ageing" : "edd";
  // The courier's own promise is what a courier gets chased about, so
  // "Logistics Delivery EDD" (`expectedDate`) is the default.
  const eddSource: EddSource = one(searchParams.edd) === "store" ? "store" : "courier";
  const couriers = many(searchParams.courier).filter(Boolean);

  const today = istToday();
  const from = one(searchParams.from) || addDays(today, -WINDOW_DAYS);
  const to = one(searchParams.to) || addDays(today, WINDOW_DAYS);

  const rows = await scopedOrders(scope, user);
  // Options come off the rows this report actually contains, so the filter can
  // never offer a courier with nothing behind it — and never hides a synced
  // spelling that the LOGISTICS_PARTNERS constant does not carry.
  const courierOptions = [...new Set(inTransitDockets(rows).map((r) => courierOf(r.order)))].sort();

  const eddLabel = eddSource === "store" ? "Store Delivery EDD" : "Logistics Delivery EDD";

  // Carried into the view links so switching view keeps the filters.
  const carried = new URLSearchParams();
  if (facilityParam) carried.set("facility", facilityParam);
  if (eddSource !== "courier") carried.set("edd", eddSource);
  for (const c of couriers) carried.append("courier", c);

  const filters = (
    <>
      <label>
        <span className={FIELD_LABEL}>EDD source</span>
        <Select name="edd" defaultValue={eddSource} className="w-[190px]">
          <option value="courier">Logistics Delivery EDD</option>
          <option value="store">Store Delivery EDD</option>
        </Select>
      </label>
      <label>
        <span className={FIELD_LABEL}>Facility</span>
        <Select name="facility" defaultValue={facilityParam ?? "ALL"} className="w-[180px]">
          {facilities.length > 1 ? <option value="ALL">All my facilities</option> : null}
          {facilities.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span className={FIELD_LABEL}>Courier — all if none picked</span>
        <Select
          name="courier"
          multiple
          size={Math.min(4, Math.max(2, courierOptions.length))}
          defaultValue={couriers}
          className="w-[200px] py-1"
        >
          {courierOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </label>
    </>
  );

  const backLink = (
    <Link
      href="/reports"
      className="flex items-center gap-1.5 rounded-control border border-line-control bg-paper px-3.5 py-2 text-dense font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:text-sage"
    >
      <Icon name="arrow-left-linear" size={14} />
      All reports
    </Link>
  );

  if (view === "breached") {
    const breached = breachedRows(rows, { eddSource, couriers }, today);
    // Why the list is shorter than the in-transit count: a docket with no AWB
    // cannot be chased, and one with no EDD on this source cannot be breached.
    const pool = couriers.length
      ? inTransitDockets(rows).filter((r) => couriers.includes(courierOf(r.order)))
      : inTransitDockets(rows);
    const noAwb = pool.filter((r) => !r.awb).length;
    const noEdd = pool.filter((r) => r.awb && !eddOf(r.order, eddSource)).length;

    return (
      <>
        <PageHead
          title="EDD breached shipments"
          sub={`Every in-transit AWB already past its ${eddLabel}, worst first — the columns the courier sheet uses. Copy pastes straight into the mail.`}
          right={backLink}
        />
        <LinkTabs items={VIEWS} active="breached" params={carried} className="mb-4" />

        {/* A plain GET form: no client component, no fetch, and the whole thing
            keeps working with JavaScript off. Only Copy needs the browser. */}
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2.5">
          <input type="hidden" name="view" value="breached" />
          {filters}
          <button
            type="submit"
            className="rounded-control border border-line-control bg-paper px-4 py-2 text-ui font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:text-sage"
          >
            Apply
          </button>
          <BreachedActions rows={breached} />
        </form>

        <div className="overflow-hidden rounded-card bg-card shadow-card">
          <div className="max-h-[68vh] overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                  <th className="bg-paper px-5 py-3 text-right font-semibold">Aging (days)</th>
                  <th className="bg-paper px-4 py-3 font-semibold">AWB</th>
                  <th className="bg-paper px-4 py-3 font-semibold">Courier</th>
                  <th className="bg-paper px-4 py-3 font-semibold">Store name</th>
                  <th className="bg-paper px-4 py-3 font-semibold">EDD</th>
                  <th className="bg-paper px-5 py-3 text-right font-semibold">Boxes</th>
                </tr>
              </thead>
              <tbody>
                {breached.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-sm text-mute">
                      Nothing past its {eddLabel} for these filters.
                    </td>
                  </tr>
                ) : (
                  breached.map((r) => (
                    <tr
                      key={`${r.so}-${r.awb}`}
                      className="border-b border-line text-dense last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper"
                    >
                      {/* The number the sheet carries, sign and all — it is the
                          thing that gets pasted, so the screen must not show a
                          prettier version of it. */}
                      <td className="mono px-5 py-2.5 text-right font-semibold text-breach">{r.aging}</td>
                      <td className="mono px-4 py-2.5 text-ink">
                        <Link
                          href={`/orders/${encodeURIComponent(r.so)}`}
                          className="transition-colors duration-150 ease-ui hover:text-sage"
                        >
                          {r.awb}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-ink-soft">{r.courier}</td>
                      <td className="px-4 py-2.5 font-semibold text-ink">{r.store}</td>
                      <td className="mono px-4 py-2.5 text-ink-soft">{eddCell(r.edd)}</td>
                      <td className="mono px-5 py-2.5 text-right text-ink-soft">{r.boxes}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="px-1 pb-8 pt-3">
          <p aria-live="polite" className="text-dense text-mute">
            {breached.length} breached {breached.length === 1 ? "AWB" : "AWBs"} · aged against today (
            {fmtDate(today)} IST) · Copy is tab-separated and includes the empty Remarks column
          </p>
          {noAwb ? (
            <Footnote>
              {noAwb} in-transit {noAwb === 1 ? "docket has" : "dockets have"} no AWB captured yet — nothing
              to chase a courier with, so they are not listed.
            </Footnote>
          ) : null}
          {noEdd ? (
            <Footnote>
              {noEdd} in-transit {noEdd === 1 ? "docket carries" : "dockets carry"} no {eddLabel}, so nothing
              can be called breached on them. Switch the EDD source to see them against our own promise.
            </Footnote>
          ) : null}
        </div>
      </>
    );
  }

  const pivot = buildPivot(rows, { mode, eddSource, couriers, from, to }, today);
  const footnotes = (
    [
      pivot.noAwb
        ? `${pivot.noAwb} in-transit ${pivot.noAwb === 1 ? "docket has" : "dockets have"} no AWB captured yet — excluded from the matrix (there is nothing to chase a courier with), not dropped.`
        : undefined,
      mode === "edd" && pivot.outOfWindow
        ? `${pivot.outOfWindow} in-transit ${pivot.outOfWindow === 1 ? "docket falls" : "dockets fall"} outside the ${fmtDate(from)} – ${fmtDate(to)} EDD window and are not counted above. Widen the window to include them.`
        : undefined,
      mode === "ageing"
        ? `Ageing is days past the ${eddLabel}, measured against today (${fmtDate(today)} IST). A re-opened or older export ages against the day it was taken, not against today.`
        : undefined,
    ] as (string | undefined)[]
  ).filter(Boolean) as string[];

  return (
    <>
      <PageHead
        title="Logistics follow-up pivot"
        sub={`In-transit dockets by store and ${mode === "edd" ? eddLabel : "days past EDD"} — one count per live AWB. For sending to a courier, use the breached list.`}
        right={backLink}
      />
      <LinkTabs items={VIEWS} active="pivot" params={carried} className="mb-4" />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2.5">
        <input type="hidden" name="view" value="pivot" />
        <label>
          <span className={FIELD_LABEL}>Columns</span>
          <Select name="mode" defaultValue={mode} className="w-[160px]">
            <option value="edd">EDD dates</option>
            <option value="ageing">Ageing buckets</option>
          </Select>
        </label>
        {filters}
        {/* Only EDD mode has a date axis to bound; ageing runs over every
            in-transit docket, which is the whole point of the overdue view. */}
        {mode === "edd" ? (
          <>
            <label>
              <span className={FIELD_LABEL}>EDD from</span>
              <Input type="date" name="from" defaultValue={from} className="w-[150px]" />
            </label>
            <label>
              <span className={FIELD_LABEL}>EDD to</span>
              <Input type="date" name="to" defaultValue={to} className="w-[150px]" />
            </label>
          </>
        ) : null}
        <button
          type="submit"
          className="rounded-control bg-ink px-4 py-2 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85"
        >
          Apply
        </button>
        <ExportButton pivot={pivot} mode={mode} />
      </form>

      <div className="overflow-hidden rounded-card bg-card shadow-card">
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                <th className="sticky left-0 z-10 bg-paper px-5 py-3 font-semibold">Store name</th>
                {pivot.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap bg-paper px-4 py-3 text-right font-semibold">
                    {mode === "edd" && c !== NO_EDD ? fmtDate(c) : c}
                  </th>
                ))}
                <th className="bg-paper px-5 py-3 text-right font-semibold text-ink">Grand total</th>
              </tr>
            </thead>
            <tbody>
              {pivot.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={pivot.columns.length + 2}
                    className="px-6 py-12 text-center text-sm text-mute"
                  >
                    No in-transit dockets for these filters.
                  </td>
                </tr>
              ) : (
                pivot.rows.map((r) => (
                  <tr
                    key={r.store}
                    className="border-b border-line text-dense last:border-b-0 hover:bg-paper"
                  >
                    <td className="sticky left-0 bg-card px-5 py-2.5 font-semibold text-ink">{r.store}</td>
                    {r.cells.map((n, i) => (
                      // Blank, not "0" — the shared sheet reads as a map of where
                      // the chases are, and a wall of zeroes destroys that.
                      <td key={i} className="mono px-4 py-2.5 text-right text-ink-soft">
                        {n === 0 ? "" : n}
                      </td>
                    ))}
                    <td className="mono px-5 py-2.5 text-right font-semibold text-ink">{r.total}</td>
                  </tr>
                ))
              )}
            </tbody>
            {pivot.rows.length ? (
              <tfoot className="sticky bottom-0">
                <tr className="border-t border-line bg-paper text-dense font-semibold text-ink">
                  <td className="sticky left-0 bg-paper px-5 py-3">Grand total</td>
                  {pivot.columnTotals.map((n, i) => (
                    <td key={i} className="mono px-4 py-3 text-right">
                      {n === 0 ? "" : n}
                    </td>
                  ))}
                  <td className="mono px-5 py-3 text-right">{pivot.grandTotal}</td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </div>

      <div className="px-1 pb-8 pt-3">
        <p aria-live="polite" className="text-dense text-mute">
          {pivot.grandTotal} in-transit AWBs across {pivot.rows.length}{" "}
          {pivot.rows.length === 1 ? "store" : "stores"} · export is this matrix, totals included
        </p>
        {footnotes.map((f) => (
          <Footnote key={f}>{f}</Footnote>
        ))}
      </div>
    </>
  );
}
