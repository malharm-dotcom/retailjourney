/**
 * Restore order type / zone that a blank spine value overwrote.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-blanked-type-zone.ts
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-blanked-type-zone.ts --apply
 *
 * DRY BY DEFAULT — prints what it would change and writes nothing without
 * --apply.
 *
 * WHY THIS EXISTS: the mapper turns a blank ORDER_TYPE into "OTHER" and a
 * blank ZONE into "UNMAPPED", and the hourly sync wrote those fallbacks over
 * the real values UC intake (or an earlier spine read) had set. Measured
 * 2026-09-29: 650 orders read OTHER that were FRESH/RPL, 820 read UNMAPPED
 * that had a zone. dropBlankFallbacks (sync.ts) stops it recurring; this puts
 * the lost values back.
 *
 * FINDS BY THE DEFECT: an order is repaired only when its field STILL holds
 * the fallback AND a SYNCED_SNOWFLAKE event recorded the overwrite. It is
 * restored to that event's own fromValue — the newest real value it held —
 * never a guess. Re-runnable: a repaired order no longer matches.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");
const FIELDS = [
  { field: "type", blank: "OTHER" },
  { field: "zone", blank: "UNMAPPED" },
] as const;

async function main() {
  const db = prisma();
  for (const { field, blank } of FIELDS) {
    const events = await db.orderEvent.findMany({
      where: { source: "SYNCED_SNOWFLAKE", field, toValue: blank, fromValue: { notIn: [blank, ""] } },
      select: { orderId: true, fromValue: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    // Newest overwrite per order carries the value it most recently held.
    const restoreTo = new Map<string, string>();
    for (const e of events) if (!restoreTo.has(e.orderId) && e.fromValue) restoreTo.set(e.orderId, e.fromValue);

    const stillBlank = await db.order.findMany({
      where: { id: { in: [...restoreTo.keys()] }, [field]: blank },
      select: { id: true, soNumber: true },
    });
    const tally = new Map<string, number>();
    for (const o of stillBlank) tally.set(restoreTo.get(o.id)!, (tally.get(restoreTo.get(o.id)!) ?? 0) + 1);
    console.log(`${field}: ${stillBlank.length} orders to restore`, Object.fromEntries(tally), stillBlank.slice(0, 5).map((o) => o.soNumber));

    if (!APPLY) continue;
    let done = 0;
    for (const o of stillBlank) {
      const value = restoreTo.get(o.id)!;
      await db.$transaction([
        db.order.update({ where: { id: o.id }, data: { [field]: value } }),
        db.orderEvent.create({
          data: {
            orderId: o.id,
            field,
            fromValue: blank,
            toValue: value,
            source: "SYNCED_SNOWFLAKE",
            actorId: null,
            note: `Restored — a blank spine ${field} had overwritten it with ${blank} (fix-blanked-type-zone).`,
          },
        }),
      ]);
      done += 1;
    }
    console.log(`${field}: restored ${done}`);
  }
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
