// Production start wrapper (Coolify): run pending migrations, then serve.
// PRD §11 — migrations apply on deploy, not at build time (the build machine
// has no database). If DATABASE_URL is unset we boot straight into the
// in-memory fallback; if migrate fails we still boot so manual entry keeps
// working and the failure is loud in the logs.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Boot preflight. Both of these failure modes are SILENT inside Next — a
// missing deploy marker returns early out of bootNode(), and a missing
// instrumentation bundle is swallowed as MODULE_NOT_FOUND by next-server —
// so the schedulers simply never run and every source drifts stale together.
// Surface both here, before Next starts, where an operator will actually see it.
const deployEnv = process.env.RETAILJOURNEY_DEPLOY_ENV ?? "(absent)";
console.log(`[start] RETAILJOURNEY_DEPLOY_ENV=${deployEnv} NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
if (deployEnv !== "production") {
  console.error(
    "[start] WARNING: RETAILJOURNEY_DEPLOY_ENV is not 'production'. The in-app sync schedulers will NOT start " +
      "(eShipz poller and Snowflake reader both stay silent). Set it in the Coolify app environment.",
  );
}
if (!existsSync(".next/server/instrumentation.js")) {
  console.error(
    "[start] WARNING: .next/server/instrumentation.js is missing from the build — Next silently skips the " +
      "instrumentation hook, so no scheduler can ever start. Rebuild with experimental.instrumentationHook enabled.",
  );
}

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
