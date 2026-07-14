// Dry-run diagnostic for the Snowflake distribution_analytics reader.
//   npx tsx scripts/snowflake-dryrun.ts [SO_NUMBER ...]
// Prints shape/vocabulary summaries (no bulk data dump) so the mapper and
// schema types can be validated against real rows before a deploy.

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { queryDistributionAnalytics, type DistributionRow } from "../src/lib/snowflake";

function distinct(rows: DistributionRow[], key: keyof DistributionRow): string[] {
  return [...new Set(rows.map((r) => String(r[key] ?? "∅")))].sort();
}

async function main() {
  const t0 = Date.now();
  const rows = await queryDistributionAnalytics();
  console.log(`fetched ${rows.length} rows in ${Date.now() - t0}ms`);

  const byOrder = new Map<string, DistributionRow[]>();
  for (const r of rows) {
    const list = byOrder.get(r.ORDER_NAME) ?? [];
    list.push(r);
    byOrder.set(r.ORDER_NAME, list);
  }
  console.log(`distinct orders: ${byOrder.size}`);

  const multiAwb = [...byOrder.entries()].filter(
    ([, rs]) => new Set(rs.map((r) => r.TRACKING_NUMBER).filter(Boolean)).size > 1,
  );
  console.log(`orders with 2+ AWBs: ${multiAwb.length} → ${multiAwb.slice(0, 5).map(([so]) => so).join(", ")}`);

  for (const key of [
    "ORDER_TYPE", "WAREHOUSE_NAME", "OVERALL_STATUS", "FINAL_STATUS", "COURIER_PARTNER",
    "ESHIP_STATUS", "STATUS", "LAST_CHECKPOINT_TAG", "ZONE", "LANE_CLASSIFICATION",
    "ORDER_PLACEMENT_SLA", "HANDOVER_SLA", "PICKUP_SLA", "DELIVERY_SLA",
    "TARGET_ORDER_DAY", "TARGET_ORDER_CUTOFF",
  ] as const) {
    console.log(`${key}: ${distinct(rows, key).slice(0, 20).join(" | ")}`);
  }

  const sample = rows.find((r) => r.TRACKING_NUMBER) ?? rows[0];
  if (sample) {
    console.log("--- sample row types/values (timestamp & tat fields) ---");
    for (const k of [
      "ORDER_TIMESTAMP", "ORDER_DATE", "MANIFESTED_TIMESTAMP", "ORDER_CUTOFF_TS",
      "HANDOVER_DEADLINE_TS", "PICKUP_TAT", "IDEAL_DELIVERY_DATE", "DELIVERY_TAT",
      "LOGISTICS_CREATED_TIMESTAMP", "TRACKING_PICK_DATE", "LOGISTICS_DELIVERY_TIMESTAMP",
      "LOGISTICS_EXPECTED_DELIVERY_DATE", "FIRST_OFD_DATE", "LATEST_OFD_DATE",
      "QUANTITY", "SALES_30D", "RANK", "BEST_TAT", "PACKAGE_COUNT",
      "DELIVERY_ATTEMPTS", "PICKUP_ATTEMPTS", "STORE",
    ] as const) {
      const v = sample[k];
      console.log(`  ${k}: [${typeof v}] ${v === null ? "null" : String(v)}`);
    }
  }

  const selfRows = rows.filter(
    (r) => /self|porter/i.test(r.COURIER_PARTNER ?? "") || /^SN\d+$/.test(r.TRACKING_NUMBER ?? ""),
  );
  console.log(
    `self/porter rows: ${selfRows.length} — sample AWBs: ${[...new Set(selfRows.map((r) => r.TRACKING_NUMBER))].slice(0, 8).join(", ")}`,
  );
  console.log(`rows without TRACKING_NUMBER: ${rows.filter((r) => !r.TRACKING_NUMBER).length}`);

  for (const so of process.argv.slice(2)) {
    const rs = byOrder.get(so) ?? [];
    console.log(`--- ${so}: ${rs.length} row(s) ---`);
    for (const r of rs) {
      console.log(
        `  awb=${r.TRACKING_NUMBER} courier=${r.COURIER_PARTNER} status=${r.STATUS} eship=${r.ESHIP_STATUS} overall=${r.OVERALL_STATUS} store=${r.STORE} invoice=${r.INVOICE_NUMBER}`,
      );
    }
  }
}

main().catch((e) => {
  console.error("dry-run failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
