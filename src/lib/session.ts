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

/**
 * The signed-in AND active user, or undefined — no redirect.
 *
 * Route handlers need this shape: bouncing a POST from curl or a fetch() to
 * the login page answers with a 307 to HTML, which a caller cannot act on. A
 * page wants the redirect; an API wants a status code. Both read `active` from
 * the row here, so neither can drift from the other.
 */
export async function currentUserOrNull(): Promise<User | undefined> {
  const session = await getServerSession(buildAuthOptions());
  const u = session?.user?.id ? await findUserById(session.user.id) : undefined;
  return u && u.active ? u : undefined;
}

export async function currentUser(): Promise<User> {
  const u = await currentUserOrNull();
  if (!u) redirect("/login");
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
