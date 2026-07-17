// Prisma 7 CLI config — the connection URL moved here from schema.prisma.
// The CLI does NOT auto-load .env files in v7, so we load Next.js-style env
// files explicitly ('.env.local' wins over '.env', matching next dev).
// The runtime client gets its connection via @prisma/adapter-pg in src/lib/db.ts.

import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnv({ path: [".env.local", ".env"] });

// Same deploy-environment gate as src/lib/db.ts (kept self-contained — the
// Prisma CLI loads this file outside the app's module graph): a local
// `prisma migrate/db` against the production host refuses by default; Coolify
// sets RETAILJOURNEY_DEPLOY_ENV=production, operator scripts opt in per
// invocation with RETAILJOURNEY_ALLOW_PROD_DB=1.
const url = process.env.DATABASE_URL ?? "postgresql://unset:unset@localhost:5432/unset";
// Pure-codegen commands (generate/validate/format) never open a connection —
// they must keep working in local builds regardless of what .env.local holds.
const codegenOnly = process.argv.some((a) => /^(generate|validate|format|version|--version)$/.test(a));
if (
  !codegenOnly &&
  url.includes("168.144.81.147") &&
  process.env.RETAILJOURNEY_DEPLOY_ENV !== "production" &&
  process.env.RETAILJOURNEY_ALLOW_PROD_DB !== "1"
) {
  throw new Error(
    "REFUSING to run Prisma CLI against the production database from a non-deployed process. " +
      "Set RETAILJOURNEY_ALLOW_PROD_DB=1 for a deliberate one-off invocation.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url,
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
