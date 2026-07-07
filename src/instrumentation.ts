// Next.js instrumentation hook. The scheduler lives in instrumentation-node.ts
// and is only imported in the Node runtime — the edge compile of this file must
// never pull in pg/prisma (they need Node builtins).

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootNode } = await import("./instrumentation-node");
    bootNode();
  }
}
