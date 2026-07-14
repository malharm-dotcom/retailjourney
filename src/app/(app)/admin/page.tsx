// Admin (PRD §6.8) — users / roles / facility entitlements, integration
// health, sync log. M2: live sync-health cards, on-demand sync, and the
// unmatched-channel review queue.

import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { googleConfigured } from "@/lib/auth";
import { databaseConfigured } from "@/lib/db";
import { eshipzConfigured, eshipzWebhookConfigured } from "@/lib/integrations/eshipz-source";
import { getSyncHealth } from "@/lib/integrations/sync";
import { ucConfigured } from "@/lib/integrations/uc-client";
import { snowflakeConfigured } from "@/lib/snowflake";
import { fmtDateTime } from "@/lib/ist";
import { ROLE_POLICY } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import { requireSession } from "@/lib/session";
import { FACILITY_SHORT } from "@/lib/facilities";
import { cn } from "@/lib/ui";
import { SyncHealthCards, UnmatchedChannels, type SourceCard, type SyncRunView } from "./sync-panel";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

function toRunView(r?: {
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean | null;
  rowsFetched: number;
  rowsUpserted: number;
  conflicts: number;
  errors: unknown;
}): SyncRunView | undefined {
  if (!r) return undefined;
  const errors = Array.isArray(r.errors) ? (r.errors as string[]) : [];
  return {
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString(),
    ok: r.ok ?? undefined,
    rowsFetched: r.rowsFetched,
    rowsUpserted: r.rowsUpserted,
    conflicts: r.conflicts,
    errorCount: errors.length,
    firstError: errors[0],
  };
}

