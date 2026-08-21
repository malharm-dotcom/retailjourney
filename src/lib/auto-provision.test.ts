// What a self-provisioned account actually gets written as. auth.test.ts pins
// down WHO reaches this function; this pins down that what it creates is
// harmless — because from here on, an account can appear without any admin
// having looked at it, and the row shape is the only thing standing between
// "an employee can log in" and "an employee can change orders".

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ databaseConfigured: vi.fn(() => true), prisma: vi.fn() }));

import { databaseConfigured, prisma } from "./db";
import { provisionOnFirstSignIn } from "./auto-provision";

/** A prisma double recording what the user and audit models were asked to write. */
function db(existing?: Record<string, unknown> | null) {
  const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
    id: "usr_new",
    areaManager: null,
    ...create,
  }));
  const auditCreate = vi.fn(async (args: unknown) => args);
  const client = {
    user: { findUnique: vi.fn(async () => existing ?? null), upsert },
    userAccessAudit: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  vi.mocked(prisma).mockReturnValue(client as unknown as ReturnType<typeof prisma>);
  return { upsert, auditCreate, findUnique: client.user.findUnique };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(databaseConfigured).mockReturnValue(true);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("the auto-provisioned row", () => {
  it("lands on VIEWER, active, with no credential", async () => {
    const { upsert } = db();

    const user = await provisionOnFirstSignIn({ email: "Newbie@Snitch.com", name: "New Bie" });

    expect(user?.role).toBe("VIEWER");
    const { create } = upsert.mock.calls[0][0];
    expect(create.role).toBe("VIEWER");
    expect(create.active).toBe(true);
    // A hash is what would let this account be signed into with a password.
    // Never setting one is what keeps an auto-provisioned account SSO-only.
    expect(create).not.toHaveProperty("passwordHash");
  });

  it("normalises the address to lowercase", async () => {
    // The unique index and every findUserByEmail lookup are lowercase; a row
    // written with Google's casing would be a second, invisible account.
    const { upsert, findUnique } = db();

    await provisionOnFirstSignIn({ email: "  Newbie@Snitch.com  ", name: "New Bie" });

    expect(findUnique).toHaveBeenCalledWith({ where: { email: "newbie@snitch.com" } });
    expect(upsert.mock.calls[0][0].create.email).toBe("newbie@snitch.com");
  });

  it("falls back to the local part when Google sends no name", async () => {
    const { upsert } = db();

    await provisionOnFirstSignIn({ email: "newbie@snitch.com", name: null });

    expect(upsert.mock.calls[0][0].create.name).toBe("newbie");
  });

  it("writes an audit row with a system actor, not an admin", async () => {
    const { auditCreate } = db();

    await provisionOnFirstSignIn({ email: "newbie@snitch.com", name: "New Bie" });

    const { data } = auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.action).toBe("auto-provision");
    expect(data.actorId).toBe("system");
    expect(data.targetEmail).toBe("newbie@snitch.com");
  });
});

describe("what it refuses to do", () => {
  it("never resurrects a deactivated account", async () => {
    // The revocation bypass: deactivate someone, they sign in again, and a
    // naive "no active row? make one" would hand the account straight back.
    const { upsert } = db({ id: "usr_old", email: "gone@snitch.com", active: false });

    expect(await provisionOnFirstSignIn({ email: "gone@snitch.com" })).toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns an existing active row untouched, keeping its real role", async () => {
    // An admin signing in must not be rewritten to VIEWER by the path that
    // creates newcomers.
    const { upsert } = db({
      id: "usr_admin",
      name: "Admin",
      email: "admin@snitch.com",
      role: "ADMIN",
      facilities: [],
      allView: true,
      areaManager: null,
      active: true,
    });

    const user = await provisionOnFirstSignIn({ email: "admin@snitch.com" });

    expect(user?.role).toBe("ADMIN");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("declines rather than pretending, with no database configured", async () => {
    vi.mocked(databaseConfigured).mockReturnValue(false);

    expect(await provisionOnFirstSignIn({ email: "newbie@snitch.com" })).toBeUndefined();
    expect(prisma).not.toHaveBeenCalled();
  });
});
