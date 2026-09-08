/**
 * ARTIFACT E STEP-1 — one real UC export job, to learn its ACTUAL columns.
 *
 *   npx tsx scripts/uc-export-probe.ts [hours]
 *
 * Creates ONE export over a small updatedAt window (default: the last 2 hours),
 * polls it to completion, downloads the CSV and prints the real header list
 * with a sample value for each. Touches no database and writes nothing to UC
 * beyond the export job itself.
 *
 * This exists because the CSVs on hand are a TRANSFORMED model, not the raw
 * export. The mapping below must be read off a genuine payload and signed off
 * before any intake is built — assuming it from a prior file is how a column
 * silently becomes the wrong field.
 *
 * The downloaded CSV is saved next to this script so the mapping can be
 * re-derived without firing a second job.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseCsv } from "../src/lib/csv";
import { ucConfigured, ucDownload, ucPost } from "../src/lib/integrations/uc-client";
import { FACILITIES } from "../src/lib/types";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 36; // ~3 minutes, the cadence the old client proved
const OUT_DIR = join(process.cwd(), "scripts", "data", "uc-export");

/** The channels store orders arrive on. */
const STORE_CHANNELS = ["FRANCHISE_STORE_B2B", "OWN_STORE", "FRANCHISE_STORE", "OWN_STORE_B2B"];

/**
 * The columns requested, as UC's own internal keys.
 *
 * `exportColums: []` is rejected outright ("exportColums can not be empty" /
 * INVALID_EXPORT_JOB_COLUMN), so the set has to be named up front. These keys
 * come from the browser's own create call — the full vocabulary is much
 * larger, and everything financial, tax-bearing or personal is deliberately
 * absent rather than fetched and discarded. Store orders do not need a
 * customer address, so the safest place to drop that data is before it is
 * ever requested.
 *
 * NOT requested, on purpose: every address/phone/email field, MRP and all
 * prices, subtotal/discount/charges, the whole GST/CGST/SGST/IGST/UTGST/CESS/
 * TCS family, GSTIN/TIN, IMEI, IRN, e-way bill, payment instructions and
 * store credit.
 */
