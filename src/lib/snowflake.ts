// Snowflake reader for RETAIL_JOURNEY_SPINE — the order-data source that
// replaced distribution_analytics as the app's base layer. Key-pair (JWT)
// auth; CONNECT → QUERY → DESTROY on every call (Snowflake idle-drops
// connections, so a held module-level connection fails silently on an hourly
// job). The source table is TIMESTAMP_NTZ built in IST, so the session
// timezone is forced to Asia/Kolkata and all DATE/TIMESTAMP columns are
// fetched as strings — distribution-map.ts converts them via ist.ts.
//
// WHY THE SWAP: distribution_analytics gated out any order the rulebook did
// not cover, so those orders were invisible. The spine keeps them, flagged
// with RULEBOOK_COVERED=false and carrying a fallback delivery target. This
// is still the BASE layer only — precedence (manual > eShipz poller >
// Snowflake) is unchanged and lives in integrations/sync.ts.

import crypto from "crypto";

/** Fully-qualified source. The reader is pinned to this table rather than the
 *  session's default schema so a mis-set SNOWFLAKE_SCHEMA cannot silently
 *  point the hourly sync at a different object. */
export const SPINE_TABLE = "SNITCH_DB.MAPLEMONK.RETAIL_JOURNEY_SPINE";

/** One row per (ORDER_NAME, SHIPMENT_BILL, TRACKING_NUMBER) — the order+AWB
 *  child grain. Timestamps arrive as IST wall-clock strings
 *  ("YYYY-MM-DD HH:mm:ss.SSS"), dates as "YYYY-MM-DD". */
export interface DistributionRow {
  ORDER_NAME: string;
  ORDER_TIMESTAMP: string | null;
  ORDER_DATE: string | null;
  ORDER_TYPE: string | null;
  WAREHOUSE_NAME: string | null;
  QUANTITY: number | null;
  STORE: string | null;
  INVOICE_NUMBER: string | null;
  MANIFESTED_TIMESTAMP: string | null;
  MERCHANDISER: string | null;
  AREA_MANAGER: string | null;
  SALES_30D: number | null;
  RANK: number | null;
  LANE_CLASSIFICATION: string | null;
  BEST_TAT: number | null;
  ZONE: string | null;
  RECEIVER_CITY: string | null;
  RECEIVER_STATE: string | null;
  /** NOT YET IN THE SPINE — optional until the column is added there (see
   *  SPINE_PENDING_COLUMNS). Reads as undefined meanwhile; the mapper is
   *  null-safe, so no downstream code changes when it appears. */
  RECEIVER_POSTAL_CODE?: string | null;
  TARGET_ORDER_DAY: string | null;
  TARGET_ORDER_CUTOFF: string | null;
  TARGET_HANDOVER_DAY: string | null;
  TARGET_HANDOVER_CUTOFF: string | null;
  TARGET_PICKUP_DAY: string | null;
  TARGET_DELIVERY_DAY: string | null;
  ORDER_CUTOFF_TS: string | null;
  HANDOVER_DEADLINE_TS: string | null;
  PICKUP_TAT: string | null;
  IDEAL_DELIVERY_DATE: string | null;
  DELIVERY_TAT: string | null;
  ORDER_PLACEMENT_SLA: string | null;
  HANDOVER_SLA: string | null;
  OVERALL_STATUS: string | null;
  FINAL_STATUS: string | null;
  TRACKING_NUMBER: string | null;
  COURIER_PARTNER: string | null;
  ESHIP_STATUS: string | null;
  STATUS: string | null;
  LOGISTICS_CREATED_TIMESTAMP: string | null;
  TRACKING_PICK_DATE: string | null;
  LOGISTICS_DELIVERY_TIMESTAMP: string | null;
  LOGISTICS_EXPECTED_DELIVERY_DATE: string | null;
  FIRST_OFD_DATE: string | null;
  LATEST_OFD_DATE: string | null;
  DELIVERY_ATTEMPTS: number | null;
  PICKUP_ATTEMPTS: number | null;
  TRACKING_LINK: string | null;
  TRACKING_STATUS: string | null;
  TRACKING_SUB_STATUS: string | null;
  TRACKING_LATEST_LOCATION: string | null;
  TRACKING_LATEST_MESSAGE: string | null;
  LAST_CHECKPOINT_CITY: string | null;
  LAST_CHECKPOINT_STATE: string | null;
  /** NOT YET IN THE SPINE — see SPINE_PENDING_COLUMNS. */
  LAST_CHECKPOINT_REMARK?: string | null;
  LAST_CHECKPOINT_SUBTAG?: string | null;
  LAST_CHECKPOINT_TAG?: string | null;
  POD_LINK: string | null;
  PACKAGE_COUNT: number | null;
  PICKUP_SLA: string | null;
  DELIVERY_SLA: string | null;
  LOGISTICS_DELIVERY_SLA: string | null;
  PERFECT_ORDER_SLA: string | null;

