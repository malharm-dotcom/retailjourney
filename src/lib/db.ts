// Prisma client singleton (Prisma 7 + @prisma/adapter-pg). DATABASE_URL is
// read lazily inside the factory (PRD §11 — Coolify injects runtime env after
// module evaluation) and the instance lives on globalThis so it survives
// Next.js HMR / route module reloads.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const g = globalThis as unknown as { __retailjourneyPrisma?: PrismaClient };

const PROD_DB_HOST = "168.144.81.147";

/**
 * Deploy-environment gate — closes the "local production build" hole. The
 * older guard keyed on NODE_ENV, which `next start` on a laptop satisfies;
 * this one keys on RETAILJOURNEY_DEPLOY_ENV=production, a marker set ONLY in
 * the Coolify environment and absent everywhere else. Any local process
 * (dev server, prod build, tsx script) that holds the production DATABASE_URL
 * dies here by default. Deliberate operator scripts opt in per invocation
 * with RETAILJOURNEY_ALLOW_PROD_DB=1 — an explicit claim, never a default.
 */
export function assertProdDbAllowed(url: string): void {
  if (!url.includes(PROD_DB_HOST)) return;
  if (process.env.RETAILJOURNEY_DEPLOY_ENV === "production") return;
  if (process.env.RETAILJOURNEY_ALLOW_PROD_DB === "1") return;
  throw new Error(
    `REFUSING to open a connection to the production database (${PROD_DB_HOST}) from a non-deployed process. ` +
      `The deployed app sets RETAILJOURNEY_DEPLOY_ENV=production in Coolify; local processes never carry it. ` +
      `For a deliberate operator script against prod, run with RETAILJOURNEY_ALLOW_PROD_DB=1 for that invocation only.`,
  );
}

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function prisma(): PrismaClient {
  if (!g.__retailjourneyPrisma) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    assertProdDbAllowed(url);
    const adapter = new PrismaPg({ connectionString: url });
    g.__retailjourneyPrisma = new PrismaClient({ adapter });
  }
  return g.__retailjourneyPrisma;
}