const COLUMNS = [
  // Identity + grain
  "soicode", // Sale Order Item Code — the dedupe/upsert key
  "displayorderCode", // Display Order Code — the app's soNumber
  "saleOrderCode",
  "ShippingPackageCode",
  // Placement + routing
  "channel",
  "facility",
  "saleOrderCustomFields_Order_Type", // Order_Type — RPL for store orders
  // The spine claims UC's own STORE__CODE is "NA"/garbage and that the store
  // must come from LEFT(order_name,6) instead. Requested ONCE so the probe can
  // confirm that on live data rather than inheriting the claim; it is not part
  // of the intake set either way.
  "saleOrderCustomFields_STORE__CODE",
  // Lifecycle
  "status", // Sale Order Status
  "SoiStatus", // Sale Order Item Status
  "shippingPackageStatusCode",
  "onhold",
  "cancellationReason",
  // Timing
  "created", // UC_CREATED
  "displayOrderDateTime", // order timestamp
  "updated", // the incremental watermark itself
  "packingtimeinvoiceuser", // candidate for packed_timestamp — label unverified
  "fulfillmentTat",
  "dispatchDate",
  // NOT requested: `deliveryTime` came back 0/28632 filled over a full day at
  // WH2, and `itemCode` ("Item Details") likewise. UC also returns "Channel
  // Shipping" unrequested, so the returned column list is not exactly the
  // requested one — the intake must map by HEADER, never by position.
  // Line content + the RTS-Logic weight capture
  "skuCode",
  "skuName",
  "itemTypeName",
  "itemTypeColor",
  "itemTypeSize",
  "actualWeight",
  // Transit identity (no cost, no PII)
  "TrackingNumber",
  "shippingCourier",
  "shippingProvider",
  "invoiceCode", // a document number, not an amount
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ExportCreateResponse {
  successful?: boolean;
  jobCode?: string;
  errors?: unknown[];
}

interface ExportStatusResponse {
  successful?: boolean;
  status?: string; // QUEUED | PROCESSING | COMPLETE | FAILED
  filePath?: string;
  errors?: unknown[];
}

async function main() {
  if (!ucConfigured()) {
    throw new Error("UC_BASE_URL / UC_USERNAME / UC_PASSWORD are not set — nothing to probe.");
  }

  const hours = Math.max(1, Number(process.argv[2] ?? 2));
  const end = Date.now();
  const start = end - hours * 60 * 60 * 1000;
  const jobType = process.env.UC_EXPORT_JOB_TYPE ?? "4mclothingllp Sale Orders";

  console.log(`UC export probe — job type "${jobType}"`);
  console.log(`Window: updatedAt ${new Date(start).toISOString()} → ${new Date(end).toISOString()} (${hours}h)`);
  console.log(`Store channels the intake will filter to: ${STORE_CHANNELS.join(", ")}\n`);

  // export/job/create is a FACILITY-LEVEL API: without the header it answers
  // 403 "Illegal Access, facility is required" (observed live). One export is
  // therefore per-facility, and the real intake must fan out across all three
  // and union the results — a single call can never see the whole estate.
  const facility = process.argv[3] ?? FACILITIES[0];
  console.log(`Facility header: ${facility}`);

  const create = await ucPost<ExportCreateResponse>("/services/rest/v1/export/job/create", {
    facility,
    body: {
      exportJobTypeName: jobType,
      exportColums: COLUMNS,
      exportFilters: [
        // `updatedOn`, as the browser's own call names it — NOT the `updatedAt`
        // the pre-removal client sent. This is the field the intake watermark
        // will advance on.
        { id: "updatedOn", dateRange: { start, end } },
        { id: "channelFilter", selectedValues: STORE_CHANNELS },
      ],
      frequency: "ONETIME",
    },
  });
  if (!create.jobCode) {
    throw new Error(`export create returned no jobCode: ${JSON.stringify(create.errors ?? create).slice(0, 400)}`);
  }
  console.log(`Job created: ${create.jobCode}`);

  let filePath: string | undefined;
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    const status = await ucPost<ExportStatusResponse>("/services/rest/v1/export/job/status", {
      facility,
      body: { jobCode: create.jobCode },
    });
    console.log(`  poll ${attempt}: ${status.status ?? "(no status)"}`);
    if (status.status === "COMPLETE" && status.filePath) {
      filePath = status.filePath;
      break;
    }
    if (status.status === "FAILED") {
      throw new Error(`export job ${create.jobCode} FAILED: ${JSON.stringify(status.errors ?? {}).slice(0, 400)}`);
    }
  }
  if (!filePath) throw new Error(`export job ${create.jobCode} did not complete within ~3 minutes`);

  console.log(`\nDownloading ${filePath}`);
  const csv = await ucDownload(filePath);
  mkdirSync(OUT_DIR, { recursive: true });
  const saved = join(OUT_DIR, `${create.jobCode}.csv`);
  writeFileSync(saved, csv, "utf8");
  console.log(`Saved ${csv.length} bytes to ${saved}`);

  const rows = parseCsv(csv);
  if (rows.length < 1) {
    console.log("\nEmpty export — widen the window and re-run, e.g. `npx tsx scripts/uc-export-probe.ts 24`.");
    return;
  }
  const headers = rows[0];
  const body = rows.slice(1);

  console.log(`\n${"=".repeat(78)}\nACTUAL EXPORT COLUMNS — ${headers.length} columns, ${body.length} data rows\n${"=".repeat(78)}`);
  headers.forEach((h, i) => {
    // First non-empty value in the column, so an all-null column is visibly so
    // rather than looking like a column that simply had no sample.
    const sample = body.find((r) => (r[i] ?? "").trim() !== "")?.[i] ?? "";
    const filled = body.filter((r) => (r[i] ?? "").trim() !== "").length;
    console.log(
      `${String(i).padStart(3)}  ${h.padEnd(42).slice(0, 42)}  ${String(filled).padStart(5)}/${body.length}  ${sample.slice(0, 40)}`,
    );
  });

  console.log(`\n${"=".repeat(78)}\nNEXT: map these labels to internal fields and sign off BEFORE any ingest.\n${"=".repeat(78)}`);
  console.log("Fields the intake needs a home for:");
  console.log("  Sale Order Item Code   → dedupe/upsert key (grain: one row per item)");
  console.log("  Display Order Code     → soNumber; order qty = COUNT of item rows");
  console.log("  Order_Type             → type (store orders are RPL; NSO excluded at intake)");
  console.log("  Channel                → filtered to the four store channels above");
  console.log("  Facility               → facility, independent of store match (fail-open)");
  console.log("  LEFT(order_name,6)     → gs_store_details prefix (NOT UC STORE-CODE, which is 'NA')");
  console.log("\nDropped on sight — never ingested:");
  console.log("  MRP, prices, GST/CGST/SGST/IGST/CESS/TCS, addresses, phones, GSTIN, IMEI, IRN, payment");
}

main().catch((e) => {
  console.error(`\nPROBE FAILED: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