  // --- Spine additions (not present in distribution_analytics) ---
  /** Second half of the grain key: one order can carry several bills. */
  SHIPMENT_BILL: string | null;
  /** "OWN" | "FRANCHISE". */
  STORE_CHANNEL: string | null;
  /** TRUE only when a REAL rulebook target exists — not merely "row present". */
  RULEBOOK_COVERED: boolean | null;
  /** Delivery target; carries the eShipz EDD when the order is out-of-rulebook.
   *  Sparse (~58% of covered rows), so it is a FALLBACK behind
   *  IDEAL_DELIVERY_DATE, never a replacement for it. */
  DELIVERY_TARGET_EDD: string | null;
  // Inward — DATA ONLY this arc. Mapped into the model, no UI reads them yet.
  INWARDED_DATE: string | null;
  STI_QTY: number | null;
  EX_SHORT: number | null;
  /** IST wall-clock string, second precision (declared NTZ(9) but upstream only
   *  ever stamps whole seconds, and does so in per-job batches — many rows
   *  share one exact value). NULL on rows upstream hasn't touched with its own
   *  update job yet (freshly created orders sit NULL until then), so an
   *  incremental filter must always admit NULL rows or new orders vanish.
   *
   *  NOT a change-data-capture column for the LOGISTICS half of the row. It is
   *  stamped on order/manifest-side events and never bumped again: measured
   *  over the live spine, LAST_UPDATED equalled MANIFESTED_TIMESTAMP on 3,098
   *  of 6,149 AWB rows, equalled the AWB's own creation on 0, equalled the
   *  delivery timestamp on 0, and PREDATED the AWB's creation on 6,081. Using
   *  it alone as the incremental watermark made every AWB, every
   *  STATUS→DELIVERED and every POD structurally unreachable once a row had
   *  been ingested. See SPINE_LAST_EVENT_TS. */
  LAST_UPDATED: string | null;
  /**
   * The row's newest event across BOTH halves — order-side and logistics-side:
   *   GREATEST_IGNORE_NULLS(last_updated, logistics_created_timestamp,
   *     tracking_pick_date, first_ofd_date, latest_ofd_date,
   *     logistics_delivery_timestamp, inwarded_date)
   *
   * This is the column the watermark rides on. Optional in the type because
   * the app tolerates a spine that does not expose it yet — see
   * spineHasEventTs: the reader degrades to the dated sweep alone and says so
   * loudly rather than failing the whole run.
   */
  SPINE_LAST_EVENT_TS?: string | null;
}

/**
 * Snowflake returns a NULL TIMESTAMP_NTZ as the literal string "NULL" under
 * `fetchAsString: ["Date"]`, NOT as null. Every truthiness test, comparison or
 * max over a spine timestamp must normalise through this first — a raw
 * `if (row.SOME_TS)` is always true and silently wrong.
 */
export function ntzValue(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" || s === "NULL" ? undefined : s;
}

/**
 * Columns the app still wants that the spine does not yet expose. The spine SQL
 * carries distribution_analytics as a CTE, so these can be added to its final
 * SELECT; once they are, add them to SPINE_QUERY below and they light up with
 * no other change (the row type already declares them optional and the mapper
 * is null-safe).
 */
export const SPINE_PENDING_COLUMNS = [
  "RECEIVER_POSTAL_CODE",
  "LAST_CHECKPOINT_REMARK",
  "LAST_CHECKPOINT_SUBTAG",
  "LAST_CHECKPOINT_TAG",
] as const;

