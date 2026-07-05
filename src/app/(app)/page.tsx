// Control Tower (PRD §6.1) — role-aware landing: the four-stage pulse,
// today's breaches, open reconciliation, and what the rulebook says is due out.

import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { KpiCard } from "@/components/ui/kpi";
import { StatusPill } from "@/components/ui/pill";
import { scopedOrders, type OrderRow } from "@/lib/data";
import { fmtRelative, istDateOf, istToday } from "@/lib/ist";
import { LEG_LABEL } from "@/lib/sla";
import { policyOf } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { OVERALL_VISUAL, SLA_VISUAL, WH_STATUS_VISUAL, cn } from "@/lib/ui";

export const dynamic = "force-dynamic";

function Panel({
  title,
  icon,
  count,
  tone,
  children,
  footer,
}: {
  title: string;
  icon: string;
  count: number;
  tone: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl bg-card shadow-card">
      <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
        <span className={cn("grid h-7 w-7 place-items-center rounded-lg", tone)}>
          <Icon name={icon} size={16} />
        </span>
        <h2 className="text-[13px] font-bold">{title}</h2>
        <span className="mono ml-auto font-display text-[15px] font-bold">{count}</span>
      </header>
      <div className="flex-1">{children}</div>
      {footer ? <footer className="border-t border-line px-5 py-3">{footer}</footer> : null}
    </section>
  );
}

function MiniRow({
  so,
  primary,
  secondary,
  right,
  rail,
}: {
  so: string;
  primary: string;
  secondary: string;
  right: React.ReactNode;
  rail: string;
}) {
  return (
    <Link
      href={`/orders/${so}`}
      className="rail flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0 hover:bg-[#FCFBF7]"
      style={{ "--rail": rail } as React.CSSProperties}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{primary}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-mute">{secondary}</div>
      </div>
      {right}
    </Link>
  );
}

const EMPTY = (msg: string) => (
  <div className="px-5 py-8 text-center text-[13px] text-mute">{msg}</div>
);

export default async function ControlTower() {
  const { user, scope } = await requireSession();
  const rows = scopedOrders(scope, user);
  const today = istToday();
  const policy = policyOf(user.role);

  const active = rows.filter((r) => !["CANCELLED", "UNFULFILLABLE"].includes(r.order.status));
  const byOverall = (s: OrderRow["order"]["overallStatus"]) =>
    active.filter((r) => r.order.overallStatus === s && !(s === "DELIVERED" && r.order.entryStatus === "CLOSED"));

  const whCount = byOverall("WH_PROCESSING").length;
  const pickupCount = byOverall("PICKUP_PENDING").length;
  const transitCount = byOverall("IN_TRANSIT").length;
  const deliveredToday = active.filter((r) => r.order.deliveredDate === today).length;

  const breaching = active
    .filter((r) => r.breaching && r.order.overallStatus !== "DELIVERED")
    .sort((a, b) => b.sla.ageing - a.sla.ageing)
    .slice(0, 6);

  const dueToday = active
    .filter(
      (r) =>
        r.order.overallStatus === "WH_PROCESSING" &&
        r.sla.handoverDeadlineTs &&
        istDateOf(r.sla.handoverDeadlineTs) <= today,
    )
    .slice(0, 6);

  const reconOpen = rows
    .filter((r) => ((r.order.shortageQty ?? 0) > 0 || (r.order.excessQty ?? 0) > 0) && r.order.entryStatus !== "CLOSED")
    .slice(0, 6);

  const firstName = user.name.split(" ")[0];

  return (
    <>
      <PageHead
        title="Control tower"
        sub={`Good day, ${firstName} — here's the distribution pulse${policy.readOnly ? " (read-only view)" : ""}.`}
        right={
          <Link
            href="/in-transit"
            className="flex items-center gap-2 rounded-[11px] bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper shadow-card transition-colors hover:bg-ink/85"
          >
            <Icon name="delivery-bold-duotone" size={16} />
            Live in-transit board
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard icon="box-bold-duotone" iconClass="bg-pending-bg text-ink-soft" label="WH Processing" value={whCount} sub={`${dueToday.length} due out today`} />
        <KpiCard icon="hand-money-bold-duotone" iconClass="bg-sage-soft text-sage" label="Pickup Pending" value={pickupCount} sub="awaiting courier scan" />
        <KpiCard icon="delivery-bold-duotone" iconClass="bg-transit-bg text-transit" label="In Transit" value={transitCount} sub={`${breaching.length} breaching`} />
        <KpiCard icon="check-circle-bold-duotone" iconClass="bg-deliv-bg text-deliv" label="Delivered Today" value={deliveredToday} sub={`${reconOpen.length} recon open`} />
      </div>

      <div className="grid gap-3.5 lg:grid-cols-3">
        <Panel
          title="Breaching now"
          icon="danger-triangle-bold-duotone"
          count={breaching.length}
          tone="bg-breach-bg text-breach"
        >
          {breaching.length === 0
            ? EMPTY("Nothing is breaching. The baton is moving clean.")
            : breaching.map((r) => {
                const worst = r.sla.legs.find((l) => l.state === "BREACHED_PENDING") ?? r.sla.legs.find((l) => l.state === "BREACHED");
                return (
                  <MiniRow
                    key={r.order.soNumber}
                    so={r.order.soNumber}
                    primary={r.order.storeNameFormat}
                    secondary={`${r.order.soNumber} · ${worst ? LEG_LABEL[worst.leg] : "SLA"} overdue`}
                    rail="#BE5340"
                    right={<StatusPill size="sm" visual={SLA_VISUAL[worst?.state ?? "BREACHED"]} />}
                  />
                );
              })}
        </Panel>

        <Panel
          title="Due out today (rulebook)"
          icon="alarm-bold-duotone"
          count={dueToday.length}
          tone="bg-sage-soft text-sage"
        >
          {dueToday.length === 0
            ? EMPTY("No handovers due today for this scope.")
            : dueToday.map((r) => (
                <MiniRow
                  key={r.order.soNumber}
                  so={r.order.soNumber}
                  primary={r.order.storeNameFormat}
                  secondary={`${r.order.soNumber} · handover ${fmtRelative(istDateOf(r.sla.handoverDeadlineTs!))}`}
                  rail={WH_STATUS_VISUAL[r.order.status].rail}
                  right={<StatusPill size="sm" visual={WH_STATUS_VISUAL[r.order.status]} />}
                />
              ))}
        </Panel>

        <Panel
          title="Shortage / excess open"
          icon="clipboard-remove-bold-duotone"
          count={reconOpen.length}
          tone="bg-ofd-bg text-ofd"
        >
          {reconOpen.length === 0
            ? EMPTY("No open reconciliation. Clean inwards all round.")
            : reconOpen.map((r) => (
                <MiniRow
                  key={r.order.soNumber}
                  so={r.order.soNumber}
                  primary={r.order.storeNameFormat}
                  secondary={`${r.order.soNumber} · ${
                    (r.order.shortageQty ?? 0) > 0
                      ? `short ${r.order.shortageQty} pcs`
                      : `excess ${r.order.excessQty} pcs`
                  }`}
                  rail="#B67F2E"
                  right={<StatusPill size="sm" visual={OVERALL_VISUAL.DELIVERED} />}
                />
              ))}
        </Panel>
      </div>
    </>
  );
}
