// Admin (PRD §6.8) — users / roles / facility entitlements, integration
// health, sync log. Integrations light up in M5; this is their home already.

import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { PageHead } from "@/components/shell/page-head";
import { ROLE_POLICY } from "@/lib/rbac";
import { repo } from "@/lib/repo";
import { requireSession } from "@/lib/session";
import { FACILITY_SHORT } from "@/components/shell/facility-switcher";
import { cn } from "@/lib/ui";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const INTEGRATIONS = [
  {
    name: "Unicommerce",
    detail: "B2B SO intake + processing lifecycle",
    icon: "cloud-download-bold-duotone",
    milestone: "M5",
  },
  {
    name: "eShipz",
    detail: "Shipment tracking, checkpoints, POD",
    icon: "radar-2-bold-duotone",
    milestone: "M5",
  },
  {
    name: "Google SSO",
    detail: "@snitch.com sign-in with admin activation",
    icon: "shield-check-bold-duotone",
    milestone: "env-gated",
  },
];

export default async function AdminPage() {
  const { user } = await requireSession();
  if (user.role !== "ADMIN") redirect("/");
  const users = await repo.listUsers();

  return (
    <>
      <PageHead
        title="Admin console"
        sub="Users, facility entitlements and integration health. Manual entry keeps working even when a sync is down."
      />

      <div className="mb-6 grid gap-3.5 md:grid-cols-3">
        {INTEGRATIONS.map((i) => (
          <section key={i.name} className="rounded-2xl bg-card p-5 shadow-card">
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-pending-bg text-ink-soft">
                <Icon name={i.icon} size={19} />
              </span>
              <div>
                <h3 className="text-[13.5px] font-bold">{i.name}</h3>
                <p className="text-[11.5px] text-mute">{i.detail}</p>
              </div>
            </div>
            <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-[12px] font-semibold text-mute">
              <span className="h-2 w-2 rounded-full bg-pending" />
              Not connected · lands in {i.milestone}
            </div>
          </section>
        ))}
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
        </header>
        <div className="px-6 py-12 text-center text-sm text-mute">
          No sync runs yet — UC and eShipz polling start in M5. Every synced write will land here and on each
          order&rsquo;s timeline.
        </div>
      </section>
    </>
  );
}