const SPINE_SELECT = `
SELECT
  ORDER_NAME, ORDER_TIMESTAMP, ORDER_DATE, ORDER_TYPE, WAREHOUSE_NAME,
  QUANTITY, STORE, INVOICE_NUMBER, MANIFESTED_TIMESTAMP,
  MERCHANDISER, AREA_MANAGER, SALES_30D, RANK,
  LANE_CLASSIFICATION, BEST_TAT, ZONE,
  RECEIVER_CITY, RECEIVER_STATE,
  TARGET_ORDER_DAY, TARGET_ORDER_CUTOFF, TARGET_HANDOVER_DAY, TARGET_HANDOVER_CUTOFF,
  TARGET_PICKUP_DAY, TARGET_DELIVERY_DAY,
  ORDER_CUTOFF_TS, HANDOVER_DEADLINE_TS, PICKUP_TAT, IDEAL_DELIVERY_DATE, DELIVERY_TAT,
  ORDER_PLACEMENT_SLA, HANDOVER_SLA, OVERALL_STATUS, FINAL_STATUS,
  TRACKING_NUMBER, COURIER_PARTNER, ESHIP_STATUS, STATUS,
  LOGISTICS_CREATED_TIMESTAMP, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP,
  LOGISTICS_EXPECTED_DELIVERY_DATE, FIRST_OFD_DATE, LATEST_OFD_DATE,
  DELIVERY_ATTEMPTS, PICKUP_ATTEMPTS, TRACKING_LINK,
  TRACKING_STATUS, TRACKING_SUB_STATUS, TRACKING_LATEST_LOCATION, TRACKING_LATEST_MESSAGE,
  LAST_CHECKPOINT_CITY, LAST_CHECKPOINT_STATE, POD_LINK, PACKAGE_COUNT,
  PICKUP_SLA, DELIVERY_SLA, LOGISTICS_DELIVERY_SLA, PERFECT_ORDER_SLA,
  SHIPMENT_BILL, STORE_CHANNEL, RULEBOOK_COVERED, DELIVERY_TARGET_EDD,
  INWARDED_DATE, STI_QTY, EX_SHORT, LAST_UPDATED`;

/** Appended only when the spine exposes the column (see spineHasEventTs). */
const EVENT_TS_SELECT = `,
  SPINE_LAST_EVENT_TS`;

const FROM_SPINE = `
FROM ${SPINE_TABLE}`;

// Stable order across runs. The parent rollup no longer depends on row order
// (see pickParentRow in distribution-map.ts), but a deterministic feed keeps
// sync diffs and OrderEvent noise reproducible.
const SPINE_ORDER_BY = `ORDER BY ORDER_NAME, SHIPMENT_BILL NULLS FIRST, TRACKING_NUMBER NULLS FIRST`;

/**
 * The dated sweep, in days. Every row this recent is re-read on EVERY run
 * regardless of the watermark — the backstop that guarantees an in-flight
 * order is revisited even if its event stamp never moves.
 *
 * It is a BACKSTOP, not the fix: SPINE_LAST_EVENT_TS is what actually makes
 * the incremental pull correct. Read alone, a dated sweep would leave anything
 * older than the window permanently unreachable.
 *
 * 45 days: the live spine holds ~60 days and the oldest genuinely-open orders
 * observed were 48 days, so this covers the real pendency tail with margin
 * while still reading far less than a full scan.
 */
export const SPINE_SWEEP_DAYS = 45;

/** The dated sweep clause. Carries NO status filter on purpose — DELIVERED
 *  rows must be swept in, since "it delivered" is exactly the transition the
 *  app is missing on the orders this exists to rescue. */
const SWEEP_CLAUSE = `ORDER_DATE >= DATEADD(day, -${SPINE_SWEEP_DAYS}, CURRENT_DATE)`;

/** Full window — the only mode before a watermark exists, and the explicit
 *  manual-reseed fallback thereafter. Deliberately the SAME window as the
 *  sweep: a reseed is the recover-everything button, so it must never read
 *  less than routine operation already does. */
export const SPINE_QUERY = `${SPINE_SELECT}${EVENT_TS_SELECT}${FROM_SPINE}
WHERE ${SWEEP_CLAUSE}
${SPINE_ORDER_BY}`;

/** IST wall-clock NTZ string as Snowflake itself renders it
 *  ("YYYY-MM-DD HH:mm:ss" or with a fractional-seconds suffix). Validated
 *  before interpolation since this becomes literal SQL text. */
