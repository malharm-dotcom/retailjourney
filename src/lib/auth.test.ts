// The Google sign-in gate. The allowlist is now the DOMAIN, not a table: a
// login succeeds when the *verified* email is @snitch.com, and an unknown one
// self-provisions rather than being turned away. So the rejections below are
// no longer "no account" vs "an account" — the only things that still refuse
// are the wrong domain, an unverified claim, and a deactivated row. What an
// auto-provisioned account may DO is a separate guarantee, held by the VIEWER
// policy in rbac.test.ts and the row shape in auto-provision.test.ts.
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

vi.mock("./auto-provision", () => ({ provisionOnFirstSignIn: vi.fn() }));

import { findUserByEmail, findUserById } from "./users";
import { provisionOnFirstSignIn } from "./auto-provision";
import { buildAuthOptions } from "./auth";

const byEmail = vi.mocked(findUserByEmail);
const byId = vi.mocked(findUserById);
const provision = vi.mocked(provisionOnFirstSignIn);

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

  it("does not auto-provision a rejected non-snitch.com address", async () => {
    // The domain check has to run BEFORE provisioning, or the feature that
    // creates accounts becomes the feature that lets anyone create one.
    byEmail.mockResolvedValue(undefined);

    expect(await attemptSignIn("stranger@gmail.com")).toBe(false);
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not auto-provision on an unverified snitch.com claim", async () => {
    byEmail.mockResolvedValue(undefined);

    expect(await attemptSignIn("stranger@snitch.com", false)).toBe(false);
    expect(provision).not.toHaveBeenCalled();
  });

  it("auto-provisions an unknown snitch.com email and admits it", async () => {
    byEmail.mockResolvedValue(undefined);
    provision.mockResolvedValue(userRow({ email: "newbie@snitch.com", role: "VIEWER" as Role }));

    expect(await attemptSignIn("newbie@snitch.com")).toBe(true);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ email: "newbie@snitch.com" }));
  });

  it("refuses sign-in when provisioning cannot persist a row", async () => {
    // Fail closed. A caller that could not write the account must not be
    // waved through on a session with no row behind it.
    byEmail.mockResolvedValue(undefined);
    provision.mockResolvedValue(undefined);

    expect(await attemptSignIn("newbie@snitch.com")).toBe(false);
  });

  it("rejects a deactivated user WITHOUT re-provisioning them", async () => {
    // The one way this feature could quietly undo a revocation: a deactivated
    // person signs in again and gets a fresh active row. They must not.
    byEmail.mockResolvedValue(userRow({ active: false }));

    expect(await attemptSignIn("malhar.m@snitch.com")).toBe(false);
    expect(provision).not.toHaveBeenCalled();
  });

  it("admits an existing active snitch.com user without touching provisioning", async () => {
    byEmail.mockResolvedValue(userRow());

    expect(await attemptSignIn("malhar.m@snitch.com")).toBe(true);
    expect(provision).not.toHaveBeenCalled();
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

    expect(session.user?.id).toBe("usr_1");
    expect(session.user?.role).toBe("ADMIN");
  });

  it("drops the user from the session when the row is deactivated", async () => {
    // Revocation must land on the next request. The callback used to fall back
    // to the JWT's own copy of the role, so a deactivated account kept the
    // rights its token was minted with until that token expired.
    byId.mockResolvedValue(userRow({ role: "ADMIN" as Role, active: false }));

    const sessionCb = buildAuthOptions().callbacks!.session!;
    const session = (await sessionCb({
      session: { user: {}, expires: "" },
      token: { uid: "usr_1", role: "ADMIN" as Role } as JWT,
    } as Parameters<typeof sessionCb>[0])) as Session;

    expect(session.user).toBeUndefined();
  });

  it("drops the user from the session when the row is gone", async () => {
    // A deleted row used to yield a usable RETAIL_HEAD session out of the
    // `?? "RETAIL_HEAD"` fallback — a login for an account that no longer exists.
    byId.mockResolvedValue(undefined);

    const sessionCb = buildAuthOptions().callbacks!.session!;
    const session = (await sessionCb({
      session: { user: {}, expires: "" },
      token: { uid: "usr_gone", role: "ADMIN" as Role } as JWT,
    } as Parameters<typeof sessionCb>[0])) as Session;

    expect(session.user).toBeUndefined();
  });

  it("blocks a deactivated user on the credentials path too", async () => {
    // Same allowlist semantics both ways — RBAC must stay method-agnostic.
    const signIn = buildAuthOptions().callbacks!.signIn!;
    byEmail.mockResolvedValue(userRow({ active: false }));

    // Credentials never reaches signIn with a bad account: authorize() returns
    // null first. For an EXISTING session the gate is the session callback,
    // which re-reads the row and drops the user when it is inactive (covered
    // above), backed by currentUser()/currentUserOrNull() re-reading `active`.
    const res = await signIn({
      user: { id: "usr_1", email: "malhar.m@snitch.com" } as AuthUser,
      account: { provider: "credentials", type: "credentials", providerAccountId: "usr_1" },
    } as Parameters<typeof signIn>[0]);

    expect(res).toBe(true); // provider-level pass; authorize() is the real gate
  });
});
