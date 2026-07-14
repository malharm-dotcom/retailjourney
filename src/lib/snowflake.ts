// Snowflake reader for `distribution_analytics` — the order-data source that
// replaced the abandoned UC integration for B2B distribution. Key-pair (JWT)
// auth; CONNECT → QUERY → DESTROY on every call (Snowflake idle-drops
// connections, so a held module-level connection fails silently on an hourly
// job). The source table is TIMESTAMP_NTZ built in IST, so the session
// timezone is forced to Asia/Kolkata and all DATE/TIMESTAMP columns are
// fetched as strings — distribution-map.ts converts them via ist.ts.

import crypto from "crypto";

/** One row per (ORDER_NAME, TRACKING_NUMBER). Timestamps arrive as IST
 *  wall-clock strings ("YYYY-MM-DD HH:mm:ss.SSS"), dates as "YYYY-MM-DD". */
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
  RECEIVER_POSTAL_CODE: string | null;
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
  LAST_CHECKPOINT_REMARK: string | null;
  LAST_CHECKPOINT_SUBTAG: string | null;
  LAST_CHECKPOINT_TAG: string | null;
  POD_LINK: string | null;
  PACKAGE_COUNT: number | null;
  PICKUP_SLA: string | null;
  DELIVERY_SLA: string | null;
  LOGISTICS_DELIVERY_SLA: string | null;
  PERFECT_ORDER_SLA: string | null;
}

export const DISTRIBUTION_QUERY = `
SELECT
  ORDER_NAME, ORDER_TIMESTAMP, ORDER_DATE, ORDER_TYPE, WAREHOUSE_NAME,
  QUANTITY, STORE, INVOICE_NUMBER, MANIFESTED_TIMESTAMP,
  MERCHANDISER, AREA_MANAGER, SALES_30D, RANK,
  LANE_CLASSIFICATION, BEST_TAT, ZONE,
  RECEIVER_CITY, RECEIVER_STATE, RECEIVER_POSTAL_CODE,
  TARGET_ORDER_DAY, TARGET_ORDER_CUTOFF, TARGET_HANDOVER_DAY, TARGET_HANDOVER_CUTOFF,
  TARGET_PICKUP_DAY, TARGET_DELIVERY_DAY,
  ORDER_CUTOFF_TS, HANDOVER_DEADLINE_TS, PICKUP_TAT, IDEAL_DELIVERY_DATE, DELIVERY_TAT,
  ORDER_PLACEMENT_SLA, HANDOVER_SLA, OVERALL_STATUS, FINAL_STATUS,
  TRACKING_NUMBER, COURIER_PARTNER, ESHIP_STATUS, STATUS,
  LOGISTICS_CREATED_TIMESTAMP, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP,
  LOGISTICS_EXPECTED_DELIVERY_DATE, FIRST_OFD_DATE, LATEST_OFD_DATE,
  DELIVERY_ATTEMPTS, PICKUP_ATTEMPTS, TRACKING_LINK,
  TRACKING_STATUS, TRACKING_SUB_STATUS, TRACKING_LATEST_LOCATION, TRACKING_LATEST_MESSAGE,
  LAST_CHECKPOINT_CITY, LAST_CHECKPOINT_STATE, LAST_CHECKPOINT_REMARK,
  LAST_CHECKPOINT_SUBTAG, LAST_CHECKPOINT_TAG, POD_LINK, PACKAGE_COUNT,
  PICKUP_SLA, DELIVERY_SLA, LOGISTICS_DELIVERY_SLA, PERFECT_ORDER_SLA
FROM distribution_analytics
WHERE ORDER_DATE >= DATEADD(day, -20, CURRENT_DATE)`;

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

/** The hourly reader: last 20 days of distribution_analytics, one row per
 *  (order, AWB). Throws on failure — the caller (sync run) records the error
 *  in SyncRun and the scheduler survives. */
export async function queryDistributionAnalytics(): Promise<DistributionRow[]> {
  return querySnowflake<DistributionRow>(DISTRIBUTION_QUERY);
}
