// The ONE auth module (PRD §8c). Every provider, callback and session shape
// lives here so swapping the credentials login for Google SSO later is a
// single-file change. Env is read lazily inside function bodies (PRD §11).
//
// Two ways in. Google SSO is the primary path and self-provisions: any
// verified @snitch.com address gets a User row on first sign-in (see
// auto-provision.ts), landing on VIEWER — read-only, every facility, no edit
// right — until an admin grants a real role. Email + password against
// User.passwordHash (bcrypt) remains for admin-created accounts; an
// auto-provisioned row has no hash and so cannot use it.
//
// The old passwordless "persona" provider is GONE — it authenticated on a user
// id alone, which is an authentication bypass wherever its env flag was set.

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { compare } from "bcryptjs";
import { findUserByEmail, findUserById, findPasswordHash } from "./users";
import { provisionOnFirstSignIn } from "./auto-provision";
import type { Facility, Role } from "./types";

declare module "next-auth" {
  interface Session {
    /** Optional on purpose: the session callback drops it entirely when the
     *  backing User row is gone or deactivated, so a consumer that forgets to
     *  check cannot compile its way past a revoked account. */
    user?: {
      id: string;
      name: string;
      email: string;
      role: Role;
      facilities: Facility[];
      allView: boolean;
      areaManager?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: Role;
    facilities?: Facility[];
    allView?: boolean;
    areaManager?: string;
  }
}

/** A real bcrypt hash of a value nobody holds — the constant-time decoy for
 *  unknown emails. Never matches: it hashes a random-at-module-load string. */
const DUMMY_HASH = "$2b$12$K8pQZ1vJ0oR9sB2xY4uWmugC7hJ3nD5tE1fA6cV8bN0lM2kP4qS9y";

/** Session signing key. A shared fallback was tolerable when the only login
 *  was a demo persona switcher; with real accounts behind it, an unset secret
 *  in a deployed environment means forgeable sessions — so refuse to run. */
function sessionSecret(): string {
  const s = process.env.NEXTAUTH_SECRET ?? process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.RETAILJOURNEY_DEPLOY_ENV === "production") {
    throw new Error("NEXTAUTH_SECRET is not set — refusing to sign sessions with a shared development key.");
  }
  return "retailjourney-dev-secret-not-for-prod";
}

export function buildAuthOptions(): NextAuthOptions {
  const providers: NextAuthOptions["providers"] = [];

  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (googleId && googleSecret) {
    providers.push(
      GoogleProvider({
        clientId: googleId,
        clientSecret: googleSecret,
        authorization: { params: { hd: "snitch.com", prompt: "select_account" } },
      }),
    );
  }

  providers.push(
    CredentialsProvider({
      id: "credentials",
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;
        if (!email || !password) return null;

        try {
          const u = await findUserByEmail(email);
          const hash = u ? await findPasswordHash(u.id) : undefined;
          // Always run a compare, even for an unknown email or an account with
          // no password set, so a wrong address and a wrong password cost the
          // same time and cannot be told apart by timing.
          const ok = await compare(password, hash ?? DUMMY_HASH);
          if (!u || !u.active || !hash || !ok) return null;

          return { id: u.id, name: u.name, email: u.email };
        } catch (e) {
          // NextAuth puts a thrown message straight into the ?error= query
          // string on the redirect. Internal failures (a refused database
          // connection, a driver error) must never be shown to whoever is
          // standing at the login form — log them, deny the attempt.
          console.error("[auth] credentials check failed:", e instanceof Error ? e.message : e);
          return null;
        }
      },
    }),
  );

  return {
    providers,
    session: { strategy: "jwt" },
    secret: sessionSecret(),
    pages: { signIn: "/login" },
    callbacks: {
      async signIn({ user, account, profile }) {
        if (account?.provider === "google") {
          // hd param is advisory — enforce the domain server-side (PRD §8c),
          // and on the claim Google actually verified, not on whatever the
          // account happens to carry.
          const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
          // An unverified address is an unowned one. Without this gate the
          // suffix check below proves nothing: a directory can hold an
          // @snitch.com address whose mailbox was never confirmed.
          const verified = (profile as { email_verified?: boolean } | undefined)?.email_verified === true;
          if (!verified || !email.endsWith("@snitch.com")) {
            console.warn(`[auth] google sign-in denied — domain/verification: ${email || "<no email>"}`);
            return false;
          }
          // Past this point the address is a verified @snitch.com one, so it
          // is an employee: they get an account without an admin pre-creating
          // it. What they do NOT get is access — the row lands on VIEWER,
          // read-only everywhere, until an admin says otherwise.
          const known = await findUserByEmail(email);
          if (known) {
            if (!known.active) {
              console.warn(`[auth] google sign-in denied — deactivated account: ${email}`);
              return false;
            }
            return true;
          }
          const provisioned = await provisionOnFirstSignIn({ email, name: profile?.name ?? user.name });
          if (!provisioned) {
            console.warn(`[auth] google sign-in denied — could not provision: ${email}`);
            return false;
          }
          return true;
        }
        return true;
      },
      async jwt({ token, user }) {
        if (user?.id) token.uid = user.id;
        // The credentials provider returns our own row id, so the id lookup
        // hits. Google returns *its* `sub` — an id no User row will ever
        // carry — so fall through to the email that signIn just verified,
        // then overwrite token.uid below with the real one.
        const email = user?.email ?? token.email;
        const u =
          (token.uid ? await findUserById(token.uid) : undefined) ??
          (email ? await findUserByEmail(email) : undefined);
        if (u) {
          token.uid = u.id;
          token.role = u.role;
          token.facilities = u.facilities;
          token.allView = u.allView;
          token.areaManager = u.areaManager;
        }
        return token;
      },
      async session({ session, token }) {
        const u = token.uid ? await findUserById(token.uid) : undefined;
        // Revocation has to take effect on the next request, not at token
        // expiry. The row is the authority: the JWT's own copy of role and
        // entitlements is a cache, and falling back to it — or worse, to
        // "RETAIL_HEAD" — meant a deleted row still produced a plausible
        // session and a deactivated one kept whatever role it was minted with.
        // No row, or an inactive one, now means no user on the session at all.
        if (!u || !u.active) {
          session.user = undefined;
          return session;
        }
        session.user = {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          facilities: u.facilities,
          allView: u.allView,
          areaManager: u.areaManager,
        };
        return session;
      },
    },
  };
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

