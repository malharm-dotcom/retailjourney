import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { scopedOrders } from "@/lib/data";
import { courierOf } from "@/lib/journey";
import { buildReport, reportBySlug } from "@/lib/reports";
import { requireSession } from "@/lib/session";
import type { OrderType } from "@/lib/types";
import { ReportTable } from "./table";

export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  type?: string;
  courier?: string;
  from?: string;
  to?: string;
}

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

  let rows = await scopedOrders(scope, user);
  if (searchParams.type) rows = rows.filter((r) => r.order.type === (searchParams.type as OrderType));
  // Same resolved carrier the scorecard groups on -- filtering on
  // `logisticsPartner` alone matched nothing, since it is NULL everywhere.
  if (searchParams.courier) rows = rows.filter((r) => courierOf(r.order) === searchParams.courier);
  if (searchParams.from) rows = rows.filter((r) => r.order.orderDate >= searchParams.from!);
  if (searchParams.to) rows = rows.filter((r) => r.order.orderDate <= searchParams.to!);

  const data = buildReport(def.slug, rows, searchParams.q);

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
        data={data}
        initial={{
          q: searchParams.q ?? "",
          type: searchParams.type ?? "",
          courier: searchParams.courier ?? "",
          from: searchParams.from ?? "",
          to: searchParams.to ?? "",
        }}
        showLookup={def.slug === "order-lookup"}
      />
    </>
  );
}
