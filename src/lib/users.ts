// User lookups for auth/session — DB-backed when DATABASE_URL is set, seed
// fallback otherwise (mirrors the repo selection in repo.ts). Async because
// NextAuth callbacks and server components already are.

import { databaseConfigured, prisma } from "./db";
import { userToDomain } from "./prisma-map";
import { userByEmail as seedByEmail, userById as seedById } from "./seed/users";
import type { User } from "./types";

export async function findUserById(id: string): Promise<User | undefined> {
  if (!databaseConfigured()) return seedById(id);
  const row = await prisma().user.findUnique({ where: { id } });
  return row ? userToDomain(row) : undefined;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  if (!databaseConfigured()) return seedByEmail(email);
  const row = await prisma().user.findUnique({ where: { email: email.toLowerCase() } });
  return row ? userToDomain(row) : undefined;
}

/**
 * The bcrypt hash, fetched separately and deliberately NOT part of the domain
 * `User` type — User objects are passed into server components and props, and
 * a hash that never enters that shape can never be serialised to a client.
 * Only the credentials provider calls this. The seed repo has no passwords, so
 * in-memory mode cannot authenticate anyone.
 */
export async function findPasswordHash(userId: string): Promise<string | undefined> {
  if (!databaseConfigured()) return undefined;
  const row = await prisma().user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return row?.passwordHash ?? undefined;
}
