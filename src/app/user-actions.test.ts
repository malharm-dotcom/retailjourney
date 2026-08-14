// The Admin → Users mutations, driven through the REAL server actions rather
// than a re-implementation, so a future edit to actions.ts cannot pass these by
// accident. Three things are being pinned down:
//
//  1. non-admins are refused before anything is written;
//  2. every mutation leaves an audit row, and a credential reset records only
//     that it happened — never the value;
//  3. createUser writes the row shape that auth.ts's allowlist accepts, which
//     is the whole point of the surface: an active row IS the SSO grant.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, User } from "@/lib/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
// Pulled in by actions.ts for the sync buttons; irrelevant here and expensive
// to load for real.
vi.mock("@/lib/integrations/sync", () => ({
  runAllSyncs: vi.fn(),
  runEshipzSync: vi.fn(),
  runSnowflakeSync: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ currentUser: vi.fn(), FACILITY_COOKIE: "facility" }));
vi.mock("@/lib/repo", () => ({ repo: { listUsers: vi.fn() } }));
vi.mock("@/lib/db", () => ({ databaseConfigured: vi.fn(() => true), prisma: vi.fn() }));

import { prisma } from "@/lib/db";
import { repo } from "@/lib/repo";
import { currentUser } from "@/lib/session";
import {
  createUser,
  deactivateUser,
  reactivateUser,
  setUserCredential,
  updateUserAccess,
} from "@/app/actions";

function userRow(over: Partial<User> = {}): User {
  return {
    id: "usr_target",
    name: "Target",
    email: "target@snitch.com",
    role: "LOGISTICS" as Role,
    facilities: [],
    allView: false,
    active: true,
    ...over,
  };
}

const ADMIN = userRow({ id: "usr_admin", name: "Admin", email: "admin@snitch.com", role: "ADMIN", allView: true });
const SECOND_ADMIN = userRow({ id: "usr_admin2", email: "admin2@snitch.com", role: "ADMIN", allView: true });
const TARGET = userRow();

/** A prisma double that records what each model was asked to write. */
function db() {
  const userUpdate = vi.fn(async (args: unknown) => args);
  const userCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "usr_new",
    ...data,
  }));
  const auditCreate = vi.fn(async (args: unknown) => args);
  const client = {
    user: { update: userUpdate, create: userCreate },
    userAccessAudit: { create: auditCreate },
    // The real $transaction hands the callback a scoped client; the doubles are
    // the same objects, which is what lets a test assert the audit row and the
    // mutation landed together.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return { client, userUpdate, userCreate, auditCreate };
}

let mock = db();

/** The single audit row this mutation wrote. */
function auditData(): Record<string, unknown> {
  expect(mock.auditCreate).toHaveBeenCalledTimes(1);
  return (mock.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock = db();
  vi.mocked(prisma).mockReturnValue(mock.client as never);
  vi.mocked(currentUser).mockResolvedValue(ADMIN as never);
  vi.mocked(repo.listUsers).mockResolvedValue([ADMIN, SECOND_ADMIN, TARGET]);
});

describe("non-admin refusal", () => {
  beforeEach(() => {
    vi.mocked(currentUser).mockResolvedValue(userRow({ id: "usr_wh", role: "WH_SUPERVISOR" }) as never);
  });

  const patch = {
    role: "ADMIN" as Role,
    facilities: [],
    allView: true,
    active: true,
  };

  it("refuses every mutation and writes nothing", async () => {
    // A warehouse supervisor holds canEditWarehouse — a real mutation right —
    // which is exactly the account that must not reach this surface.
    const results = [
      await updateUserAccess(TARGET.id, patch),
      await createUser({ ...patch, name: "Sneaky", email: "sneaky@snitch.com", role: "ADMIN" }),
      await deactivateUser(TARGET.id),
      await reactivateUser(TARGET.id),
      await setUserCredential(TARGET.id, "x".repeat(20)),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/admin only/i);
    }
    expect(mock.userUpdate).not.toHaveBeenCalled();
    expect(mock.userCreate).not.toHaveBeenCalled();
    expect(mock.auditCreate).not.toHaveBeenCalled();
  });
});

