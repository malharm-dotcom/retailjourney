// Order search (Artifact C) — the searchable history.
//
// First paint is deliberately narrow: the last 30 days by order date. Everything
// older is MASKED, never removed — the moment any facet is set the window is
// lifted and the query reaches every order Postgres holds, however old. Nothing
// that was ever synced becomes unfindable.
//
// The bar is a plain GET form, so the state lives in the URL and a found order
// is a link someone can send. No client component, no debounce, no router — the
// native form and <input type="date"> already do all of it.

import Link from "next/link";
import { NsoBadge } from "@/components/nso-badge";
import { PageHead } from "@/components/shell/page-head";
import { searchOrders } from "@/lib/data";
import { fmtDate } from "@/lib/ist";
import { OVERALL_LABEL, STATUS_LABEL } from "@/lib/journey";
import {
  DEFAULT_WINDOW_DAYS,
  SEARCHABLE_STATUSES,
  isSearching,
  searchFromParams,
} from "@/lib/order-search";
import { repo } from "@/lib/repo";
import { ORDER_TYPES } from "@/lib/types";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Orders" };
export const dynamic = "force-dynamic";

/** Column widths as one grid template, shared by the header and every row so
 *  the two can never disagree. Fixed columns first, store takes the slack —
 *  the 1304px lesson: nothing here is free to grow past its share. */
const COLS = "grid-cols-[minmax(9rem,1.1fr)_6.5rem_minmax(8rem,1.4fr)_4rem_5.5rem_8rem_9rem]";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { user, scope } = await requireSession();
  const search = searchFromParams(searchParams);
  const [orders, stores] = await Promise.all([
    searchOrders(scope, user, search),
    repo.listStores(),
  ]);
  const searching = isSearching(search);

  // Facets come from the store MASTER, not from the rows on screen: a picker
  // built from the current result set would only ever offer stores from the
  // 30 days already visible, which is exactly the history this page exists to
  // reach. `storeName` is the column sync writes to Order.storeNameFormat.
  // An unmapped store has no master row and is reached through the free-text
  // box instead, which searches the same field.
  const storeNames = [
    ...new Set(
      stores.filter((s) => scope === "ALL" || s.facility === scope).map((s) => s.storeName),
    ),
  ]
    .filter(Boolean)
    .sort();

  return (
    <>
      <PageHead
        title="Orders"
        sub={
          searching
            ? `Searching every order on record — ${orders.length} match${orders.length === 1 ? "" : "es"}.`
            : `The last ${DEFAULT_WINDOW_DAYS} days — ${orders.length} order${orders.length === 1 ? "" : "s"}. Search to reach the full history.`
        }
      />

      <form
        method="GET"
        className="mb-3 flex flex-wrap items-end gap-2.5 rounded-card bg-card p-4 shadow-card"
      >
        <label className="flex flex-col gap-1">
          <span className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">
            SO number or store
          </span>
          <input
            type="search"
            name="q"
            defaultValue={search.q}
            placeholder="ANSAPL16017"
            className="min-w-[15rem] rounded-control border border-line-control bg-paper px-3 py-2 text-ui"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">From</span>
          <input
            type="date"
            name="from"
            defaultValue={search.from}
            className="rounded-control border border-line-control bg-paper px-3 py-2 text-ui"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">To</span>
          <input
            type="date"
            name="to"
            defaultValue={search.to}
            className="rounded-control border border-line-control bg-paper px-3 py-2 text-ui"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">Status</span>
          <select
            name="status"
            defaultValue={search.status}
            className="min-w-[10rem] rounded-control border border-line-control bg-paper px-3 py-2 text-ui"
          >
            <option value="">Any status</option>
            {SEARCHABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">Type</span>
          <select
            name="type"
            defaultValue={search.type}
            className="min-w-[9rem] rounded-control border border-line-control bg-paper px-3 py-2 text-ui"
          >
            <option value="">Any type</option>
            {ORDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-cap font-semibold uppercase tracking-[0.04em] text-mute">Store</span>
          <select
            name="store"
            defaultValue={search.store}
            className="min-w-[11rem] rounded-control border border-line-control bg-paper px-3 py-2 text-ui"
          >
            <option value="">Any store</option>
            {storeNames.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="min-h-[38px] rounded-control bg-ink px-4 py-2.5 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85"
        >
          Search
        </button>
        {searching ? (
          <Link
            href="/orders"
            className="min-h-[38px] rounded-control border border-line-control px-4 py-2.5 text-ui font-semibold text-mute transition-colors duration-150 ease-ui hover:text-ink"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="rounded-card bg-card shadow-card">
        <div className="overflow-x-auto">
          <div className="min-w-[52rem]">
            <div
              className={`grid ${COLS} gap-3 border-b border-line px-5 py-2.5 text-cap font-semibold uppercase tracking-[0.04em] text-mute`}
            >
              <span>SO number</span>
              <span>Order date</span>
              <span>Store</span>
              <span className="text-right">Qty</span>
              <span>Type</span>
              <span>Stage</span>
              <span>Journey</span>
            </div>

            {orders.length === 0 ? (
              <div className="px-5 py-14 text-center text-ui text-mute">
                {searching
                  ? "No order matches that search."
                  : `No orders in the last ${DEFAULT_WINDOW_DAYS} days. Search to reach older ones.`}
              </div>
            ) : (
              orders.map((o) => (
                <Link
                  key={o.soNumber}
                  href={`/orders/${encodeURIComponent(o.soNumber)}`}
                  className={`grid ${COLS} items-center gap-3 border-b border-line px-5 py-3 last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper`}
                >
                  <span className="mono truncate text-ui font-semibold">{o.soNumber}</span>
                  <span className="text-ui text-mute">{fmtDate(o.orderDate)}</span>
                  <span className="truncate text-ui">{o.storeNameFormat}</span>
                  <span className="mono text-right text-ui">{o.qty}</span>
                  <span className="truncate text-ui">
                    {o.type === "NSO" ? <NsoBadge /> : <span className="text-mute">{o.type}</span>}
                  </span>
                  <span className="truncate text-ui text-mute">{STATUS_LABEL[o.status]}</span>
                  <span className="truncate text-ui text-mute">
                    {OVERALL_LABEL[o.overallStatus]}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
