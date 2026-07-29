"use client";

// Admin → Users & entitlements. Until now this table was a read-only mirror of
// whatever scripts/seed-admin.mts had written; granting someone access meant
// shelling into the box. One row at a time opens into an inline editor, so the
// list you are comparing against stays on screen while you change a role.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Button, Select } from "@/components/ui/primitives";
import { updateUserAccess } from "@/app/actions";
import { FACILITY_SHORT } from "@/lib/facilities";
import { FACILITIES } from "@/lib/types";
import type { Facility, Role } from "@/lib/types";
import { cn } from "@/lib/ui";

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  facilities: Facility[];
  allView: boolean;
  areaManager?: string;
  active: boolean;
}

export interface RoleOption {
  value: Role;
  label: string;
  readOnly: boolean;
}

interface Draft {
  role: Role;
  facilities: Facility[];
  allView: boolean;
  areaManager: string;
  active: boolean;
}

function draftOf(u: UserView): Draft {
  return {
    role: u.role,
    facilities: [...u.facilities],
    allView: u.allView,
    areaManager: u.areaManager ?? "",
    active: u.active,
  };
}

export function UsersPanel({
  users,
  roles,
  actorId,
  dbReady,
}: {
  users: UserView[];
  roles: RoleOption[];
  /** The signed-in admin — their own row cannot be self-demoted. */
  actorId: string;
  dbReady: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, startTransition] = useTransition();

  const open = (u: UserView) => {
    setOpenId(u.id);
    setDraft(draftOf(u));
  };
  const close = () => {
    setOpenId(null);
    setDraft(null);
  };

  const save = (u: UserView) => {
    if (!draft) return;
    startTransition(async () => {
      const res = await updateUserAccess(u.id, {
        role: draft.role,
        facilities: draft.facilities,
        allView: draft.allView,
        areaManager: draft.areaManager.trim() || undefined,
        active: draft.active,
      });
      if (res.ok) {
        toast.success(`${u.name} updated`);
        close();
      } else {
        // The lockout rules ("last active admin", "your own admin access")
        // arrive here as plain sentences — show them verbatim rather than a
        // generic failure, because the message IS the instruction.
        toast.error(res.error);
      }
    });
  };

  const toggleFacility = (f: Facility) => {
    setDraft((d) =>
      d ? { ...d, facilities: d.facilities.includes(f) ? d.facilities.filter((x) => x !== f) : [...d.facilities, f] } : d,
    );
  };

  return (
    <section className="mb-6 overflow-hidden rounded-card bg-card shadow-card">
      <header className="flex items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
        <Icon name="users-group-two-rounded-bold-duotone" size={17} className="text-sage" />
        <h2 className="font-display text-sec font-bold">Users &amp; entitlements</h2>
        <span className="ml-auto text-cap text-mute">
          {dbReady ? (
            <>
              new accounts: <span className="mono">scripts/seed-admin.mts</span>
            </>
          ) : (
            "read-only — no database configured"
          )}
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
              <th className="px-5 py-3 font-semibold">User</th>
              <th className="px-4 py-3 font-semibold">Role</th>
              <th className="px-4 py-3 font-semibold">Facilities</th>
              <th className="px-4 py-3 font-semibold">All view</th>
              <th className="px-4 py-3 font-semibold">AM scope</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const editing = openId === u.id && draft;
              const roleLabel = roles.find((r) => r.value === u.role)?.label ?? u.role;
              return (
                <tr key={u.id} className="border-b border-line text-dense last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper">
                  {editing ? (
                    <td colSpan={7} className="bg-paper px-5 py-4">
                      <div className="mb-3 flex items-baseline gap-2">
                        <span className="text-ui font-bold">{u.name}</span>
                        <span className="mono text-cap text-mute">{u.email}</span>
                        {u.id === actorId ? (
                          <span className="rounded-full bg-pending-bg px-2 py-0.5 text-meta font-bold text-ink-soft">
                            you
                          </span>
                        ) : null}
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="block">
                          <span className="mb-1.5 block text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                            Role
                          </span>
                          <Select
                            value={draft.role}
                            onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}
                          >
                            {roles.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                                {r.readOnly ? " — read-only" : ""}
                              </option>
                            ))}
                          </Select>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                            AM scope
                          </span>
                          <input
                            value={draft.areaManager}
                            onChange={(e) => setDraft({ ...draft, areaManager: e.target.value })}
                            placeholder="none — sees all stores"
                            className="w-full rounded-control border border-line-control bg-paper px-3 py-2 text-ui text-ink outline-none transition-colors duration-150 ease-ui placeholder:text-mute focus:border-sage"
                          />
                        </label>

                        <fieldset className="block">
                          <legend className="mb-1.5 block text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                            Facilities
                          </legend>
                          <div className="flex flex-wrap gap-2">
                            {FACILITIES.map((f) => {
                              const on = draft.facilities.includes(f);
                              return (
                                <button
                                  key={f}
                                  type="button"
                                  aria-pressed={on}
                                  onClick={() => toggleFacility(f)}
                                  className={cn(
                                    "flex min-h-[38px] items-center gap-2 rounded-full border px-3.5 py-2 text-ui font-medium transition-colors duration-150 ease-ui",
                                    on
                                      ? "border-ink bg-ink text-white"
                                      : "border-line-control bg-paper text-ink-soft hover:border-ink-soft",
                                  )}
                                >
                                  {FACILITY_SHORT[f]}
                                </button>
                              );
                            })}
                          </div>
                          {/* Empty is not "no access" — rbac.entitledFacilities()
                              reads an empty list as the full set. Saying so here
                              stops an admin clearing chips to restrict someone
                              and achieving the exact opposite. */}
                          <span className="mt-1.5 block text-cap text-mute">
                            {draft.facilities.length ? "Limited to the selected facilities." : "None selected = all facilities."}
                          </span>
                        </fieldset>

                        <div className="grid content-start gap-2">
                          <label className="flex items-center gap-2.5 text-ui">
                            <input
                              type="checkbox"
                              checked={draft.allView}
                              onChange={(e) => setDraft({ ...draft, allView: e.target.checked })}
                              className="h-4 w-4 accent-ink"
                            />
                            Offer the “All facilities” union view
                          </label>
                          <label className="flex items-center gap-2.5 text-ui">
                            <input
                              type="checkbox"
                              checked={draft.active}
                              onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                              className="h-4 w-4 accent-ink"
                            />
                            Active — can sign in
                          </label>
                        </div>
                      </div>

                      <div className="mt-4 flex gap-2.5">
                        <Button onClick={() => save(u)} disabled={pending}>
                          {pending ? "Saving…" : "Save changes"}
                        </Button>
                        <Button variant="ghost" onClick={close} disabled={pending}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-5 py-3">
                        <span className="block font-semibold">{u.name}</span>
                        <span className="mono block text-cap text-mute">{u.email}</span>
                      </td>
                      <td className="px-4 py-3 text-ink-soft">{roleLabel}</td>
                      <td className="px-4 py-3 text-ink-soft">
                        {u.facilities.length ? u.facilities.map((f) => FACILITY_SHORT[f]).join(" · ") : "All facilities"}
                      </td>
                      <td className="px-4 py-3">{u.allView ? "✓" : "—"}</td>
                      <td className="px-4 py-3 text-ink-soft">{u.areaManager ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-meta font-bold",
                            u.active ? "bg-deliv-bg text-deliv" : "bg-pending-bg text-ink-soft",
                          )}
                        >
                          {u.active ? "active" : "pending"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="outline"
                          onClick={() => open(u)}
                          disabled={!dbReady || openId !== null}
                          title={dbReady ? undefined : "Requires the database"}
                        >
                          Edit access
                        </Button>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