describe("audit trail", () => {
  it("records a create with the full initial grant", async () => {
    const res = await createUser({
      name: "Priya Sharma",
      email: "  Priya.S@Snitch.com ",
      role: "WH_OPERATOR" as Role,
      facilities: ["SAPL-WH1"],
      allView: false,
      active: true,
    });
    expect(res.ok).toBe(true);

    const d = auditData();
    expect(d.action).toBe("create");
    expect(d.actorId).toBe(ADMIN.id);
    expect(d.actorEmail).toBe(ADMIN.email);
    expect(d.targetEmail).toBe("priya.s@snitch.com");
    // No "before" exists, so the diff is the grant itself.
    expect(d.diff).toMatchObject({ role: "WH_OPERATOR", facilities: ["SAPL-WH1"], active: true });
  });

  it("records an update as a from/to delta of only what changed", async () => {
    const res = await updateUserAccess(TARGET.id, {
      role: "MERCHANDISING" as Role,
      facilities: [],
      allView: false,
      active: true,
    });
    expect(res.ok).toBe(true);

    const d = auditData();
    expect(d.action).toBe("update");
    expect(d.targetUserId).toBe(TARGET.id);
    expect(d.diff).toEqual({ role: { from: "LOGISTICS", to: "MERCHANDISING" } });
  });

  it("records deactivation and reactivation under their own action names", async () => {
    expect((await deactivateUser(TARGET.id)).ok).toBe(true);
    expect(auditData()).toMatchObject({ action: "deactivate", diff: { active: { from: true, to: false } } });

    mock = db();
    vi.mocked(prisma).mockReturnValue(mock.client as never);
    vi.mocked(repo.listUsers).mockResolvedValue([ADMIN, SECOND_ADMIN, userRow({ active: false })]);
    expect((await reactivateUser(TARGET.id)).ok).toBe(true);
    expect(auditData()).toMatchObject({ action: "reactivate", diff: { active: { from: false, to: true } } });
  });

  it("records a credential reset WITHOUT the credential", async () => {
    const secret = "correct-horse-battery-staple";
    const res = await setUserCredential(TARGET.id, secret);
    expect(res.ok).toBe(true);

    const d = auditData();
    expect(d.action).toBe("cred-reset");
    // The action name is the whole record. Anything else here would put a
    // password in a table built to be read by humans.
    expect(d.diff).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(secret);
  });

  it("stores only a bcrypt hash, never the plaintext", async () => {
    const secret = "correct-horse-battery-staple";
    await setUserCredential(TARGET.id, secret);

    const { data } = mock.userUpdate.mock.calls[0][0] as { data: { passwordHash: string } };
    expect(data.passwordHash).not.toBe(secret);
    expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
    // The action's own return type carries no hash, so nothing can serialise it
    // back to the client.
    expect(JSON.stringify(await setUserCredential(TARGET.id, secret))).not.toContain(secret);
  });
});

describe("lockouts still bite through the actions", () => {
  it("refuses to deactivate the last active admin", async () => {
    // Actor is a different admin, so this is the floor rule, not the self rule.
    vi.mocked(currentUser).mockResolvedValue(SECOND_ADMIN as never);
    vi.mocked(repo.listUsers).mockResolvedValue([ADMIN, TARGET, { ...SECOND_ADMIN, active: false }]);

    const res = await deactivateUser(ADMIN.id);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/last active admin/i);
    expect(mock.userUpdate).not.toHaveBeenCalled();
    expect(mock.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses self-deactivation", async () => {
    const res = await deactivateUser(ADMIN.id);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/your own/i);
    expect(mock.auditCreate).not.toHaveBeenCalled();
  });

  it("rebuilds the patch from the stored row, so deactivate cannot alter a role", async () => {
    await deactivateUser(TARGET.id);
    const { data } = mock.userUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ role: TARGET.role, facilities: TARGET.facilities, active: false });
  });
});

describe("createUser is the SSO allowlist entry", () => {
  it("persists an active, lowercased row — the shape auth.ts requires", async () => {
    const res = await createUser({
      name: "Priya Sharma",
      email: "  Priya.S@Snitch.com ",
      role: "LOGISTICS" as Role,
      facilities: [],
      allView: false,
      active: true,
    });
    expect(res.ok).toBe(true);

    const { data } = mock.userCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    // auth.ts looks the address up lowercased and refuses anything not active;
    // both halves of that gate are satisfied here.
    expect(data.email).toBe("priya.s@snitch.com");
    expect(data.active).toBe(true);
    // No credential is created alongside the row — SSO is the intended route.
    expect(data).not.toHaveProperty("passwordHash");
  });

  it("drops areaManager for roles that never read it", async () => {
    await createUser({
      name: "Ops Person",
      email: "ops@snitch.com",
      role: "LOGISTICS" as Role,
      facilities: [],
      allView: false,
      areaManager: "Sonit Tandon",
      active: true,
    });
    const { data } = mock.userCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    // Dead scoping data that would start biting the day this account became a
    // RETAIL_HEAD.
    expect(data.areaManager).toBeNull();
  });

  it("refuses a duplicate address before touching the database", async () => {
    const res = await createUser({
      name: "Dupe",
      email: "TARGET@snitch.com",
      role: "LOGISTICS" as Role,
      facilities: [],
      allView: false,
      active: true,
    });
    expect(res.ok).toBe(false);
    expect(mock.userCreate).not.toHaveBeenCalled();
  });
});
