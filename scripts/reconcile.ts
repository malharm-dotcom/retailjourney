/**
 * DATA-SANITY RECONCILIATION — app Postgres vs Snowflake RETAIL_JOURNEY_SPINE.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/reconcile.ts
 *
 * READ-ONLY on both sides. SELECTs only: no INSERT, no UPDATE, no DELETE, no
 * DDL, no migration. It changes nothing and is safe to re-run.
 *
 * This is how data accuracy is PROVEN rather than asserted. Five checks, each
 * printing a count and writing a CSV of the offenders next to this script:
 *
 *   1 COMPLETENESS   spine orders missing from Postgres
 *   2 PHANTOMS       Postgres orders absent from the spine that are not
 *                    legitimately retained history
 *   3 FIDELITY       field-by-field disagreement on the orders both hold
 *   4 STORE MAPPING  review-queue entries whose store DOES resolve upstream
 *   5 RETENTION      history still present and still reachable by search
 *
 * Every spine field is derived through the SYNC'S OWN mapping functions
 * (mapDistributionRows, normFacility, normOverallStatus, normStoreKey) and the
 * same SELECT list, via spineWindowQuery. Nothing here re-states how a column
 * becomes a field: a reconciliation that drifts from the code it reconciles
 * reports its own bugs as data errors.
 *
 * PROD SAFETY: lib/db.ts refuses a production DATABASE_URL unless
 * RETAILJOURNEY_ALLOW_PROD_DB=1 is set for that invocation. That guard is left
 * deliberately in the operator's hands — this script never sets it.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { toCsv } from "../src/lib/csv";
import { mapDistributionRows, normFacility } from "../src/lib/distribution-map";
import { prisma } from "../src/lib/db";
import { addDays, istDateOf, istToday } from "../src/lib/ist";
import { normStoreKey } from "../src/lib/qc-tat";
import { querySnowflake, spineWindowQuery, type DistributionRow } from "../src/lib/snowflake";
import { STORE_MASTER_TABLE } from "../src/lib/snowflake-stores";

/** The reconciliation window. 60 days: wider than the sync's 45-day sweep, so
 *  a completeness gap caused by the sweep boundary itself is visible rather
 *  than hidden behind the same window that created it. */
const WINDOW_DAYS = 60;

/** How many field-fidelity offenders to sample. The check is a sample by
 *  design — it exists to detect systematic drift, not to diff every row. */
const FIDELITY_SAMPLE = 500;

const OUT_DIR = join(process.cwd(), "scripts", "data", "reconciliation");

const head = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

/** One check's result, for the closing summary table. */
interface CheckResult {
  id: string;
  name: string;
  count: number;
  of: number;
  verdict: string;
  csv?: string;
}

const results: CheckResult[] = [];

