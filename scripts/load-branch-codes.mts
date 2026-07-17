// Branch-code loader — reconciles scripts/data/store-branch-codes.csv
// (STORE_NAME_FORMAT, STATE, BRANCH_CODE — the physical-location codes) against
// the Store master. Report-only by default; pass --load to write.
//
// Ground rules (decided, not re-litigated):
// - Snowflake STORE is the runtime join key and never changes; the FILE is
//   normalized to match the master (normStoreKey), never the reverse.
// - branchCode: the file is the authority — real codes replace the synthetic
//   SN1xx / SF-<NAME> placeholders. Stores with no file row keep their
//   synthetic code (reported).
// - STATE: the Snowflake-derived master value WINS on conflict (the file has
//   known city-as-state rows, e.g. MFC HYDERABAD); conflicts are reported only.
// - QC / MFC / SUVIDHA rows with no master match are NEW destinations (B2B
//   orders are sent there and must be tracked) — created here so their first
//   Snowflake order matches instead of parking in the review queue. QC stores
//   share the parent's branchCode and inherit its location fields.
// - B2BCORPORATE / SAPL-NORTH-TAURU (branch code 0) are warehouse/corporate
//   nodes, not stores — never created.
//
// Guardrails: aborts before any write if the normalization maps two different
// file rows onto one store, or leaves more than 5 non-new-destination file
// rows unmatched.
//
// Usage:
//   npx tsx scripts/load-branch-codes.mts          # report only
//   npx tsx scripts/load-branch-codes.mts --load   # apply
//
// Credentials come from the environment (.env.local via @next/env).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const LOAD = process.argv.includes("--load");
const CSV_PATH = join(process.cwd(), "scripts", "data", "store-branch-codes.csv");

interface FileRow {
  name: string;
  state?: string;
  code?: string;
  line: number;
}

