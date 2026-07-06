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
