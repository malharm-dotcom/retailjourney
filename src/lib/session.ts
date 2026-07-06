// Server-side session + facility scope resolution. The facility cookie is a
// preference only — resolveScope() validates it against entitlements on every
// request (PRD §3: never trust a client facility value).

import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { buildAuthOptions } from "./auth";
import { resolveScope } from "./rbac";
import { findUserById } from "./users";
import type { FacilityScope, User } from "./types";

export const FACILITY_COOKIE = "retailjourney-facility";

export async function currentUser(): Promise<User> {
  const session = await getServerSession(buildAuthOptions());
  const u = session?.user?.id ? await findUserById(session.user.id) : undefined;
  if (!u || !u.active) redirect("/login");
  return u;
}

export async function currentScope(user?: User): Promise<FacilityScope> {
  const u = user ?? (await currentUser());
  const requested = cookies().get(FACILITY_COOKIE)?.value;
  return resolveScope(u, requested);
}

/** One-shot helper for pages: [user, validated facility scope]. */
export async function requireSession(): Promise<{ user: User; scope: FacilityScope }> {
  const user = await currentUser();
  const scope = await currentScope(user);
  return { user, scope };
}