export default async function AdminPage() {
  const { user } = await requireSession();
  if (user.role !== "ADMIN") redirect("/");
  const [users, stores, health] = await Promise.all([repo.listUsers(), repo.listStores(), getSyncHealth()]);
  const dbReady = databaseConfigured();

  const cards: SourceCard[] = [
    {
      source: "UC",
      name: "Unicommerce",
      detail: "B2B SO intake + processing lifecycle",
      icon: "cloud-download-bold-duotone",
      configured: ucConfigured(),
      lastRun: toRunView(health.lastRuns.UC),
    },
    {
      source: "ESHIPZ",
      name: "eShipz",
      detail: "Shipment tracking, checkpoints, POD",
      icon: "radar-2-bold-duotone",
      configured: eshipzConfigured(),
      lastRun: toRunView(health.lastRuns.ESHIPZ),
    },
    {
      source: "SNOWFLAKE",
      name: "Snowflake",
      detail: "distribution_analytics — orders, deadlines, split shipments (hourly)",
      icon: "database-bold-duotone",
      configured: snowflakeConfigured(),
      lastRun: toRunView(health.lastRuns.SNOWFLAKE),
    },
    {
      source: "ESHIPZ_WEBHOOK",
      name: "eShipz webhook",
      detail: "Real-time tracking pushes (POST /api/webhooks/eshipz)",
      icon: "bolt-bold-duotone",
      configured: eshipzWebhookConfigured(),
      passive: true,
      lastRun: toRunView(health.lastRuns.ESHIPZ_WEBHOOK),
    },
  ];

  return (
    <>
      <PageHead
        title="Admin console"
        sub="Users, facility entitlements and integration health. Manual entry keeps working even when a sync is down."
      />

      <SyncHealthCards cards={cards} dbReady={dbReady} />

      <UnmatchedChannels
        unmatched={health.unmatched.map((u) => ({
          channel: u.channel,
          orderCount: u.orderCount,
          lastSeenAt: u.lastSeenAt.toISOString(),
          sampleSoNumbers: u.sampleSoNumbers,
        }))}
        stores={stores.map((s) => ({ id: s.id, label: `${s.finalStore} (${s.facility})` }))}
      />

      <div className="mb-6 rounded-2xl bg-card p-5 shadow-card">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-pending-bg text-ink-soft">
            <Icon name="shield-check-bold-duotone" size={19} />
          </span>
          <div>
            <h3 className="text-[13.5px] font-bold">Google SSO</h3>
            <p className="text-[11.5px] text-mute">@snitch.com sign-in with admin activation</p>
          </div>
          <span
            className={cn(
              "ml-auto flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-[12px] font-semibold text-mute",
            )}
          >
            <span className={cn("h-2 w-2 rounded-full", googleConfigured() ? "bg-deliv" : "bg-pending")} />
            {googleConfigured() ? "Configured" : "Env-gated · set GOOGLE_CLIENT_ID/SECRET"}
          </span>
        </div>
      </div>

      <section className="mb-6 overflow-hidden rounded-2xl bg-card shadow-card">
        <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
          <Icon name="users-group-two-rounded-bold-duotone" size={17} className="text-sage" />
          <h2 className="text-[13px] font-bold">Users & entitlements</h2>
          <span className="ml-auto text-[11.5px] text-mute">
            new @snitch.com sign-ins appear here pending activation
          </span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-paper text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
                <th className="px-5 py-3 font-semibold">User</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Facilities</th>
                <th className="px-4 py-3 font-semibold">All view</th>
                <th className="px-4 py-3 font-semibold">AM scope</th>
                <th className="px-4 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line text-[12.5px] last:border-b-0 hover:bg-[#FCFBF7]">
                  <td className="px-5 py-3">
                    <span className="block font-semibold">{u.name}</span>
                    <span className="mono block text-[11px] text-mute">{u.email}</span>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{ROLE_POLICY[u.role].label}</td>
                  <td className="px-4 py-3 text-ink-soft">
                    {u.facilities.length ? u.facilities.map((f) => FACILITY_SHORT[f]).join(" · ") : "All facilities"}
                  </td>
                  <td className="px-4 py-3">{u.allView ? "✓" : "—"}</td>
                  <td className="px-4 py-3 text-ink-soft">{u.areaManager ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-[10.5px] font-bold",
                        u.active ? "bg-deliv-bg text-deliv" : "bg-pending-bg text-ink-soft",
                      )}
                    >
                      {u.active ? "active" : "pending"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl bg-card shadow-card">
        <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
          <Icon name="history-bold-duotone" size={17} className="text-sage" />
          <h2 className="text-[13px] font-bold">Sync log</h2>
          <span className="ml-auto text-[11.5px] text-mute">last {health.recentRuns.length} runs</span>
        </header>
        {health.recentRuns.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-mute">
            No sync runs yet — they start once the database and UC/eShipz credentials are configured. Every synced
            write lands here and on each order&rsquo;s timeline.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
                  <th className="px-5 py-3 font-semibold">Source</th>
                  <th className="px-4 py-3 font-semibold">Started</th>
                  <th className="px-4 py-3 font-semibold">Result</th>
                  <th className="px-4 py-3 font-semibold">Fetched</th>
                  <th className="px-4 py-3 font-semibold">Upserted</th>
                  <th className="px-4 py-3 font-semibold">Conflicts</th>
                  <th className="px-4 py-3 font-semibold">Errors</th>
                </tr>
              </thead>
              <tbody>
                {health.recentRuns.map((r) => {
                  const errors = Array.isArray(r.errors) ? (r.errors as string[]) : [];
                  return (
                    <tr key={r.id} className="border-b border-line text-[12.5px] last:border-b-0">
                      <td className="mono px-5 py-3 font-semibold">{r.source}</td>
                      <td className="mono px-4 py-3 text-ink-soft">{fmtDateTime(r.startedAt.toISOString())}</td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[10.5px] font-bold",
                            r.ok === true && "bg-deliv-bg text-deliv",
                            r.ok === false && "bg-breach-bg text-breach",
                            r.ok == null && "bg-pending-bg text-ink-soft",
                          )}
                        >
                          {r.ok === true ? "ok" : r.ok === false ? "failed" : "running"}
                        </span>
                      </td>
                      <td className="mono px-4 py-3">{r.rowsFetched}</td>
                      <td className="mono px-4 py-3">{r.rowsUpserted}</td>
                      <td className="mono px-4 py-3">{r.conflicts}</td>
                      <td className="px-4 py-3 text-[11.5px] text-mute" title={errors.join("\n")}>
                        {errors.length ? `${errors.length} — ${errors[0]?.slice(0, 60)}…` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
