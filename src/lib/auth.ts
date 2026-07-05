// NextAuth scaffold (PRD §8c) — Google SSO restricted to @snitch.com plus a
// credentials fallback. In M1 (no DB) the credentials provider doubles as the
// dev persona switcher: it signs in as any active seed user so every role's
// view is demoable. Env is read lazily inside function bodies (PRD §11 gotcha).

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { userByEmail, userById } from "./seed/users";
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

function devPersonaEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.RELAY_DEV_PERSONA === "1";
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
      id: "persona",
      name: "Persona",
      credentials: { userId: { label: "Persona", type: "text" } },
      async authorize(credentials) {
        if (!devPersonaEnabled()) return null;
        const u = credentials?.userId ? userById(credentials.userId) : undefined;
        if (!u || !u.active) return null;
        return { id: u.id, name: u.name, email: u.email };
      },
    }),
  );

  return {
    providers,
    session: { strategy: "jwt" },
    secret: process.env.NEXTAUTH_SECRET ?? process.env.SESSION_SECRET ?? "relay-dev-secret-not-for-prod",
    pages: { signIn: "/login" },
    callbacks: {
      async signIn({ user, account }) {
        if (account?.provider === "google") {
          // hd param is advisory — enforce the domain server-side (PRD §8c).
          const email = user.email ?? "";
          if (!email.endsWith("@snitch.com")) return false;
          // New @snitch.com logins need an Admin-activated seed/user record.
          const known = userByEmail(email);
          return Boolean(known?.active);
        }
        return true;
      },
      async jwt({ token, user }) {
        if (user?.id) token.uid = user.id;
        const u = token.uid ? userById(token.uid) : token.email ? userByEmail(token.email) : undefined;
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
        const u = token.uid ? userById(token.uid) : undefined;
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

export { devPersonaEnabled };
