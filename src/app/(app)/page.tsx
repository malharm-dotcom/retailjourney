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
import { SLA_VISUAL, TONE, WH_STATUS_VISUAL, cn, railOf, type Tone } from "@/lib/ui";

export const dynamic = "force-dynamic";

function Panel({
  title,
  icon,
  count,
  shown,
  tone,
  viewAllHref,
  children,
}: {
  title: string;
  icon: string;
  /** The true total, not the number of rows rendered below. */
  count: number;
  shown: number;
  tone: Tone;
  viewAllHref: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-card bg-card shadow-card">
      <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
        <span className={cn("grid h-7 w-7 place-items-center rounded-control", TONE[tone].tile)}>
          <Icon name={icon} size={16} />
        </span>
        <h2 className="text-ui font-bold">{title}</h2>
        <span className="mono ml-auto font-display text-title font-bold">{count}</span>
      </header>
      <div className="flex-1">{children}</div>
      {/* The `footer` slot existed on this component and was never passed, so a
          panel capped at six rows had no way to reach the other thirty-four. */}
      {count > shown ? (
        <footer className="border-t border-line px-5 py-3">
          <Link href={viewAllHref} className="text-dense font-semibold text-sage hover:underline">
            View all {count} →
          </Link>
        </footer>
      ) : null}
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
      className="rail flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0 hover:bg-paper"
      style={{ "--rail": rail } as React.CSSProperties}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui font-semibold">{primary}</div>
        <div className="mt-0.5 truncate text-cap text-mute">{secondary}</div>
      </div>
      {right}
    </Link>
  );
}

const EMPTY = (msg: string) => <div className="px-5 py-8 text-center text-ui text-mute">{msg}</div>;

