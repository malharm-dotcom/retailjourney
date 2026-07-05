import { Icon } from "@/components/icon";
import { cn } from "@/lib/ui";

/** KPI card — the prototype's .kpi block. */
export function KpiCard({
  icon,
  iconClass,
  label,
  value,
  sub,
  className,
}: {
  icon: string;
  iconClass: string; // e.g. "bg-transit-bg text-transit"
  label: string;
  value: string | number;
  sub?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl bg-card px-5 py-[18px] shadow-card transition-all duration-200 hover:-translate-y-[3px] hover:shadow-lift",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-ink-soft">
        <span className={cn("grid h-[30px] w-[30px] place-items-center rounded-[9px]", iconClass)}>
          <Icon name={icon} size={17} />
        </span>
        {label}
      </div>
      <div className="mono mt-3 font-display text-4xl font-bold leading-none tracking-tight">{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-mute">{sub}</div> : null}
    </div>
  );
}
