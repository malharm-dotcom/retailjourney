// Prisma client singleton (Prisma 7 + @prisma/adapter-pg). DATABASE_URL is
// read lazily inside the factory (PRD §11 — Coolify injects runtime env after
// module evaluation) and the instance lives on globalThis so it survives
// Next.js HMR / route module reloads.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const g = globalThis as unknown as { __retailjourneyPrisma?: PrismaClient };

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function prisma(): PrismaClient {
  if (!g.__retailjourneyPrisma) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const adapter = new PrismaPg({ connectionString: url });
    g.__retailjourneyPrisma = new PrismaClient({ adapter });
  }
  return g.__retailjourneyPrisma;
}
