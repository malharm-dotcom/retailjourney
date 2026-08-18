/**
 * STEP-0 FOLLOW-UP, READ-ONLY — the app-open orders that have NO spine row.
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/no-spine-deepdive.ts
 * Resolves them against warehouse_sla_performance and buckets the reason.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { ntzValue, querySnowflake, SPINE_TABLE } from "../src/lib/snowflake";

const head = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
// NULL-timestamp normalisation comes from lib/snowflake (ntzValue): Snowflake
// renders a NULL TIMESTAMP_NTZ as the literal string "NULL", which is truthy.

async function main() {
  const db = prisma();
  const open = await db.order.findMany({
    where: { overallStatus: { in: ["PICKUP_PENDING", "IN_TRANSIT", "WH_PROCESSING"] } },
    select: { soNumber: true, status: true, overallStatus: true, orderDate: true, finalStore: true, facility: true, manifestedTs: true, _count: { select: { shipments: true } } },
  });
  const inList = (xs: string[]) => xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const present = new Set(
    (await querySnowflake<{ ORDER_NAME: string }>(
      `SELECT DISTINCT ORDER_NAME FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${inList(open.map((o) => o.soNumber))})`,
    )).map((r) => r.ORDER_NAME),
  );
  const missing = open.filter((o) => !present.has(o.soNumber));
  head(`APP-OPEN ORDERS WITH NO SPINE ROW: ${missing.length}`);

  const wsp = await querySnowflake<Record<string, unknown>>(
    `SELECT order_name, order_date, marketplace_mapped, order_type, sla_status, item_status, last_updated
     FROM snitch_db.maplemonk.warehouse_sla_performance
     WHERE UPPER(TRIM(order_name)) IN (${inList(missing.map((o) => o.soNumber.toUpperCase()))})`,
  );
  console.log(`warehouse_sla_performance rows returned: ${wsp.length}`);

  const bySo = new Map<string, Record<string, unknown>[]>();
  for (const r of wsp) {
    const k = String(r.ORDER_NAME ?? r.order_name).toUpperCase().trim();
    const cur = bySo.get(k);
    if (cur) cur.push(r); else bySo.set(k, [r]);
  }
  console.log(`distinct orders resolved there: ${bySo.size} / ${missing.length}`);

  head("VOCABULARY in warehouse_sla_performance for this population");
  for (const key of ["ITEM_STATUS", "SLA_STATUS", "ORDER_TYPE", "MARKETPLACE_MAPPED"]) {
    const counts = new Map<string, number>();
    for (const r of wsp) {
      const v = String(r[key] ?? "∅");
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    console.log(`${key}: ${[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }

  head("BUCKETED");
  const buckets = new Map<string, { so: string; detail: string }[]>();
  const put = (k: string, so: string, detail: string) => {
    const a = buckets.get(k);
    if (a) a.push({ so, detail }); else buckets.set(k, [{ so, detail }]);
  };
  for (const o of missing) {
    const rs = bySo.get(o.soNumber.toUpperCase().trim());
    const ageDays = Math.floor((Date.now() - o.orderDate.getTime()) / 86_400_000);
    if (!rs) {
      put("absent (mapping) — not in warehouse_sla_performance either", o.soNumber, `orderDate=${o.orderDate.toISOString().slice(0, 10)} age=${ageDays}d store=${o.finalStore} status=${o.status}`);
      continue;
    }
    const itemStatuses = [...new Set(rs.map((r) => String(r.ITEM_STATUS ?? "∅").toUpperCase()))];
    const detail = `orderDate=${o.orderDate.toISOString().slice(0, 10)} age=${ageDays}d app=${o.status}/${o.overallStatus} item_status=[${itemStatuses.join(",")}] sla=[${[...new Set(rs.map((r) => String(r.SLA_STATUS ?? "∅")))].join(",")}] type=${rs[0].ORDER_TYPE ?? "∅"} mkt=${rs[0].MARKETPLACE_MAPPED ?? "∅"} lu=${ntzValue(rs[0].LAST_UPDATED as string | null) ?? "∅"}`;
    if (itemStatuses.some((s) => /CANCEL/.test(s))) put("cancelled-upstream", o.soNumber, detail);
    else if (ageDays > 60) put("aged-out (older than spine retention, 2026-06-18)", o.soNumber, detail);
    else put("excluded-by-rule (present in WH SLA, absent from spine)", o.soNumber, detail);
  }
  for (const [k, v] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${k}: ${v.length}`);
    for (const x of v.slice(0, 10)) console.log(`   ${x.so.padEnd(14)} ${x.detail}`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
