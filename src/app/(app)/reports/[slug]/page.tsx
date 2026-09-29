import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { courierOf } from "@/lib/journey";
import { buildReport, filterReportRows, reportBySlug } from "@/lib/reports";
import { pickFacilities } from "@/lib/reports-download";
import { requireSession } from "@/lib/session";
import { ORDER_TYPES } from "@/lib/types";
import { ReportTable } from "./table";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const many = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]).filter(Boolean);

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: Search;
}) {
  const def = reportBySlug(params.slug);
  if (!def) notFound();
  const { user, scope } = await requireSession();

  const all = await scopedOrders(scope, user);
  // The session's facility view is the ceiling; ticking facilities can only
  // narrow inside it.
  const { facilities: pickedFacilities } = pickFacilities(user, scope, many(searchParams.facility));
  const selectable = pickFacilities(user, scope, []).facilities;
  const narrowed = pickedFacilities.length < selectable.length;

  const initial = {
    q: one(searchParams.q) ?? "",
    from: one(searchParams.from) ?? "",
    to: one(searchParams.to) ?? "",
    type: many(searchParams.type),
    courier: many(searchParams.courier),
    facility: narrowed ? pickedFacilities : [],
  };

  const rows = filterReportRows(def, all, {
    from: initial.from || undefined,
    to: initial.to || undefined,
    types: initial.type,
    couriers: initial.courier,
    facilities: narrowed ? pickedFacilities : [],
  });
  const data = buildReport(def.slug, rows, initial.q, Boolean(initial.from || initial.to));

  // Courier options come off the data, never a constant: the spine spells them
  // MUDITA_CARGO / SELF_DELIVERY / EKART_B2B_CARGO, and the old fixed list
  // (MUDITACARGO, SELF, EKART B2B) matched nothing — picking one emptied the
  // report.
  const couriers = [...new Set(all.map((r) => courierOf(r.order)))].sort((a, b) =>
    a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b),
  );

  return (
    <>
      <PageHead
        title={def.title}
        sub={def.description}
        right={
          <Link
            href="/reports"
            className="flex items-center gap-1.5 rounded-control border border-line-control bg-paper px-3.5 py-2 text-dense font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:text-sage"
          >
            <Icon name="arrow-left-linear" size={14} />
            All reports
          </Link>
        }
      />
      <ReportTable
        slug={def.slug}
        def={{ question: def.question, grain: def.grain, dateBasis: def.dateBasis, filters: def.filters }}
        data={data}
        initial={initial}
        options={{
          type: ORDER_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") })),
          courier: couriers.map((c) => ({ value: c, label: c === "—" ? "No courier yet" : c.replace(/_/g, " ") })),
          facility: selectable.length > 1 ? selectable : [],
        }}
        showLookup={def.slug === "order-lookup"}
      />
    </>
  );
}
