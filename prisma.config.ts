// Prisma 7 CLI config — the connection URL moved here from schema.prisma.
// The CLI does NOT auto-load .env files in v7, so we load Next.js-style env
// files explicitly ('.env.local' wins over '.env', matching next dev).
// The runtime client gets its connection via @prisma/adapter-pg in src/lib/db.ts.

import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnv({ path: [".env.local", ".env"] });

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://unset:unset@localhost:5432/unset",
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