function parseCsv(): FileRow[] {
  const raw = readFileSync(CSV_PATH, "utf8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip BOM
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(1).map((l, i) => {
    const [name, state, code] = l.split(",").map((c) => c.trim());
    return { name, state: state || undefined, code: code || undefined, line: i + 2 };
  });
}

async function main() {
  const { normStoreKey, parseStoreKey, isQcStoreKey, isExcludedStoreKey } = await import("../src/lib/qc-tat");
  const { prisma, databaseConfigured } = await import("../src/lib/db");
  if (!databaseConfigured()) throw new Error("DATABASE_URL not set");
  const db = prisma();

  const raw = parseCsv();
  console.log(`file rows: ${raw.length}`);

  // --- clean the file ------------------------------------------------------
  const blank = raw.filter((r) => !r.code);
  for (const r of blank) console.log(`  discard (blank branch code, junk row): line ${r.line} [${r.name}]`);
  const excluded = raw.filter((r) => r.code && (isExcludedStoreKey(r.name) || r.code === "0"));
  for (const r of excluded) console.log(`  discard (warehouse/corporate node): line ${r.line} [${r.name}]`);

  const byKey = new Map<string, FileRow>();
  const ambiguous: string[] = [];
  for (const r of raw) {
    if (!r.code || isExcludedStoreKey(r.name) || r.code === "0") continue;
    const k = normStoreKey(r.name);
    const prev = byKey.get(k);
    if (prev && prev.code !== r.code) ambiguous.push(`[${r.name}] code ${prev.code} vs ${r.code}`);
    else byKey.set(k, r);
  }
  if (ambiguous.length) {
    console.error(`\nABORT — same store, different codes in the file:\n  ${ambiguous.join("\n  ")}`);
    process.exit(1);
  }

  // --- master + collision guardrails --------------------------------------
  const stores = await db.store.findMany();
  const masterByKey = new Map<string, (typeof stores)[number]>();
  for (const s of stores) {
    const k = normStoreKey(s.finalStore);
    const prev = masterByKey.get(k);
    if (prev) {
      console.error(`\nABORT — normalization collides two master rows: [${prev.finalStore}] and [${s.finalStore}]`);
      process.exit(1);
    }
    masterByKey.set(k, s);
  }

  // --- two-way delta -------------------------------------------------------
  const matched: { row: FileRow; store: (typeof stores)[number] }[] = [];
  const newDestinations: FileRow[] = [];
  const unmatched: FileRow[] = [];
  for (const row of byKey.values()) {
    const store = masterByKey.get(normStoreKey(row.name));
    if (store) matched.push({ row, store });
    else {
      const { ownership } = parseStoreKey(row.name);
      if (isQcStoreKey(row.name) || ownership === "MFC" || ownership === "SUVIDHA") newDestinations.push(row);
      else unmatched.push(row);
    }
  }
  const fileKeys = new Set([...byKey.keys()]);
  const noFileRow = stores.filter((s) => !fileKeys.has(normStoreKey(s.finalStore)));

  console.log(`\nmatched file->master: ${matched.length}`);
  console.log(`new destinations to create (QC/MFC/SUVIDHA): ${newDestinations.length}`);
  for (const r of newDestinations) console.log(`  + [${r.name}] code ${r.code} state ${r.state ?? "?"}`);
  console.log(`file rows with NO master match (left alone): ${unmatched.length}`);
  for (const r of unmatched) console.log(`  ? [${r.name}] code ${r.code}`);
  console.log(`master stores with NO file row (keep synthetic code): ${noFileRow.length}`);
  for (const s of noFileRow) console.log(`  - [${s.finalStore}] keeps ${s.branchCode}`);

  if (unmatched.length > 5) {
    console.error(`\nABORT — ${unmatched.length} file rows unmatched after normalization (>5): ambiguity to review.`);
    process.exit(1);
  }

  // --- planned writes ------------------------------------------------------
  const codeChanges = matched.filter(({ row, store }) => store.branchCode !== row.code);
  const stateConflicts = matched.filter(
    ({ row, store }) =>
      row.state && store.storeState && row.state.toUpperCase() !== store.storeState.toUpperCase(),
  );
  const qcFlags = matched.filter(({ row, store }) => isQcStoreKey(row.name) && !store.isQuickCommerce);

  console.log(`\nbranch-code updates: ${codeChanges.length}`);
  for (const { row, store } of codeChanges) console.log(`  [${store.finalStore}] ${store.branchCode} -> ${row.code}`);
  console.log(`state conflicts (Snowflake-derived master value KEPT): ${stateConflicts.length}`);
  for (const { row, store } of stateConflicts)
    console.log(`  [${store.finalStore}] master "${store.storeState}" vs file "${row.state}"`);
  console.log(`existing stores gaining isQuickCommerce: ${qcFlags.length}`);

  if (!LOAD) {
    console.log(`\n(report only — rerun with --load to apply)`);
    return;
  }

  // Updates first so QC creations can resolve their parent's real code.
  for (const { row, store } of codeChanges) {
    await db.store.update({ where: { id: store.id }, data: { branchCode: row.code! } });
  }
  for (const { store } of qcFlags) {
    await db.store.update({ where: { id: store.id }, data: { isQuickCommerce: true } });
  }

  const updatedStores = await db.store.findMany();
  let created = 0;
  const skippedCreates: string[] = [];
  for (const row of newDestinations) {
    const { ownership, storeName } = parseStoreKey(row.name);
    const isQc = isQcStoreKey(row.name);
    const parent = updatedStores.find((s) => !s.isQuickCommerce && s.branchCode === row.code);
    // Location fields come from the parent (same premises); for parentless
    // MFC/SUVIDHA fall back to the modal facility of same-state (or same-city,
    // for the MFC city-as-state row) master stores.
    let facility = parent?.facility;
    if (!facility) {
      const pool = updatedStores.filter(
        (s) =>
          (row.state && s.storeState && s.storeState.toUpperCase() === row.state.toUpperCase()) ||
          (row.state && s.storeCity && s.storeCity.toUpperCase() === row.state.toUpperCase()),
      );
      const counts = new Map<string, number>();
      for (const s of pool) counts.set(s.facility, (counts.get(s.facility) ?? 0) + 1);
      facility = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    if (!facility || !ownership) {
      skippedCreates.push(`[${row.name}] ${!ownership ? "ownership unparseable" : "no facility derivable"}`);
      continue;
    }
    // File STATE is trusted only when it is not a known city-as-state value
    // (the parent/master, i.e. Snowflake-derived, wins whenever available).
    const cityAsState = Boolean(
      row.state && updatedStores.some((s) => s.storeCity && s.storeCity.toUpperCase() === row.state!.toUpperCase()),
    );
    await db.store.create({
      data: {
        branchCode: row.code!,
        storeName,
        finalStore: row.name,
        ownership,
        channel: ownership === "COCO" || ownership === "MFC" ? "OWN_STORE" : "FRANCHISE_STORE",
        isQuickCommerce: isQc,
        storeCity: parent?.storeCity ?? null,
        storeState: parent?.storeState ?? (cityAsState ? null : (row.state ?? null)),
        zone: parent?.zone ?? null,
        facility,
        areaManager: parent?.areaManager ?? null,
        merchandiser: parent?.merchandiser ?? null,
      },
    });
    created += 1;
    console.log(
      `  created [${row.name}] code ${row.code} facility ${facility}${parent ? ` (parent ${parent.finalStore})` : " (no parent — modal facility)"}`,
    );
  }

  console.log(
    `\n--load complete: branch codes updated ${codeChanges.length}, QC flags set ${qcFlags.length}, created ${created}, create-skipped ${skippedCreates.length}`,
  );
  for (const s of skippedCreates) console.log(`  SKIPPED ${s}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