export default async function ControlTower() {
  const { user, scope } = await requireSession();
  const rows = await scopedOrders(scope, user);
  const today = istToday();
  const policy = policyOf(user.role);

  const active = rows.filter((r) => !["CANCELLED", "UNFULFILLABLE"].includes(r.order.status));
  const byOverall = (s: OrderRow["order"]["overallStatus"]) =>
    active.filter((r) => r.order.overallStatus === s && !(s === "DELIVERED" && r.order.entryStatus === "CLOSED"));

  const whCount = byOverall("WH_PROCESSING").length;
  const pickupCount = byOverall("PICKUP_PENDING").length;
  const transitCount = byOverall("IN_TRANSIT").length;
  const deliveredToday = active.filter((r) => r.order.deliveredDate === today).length;

  // The FULL sets. These were previously sliced to 6 before their lengths were
  // read, so every count on this screen — the KPI subtitles and the panel header
  // figures alike — silently topped out at six. Forty breaches read as six on
  // the Retail Head's landing page, which is the one number here that decides
  // whether anyone escalates. Slice for display only, at the render site.
  const breachingAll = active
    .filter((r) => r.breaching && r.order.overallStatus !== "DELIVERED")
    .sort((a, b) => b.sla.ageing - a.sla.ageing);

  const dueTodayAll = active.filter(
    (r) =>
      r.order.overallStatus === "WH_PROCESSING" &&
      r.sla.handoverDeadlineTs &&
      istDateOf(r.sla.handoverDeadlineTs) <= today,
  );

  const reconOpenAll = rows.filter(
    (r) => ((r.order.shortageQty ?? 0) > 0 || (r.order.excessQty ?? 0) > 0) && r.order.entryStatus !== "CLOSED",
  );

  /** Rows shown inside a panel before it defers to its "view all" footer. */
  const PANEL_ROWS = 6;
  const breaching = breachingAll.slice(0, PANEL_ROWS);
  const dueToday = dueTodayAll.slice(0, PANEL_ROWS);
  const reconOpen = reconOpenAll.slice(0, PANEL_ROWS);

  const firstName = user.name.split(" ")[0];

  return (
    <>
      <PageHead
        title="Control tower"
        sub={`Good day, ${firstName} — here's the distribution pulse${policy.readOnly ? " (read-only view)" : ""}.`}
        right={
          <Link
            href="/in-transit"
            className="flex min-h-[38px] items-center gap-2 rounded-control bg-ink px-4 py-2.5 text-ui font-semibold text-paper shadow-card transition-colors hover:bg-ink/85"
          >
            <Icon name="delivery-bold-duotone" size={16} />
            Live in-transit board
          </Link>
        }
      />

      {/* Tones come from the status ramp, so Pickup Pending is no longer a sage
          tile beside a grey Pickup Pending pill on the same screen. Each card
          links to the surface that lets you act on it — which also earns the
          hover lift it always had. */}
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard icon="box-bold-duotone" tone="pending" label="WH Processing" value={whCount} sub={`${dueTodayAll.length} due out today`} href="/warehouse" />
        <KpiCard icon="hand-money-bold-duotone" tone="pending" label="Pickup Pending" value={pickupCount} sub="awaiting courier scan" href="/in-transit" />
        <KpiCard icon="delivery-bold-duotone" tone="motion" label="In Transit" value={transitCount} sub={`${breachingAll.length} breaching`} href="/in-transit" />
        <KpiCard icon="check-circle-bold-duotone" tone="done" label="Delivered Today" value={deliveredToday} sub={`${reconOpenAll.length} recon open`} href="/logistics" />
      </div>

      <div className="grid gap-3.5 lg:grid-cols-3">
        <Panel
          title="Breaching now"
          icon="danger-triangle-bold-duotone"
          count={breachingAll.length}
          shown={breaching.length}
          tone="failed"
          viewAllHref="/in-transit"
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
                    rail={TONE.failed.hex}
                    right={<StatusPill size="sm" visual={SLA_VISUAL[worst?.state ?? "BREACHED"]} />}
                  />
                );
              })}
        </Panel>

        <Panel
          title="Due out today (rulebook)"
          icon="alarm-bold-duotone"
          count={dueTodayAll.length}
          shown={dueToday.length}
          tone="staged"
          viewAllHref="/warehouse"
        >
          {dueToday.length === 0
            ? EMPTY("No handovers due today for this scope.")
            : dueToday.map((r) => (
                <MiniRow
                  key={r.order.soNumber}
                  so={r.order.soNumber}
                  primary={r.order.storeNameFormat}
                  secondary={`${r.order.soNumber} · handover ${fmtRelative(istDateOf(r.sla.handoverDeadlineTs!))}`}
                  rail={railOf(WH_STATUS_VISUAL[r.order.status])}
                  right={<StatusPill size="sm" visual={WH_STATUS_VISUAL[r.order.status]} />}
                />
              ))}
        </Panel>

        <Panel
          title="Shortage / excess open"
          icon="clipboard-remove-bold-duotone"
          count={reconOpenAll.length}
          shown={reconOpen.length}
          tone="handling"
          viewAllHref="/logistics"
        >
          {reconOpen.length === 0
            ? EMPTY("No open reconciliation. Clean inwards all round.")
            : reconOpen.map((r) => {
                const short = (r.order.shortageQty ?? 0) > 0;
                // Was a green "Delivered" pill. Every row in this panel exists
                // because the count did NOT match, so the success colour was
                // reporting the opposite of the panel's reason for existing.
                // These read as work outstanding, because that is what they are.
                return (
                  <MiniRow
                    key={r.order.soNumber}
                    so={r.order.soNumber}
                    primary={r.order.storeNameFormat}
                    secondary={`${r.order.soNumber} · awaiting reconciliation`}
                    rail={TONE.handling.hex}
                    right={
                      <StatusPill
                        size="sm"
                        visual={{
                          icon: short ? "minus-circle-bold-duotone" : "add-circle-bold-duotone",
                          label: short ? `Short ${r.order.shortageQty} pcs` : `Excess ${r.order.excessQty} pcs`,
                          tone: "handling",
                        }}
                      />
                    }
                  />
                );
              })}
        </Panel>
      </div>
    </>
  );
}