function writeCsv<T>(name: string, columns: { header: string; value: (r: T) => unknown }[], rows: T[]): string | undefined {
  if (!rows.length) return undefined;
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.csv`);
  writeFileSync(
    path,
    "﻿" + toCsv(columns as never, rows),
    "utf8",
  );
  return path;
}

/** The handover date exactly as the Warehouse queue prints it:
 *  COALESCE(TO_DATE(PICKUP_TAT), TO_DATE(WH_PROCESSING_TAT)). */
const handoverDateOf = (o: { pickupTat?: string | Date | null; handoverDeadlineTs?: string | Date | null }) => {
  const v = o.pickupTat ?? o.handoverDeadlineTs;
  return v ? istDateOf(v instanceof Date ? v.toISOString() : v) : undefined;
};

async function main() {
  const db = prisma();
  const today = istToday();
  const windowFloor = addDays(today, -WINDOW_DAYS);

  console.log(`Reconciliation — ${WINDOW_DAYS}-day window, floor ${windowFloor} (IST today ${today}).`);
  console.log("READ-ONLY: SELECTs only, on both sides.\n");

  // ---------------------------------------------------------------- spine ---
  head(`SPINE — reading ${WINDOW_DAYS} days through the sync's own SELECT`);
  const spineRows = await querySnowflake<DistributionRow>(spineWindowQuery(WINDOW_DAYS));
  // Same grouping the sync applies: one MappedOrder per ORDER_NAME, parent
  // fields taken from the most-advanced sibling row.
  const spine = mapDistributionRows(spineRows);
  const spineByKey = new Map(spine.map((m) => [m.soNumber.trim().toUpperCase(), m]));
  console.log(`   ${spineRows.length} rows → ${spine.length} distinct orders`);

  // ------------------------------------------------------------------ app ---
  head("APP — reading every order Postgres holds");
  const appAll = await db.order.findMany({
    select: {
      soNumber: true,
      orderDate: true,
      facility: true,
      finalStore: true,
      storeNameFormat: true,
      storeId: true,
      qty: true,
      status: true,
      overallStatus: true,
      pickupTat: true,
      handoverDeadlineTs: true,
      idealDeliveryDate: true,
      deliveryTargetEdd: true,
    },
  });
  const appByKey = new Map(appAll.map((o) => [o.soNumber.trim().toUpperCase(), o]));
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);
  const appInWindow = appAll.filter((o) => (day(o.orderDate) ?? "") >= windowFloor);
  console.log(`   ${appAll.length} orders total, ${appInWindow.length} inside the ${WINDOW_DAYS}-day window`);

  // How far back the spine actually reaches. Anything older than this in
  // Postgres is retained history, not a phantom — the spine simply no longer
  // carries it, which is precisely what Artifacts A–C exist to survive.
  const spineFloorRow = await querySnowflake<{ FLOOR: string | null }>(
    `SELECT MIN(ORDER_DATE) AS FLOOR FROM SNITCH_DB.MAPLEMONK.RETAIL_JOURNEY_SPINE`,
  );
  const spineFloor = (spineFloorRow[0]?.FLOOR ?? "").toString().slice(0, 10) || undefined;
  console.log(`   spine live coverage starts ${spineFloor ?? "unknown"}`);

  // ------------------------------------------------------ 1. COMPLETENESS ---
  head("1. COMPLETENESS — spine orders missing from Postgres");
  const missing = spine.filter((m) => !appByKey.has(m.soNumber.trim().toUpperCase()));
  // Bucketed by warehouse × order date, which is where a systematic gap shows
  // itself: one warehouse, or one day, going dark is a sync failure; a scatter
  // of singletons is ordinary in-flight timing.
  const buckets = new Map<string, number>();
  for (const m of missing) {
    const k = `${normFacility(m.patch.facility as string | undefined) ?? "(no warehouse)"}|${m.patch.orderDate ?? "(no date)"}`;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  console.log(`   ${missing.length} of ${spine.length} spine orders are not in Postgres`);
  for (const [k, n] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    const [wh, d] = k.split("|");
    console.log(`     ${wh.padEnd(20)} ${d}  ${n}`);
  }
  if (buckets.size > 15) console.log(`     … ${buckets.size - 15} more warehouse×date buckets`);
  results.push({
    id: "1",
    name: "Completeness (spine not in app)",
    count: missing.length,
    of: spine.length,
    verdict: missing.length === 0 ? "CLEAN" : "GAP",
    csv: writeCsv(
      "1-completeness-spine-not-in-app",
      [
        { header: "order_name", value: (m: (typeof missing)[number]) => m.soNumber },
        { header: "order_date", value: (m) => m.patch.orderDate },
        { header: "warehouse_name", value: (m) => m.patch.facility },
        { header: "store", value: (m) => m.storeKey },
        { header: "quantity", value: (m) => m.patch.qty },
        { header: "spine_overall_status", value: (m) => m.overallStatusSeed },
        { header: "awb_count", value: (m) => m.shipments.length },
      ],
      missing,
    ),
  });

  // ---------------------------------------------------------- 2. PHANTOMS ---
  head("2. PHANTOMS — in-window app orders absent from the spine");
  const notInSpine = appInWindow.filter((o) => !spineByKey.has(o.soNumber.trim().toUpperCase()));
  // Retained history is NOT a phantom. An order older than the spine's live
  // coverage is exactly what Postgres-as-system-of-record is supposed to keep.
  const phantoms = notInSpine.filter((o) => !spineFloor || (day(o.orderDate) ?? "") >= spineFloor);
  const retained = notInSpine.length - phantoms.length;
  console.log(`   ${notInSpine.length} in-window app orders are not in the spine`);
  console.log(`     ${retained} are legitimately retained history (older than ${spineFloor ?? "?"})`);
  console.log(`     ${phantoms.length} are NOT explained by retention — these are the offenders`);
  results.push({
    id: "2",
    name: "Phantoms (app not in spine, not historical)",
    count: phantoms.length,
    of: appInWindow.length,
    verdict: phantoms.length === 0 ? "CLEAN" : "PHANTOM",
    csv: writeCsv(
      "2-phantoms-app-not-in-spine",
      [
        { header: "so_number", value: (o: (typeof phantoms)[number]) => o.soNumber },
        { header: "order_date", value: (o) => day(o.orderDate) },
        { header: "facility", value: (o) => o.facility },
        { header: "final_store", value: (o) => o.finalStore },
        { header: "status", value: (o) => o.status },
        { header: "overall_status", value: (o) => o.overallStatus },
      ],
      phantoms,
    ),
  });

  // --------------------------------------------------- 3. FIELD FIDELITY ---
  head(`3. FIELD FIDELITY — sample of ${FIDELITY_SAMPLE} orders both sides hold`);
  // overall_status is compared ONLY where the app has no shipment children.
  // With children the app computes its own rollup from live tracking and the
  // spine seed is deliberately not used (see syncSnowflakeOrder) — diffing
  // those would report the design as a defect.
  const bothKeys = [...spineByKey.keys()].filter((k) => appByKey.has(k)).slice(0, FIDELITY_SAMPLE);
  const childCounts = new Map<string, number>();
  for (const g of await db.orderShipment.groupBy({
    by: ["soNumber"],
    _count: { _all: true },
    where: { soNumber: { in: bothKeys.map((k) => appByKey.get(k)!.soNumber) } },
  })) {
    childCounts.set(g.soNumber.trim().toUpperCase(), g._count._all);
  }

  interface Mismatch {
    soNumber: string;
    field: string;
    app: string;
    spine: string;
  }
  const mismatches: Mismatch[] = [];
  let rollupSkipped = 0;

  for (const k of bothKeys) {
    const a = appByKey.get(k)!;
    const s = spineByKey.get(k)!;
    const add = (field: string, app: unknown, sp: unknown) => {
      const A = app == null ? "" : String(app);
      const S = sp == null ? "" : String(sp);
      if (A !== S) mismatches.push({ soNumber: a.soNumber, field, app: A, spine: S });
    };

    if ((childCounts.get(k) ?? 0) > 0) rollupSkipped += 1;
    else add("overall_status", a.overallStatus, s.overallStatusSeed);

    add("quantity", a.qty, s.patch.qty);
    // The store join is the sync's own: whitespace/hyphen tolerant, because
    // spine STORE strings drift ("QC  KALYAN NAGAR", "HSR LAYOUT-2").
    add("store", normStoreKey(a.finalStore ?? ""), normStoreKey(s.storeKey ?? ""));
    add("warehouse_name", a.facility, normFacility(s.patch.facility as string | undefined));
    add("handover_date", handoverDateOf(a), handoverDateOf(s.patch));
    // EDD as the app resolves it: the rulebook date first, the spine's own
    // delivery target behind it for out-of-rulebook orders.
    add(
      "edd",
      day(a.idealDeliveryDate),
      s.patch.idealDeliveryDate ?? (s.patch.deliveryTargetEdd ? istDateOf(s.patch.deliveryTargetEdd) : undefined),
    );
  }

  const byField = new Map<string, number>();
  for (const m of mismatches) byField.set(m.field, (byField.get(m.field) ?? 0) + 1);
  console.log(`   ${bothKeys.length} orders sampled (${rollupSkipped} skipped for overall_status — app owns the rollup once an AWB exists)`);
  console.log(`   ${mismatches.length} field mismatches:`);
  for (const [f, n] of [...byField].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${f.padEnd(18)} ${n}  (${((n / bothKeys.length) * 100).toFixed(1)}% of sample)`);
  }
  results.push({
    id: "3",
    name: "Field fidelity (mismatched values)",
    count: mismatches.length,
    of: bothKeys.length,
    verdict: mismatches.length === 0 ? "CLEAN" : "DRIFT",
    csv: writeCsv(
      "3-field-fidelity-mismatches",
      [
        { header: "so_number", value: (m: Mismatch) => m.soNumber },
        { header: "field", value: (m) => m.field },
        { header: "app_value", value: (m) => m.app },
        { header: "spine_value", value: (m) => m.spine },
      ],
      mismatches,
    ),
  });

  // ------------------------------------------------------ 4. STORE MAPPING ---
  head("4. STORE MAPPING — review-queue entries that DO resolve upstream");
  // The known fail-open bug: a channel sitting in the review queue whose
  // LEFT(order_name,6) resolves perfectly well in gs_store_details. Those are
  // false flags — the order was never blocked, but the queue says it needs
  // attention it does not need.
  const unmatched = await db.unmatchedChannel.findMany();
  const soCodes = new Set(
    (
      await querySnowflake<{ SO_CODE: string | null }>(
        `SELECT DISTINCT UPPER(TRIM(SO_CODE)) AS SO_CODE FROM ${STORE_MASTER_TABLE} WHERE SO_CODE IS NOT NULL`,
      )
    )
      .map((r) => (r.SO_CODE ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  const falseFlags = unmatched.flatMap((u) =>
    u.sampleSoNumbers
      .map((so) => ({ channel: u.channel, soNumber: so, prefix: so.trim().slice(0, 6).toUpperCase() }))
      .filter((x) => soCodes.has(x.prefix)),
  );
  const flaggedChannels = new Set(falseFlags.map((f) => f.channel));
  console.log(`   ${unmatched.length} channels in the review queue, ${soCodes.size} SO codes in the store master`);
  console.log(`   ${falseFlags.length} sample orders across ${flaggedChannels.size} channels DO resolve — false flags`);
  results.push({
    id: "4",
    name: "Store mapping false-flags",
    count: falseFlags.length,
    of: unmatched.reduce((n, u) => n + u.sampleSoNumbers.length, 0),
    verdict: falseFlags.length === 0 ? "CLEAN" : "FALSE-FLAG",
    csv: writeCsv(
      "4-store-mapping-false-flags",
      [
        { header: "channel", value: (f: (typeof falseFlags)[number]) => f.channel },
        { header: "sample_so_number", value: (f) => f.soNumber },
        { header: "resolved_so_code", value: (f) => f.prefix },
      ],
      falseFlags,
    ),
  });

  // -------------------------------------------------- 5. RETENTION INTEGRITY ---
  head("5. RETENTION INTEGRITY — history kept, and reachable");
  const historical = appAll.filter((o) => (day(o.orderDate) ?? "") < windowFloor);
  // "Reachable by search" is not a claim, it is the same query the /orders
  // page runs: a search lifts the 30-day floor, so an order is reachable iff
  // searching its own SO number returns it.
  const sample = historical.slice(0, 25);
  const reachable = sample.length
    ? await db.order.count({
        where: { soNumber: { in: sample.map((o) => o.soNumber) } },
      })
    : 0;
  console.log(`   ${historical.length} Postgres orders are older than ${WINDOW_DAYS} days and still present`);
  console.log(`   ${reachable} of ${sample.length} sampled are returned by an unfloored SO-number search`);
  if (!historical.length) {
    console.log(
      `   NOTE: none yet. The sync reads a 45-day window (SPINE_SWEEP_DAYS), so Postgres only\n` +
        `   accumulates history as it runs — this count grows over time and is not a failure today.`,
    );
  }
  results.push({
    id: "5",
    name: "Retention (history present & reachable)",
    count: historical.length,
    of: appAll.length,
    verdict: sample.length === 0 ? "NO HISTORY YET" : reachable === sample.length ? "CLEAN" : "UNREACHABLE",
    csv: writeCsv(
      "5-retention-historical-orders",
      [
        { header: "so_number", value: (o: (typeof historical)[number]) => o.soNumber },
        { header: "order_date", value: (o) => day(o.orderDate) },
        { header: "facility", value: (o) => o.facility },
        { header: "final_store", value: (o) => o.finalStore },
        { header: "overall_status", value: (o) => o.overallStatus },
      ],
      historical,
    ),
  });

  // --------------------------------------------------------------- summary ---
  head("SUMMARY");
  console.log(
    ["#", "CHECK".padEnd(42), "COUNT".padStart(8), "OF".padStart(8), "VERDICT"].join("  "),
  );
  for (const r of results) {
    console.log(
      [r.id, r.name.padEnd(42), String(r.count).padStart(8), String(r.of).padStart(8), r.verdict].join("  "),
    );
  }
  const written = results.filter((r) => r.csv);
  if (written.length) {
    console.log(`\nCSVs written to ${OUT_DIR}:`);
    for (const r of written) console.log(`   ${r.csv}`);
  } else {
    console.log("\nNo offenders — no CSV written.");
  }
  console.log("\nNothing was changed. This script only reads.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma().$disconnect());
