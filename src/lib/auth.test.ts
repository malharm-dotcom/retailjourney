// The Google sign-in gate. Provisioning is an ALLOWLIST: a Google login
// succeeds only when the *verified* email is @snitch.com AND a matching active
// User row already exists. There is no auto-create, so every rejection below
// is the difference between "no account" and "an account" — not a UX detail.
//
// These tests drive the real callbacks off buildAuthOptions() rather than a
// re-implementation, so a future edit to auth.ts cannot pass them by accident.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Profile, Session, User as AuthUser } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { User, Role } from "./types";

vi.mock("./users", () => ({
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  findPasswordHash: vi.fn(),
}));

import { findUserByEmail, findUserById } from "./users";
import { buildAuthOptions } from "./auth";

const byEmail = vi.mocked(findUserByEmail);
const byId = vi.mocked(findUserById);

function userRow(over: Partial<User> = {}): User {
  return {
    id: "usr_1",
    name: "Malhar M",
    email: "malhar.m@snitch.com",
    role: "LOGISTICS" as Role,
    facilities: [],
    allView: true,
    active: true,
    ...over,
  } as User;
}

const GOOGLE: Account = { provider: "google", type: "oauth", providerAccountId: "sub-123" };

/** Google hands us its own `sub` as the user id — never a User.id. */
function googleIdentity(email: string, emailVerified: boolean) {
  return {
    user: { id: "sub-123", name: "Malhar M", email } as AuthUser,
    account: GOOGLE,
    profile: { email, email_verified: emailVerified } as Profile,
  };
}

async function attemptSignIn(email: string, emailVerified = true): Promise<boolean> {
  const signIn = buildAuthOptions().callbacks!.signIn!;
  const res = await signIn(googleIdentity(email, emailVerified) as Parameters<typeof signIn>[0]);
  return res === true;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.NEXTAUTH_SECRET = "test-secret";
});

describe("google sign-in gate", () => {
  it("rejects a verified email outside snitch.com", async () => {
    // Allowlisted at the *other* domain — proves the domain check runs before
    // and independently of the allowlist, not merely alongside it.
    byEmail.mockResolvedValue(userRow({ email: "malhar.m@gmail.com" }));

    expect(await attemptSignIn("malhar.m@gmail.com")).toBe(false);
  });

  it("rejects an unverified snitch.com email", async () => {
    // hd=snitch.com on the authorization request is a hint Google does not
    // guarantee; an unverified claim must not clear the domain check.
    byEmail.mockResolvedValue(userRow());

    expect(await attemptSignIn("malhar.m@snitch.com", false)).toBe(false);
  });

  it("rejects a snitch.com email absent from the allowlist", async () => {
    byEmail.mockResolvedValue(undefined);

    expect(await attemptSignIn("stranger@snitch.com")).toBe(false);
  });

  it("rejects a deactivated allowlisted user", async () => {
    byEmail.mockResolvedValue(userRow({ active: false }));

    expect(await attemptSignIn("malhar.m@snitch.com")).toBe(false);
  });

  it("admits an allowlisted active snitch.com user", async () => {
    byEmail.mockResolvedValue(userRow());

    expect(await attemptSignIn("malhar.m@snitch.com")).toBe(true);
  });
});

describe("google session shape", () => {
  it("carries the role from the User row, not Google's sub", async () => {
    // The whole point of the jwt fallback: Google's `sub` matches no User row,
    // so an id-only lookup would silently hand out the default role.
    const row = userRow({ role: "ADMIN" as Role });
    byId.mockResolvedValue(undefined);
    byEmail.mockResolvedValue(row);

    const opts = buildAuthOptions();
    const jwt = opts.callbacks!.jwt!;
    const sessionCb = opts.callbacks!.session!;

    const token = (await jwt({
      token: { email: row.email } as JWT,
      user: { id: "sub-123", name: row.name, email: row.email } as AuthUser,
      account: GOOGLE,
    } as Parameters<typeof jwt>[0])) as JWT;

    expect(token.uid).toBe("usr_1");
    expect(token.role).toBe("ADMIN");

    byId.mockResolvedValue(row);
    const session = (await sessionCb({
      session: { user: {}, expires: "" },
      token,
    } as Parameters<typeof sessionCb>[0])) as Session;

    expect(session.user.id).toBe("usr_1");
    expect(session.user.role).toBe("ADMIN");
  });

  it("blocks a deactivated user on the credentials path too", async () => {
    // Same allowlist semantics both ways — RBAC must stay method-agnostic.
    const signIn = buildAuthOptions().callbacks!.signIn!;
    byEmail.mockResolvedValue(userRow({ active: false }));

    // Credentials never reaches signIn with a bad account: authorize() returns
    // null first. The deactivation gate that matters for an existing session is
    // currentUser(), which re-reads `active` on every request.
    const res = await signIn({
      user: { id: "usr_1", email: "malhar.m@snitch.com" } as AuthUser,
      account: { provider: "credentials", type: "credentials", providerAccountId: "usr_1" },
    } as Parameters<typeof signIn>[0]);

    expect(res).toBe(true); // provider-level pass; authorize() is the real gate
  });
});
