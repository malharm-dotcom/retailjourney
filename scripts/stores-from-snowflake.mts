// Store-master loader — sources the live store list from Snowflake
// distribution_analytics (the authoritative STORE strings on real orders) and
// reconciles it against the Store table. Report-only by default; pass --load
// to upsert the missing stores. Idempotent and re-runnable: matches on the
// normalized finalStore key, never duplicates, never overwrites an existing
// store's fields (admin edits survive).
//
// Usage:
//   npx tsx scripts/stores-from-snowflake.mts          # report only, no writes
//   npx tsx scripts/stores-from-snowflake.mts --load   # upsert missing stores
//
// Credentials come from the environment (.env.local via @next/env) — never
// hardcode or persist connection strings.

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const LOAD = process.argv.includes("--load");

interface StoreAgg {
  STORE: string | null;
  ORDERS: number;
  WAREHOUSE_NAME: string | null;
  ZONE: string | null;
  AREA_MANAGER: string | null;
  MERCHANDISER: string | null;
  CITY: string | null;
  STATE: string | null;
  SALES_30D: number | null;
  RANK: number | null;
}

const AGG_QUERY = `
SELECT
  STORE,
  COUNT(DISTINCT ORDER_NAME) AS ORDERS,
  MODE(WAREHOUSE_NAME) AS WAREHOUSE_NAME,
  MODE(ZONE)           AS ZONE,
  MODE(AREA_MANAGER)   AS AREA_MANAGER,
  MODE(MERCHANDISER)   AS MERCHANDISER,
  MODE(RECEIVER_CITY)  AS CITY,
  MODE(RECEIVER_STATE) AS STATE,
  MAX(SALES_30D)       AS SALES_30D,
  MAX(RANK)            AS RANK
FROM distribution_analytics
WHERE ORDER_DATE >= DATEADD(day, -20, CURRENT_DATE)
GROUP BY STORE
ORDER BY STORE`;

const NO_STORE_QUERY = `
SELECT ORDER_NAME, ORDER_DATE, WAREHOUSE_NAME, QUANTITY, ORDER_TYPE, FINAL_STATUS, STORE
FROM distribution_analytics
WHERE STORE IS NULL OR TRIM(STORE) = ''
  AND ORDER_DATE >= DATEADD(day, -20, CURRENT_DATE)
LIMIT 20`;

const norm = (s: string) => s.trim().toUpperCase();

/** "SNITCH - COFO - BANER" → { ownership: "COFO", storeName: "COFO - BANER" } */
function parseStoreKey(key: string): { ownership?: string; storeName: string } {
  const m = key.match(/^SNITCH\s*-\s*(COCO|COFO|FOCO)\s*-\s*(.+)$/i);
  if (!m) return { storeName: key.replace(/^SNITCH\s*-\s*/i, "").trim() };
  return { ownership: m[1].toUpperCase(), storeName: `${m[1].toUpperCase()} - ${m[2].trim()}` };
}

