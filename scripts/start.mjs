// Production start wrapper (Coolify): run pending migrations, then serve.
// PRD §11 — migrations apply on deploy, not at build time (the build machine
// has no database). If DATABASE_URL is unset we boot straight into the
// in-memory fallback; if migrate fails we still boot so manual entry keeps
// working and the failure is loud in the logs.

import { spawn, spawnSync } from "node:child_process";

if (process.env.DATABASE_URL) {
  console.log("[start] applying migrations (prisma migrate deploy) ...");
  const r = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error("[start] MIGRATE FAILED — booting anyway; database queries may fail until resolved");
  }
} else {
  console.log("[start] DATABASE_URL not set — skipping migrations (in-memory mode)");
}

const child = spawn("npx", ["next", "start"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code) => process.exit(code ?? 0));
