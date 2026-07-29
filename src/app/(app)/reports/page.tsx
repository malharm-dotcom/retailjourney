// Reports index (PRD §10) — every leg, every stakeholder.

import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { REPORTS } from "@/lib/reports";

export const metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHead
        title="Reports desk"
        sub="Filterable, exportable slices of the whole journey — scoped to your facility view."
      />
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
            <h2 className="mt-3.5 font-display text-title font-bold leading-snug tracking-tight">{r.title}</h2>
            <p className="mt-1.5 text-dense leading-relaxed text-mute">{r.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
