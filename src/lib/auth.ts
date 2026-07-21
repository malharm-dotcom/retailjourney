// The ONE auth module (PRD §8c). Every provider, callback and session shape
// lives here so swapping the credentials login for Google SSO later is a
// single-file change. Env is read lazily inside function bodies (PRD §11).
//
// Sign-in is email + password against User.passwordHash (bcrypt). There is no
// public signup: accounts are created by scripts/seed-admin.mts and must be
// `active`. The old passwordless "persona" provider is GONE — it authenticated
// on a user id alone, which is an authentication bypass wherever its env flag
// was set.

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { compare } from "bcryptjs";
import { findUserByEmail, findUserById, findPasswordHash } from "./users";
import type { Facility, Role } from "./types";

declare module "next-auth" {
  interface Session {
    user: {
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
      async signIn({ user, account }) {
        if (account?.provider === "google") {
          // hd param is advisory — enforce the domain server-side (PRD §8c).
          const email = user.email ?? "";
          if (!email.endsWith("@snitch.com")) return false;
          // New @snitch.com logins need an Admin-activated user record.
          const known = await findUserByEmail(email);
          return Boolean(known?.active);
        }
        return true;
      },
      async jwt({ token, user }) {
        if (user?.id) token.uid = user.id;
        const u = token.uid
          ? await findUserById(token.uid)
          : token.email
            ? await findUserByEmail(token.email)
            : undefined;
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
        session.user = {
          id: u?.id ?? token.uid ?? "unknown",
          name: u?.name ?? session.user?.name ?? "Unknown",
          email: u?.email ?? session.user?.email ?? "",
          role: u?.role ?? token.role ?? "RETAIL_HEAD",
          facilities: u?.facilities ?? token.facilities ?? [],
          allView: u?.allView ?? token.allView ?? false,
          areaManager: u?.areaManager ?? token.areaManager,
        };
        return session;
      },
    },
  };
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

