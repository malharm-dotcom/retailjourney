/**
 * One-off repair for the DD-MM-YYYY parse bug (fixed at source in
 * isoFromRfc1123).
 *
 * Eleven orders were written with a delivered date months in the FUTURE, taken
 * from an eShipz checkpoint whose "12-09-2026" (12 Sep) V8 read as 9 December.
 * A future delivered date never ages off the In-Transit board.
 *
 * Neither sync path repairs them on its own: applySyncPatch only writes
 * deliveredDate inside its `next !== o.shipmentStatus` branch, and these rows
 * are already DELIVERED, so the branch never fires — and eShipz stops polling
 * a delivered shipment. Hence an explicit correction, written through
 * repo.updateFields (one OrderEvent per field, overallStatus re-rolled after)
 * rather than a raw UPDATE. Source is SYNCED_SNOWFLAKE because the corrected
 * value IS the spine's LOGISTICS_DELIVERY_TIMESTAMP — so it stays correctable
 * by a later sync rather than being frozen as a manual override.
 *
 * Dry run by default:
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-misparsed-delivered.ts
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-misparsed-delivered.ts --apply
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });
import { prisma } from "../src/lib/db";
import { repo } from "../src/lib/repo";
import { istToday, daysBetween, istDateOf, isoFromIstNtz } from "../src/lib/ist";
import { querySnowflake, SPINE_TABLE, ntzValue } from "../src/lib/snowflake";

const APPLY = process.argv.includes("--apply");
const ACTOR = { id: "system", name: "date-parse repair" };
const NOTE = "corrected from spine LOGISTICS_DELIVERY_TIMESTAMP — was mis-parsed DD-MM-YYYY";

const dateStr = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

async function main() {
  const db = prisma();
  const today = istToday();

  // Find them by the defect itself, not by a hardcoded list: a delivered date
  // that has not happened yet.
  const all = await db.order.findMany({
    where: { deliveredDate: { not: null } },
    select: { soNumber: true, deliveredDate: true, deliveredTs: true },
  });
  const broken = all.filter((o) => daysBetween(dateStr(o.deliveredDate)!, today) < 0);
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${broken.length} orders with a future delivered date\n`);
  if (!broken.length) return;

  const names = broken.map((o) => `'${o.soNumber.replace(/'/g, "''")}'`).join(",");
  const spine = await querySnowflake<Record<string, unknown>>(
    `SELECT ORDER_NAME, LOGISTICS_DELIVERY_TIMESTAMP
     FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${names})`,
  );
  const truth = new Map<string, string>();
  for (const r of spine) {
    const ts = isoFromIstNtz(ntzValue(r.LOGISTICS_DELIVERY_TIMESTAMP as string) ?? undefined);
    if (ts) truth.set(String(r.ORDER_NAME), ts);
  }

  let fixed = 0;
  let skipped = 0;
  for (const o of broken) {
    const ts = truth.get(o.soNumber);
    if (!ts) {
      console.log(`  ${o.soNumber}  SKIPPED — spine carries no delivery timestamp`);
      skipped++;
      continue;
    }
    const date = istDateOf(ts);
    if (daysBetween(date, today) < 0) {
      console.log(`  ${o.soNumber}  SKIPPED — spine value ${date} is also in the future`);
      skipped++;
      continue;
    }
    console.log(
      `  ${o.soNumber}  deliveredDate ${dateStr(o.deliveredDate)} -> ${date}   deliveredTs ${o.deliveredTs ? new Date(o.deliveredTs).toISOString() : "—"} -> ${ts}`,
    );
    if (APPLY) {
      await repo.updateFields(
        o.soNumber,
        { deliveredDate: date, deliveredTs: ts },
        ACTOR,
        "SYNCED_SNOWFLAKE",
        NOTE,
      );
      fixed++;
    }
  }

  console.log(`\n${APPLY ? `${fixed} corrected` : `${broken.length - skipped} would be corrected`}, ${skipped} skipped`);

  if (APPLY) {
    const after = await db.order.findMany({
      where: { soNumber: { in: broken.map((o) => o.soNumber) } },
      select: { soNumber: true, deliveredDate: true, overallStatus: true },
    });
    console.log(`\nread-back:`);
    for (const o of after)
      console.log(
        `  ${o.soNumber}  delivered=${dateStr(o.deliveredDate)} overall=${o.overallStatus} onBoard=${daysBetween(dateStr(o.deliveredDate)!, today) >= 0 && daysBetween(dateStr(o.deliveredDate)!, today) <= 2}`,
      );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma().$disconnect());