async function main() {
  const { querySnowflake } = await import("../src/lib/snowflake");
  const { normFacility } = await import("../src/lib/distribution-map");
  const { prisma, databaseConfigured } = await import("../src/lib/db");

  const [aggs, noStoreRows] = [
    await querySnowflake<StoreAgg>(AGG_QUERY),
    await querySnowflake<Record<string, unknown>>(NO_STORE_QUERY),
  ];

  const live = aggs.filter((a) => a.STORE && a.STORE.trim() !== "");
  const blankAgg = aggs.find((a) => !a.STORE || a.STORE.trim() === "");

  console.log(`\n=== Snowflake distribution_analytics, 20-day window ===`);
  console.log(`distinct non-blank STORE values: ${live.length}`);
  console.log(`blank/NULL STORE bucket: ${blankAgg ? `${blankAgg.ORDERS} distinct order(s)` : "none"}`);
  if (noStoreRows.length) {
    console.log(`sample blank-STORE rows:`);
    for (const r of noStoreRows) console.log(`  ${JSON.stringify(r)}`);
  }

  if (!databaseConfigured()) {
    console.log("\nDATABASE_URL not set — cannot reconcile against Store table. Stopping.");
    return;
  }
  const db = prisma();
  const existing = await db.store.findMany();
  const byKey = new Map(existing.map((s) => [norm(s.finalStore), s]));

  const missing = live.filter((a) => !byKey.has(norm(a.STORE!)));
  const matched = live.length - missing.length;

  console.log(`\nStore master rows: ${existing.length}`);
  console.log(`live stores already in master: ${matched}`);
  console.log(`live stores MISSING from master: ${missing.length}`);

  // Field derivation per missing store — flag anything non-derivable.
  const rows = missing.map((a) => {
    const key = a.STORE!.trim();
    const { ownership, storeName } = parseStoreKey(key);
    const facility = normFacility(a.WAREHOUSE_NAME);
    const knownFacility =
      facility === "SAPL-NORTH-TAURU" || facility === "SAPL-WH1" || facility === "SAPL-WH2";
    return {
      key,
      storeName,
      ownership,
      facility,
      knownFacility,
      zone: a.ZONE?.trim() || undefined,
      areaManager: a.AREA_MANAGER?.trim() || undefined,
      merchandiser: a.MERCHANDISER?.trim() || undefined,
      city: a.CITY?.trim() || undefined,
      state: a.STATE?.trim() || undefined,
      sales30d: a.SALES_30D ?? undefined,
      rank: a.RANK ?? undefined,
      orders: a.ORDERS,
    };
  });

  const badOwnership = rows.filter((r) => !r.ownership);
  const badFacility = rows.filter((r) => !r.knownFacility);
  console.log(`\nderivation gaps: ownership unparseable: ${badOwnership.length}, facility unknown/unmappable: ${badFacility.length}`);
  for (const r of badOwnership) console.log(`  ownership? ${r.key}`);
  for (const r of badFacility) console.log(`  facility?  ${r.key} (WAREHOUSE_NAME mode → ${r.facility ?? "null"})`);

  console.log(`\nmissing stores (key | facility | zone | AM | orders):`);
  for (const r of rows) {
    console.log(
      `  ${r.key} | ${r.facility ?? "?"} | ${r.zone ?? "?"} | ${r.areaManager ?? "?"} | ${r.orders}`,
    );
  }

  if (!LOAD) {
    console.log(`\n(report only — rerun with --load to upsert the ${rows.length} missing stores)`);
    return;
  }

  const loadable = rows.filter((r) => r.ownership && r.knownFacility);
  const skipped = rows.length - loadable.length;
  let created = 0;

  // branchCode is display-only (rulebook table); real codes are not in
  // distribution_analytics, so use a stable synthetic derived from the name.
  const branchCodeFor = (storeName: string) =>
    `SF-${storeName.replace(/^(COCO|COFO|FOCO)\s*-\s*/, "").replace(/[^A-Z0-9]+/gi, "").slice(0, 12).toUpperCase()}`;

  for (const r of loadable) {
    const data = {
      branchCode: branchCodeFor(r.storeName),
      storeName: r.storeName,
      finalStore: r.key,
      ownership: r.ownership!,
      channel: r.ownership === "COCO" ? "OWN_STORE" : "FRANCHISE_STORE",
      storeCity: r.city ?? null,
      storeState: r.state ?? null,
      zone: r.zone ?? null,
      facility: r.facility!,
      areaManager: r.areaManager ?? null,
      merchandiser: r.merchandiser ?? null,
      rank: r.rank ?? null,
      sales30d: r.sales30d ?? null,
    };
    // Upsert on the normalized key — re-checked against the DB inside the loop
    // so a rerun never duplicates even if finalStore casing differs.
    const dup = await db.store.findFirst({ where: { finalStore: { equals: r.key, mode: "insensitive" } } });
    if (dup) continue;
    await db.store.create({ data });
    created += 1;
  }
  console.log(`\n--load complete: created ${created}, skipped (derivation gap) ${skipped}, already present ${rows.length - created - skipped}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