const NTZ_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Build the spine query for a given watermark. No watermark → the full window
 * (first run / manual reseed).
 *
 * With a watermark, a row is pulled when ANY of these hold:
 *
 *   SPINE_LAST_EVENT_TS >= watermark   the incremental pull proper. This
 *       column maxes the order-side stamp with every logistics timestamp, so
 *       unlike LAST_UPDATED it actually moves when an AWB is issued, picked,
 *       delivered or inwarded.
 *   SPINE_LAST_EVENT_TS IS NULL        a row with no event of any kind yet.
 *   LAST_UPDATED IS NULL               the original guard, kept verbatim.
 *       Upstream leaves freshly-created orders unstamped until its own job
 *       touches them; excluding those would hide new orders indefinitely.
 *       (Strictly redundant now — SPINE_LAST_EVENT_TS is NULL whenever
 *       LAST_UPDATED is, since it is a GREATEST over a set including it — but
 *       it is kept so this predicate is provably no narrower than the one it
 *       replaces.)
 *   ORDER_DATE >= now - SPINE_SWEEP_DAYS   the dated backstop.
 *
 * `>=`, not `>`: these stamps are batch-written to whole-second precision and
 * many rows share one exact value, so a strict `>` risks dropping siblings of
 * the row that set the watermark. Re-fetching the boundary is free —
 * applySyncPatch and upsertShipments are both no-ops on unchanged data.
 *
 * `hasEventTs: false` degrades to the previous LAST_UPDATED predicate plus the
 * sweep, for the window between deploying this code and the spine gaining the
 * column. That mode is NOT the fix — anything older than the sweep stays
 * unreachable — and runSnowflakeSync records it loudly on the run.
 */
export function spineQueryFor(watermark?: string, hasEventTs = true): string {
  if (!watermark) return hasEventTs ? SPINE_QUERY : `${SPINE_SELECT}${FROM_SPINE}
WHERE ${SWEEP_CLAUSE}
${SPINE_ORDER_BY}`;
  if (!NTZ_TS_RE.test(watermark)) {
    throw new Error(`invalid Snowflake watermark format: ${JSON.stringify(watermark)}`);
  }
  const select = `${SPINE_SELECT}${hasEventTs ? EVENT_TS_SELECT : ""}${FROM_SPINE}`;
  const incremental = hasEventTs
    ? `SPINE_LAST_EVENT_TS >= TO_TIMESTAMP_NTZ('${watermark}') OR SPINE_LAST_EVENT_TS IS NULL`
    : `LAST_UPDATED >= TO_TIMESTAMP_NTZ('${watermark}')`;
  return `${select}
WHERE (${incremental} OR LAST_UPDATED IS NULL OR ${SWEEP_CLAUSE})
${SPINE_ORDER_BY}`;
}

export function snowflakeConfigured(): boolean {
  return Boolean(
    process.env.SNOWFLAKE_ACCOUNT &&
      process.env.SNOWFLAKE_USERNAME &&
      process.env.SNOWFLAKE_PRIVATE_KEY,
  );
}

/**
 * The env var holds the encrypted PKCS#8 key either as full PEM or as bare
 * base64 (headerless, possibly with literal \n or collapsed onto one line —
 * Coolify and .env quoting both mangle multi-line values). Normalise to PEM,
 * then decrypt with the passphrase and re-export unencrypted — snowflake-sdk
 * only accepts an unencrypted PKCS#8 PEM.
 */
function decryptedPrivateKeyPem(): string {
  const raw = (process.env.SNOWFLAKE_PRIVATE_KEY ?? "").trim().replace(/^"|"$/g, "");
  const passphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;

  let pem: string;
  if (raw.includes("-----BEGIN")) {
    pem = raw.replace(/\\n/g, "\n");
  } else {
    const b64 = raw.replace(/\\n/g, "").replace(/\s+/g, "");
    const body = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
    const label = passphrase ? "ENCRYPTED PRIVATE KEY" : "PRIVATE KEY";
    pem = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
  }

  const keyObject = crypto.createPrivateKey(
    passphrase ? { key: pem, format: "pem", passphrase } : { key: pem, format: "pem" },
  );
  return keyObject.export({ format: "pem", type: "pkcs8" }) as string;
}

