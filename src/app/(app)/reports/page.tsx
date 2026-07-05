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
      <div className="grid gap-3.5 pb-8 sm:grid-cols-2 xl:grid-cols-4">
        {REPORTS.map((r, i) => (
          <Link
            key={r.slug}
            href={`/reports/${r.slug}`}
            className="group animate-rise rounded-2xl bg-card p-5 shadow-card transition-all hover:-translate-y-[3px] hover:shadow-lift"
            style={{ animationDelay: `${i * 45}ms` }}
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-sage-soft text-sage transition-colors group-hover:bg-sage group-hover:text-white">
              <Icon name={r.icon} size={21} />
            </span>
            <h2 className="mt-3.5 font-display text-[15.5px] font-bold leading-snug tracking-tight">
              {r.title}
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">{r.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
