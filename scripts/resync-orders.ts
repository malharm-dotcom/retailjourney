/**
 * OPERATOR re-read of NAMED orders through the exact per-order Snowflake sync
 * path (syncSnowflakeOrder) — for orders nothing else will ever read again:
 * their last spine event predates the watermark AND they are older than the
 * dated sweep, so neither the incremental pull nor a reseed reaches them.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/resync-orders.ts SO1 SO2 ...          # dry run
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/resync-orders.ts --apply SO1 SO2 ...  # write
 *
 * Dry run predicts the overallStatus with the same rollup helpers and writes
 * nothing. --apply runs the real sync function, which records OrderEvents
 * (source SYNCED_SNOWFLAKE) exactly as the hourly run would.
 */
import { config } from "dotenv"; config({ path: [".env.local", ".env"] });
import { prisma } from "../src/lib/db";
import { querySnowflake, spineWindowQuery, type DistributionRow } from "../src/lib/snowflake";
import { mapDistributionRows } from "../src/lib/distribution-map";
import { orderToDomain, shipmentToDomain } from "../src/lib/prisma-map";
import { rollupOverall, rollupShipments } from "../src/lib/journey";
import { syncSnowflakeOrder, withInwardSeed, frozenOverall, guardedStatus, inferredWhStatus, evidenceStatus, dispatchedOverall } from "../src/lib/integrations/sync";

const WINDOW_DAYS = 120;

async function main() {
  const apply = process.argv.includes("--apply");
  const sos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!sos.length) throw new Error("usage: resync-orders.ts [--apply] SO1 SO2 ...");
  const db = prisma();

  const rows = (await querySnowflake<DistributionRow>(spineWindowQuery(WINDOW_DAYS))).filter((r) => sos.includes(String(r.ORDER_NAME)));
  const mapped = new Map(mapDistributionRows(rows).map((m) => [m.soNumber, m]));
  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${sos.length} orders, ${rows.length} spine rows found\n`);

  for (const so of sos) {
    const m = mapped.get(so);
    const row = await db.order.findUnique({ where: { soNumber: so } });
    if (!m || !row) { console.log(`   ${so.padEnd(14)} SKIPPED — ${!m ? "no spine row in window" : "not in app"}`); continue; }
    const kids = (await db.orderShipment.findMany({ where: { soNumber: so } })).map(shipmentToDomain);
    const before = row.overallStatus;
    const frozen = before === "DELIVERED" || (kids.length > 0 && kids.every((c) => c.shipmentStatus === "DELIVERED"));
    const predicted = frozen
      ? frozenOverall(before, m.overallStatusSeed)
      : withInwardSeed(rollupOverall({ status: row.status, shipmentStatus: rollupShipments(m.shipments.map((s) => s.shipmentStatus)) }), m.overallStatusSeed);

    const locked = frozen || row.manualFields.includes("status");
    const synced = (locked ? undefined : guardedStatus(row.status, inferredWhStatus(m, m.patch.dispatchedTs ?? row.dispatchedTs?.toISOString()))) ?? row.status;
    const status = evidenceStatus(synced, predicted, Boolean(m.patch.dispatchedTs ?? row.dispatchedTs)) ?? synced;
    // A childless order takes the spine seed verbatim (then never WH Processing once dispatched).
    const expected = dispatchedOverall(m.shipments.length || frozen ? predicted : (m.overallStatusSeed ?? predicted), status);
    if (!apply) { console.log(`   ${so.padEnd(14)} ${before.padEnd(15)} -> ${expected}   status ${row.status} -> ${status}   (spine seed ${m.overallStatusSeed ?? "∅"})`); continue; }

    const res = await syncSnowflakeOrder(m, orderToDomain(row), kids);
    const { overallStatus: after, status: afterStatus } = (await db.order.findUnique({ where: { soNumber: so }, select: { overallStatus: true, status: true } }))!;
    console.log(`   ${so.padEnd(14)} ${before.padEnd(15)} -> ${after.padEnd(10)} status ${row.status} -> ${afterStatus}   changed=${res.changed} conflicts=${res.conflicts}${after !== expected ? `   !! predicted ${expected}` : ""}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