interface SnowflakeConnectionLike {
  connect(cb: (err: Error | undefined, conn: unknown) => void): void;
  destroy(cb: (err: Error | undefined) => void): void;
  execute(opts: {
    sqlText: string;
    complete: (err: Error | undefined, stmt: unknown, rows?: unknown[]) => void;
  }): void;
}

function connectAsync(conn: SnowflakeConnectionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.connect((err) => (err ? reject(err) : resolve()));
  });
}

function executeAsync<T>(conn: SnowflakeConnectionLike, sqlText: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])),
    });
  });
}

function destroyAsync(conn: SnowflakeConnectionLike): Promise<void> {
  return new Promise((resolve) => {
    // Best-effort — a destroy failure must never mask the query result/error.
    conn.destroy(() => resolve());
  });
}

/** Run one arbitrary query on a fresh IST session (dry-run tooling). */
export async function querySnowflake<T>(sqlText: string): Promise<T[]> {
  if (!snowflakeConfigured()) {
    throw new Error("Snowflake requires SNOWFLAKE_ACCOUNT / SNOWFLAKE_USERNAME / SNOWFLAKE_PRIVATE_KEY");
  }
  // Lazy import — keeps the SDK out of every page's server bundle; only the
  // hourly sync (and dry-run tooling) pays the load cost.
  const snowflake = (await import("snowflake-sdk")).default;
  snowflake.configure({
    logLevel: (process.env.SNOWFLAKE_LOG_LEVEL as "ERROR" | undefined) ?? "ERROR",
  });

  // `timezone` is honoured at runtime but missing from the SDK's
  // ConnectionOptions typing — hence the loose object.
  const options: Record<string, unknown> = {
    account: process.env.SNOWFLAKE_ACCOUNT!,
    username: process.env.SNOWFLAKE_USERNAME!,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: decryptedPrivateKeyPem(),
    role: process.env.SNOWFLAKE_ROLE || undefined,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || undefined,
    database: process.env.SNOWFLAKE_DATABASE || undefined,
    schema: process.env.SNOWFLAKE_SCHEMA || undefined,
    timezone: "Asia/Kolkata",
    // DATE / TIMESTAMP_NTZ come back as raw strings — the driver must not
    // reinterpret IST wall-clock values through the local (UTC) timezone.
    fetchAsString: ["Date"],
  };
  const conn = snowflake.createConnection(options as never) as unknown as SnowflakeConnectionLike;

  await connectAsync(conn);
  try {
    // Belt and braces on top of the connection-level timezone: the 20-day
    // window and every DATE comparison must evaluate in IST, not UTC.
    await executeAsync(conn, "ALTER SESSION SET TIMEZONE = 'Asia/Kolkata'");
    return await executeAsync<T>(conn, sqlText);
  } finally {
    await destroyAsync(conn);
  }
}

/**
 * Does the spine expose SPINE_LAST_EVENT_TS yet?
 *
 * Probed per run rather than cached, so the app picks the column up the hour
 * it appears upstream instead of at the next restart — and, equally, degrades
 * on its own if it is ever dropped. One cheap INFORMATION_SCHEMA read per
 * hourly sync.
 *
 * Deliberately NOT a hard dependency: shipping a SELECT for a column that does
 * not exist yet would fail the entire run and take the order spine down with
 * it, which is a far worse outcome than reading with the sweep alone for an
 * hour. The caller reports the degraded mode on the SyncRun.
 */
export async function spineHasEventTs(): Promise<boolean> {
  const rows = await querySnowflake<{ N: number }>(
    `SELECT COUNT(*) AS N FROM SNITCH_DB.INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'MAPLEMONK'
       AND TABLE_NAME = 'RETAIL_JOURNEY_SPINE'
       AND COLUMN_NAME = 'SPINE_LAST_EVENT_TS'`,
  );
  return Number(rows[0]?.N ?? 0) > 0;
}

/** The hourly reader: one row per (order, bill, AWB). Full window when
 *  `watermark` is omitted (first run / manual reseed); otherwise the
 *  incremental predicate plus the dated sweep (see spineQueryFor). Throws on
 *  failure — the caller (sync run) records the error in SyncRun and the
 *  scheduler survives. */
export async function queryRetailJourneySpine(
  watermark?: string,
  hasEventTs = true,
): Promise<DistributionRow[]> {
  return querySnowflake<DistributionRow>(spineQueryFor(watermark, hasEventTs));
}
