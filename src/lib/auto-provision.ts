// First-Google-sign-in account creation.
//
// Before this, a @snitch.com person could not log in at all until an admin ran
// createUser for their address — fine for a testing group, not for a rollout.
// The row is now created on their first successful SSO callback instead.
//
// What the row is NOT is an access grant. It lands on VIEWER: read-only across
// every facility, no edit right, no admin. Nothing here may ever widen that —
// the domain check in auth.ts decides WHO gets a row, this file decides that
// the row is harmless, and an admin deciding it is more than harmless stays a
// separate, audited act through the existing Admin → Users surface.
//
// Deliberately not part of app/actions.ts: that module is "use server" and its
// user mutations all begin by asserting an admin actor. This path has no actor
// at all, so it gets its own file rather than an exception carved into that one.

import { databaseConfigured, prisma } from "./db";
import { userToDomain } from "./prisma-map";
import type { User } from "./types";

/** Recorded as the actor on the audit row. There is no admin behind an
 *  auto-provision, and inventing one — the new user as their own grantor —
 *  would read like a self-service privilege escalation in the trail. */
const SYSTEM_ACTOR = { id: "system", email: "google-sso" } as const;

/**
 * The display name from the Google profile, or the local part of the address
 * when Google sent none. Never empty: `name` is non-null, and a blank name
 * renders as an unidentifiable row in the admin list.
 */
function displayName(email: string, name?: string | null): string {
  return name?.trim() || email.split("@")[0];
}

/**
 * Create the User row for a first-time @snitch.com Google sign-in.
 *
 * Callers MUST have verified the domain first — this function does not
 * re-check it, and is never the thing standing between a stranger and a row.
 *
 * Returns the row to sign in as, or undefined when sign-in must be refused.
 * Undefined covers two cases the caller does not need to tell apart: no
 * database (seed/in-memory mode cannot persist an account), and an existing
 * row that is deactivated — a revoked account must not be resurrected by its
 * owner simply signing in again, which is the one way this feature could
 * quietly undo a deactivation.
 */
export async function provisionOnFirstSignIn(opts: {
  email: string;
  name?: string | null;
}): Promise<User | undefined> {
  const email = opts.email.trim().toLowerCase();
  if (!databaseConfigured()) return undefined;

  const db = prisma();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing.active ? userToDomain(existing) : undefined;

  const created = await db.$transaction(async (tx) => {
    // upsert, not create: two browser tabs finishing OAuth at once would race
    // the findUnique above and the loser would hit the unique index on email.
    // `update: {}` makes the collision a no-op read of the row that won.
    const row = await tx.user.upsert({
      where: { email },
      create: {
        name: displayName(email, opts.name),
        email,
        role: "VIEWER",
        // Empty means ALL facilities (rbac.ts entitledFacilities) — the
        // intended scope here, and safe only because VIEWER cannot write.
        facilities: [],
        allView: true,
        // No credential is set. An auto-provisioned account is SSO-only: the
        // credentials provider refuses a null passwordHash, so this row cannot
        // be signed into with a password anyone guesses or sets for it.
        active: true,
      },
      update: {},
    });
    await tx.userAccessAudit.create({
      data: {
        actorId: SYSTEM_ACTOR.id,
        actorEmail: SYSTEM_ACTOR.email,
        targetUserId: row.id,
        targetEmail: row.email,
        action: "auto-provision",
        diff: { role: row.role, facilities: row.facilities, allView: row.allView, active: row.active },
      },
    });
    return row;
  });

  console.info(`[auth] auto-provisioned ${email} as VIEWER on first Google sign-in`);
  return userToDomain(created);
}
