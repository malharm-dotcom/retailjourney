// Next.js instrumentation hook. The scheduler lives in instrumentation-node.ts
// and is only imported in the Node runtime — the edge compile of this file must
// never pull in pg/prisma (they need Node builtins).

export async function register() {
  // Proof-of-execution: if this line is absent from the container logs, the
  // instrumentation hook itself never ran and no scheduler diagnosis below is
  // meaningful. (Three days of silent staleness cost us exactly this signal.)
  console.log(`[boot] register() invoked — NEXT_RUNTIME=${process.env.NEXT_RUNTIME ?? "(unset)"}`);
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootNode } = await import("./instrumentation-node");
    bootNode();
  }
}
