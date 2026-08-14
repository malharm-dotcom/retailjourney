"use client";

// Admin → Users & entitlements. This started as a read-only mirror of whatever
// scripts/seed-admin.mts had written, then grew an inline access editor. It is
// now the full provisioning surface: create, edit, deactivate/reactivate and
// set a break-glass credential — so onboarding someone no longer means shelling
// into the box.
//
// Two things are deliberate. There is no delete: deactivation is reversible and
// keeps the audit trail attached to a real row. And every rule shown here is
// mirrored from lib/user-admin.ts rather than restated — a form that disagrees
// with its validator is a form that lies.

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Button, Chip, Field, Input, Select } from "@/components/ui/primitives";
import { createUser, deactivateUser, reactivateUser, setUserCredential, updateUserAccess } from "@/app/actions";
import { FACILITY_SHORT } from "@/lib/facilities";
import { minCredentialLength, roleNeedsAreaManager, roleNeedsFacilities } from "@/lib/user-admin";
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

interface CreateDraft extends Draft {
  name: string;
  email: string;
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

function blankCreate(): CreateDraft {
  return {
    name: "",
    email: "",
    role: "WH_OPERATOR",
    facilities: [],
    allView: false,
    areaManager: "",
    // Active on purpose: an inactive row is not on the SSO allowlist, so
    // creating one "to be enabled later" produces an account that silently
    // cannot log in.
    active: true,
  };
}

function toggle(list: Facility[], f: Facility): Facility[] {
  return list.includes(f) ? list.filter((x) => x !== f) : [...list, f];
}

/** The facility chip row, shared by the create form and the edit drawer. */
function FacilityPicker({
  selected,
  onToggle,
  required,
}: {
  selected: Facility[];
  onToggle: (f: Facility) => void;
  required: boolean;
}) {
  return (
    <fieldset className="block">
      <legend className="mb-1.5 block text-cap font-semibold uppercase tracking-[0.04em] text-mute">Facilities</legend>
      <div className="flex flex-wrap gap-2">
        {FACILITIES.map((f) => (
          <Chip key={f} active={selected.includes(f)} onClick={() => onToggle(f)}>
            {FACILITY_SHORT[f]}
          </Chip>
        ))}
      </div>
      {/* Empty is not "no access" — rbac.entitledFacilities() reads an empty
          list as the full set. Saying so here stops an admin clearing chips to
          restrict someone and achieving the exact opposite. */}
      <span className={cn("mt-1.5 block text-cap", required && !selected.length ? "font-semibold text-breach" : "text-mute")}>
        {selected.length
          ? "Limited to the selected facilities."
          : required
            ? "This role needs at least one — an empty list would grant ALL facilities."
            : "None selected = all facilities."}
      </span>
    </fieldset>
  );
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
  const [creating, setCreating] = useState<CreateDraft | null>(null);
  const [credId, setCredId] = useState<string | null>(null);
  const [credValue, setCredValue] = useState("");
  const [pending, startTransition] = useTransition();

  // Filters. Plain component state rather than URL params: this is one panel on
  // an admin page, not a shareable board view.
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "">("");
  const [facilityFilter, setFacilityFilter] = useState<Facility | "">("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
      if (roleFilter && u.role !== roleFilter) return false;
      // An empty entitlement list means every facility, so such a user matches
      // any facility filter — anything else would hide the broadest accounts.
      if (facilityFilter && u.facilities.length && !u.facilities.includes(facilityFilter)) return false;
      if (statusFilter === "active" && !u.active) return false;
      if (statusFilter === "inactive" && u.active) return false;
      return true;
    });
  }, [users, query, roleFilter, facilityFilter, statusFilter]);

  const closeAll = () => {
    setOpenId(null);
    setDraft(null);
    setCreating(null);
    setCredId(null);
    setCredValue("");
  };

  const openEdit = (u: UserView) => {
    closeAll();
    setOpenId(u.id);
    setDraft(draftOf(u));
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
        closeAll();
      } else {
        // The lockout rules ("last active admin", "your own admin access")
        // arrive here as plain sentences — show them verbatim rather than a
        // generic failure, because the message IS the instruction.
        toast.error(res.error);
      }
    });
  };

  const submitCreate = () => {
    if (!creating) return;
    startTransition(async () => {
      const res = await createUser({
        name: creating.name,
        email: creating.email,
        role: creating.role,
        facilities: creating.facilities,
        allView: creating.allView,
        areaManager: creating.areaManager.trim() || undefined,
        active: creating.active,
      });
      if (res.ok) {
        toast.success(
          creating.active
            ? `${creating.email.trim().toLowerCase()} created — they can now sign in with Google.`
            : `${creating.email.trim().toLowerCase()} created (inactive — cannot sign in yet).`,
        );
        closeAll();
      } else {
        toast.error(res.error);
      }
    });
  };

  const flipActive = (u: UserView) => {
    startTransition(async () => {
      const res = u.active ? await deactivateUser(u.id) : await reactivateUser(u.id);
      if (res.ok) toast.success(u.active ? `${u.name} deactivated — access revoked.` : `${u.name} reactivated.`);
      else toast.error(res.error);
    });
  };

  const submitCredential = (u: UserView) => {
    startTransition(async () => {
      const res = await setUserCredential(u.id, credValue);
      // Clear the plaintext from component state whichever way it went.
      setCredValue("");
      if (res.ok) {
        toast.success(`Break-glass password set for ${u.name}.`);
        setCredId(null);
      } else {
        toast.error(res.error);
      }
    });
  };

  const filtersOn = Boolean(query || roleFilter || facilityFilter || statusFilter);

  return (
    <section className="mb-6 overflow-hidden rounded-card bg-card shadow-card">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line bg-paper px-5 py-3.5">
        <Icon name="users-group-two-rounded-bold-duotone" size={17} className="text-sage" />
        <h2 className="font-display text-sec font-bold">Users &amp; entitlements</h2>
        <span className="text-cap text-mute">
          {shown.length === users.length ? `${users.length} accounts` : `${shown.length} of ${users.length}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dbReady ? (
            <Button onClick={() => (creating ? closeAll() : (closeAll(), setCreating(blankCreate())))} disabled={pending}>
              <Icon name={creating ? "close-circle-bold-duotone" : "user-plus-bold-duotone"} size={16} />
              {creating ? "Cancel" : "Add user"}
            </Button>
          ) : (
            <span className="text-cap text-mute">read-only — no database configured</span>
          )}
        </div>
      </header>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        <div className="min-w-[220px] flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or email…"
            aria-label="Search users by name or email"
          />
        </div>
        <Select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as Role | "")}
          aria-label="Filter by role"
          className="w-auto min-w-[150px]"
        >
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          value={facilityFilter}
          onChange={(e) => setFacilityFilter(e.target.value as Facility | "")}
          aria-label="Filter by facility"
          className="w-auto min-w-[130px]"
        >
          <option value="">All facilities</option>
          {FACILITIES.map((f) => (
            <option key={f} value={f}>
              {FACILITY_SHORT[f]}
            </option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "inactive")}
          aria-label="Filter by status"
          className="w-auto min-w-[120px]"
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </Select>
        {filtersOn ? (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setRoleFilter("");
              setFacilityFilter("");
              setStatusFilter("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {/* Create form */}
      {creating ? (
        <div className="border-b border-line bg-paper px-5 py-4">
          <h3 className="mb-3 font-display text-title font-bold">New account</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Full name">
              <Input
                value={creating.name}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                placeholder="Priya Sharma"
              />
            </Field>
            <Field label="Email" hint="Must be @snitch.com — Google SSO enforces the same domain.">
              <Input
                type="email"
                value={creating.email}
                onChange={(e) => setCreating({ ...creating, email: e.target.value })}
                placeholder="priya.s@snitch.com"
              />
            </Field>

            <Field label="Role">
              <Select
                value={creating.role}
                onChange={(e) => {
                  const role = e.target.value as Role;
                  setCreating({
                    ...creating,
                    role,
                    // A fresh admin with no facility list and allView=false lands
                    // on a single facility — mirror seed-admin.mts's default.
                    allView: role === "ADMIN" ? true : creating.allView,
                    areaManager: roleNeedsAreaManager(role) ? creating.areaManager : "",
                  });
                }}
              >
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                    {r.readOnly ? " — read-only" : ""}
                  </option>
                ))}
              </Select>
            </Field>

            {/* Only RETAIL_HEAD reads areaManager (lib/data.ts), so showing it on
                any other role invites dead data that starts scoping the day
                someone's role changes. */}
            {roleNeedsAreaManager(creating.role) ? (
              <Field label="AM scope" hint="Required — without one they see every store.">
                <Input
                  value={creating.areaManager}
                  onChange={(e) => setCreating({ ...creating, areaManager: e.target.value })}
                  placeholder="Sonit Tandon"
                  invalid={!creating.areaManager.trim()}
                />
              </Field>
            ) : (
              <div className="hidden md:block" />
            )}

            <FacilityPicker
              selected={creating.facilities}
              onToggle={(f) => setCreating({ ...creating, facilities: toggle(creating.facilities, f) })}
              required={roleNeedsFacilities(creating.role)}
            />

            <div className="grid content-start gap-2">
              <label className="flex items-center gap-2.5 text-ui">
                <input
                  type="checkbox"
                  checked={creating.allView}
                  onChange={(e) => setCreating({ ...creating, allView: e.target.checked })}
                  className="h-4 w-4 accent-ink"
                />
                Offer the “All facilities” union view
              </label>
              <label className="flex items-center gap-2.5 text-ui">
                <input
                  type="checkbox"
                  checked={creating.active}
                  onChange={(e) => setCreating({ ...creating, active: e.target.checked })}
                  className="h-4 w-4 accent-ink"
                />
                Active — allowlisted for Google sign-in
              </label>
            </div>
          </div>

          <p className="mt-3 text-cap text-mute">
            No password is set here. An active account signs in with Google SSO; use{" "}
            <span className="font-semibold">Set password</span> on the row afterwards only if they need a break-glass
            fallback.
          </p>

          <div className="mt-4 flex gap-2.5">
            <Button onClick={submitCreate} disabled={pending}>
              {pending ? "Creating…" : "Create account"}
            </Button>
            <Button variant="ghost" onClick={closeAll} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

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
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-sm text-mute">
                  {users.length ? "No accounts match these filters." : "No accounts yet."}
                </td>
              </tr>
            ) : null}
            {shown.map((u) => {
              const editing = openId === u.id && draft;
              const settingCred = credId === u.id;
              const roleLabel = roles.find((r) => r.value === u.role)?.label ?? u.role;
              return (
                <tr
                  key={u.id}
                  className="border-b border-line text-dense last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper"
                >
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
                        <Field label="Role">
                          <Select
                            value={draft.role}
                            onChange={(e) => {
                              const role = e.target.value as Role;
                              setDraft({
                                ...draft,
                                role,
                                areaManager: roleNeedsAreaManager(role) ? draft.areaManager : "",
                              });
                            }}
                          >
                            {roles.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                                {r.readOnly ? " — read-only" : ""}
                              </option>
                            ))}
                          </Select>
                        </Field>

                        {roleNeedsAreaManager(draft.role) ? (
                          <Field label="AM scope" hint="Blank = sees every store.">
                            <Input
                              value={draft.areaManager}
                              onChange={(e) => setDraft({ ...draft, areaManager: e.target.value })}
                              placeholder="none — sees all stores"
                            />
                          </Field>
                        ) : (
                          <div className="hidden md:block" />
                        )}

                        <FacilityPicker
                          selected={draft.facilities}
                          onToggle={(f) => setDraft({ ...draft, facilities: toggle(draft.facilities, f) })}
                          required={roleNeedsFacilities(draft.role)}
                        />

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
                        <Button variant="ghost" onClick={closeAll} disabled={pending}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  ) : settingCred ? (
                    <td colSpan={7} className="bg-paper px-5 py-4">
                      <div className="mb-3 flex items-baseline gap-2">
                        <span className="text-ui font-bold">Break-glass password</span>
                        <span className="mono text-cap text-mute">{u.email}</span>
                      </div>
                      <div className="max-w-md">
                        <Field
                          label="New password"
                          hint={`At least ${minCredentialLength(u.role)} characters for ${roleLabel}. Only the bcrypt hash is stored — nobody can read it back, so record it somewhere safe now.`}
                        >
                          <Input
                            type="password"
                            autoComplete="new-password"
                            value={credValue}
                            onChange={(e) => setCredValue(e.target.value)}
                            invalid={credValue.length > 0 && credValue.length < minCredentialLength(u.role)}
                          />
                        </Field>
                      </div>
                      <div className="mt-4 flex gap-2.5">
                        <Button
                          onClick={() => submitCredential(u)}
                          disabled={pending || credValue.length < minCredentialLength(u.role)}
                        >
                          {pending ? "Setting…" : "Set password"}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setCredId(null);
                            setCredValue("");
                          }}
                          disabled={pending}
                        >
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
                          {u.active ? "active" : "inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => openEdit(u)}
                            disabled={!dbReady || pending}
                            title={dbReady ? undefined : "Requires the database"}
                          >
                            Edit access
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => {
                              closeAll();
                              setCredId(u.id);
                            }}
                            disabled={!dbReady || pending}
                            title="Set a break-glass password (SSO is the normal route)"
                          >
                            Set password
                          </Button>
                          <Button
                            variant={u.active ? "danger" : "outline"}
                            onClick={() => flipActive(u)}
                            disabled={!dbReady || pending}
                          >
                            {u.active ? "Deactivate" : "Reactivate"}
                          </Button>
                        </div>
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
