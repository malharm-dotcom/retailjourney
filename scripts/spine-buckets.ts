/**
 * STEP-0 READ-ONLY — corrected Family-2 bucketing, classified SQL-side.
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/spine-buckets.ts
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { querySnowflake, SPINE_TABLE } from "../src/lib/snowflake";

const head = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const rowsOut = (rs: Record<string, unknown>[], n = 40) => {
  for (const r of rs.slice(0, n)) console.log("   " + Object.entries(r).map(([k, v]) => `${k}=${v ?? "∅"}`).join("  "));
  if (rs.length > n) console.log(`   … ${rs.length - n} more`);
};

async function main() {
  const db = prisma();

  head("SPINE RETENTION");
  rowsOut(await querySnowflake(`SELECT MIN(ORDER_DATE) AS MIN_OD, MAX(ORDER_DATE) AS MAX_OD, COUNT(*) AS N_ROWS FROM ${SPINE_TABLE}`));

  const open = await db.order.findMany({
    where: { overallStatus: { in: ["PICKUP_PENDING", "IN_TRANSIT", "WH_PROCESSING"] } },
    select: { soNumber: true, overallStatus: true, shipmentStatus: true, trackingNumber: true, _count: { select: { shipments: true } } },
  });
  const list = open.map((o) => `'${o.soNumber.replace(/'/g, "''")}'`).join(",");

  head(`SPINE CLASSIFICATION of the ${open.length} app-open orders (grouped SQL-side)`);
  rowsOut(
    await querySnowflake(
      `SELECT STATUS, ESHIP_STATUS,
              COUNT(*) AS N,
              COUNT(TRACKING_NUMBER) AS WITH_AWB,
              COUNT(POD_LINK) AS WITH_POD,
              COUNT(LOGISTICS_DELIVERY_TIMESTAMP) AS WITH_DELIV_TS,
              COUNT(DISTINCT OVERALL_STATUS) AS N_OVERALL,
              MIN(OVERALL_STATUS) AS ANY_OVERALL
       FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${list})
       GROUP BY 1,2 ORDER BY N DESC`,
    ),
  );

  head("Same population, by spine OVERALL_STATUS / FINAL_STATUS");
  rowsOut(
    await querySnowflake(
      `SELECT OVERALL_STATUS, FINAL_STATUS, COUNT(*) AS N, COUNT(TRACKING_NUMBER) AS WITH_AWB, COUNT(POD_LINK) AS WITH_POD
       FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${list}) GROUP BY 1,2 ORDER BY N DESC`,
    ),
  );

  head("DEFINITIVE spine-terminal rows for app-open orders (STATUS=DELIVERED or POD present)");
  const terminal = await querySnowflake<Record<string, string | null>>(
    `SELECT ORDER_NAME, TRACKING_NUMBER, STATUS, ESHIP_STATUS, POD_LINK, LOGISTICS_DELIVERY_TIMESTAMP, LAST_UPDATED
     FROM ${SPINE_TABLE}
     WHERE ORDER_NAME IN (${list})
       AND (UPPER(STATUS) IN ('DELIVERED','RETURN','RETURNED','RTO') OR POD_LINK IS NOT NULL)`,
  );
  const bySo = new Map<string, Record<string, string | null>[]>();
  for (const r of terminal) {
    const k = String(r.ORDER_NAME);
    const cur = bySo.get(k);
    if (cur) cur.push(r); else bySo.set(k, [r]);
  }
  const openBySo = new Map(open.map((o) => [o.soNumber, o]));
  console.log(`orders: ${bySo.size}`);
  let noChild = 0, awbNotLinked = 0, pollable = 0;
  const kids = await db.orderShipment.findMany({
    where: { soNumber: { in: [...bySo.keys()] } },
    select: { soNumber: true, awb: true, shipmentStatus: true, isPollable: true },
  });
  const kidsBySo = new Map<string, typeof kids>();
  for (const k of kids) {
    const cur = kidsBySo.get(k.soNumber);
    if (cur) cur.push(k); else kidsBySo.set(k.soNumber, [k]);
  }
  for (const [so, rs] of bySo) {
    const ks = kidsBySo.get(so) ?? [];
    if (ks.length === 0) noChild += 1;
    const spineAwbs = rs.map((r) => r.TRACKING_NUMBER).filter(Boolean) as string[];
    if (spineAwbs.some((a) => !ks.some((k) => k.awb === a))) awbNotLinked += 1;
    if (spineAwbs.some((a) => !/^SN\d+$/.test(a))) pollable += 1;
  }
  console.log(`  ... with ZERO app shipment children               : ${noChild}`);
  console.log(`  ... carrying a spine AWB with no matching child   : ${awbNotLinked}`);
  console.log(`  ... whose spine AWB is a REAL (pollable) AWB      : ${pollable}`);
  console.log(`  ... whose spine AWB is a self-delivery pseudo-AWB : ${bySo.size - pollable}`);

  console.log("\n  samples:");
  let n = 0;
  for (const [so, rs] of bySo) {
    if (n++ >= 20) break;
    const o = openBySo.get(so)!;
    const ks = kidsBySo.get(so) ?? [];
    console.log(
      `   ${so.padEnd(14)} app ovr=${o.overallStatus.padEnd(15)} ship=${(o.shipmentStatus ?? "∅").padEnd(15)} awb=${(o.trackingNumber ?? "∅").padEnd(14)} kids=[${ks.map((k) => `${k.awb}:${k.shipmentStatus ?? "∅"}`).join(",") || "none"}]`,
    );
    for (const r of rs) console.log(`      spine ${r.TRACKING_NUMBER ?? "∅"} STATUS=${r.STATUS} ESHIP=${r.ESHIP_STATUS} POD=${r.POD_LINK ? "yes" : "no"} deliv=${r.LOGISTICS_DELIVERY_TIMESTAMP ?? "∅"} lu=${r.LAST_UPDATED ?? "∅"}`);
  }

  head("GENUINE RESIDUAL — app open AND spine open (no terminal signal anywhere)");
  const openSpine = await querySnowflake<Record<string, string | null>>(
    `SELECT ORDER_NAME, TRACKING_NUMBER, STATUS, ESHIP_STATUS, OVERALL_STATUS, ORDER_DATE, LAST_UPDATED
     FROM ${SPINE_TABLE}
     WHERE ORDER_NAME IN (${list})
       AND POD_LINK IS NULL AND LOGISTICS_DELIVERY_TIMESTAMP IS NULL
       AND (STATUS IS NULL OR UPPER(STATUS) NOT IN ('DELIVERED','RETURN','RETURNED','RTO'))`,
  );
  const openSos = new Set(openSpine.map((r) => String(r.ORDER_NAME)));
  for (const so of bySo.keys()) openSos.delete(so);
  console.log(`orders with NO terminal spine signal at all: ${openSos.size}`);
  rowsOut(openSpine.filter((r) => openSos.has(String(r.ORDER_NAME))), 20);

  head("LAST_UPDATED vs the events it should reflect (AWB rows, 60d)");
  rowsOut(
    await querySnowflake(
      `SELECT
         SUM(CASE WHEN LAST_UPDATED = MANIFESTED_TIMESTAMP THEN 1 ELSE 0 END) AS LU_EQ_MANIFEST,
         SUM(CASE WHEN LAST_UPDATED = LOGISTICS_CREATED_TIMESTAMP THEN 1 ELSE 0 END) AS LU_EQ_AWB_CREATED,
         SUM(CASE WHEN LAST_UPDATED = LOGISTICS_DELIVERY_TIMESTAMP THEN 1 ELSE 0 END) AS LU_EQ_DELIVERY,
         SUM(CASE WHEN LAST_UPDATED = ORDER_TIMESTAMP THEN 1 ELSE 0 END) AS LU_EQ_ORDER_TS,
         COUNT(*) AS AWB_ROWS
       FROM ${SPINE_TABLE}
       WHERE ORDER_DATE >= DATEADD(day,-60,CURRENT_DATE) AND TRACKING_NUMBER IS NOT NULL`,
    ),
  );
  console.log("\nrows the CURRENT watermark (2026-08-17 02:22:37) would fetch on the next incremental run:");
  rowsOut(
    await querySnowflake(
      `SELECT COUNT(*) AS FETCHED, COUNT(TRACKING_NUMBER) AS WITH_AWB
       FROM ${SPINE_TABLE}
       WHERE LAST_UPDATED >= TO_TIMESTAMP_NTZ('2026-08-17 02:22:37.000') OR LAST_UPDATED IS NULL`,
    ),
  );

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
