/**
 * STEP-0 READ-ONLY DIAGNOSTIC — spine (RETAIL_JOURNEY_SPINE) vs app divergence.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/spine-diagnostics.ts
 *
 * SELECTs only, both sides. Answers: how STATUS/ESHIP_STATUS are populated and
 * how fresh they are; whether a late-arriving TRACKING_NUMBER is reachable by
 * the incremental (watermark) pull; and how many app-open orders sit against a
 * terminal spine row. Throwaway instrument — not part of the app.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { ntzValue, querySnowflake, SPINE_TABLE } from "../src/lib/snowflake";

const q = <T>(sql: string) => querySnowflake<T>(sql);
const head = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const rowsOut = (rs: Record<string, unknown>[], n = 25) => {
  for (const r of rs.slice(0, n)) console.log("   " + Object.entries(r).map(([k, v]) => `${k}=${v ?? "∅"}`).join("  "));
  if (rs.length > n) console.log(`   … ${rs.length - n} more`);
};

async function main() {
  const db = prisma();

  head("1. WHAT THE SPINE OBJECT IS");
  const meta = await q<Record<string, unknown>>(
    `SELECT TABLE_TYPE, ROW_COUNT, CREATED, LAST_ALTERED FROM SNITCH_DB.INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA='MAPLEMONK' AND TABLE_NAME='RETAIL_JOURNEY_SPINE'`,
  );
  rowsOut(meta);
  try {
    const ddl = await q<{ DDL: string }>(`SELECT GET_DDL('VIEW','${SPINE_TABLE}') AS DDL`);
    const text = ddl[0]?.DDL ?? "";
    console.log(`\nDDL length ${text.length}. Lines mentioning STATUS / ESHIP / LAST_UPDATED:`);
    for (const line of text.split("\n")) {
      if (/ESHIP_STATUS|\bSTATUS\b|LAST_UPDATED|POD_LINK/i.test(line)) console.log("   " + line.trim().slice(0, 220));
    }
  } catch (e) {
    console.log(`GET_DDL(VIEW) failed (${e instanceof Error ? e.message : e}) — trying TABLE`);
    try {
      const ddl = await q<{ DDL: string }>(`SELECT GET_DDL('TABLE','${SPINE_TABLE}') AS DDL`);
      console.log((ddl[0]?.DDL ?? "").slice(0, 3000));
    } catch (e2) { console.log(`GET_DDL(TABLE) failed too: ${e2 instanceof Error ? e2.message : e2}`); }
  }

  head("2. STATUS x ESHIP_STATUS VOCABULARY + CO-OCCURRENCE (rows with an AWB, 60d)");
  rowsOut(
    await q(`SELECT ESHIP_STATUS, STATUS, COUNT(*) AS N, COUNT(POD_LINK) AS WITH_POD,
                    COUNT(LOGISTICS_DELIVERY_TIMESTAMP) AS WITH_DELIV_TS
             FROM ${SPINE_TABLE}
             WHERE ORDER_DATE >= DATEADD(day,-60,CURRENT_DATE) AND TRACKING_NUMBER IS NOT NULL
             GROUP BY 1,2 ORDER BY N DESC`),
    40,
  );

  head("3. FRESHNESS — LAST_UPDATED distribution and stamping behaviour");
  rowsOut(
    await q(`SELECT MAX(LAST_UPDATED) AS MAX_LU, MIN(LAST_UPDATED) AS MIN_LU,
                    COUNT(*) AS ROWS_60D, COUNT(LAST_UPDATED) AS STAMPED,
                    SUM(CASE WHEN LAST_UPDATED IS NULL THEN 1 ELSE 0 END) AS UNSTAMPED
             FROM ${SPINE_TABLE} WHERE ORDER_DATE >= DATEADD(day,-60,CURRENT_DATE)`),
  );
  console.log("\nrows WITH an AWB whose LAST_UPDATED is NULL or predates the AWB's own creation");
  console.log("(these are unreachable by an incremental pull once the order is already ingested):");
  rowsOut(
    await q(`SELECT
               SUM(CASE WHEN LAST_UPDATED IS NULL THEN 1 ELSE 0 END) AS AWB_ROWS_UNSTAMPED,
               SUM(CASE WHEN LAST_UPDATED IS NOT NULL AND LOGISTICS_CREATED_TIMESTAMP IS NOT NULL
                        AND LAST_UPDATED < LOGISTICS_CREATED_TIMESTAMP THEN 1 ELSE 0 END) AS LU_BEFORE_AWB_CREATED,
               SUM(CASE WHEN LAST_UPDATED IS NOT NULL AND LOGISTICS_DELIVERY_TIMESTAMP IS NOT NULL
                        AND LAST_UPDATED < LOGISTICS_DELIVERY_TIMESTAMP THEN 1 ELSE 0 END) AS LU_BEFORE_DELIVERY,
               COUNT(*) AS AWB_ROWS
             FROM ${SPINE_TABLE}
             WHERE ORDER_DATE >= DATEADD(day,-60,CURRENT_DATE) AND TRACKING_NUMBER IS NOT NULL`),
  );
  console.log("\nper-day: orders whose ONLY spine rows are AWB-less vs AWB-bearing (last 25 days)");
  rowsOut(
    await q(`SELECT ORDER_DATE, COUNT(DISTINCT ORDER_NAME) AS ORDERS,
                    COUNT(DISTINCT CASE WHEN TRACKING_NUMBER IS NOT NULL THEN ORDER_NAME END) AS WITH_AWB
             FROM ${SPINE_TABLE} WHERE ORDER_DATE >= DATEADD(day,-25,CURRENT_DATE)
             GROUP BY 1 ORDER BY 1 DESC`),
    30,
  );

  head("4. ANSAPL16017 — every spine row, verbatim");
  rowsOut(
    await q(`SELECT ORDER_NAME, SHIPMENT_BILL, ORDER_DATE, OVERALL_STATUS, FINAL_STATUS,
                    TRACKING_NUMBER, COURIER_PARTNER, ESHIP_STATUS, STATUS,
                    MANIFESTED_TIMESTAMP, LOGISTICS_CREATED_TIMESTAMP, TRACKING_PICK_DATE,
                    LOGISTICS_DELIVERY_TIMESTAMP, POD_LINK, LAST_UPDATED
             FROM ${SPINE_TABLE} WHERE ORDER_NAME = 'ANSAPL16017'`),
  );

  head("5. APP-OPEN ORDERS vs THEIR SPINE ROW");
  const open = await db.order.findMany({
    where: { overallStatus: { in: ["PICKUP_PENDING", "IN_TRANSIT", "WH_PROCESSING"] } },
    select: { soNumber: true, overallStatus: true, shipmentStatus: true, trackingNumber: true, _count: { select: { shipments: true } } },
  });
  console.log(`app-open orders: ${open.length} (of which ${open.filter((o) => o._count.shipments === 0).length} have ZERO shipment children)`);
  const list = open.map((o) => `'${o.soNumber.replace(/'/g, "''")}'`).join(",");
  const spine = await q<Record<string, string | null>>(
    `SELECT ORDER_NAME, TRACKING_NUMBER, STATUS, ESHIP_STATUS, OVERALL_STATUS, POD_LINK,
            LOGISTICS_DELIVERY_TIMESTAMP, LOGISTICS_CREATED_TIMESTAMP, LAST_UPDATED
     FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${list})`,
  );
  console.log(`spine rows returned for those SOs: ${spine.length} (across ${new Set(spine.map((r) => r.ORDER_NAME)).size} orders — orders missing entirely are outside the spine's own retention)`);

  const bySo = new Map<string, Record<string, string | null>[]>();
  for (const r of spine) {
    const k = String(r.ORDER_NAME);
    (bySo.get(k) ?? bySo.set(k, []).get(k)!).push(r);
  }
  const TERMINAL = /^(DELIVERED|RETURN|RETURNED|RTO|RETURNTOORIGIN)$/;
  const norm = (v: string | null | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z]/g, "");

  let spineTerminal = 0, spineTerminalNoChild = 0, spineAwbAppHasNone = 0, spineOpen = 0, noSpineRow = 0;
  const samples: string[] = [];
  const lateAwb: string[] = [];
  for (const o of open) {
    const rs = bySo.get(o.soNumber);
    if (!rs) { noSpineRow += 1; continue; }
    // ntzValue is mandatory here: a NULL TIMESTAMP_NTZ arrives as the literal
    // string "NULL", so a bare Boolean() marks EVERY row terminal. That bug
    // made this script's first run report 1580/1580 orders terminal.
    const terminal = rs.some(
      (r) =>
        TERMINAL.test(norm(r.STATUS)) ||
        Boolean(ntzValue(r.POD_LINK)) ||
        Boolean(ntzValue(r.LOGISTICS_DELIVERY_TIMESTAMP)),
    );
    const spineAwbs = [...new Set(rs.map((r) => r.TRACKING_NUMBER).filter(Boolean))] as string[];
    if (terminal) {
      spineTerminal += 1;
      if (o._count.shipments === 0) spineTerminalNoChild += 1;
      if (samples.length < 20) {
        samples.push(
          `   ${o.soNumber.padEnd(14)} app: ovr=${o.overallStatus.padEnd(15)} ship=${(o.shipmentStatus ?? "∅").padEnd(15)} awb=${(o.trackingNumber ?? "∅").padEnd(14)} kids=${o._count.shipments}` +
            `  | spine: ${rs.map((r) => `${r.TRACKING_NUMBER ?? "∅"}/${r.STATUS ?? "∅"}/${r.ESHIP_STATUS ?? "∅"}${r.POD_LINK ? "/POD" : ""} lu=${r.LAST_UPDATED ?? "∅"}`).join(" ; ")}`,
        );
      }
    } else spineOpen += 1;
    if (spineAwbs.length && o._count.shipments === 0) {
      spineAwbAppHasNone += 1;
      if (lateAwb.length < 20) lateAwb.push(`   ${o.soNumber.padEnd(14)} spine AWB(s)=${spineAwbs.join(",")} status=${rs.map((r) => r.STATUS ?? "∅").join(",")} lu=${rs.map((r) => r.LAST_UPDATED ?? "∅").join(",")} created=${rs.map((r) => r.LOGISTICS_CREATED_TIMESTAMP ?? "∅").join(",")}`);
    }
  }
  console.log(`\n  spine row TERMINAL (STATUS delivered/return, or POD, or delivery ts) while app open : ${spineTerminal}`);
  console.log(`     ... of those with ZERO app shipment children (never linked)                      : ${spineTerminalNoChild}`);
  console.log(`  spine carries an AWB the app has NO child row for (late/unlinked AWB)               : ${spineAwbAppHasNone}`);
  console.log(`  spine ALSO open/pending — genuine residual pendency, do NOT reclassify             : ${spineOpen}`);
  console.log(`  no spine row at all (outside spine retention / never in spine)                     : ${noSpineRow}`);
  console.log("\n  samples — app open vs terminal spine row:");
  for (const s of samples) console.log(s);
  console.log("\n  samples — spine AWB with no app child row:");
  for (const s of lateAwb) console.log(s);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
