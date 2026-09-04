// Live reader for the store master — SNITCH_DB.MAPLEMONK.GS_STORE_DETAILS,
// the Airbyte-synced Google Sheet that IS the authority behind the spine's
// STORE column (the spine resolves it as LEFT(order_name,6) = so_code, and
// returns store_name_format). 147 rows / 146 distinct names, and every one of
// the 139 stores appearing in the live spine is present in it.
//
// This exists because the app's Store table was a hand-seeded ~30-row list
// lifted from the v2 prototype that nothing ever reconciled against this table.
// Stores that were real, ordering, and correctly resolved by the spine simply
// had no local row — which is what held 140 orders off the floor.
//
// WHAT THIS TABLE DOES NOT HAVE: facility, zone, area manager, merchandiser,
// rank, sales30d. Those are not store attributes here at all. Facility in
// particular cannot come from it, and cannot come from the spine either as a
// single value — 138 of 139 stores ship from two or three warehouses (AIRIA
// MALL: North 32, WH2 13, WH1 3), so "the serving WH" is a per-ORDER fact that
// Store.facility models as a per-store one. The sync uses the DOMINANT
// warehouse as the least-wrong answer and never invents one for a store that
// has not ordered.

import { querySnowflake, SPINE_TABLE } from "./snowflake";
import type { Facility, Ownership, Store } from "./types";
import { FACILITIES } from "./types";

export const STORE_MASTER_TABLE = "SNITCH_DB.MAPLEMONK.GS_STORE_DETAILS";

/** One raw store-master row (only the columns the app consumes). Every column
 *  in this table is nullable TEXT — the sheet is hand-maintained. */
export interface StoreMasterRow {
  SO_CODE: string | null;
  BRANCH_CODE: string | null;
  STORE_NAME_FORMAT: string | null;
  /** Already the app's own vocabulary: OWN_STORE | FRANCHISE_STORE. It is NOT
   *  implied by the ownership code — "SNITCH - COCO - ANSA PLAZA" is a
   *  FRANCHISE_STORE — so this column wins over any derivation. */
  CHANNEL: string | null;
  STATE: string | null;
  CITY: string | null;
}

export async function readStoreMaster(): Promise<StoreMasterRow[]> {
  return querySnowflake<StoreMasterRow>(
    `SELECT SO_CODE, BRANCH_CODE, STORE_NAME_FORMAT, CHANNEL, STATE,
            "Shipping Address City" AS CITY
     FROM ${STORE_MASTER_TABLE}`,
  );
}

/**
 * The warehouse serving MOST of each store's orders over the sweep window,
 * keyed by the raw spine STORE string.
 *
 * A store with no orders in the window is absent from the result, and the sync
 * then declines to invent a facility for it. Its orders would still process
 * perfectly well if any arrived — intake fails open on an unmapped store — so
 * skipping it costs enrichment, never an order.
 */
export async function readStoreFacilities(): Promise<Map<string, Facility>> {
  const rows = await querySnowflake<{ STORE: string | null; DOM_WH: string | null }>(
    `SELECT STORE, MODE(WAREHOUSE_NAME) AS DOM_WH
     FROM ${SPINE_TABLE}
     WHERE ORDER_DATE >= DATEADD(day, -45, CURRENT_DATE) AND STORE IS NOT NULL
     GROUP BY STORE`,
  );
  const out = new Map<string, Facility>();
  for (const r of rows) {
    const wh = (r.DOM_WH ?? "").trim();
    if (r.STORE && (FACILITIES as readonly string[]).includes(wh)) {
      out.set(r.STORE, wh as Facility);
    }
  }
  return out;
}

const OWNERSHIPS: readonly string[] = ["COCO", "FOCO", "COFO", "MFC", "SUVIDHA"];

/** The store master's own shape, before a facility is attached. `soCode` is
 *  carried for identity and QC detection; it is not a Store column. */
export type MappedStore = Omit<Store, "id" | "facility" | "zone" | "storeCity" | "storeState"> & {
  soCode: string;
  storeCity: string;
  storeState: string;
};

/**
 * One gs_store_details row → the Store fields this table is authoritative for.
 *
 * Deliberately absent: facility, zone, areaManager, merchandiser, rank,
 * sales30d. The sheet does not carry them, and guessing them here would
 * overwrite better values the app already holds.
 */
export function mapStoreRow(r: StoreMasterRow): MappedStore | undefined {
  // Internal whitespace is collapsed for DISPLAY only — the sheet carries
  // "SNITCH - COFO - QC  KALYAN NAGAR" with a double space, and that would
  // otherwise be rendered verbatim on every board. Matching against the spine
  // is unaffected: it goes through normStoreKey, which collapses whitespace
  // and hyphens anyway, so the collapsed name resolves exactly as the raw one.
  const finalStore = (r.STORE_NAME_FORMAT ?? "").trim().replace(/\s+/g, " ");
  const soCode = (r.SO_CODE ?? "").trim();
  if (!finalStore || !soCode) return undefined;

  // "SNITCH - COCO - AIRIA MALL" → storeName "COCO - AIRIA MALL", ownership
  // COCO. Names that are not in that three-part shape (B2BCORPORATE,
  // SAPL-NORTH-TAURU, "SUVIDHA STORES - SONIPAT") keep the whole string as the
  // display name and carry no ownership code rather than a guessed one.
  const parts = finalStore.split(" - ").map((p) => p.trim());
  const hasBanner = parts.length > 1 && parts[0].toUpperCase() === "SNITCH";
  const ownership = hasBanner && OWNERSHIPS.includes(parts[1]) ? (parts[1] as Ownership) : undefined;
  const storeName = hasBanner ? parts.slice(1).join(" - ") : finalStore;

  const channelRaw = (r.CHANNEL ?? "").trim().toUpperCase();
  const channel: Store["channel"] =
    channelRaw === "OWN_STORE" || channelRaw === "FRANCHISE_STORE"
      ? channelRaw
      : ownership === "COCO"
        ? "OWN_STORE"
        : "FRANCHISE_STORE";

  return {
    soCode,
    branchCode: (r.BRANCH_CODE ?? "").trim(),
    storeName,
    finalStore,
    ownership: ownership as Ownership,
    channel,
    // The sheet's own convention for a quick-commerce outlet. Name-based
    // detection would be looser — "QC" appears mid-name in ordinary stores —
    // and this is the column the sheet actually maintains.
    isQuickCommerce: soCode.toUpperCase().startsWith("QC-"),
    storeCity: (r.CITY ?? "").trim(),
    storeState: (r.STATE ?? "").trim(),
  };
}

/**
 * The master as a deduplicated list, keyed by `normalise(finalStore)`.
 *
 * One name genuinely appears twice — "SNITCH - COFO - QC  KALYAN NAGAR" under
 * both QC-HRB (branch 52) and QC-KAL (branch absent). The row carrying a branch
 * code wins, because branchCode is what QC TAT inheritance resolves a parent
 * store by; SO_CODE breaks any remaining tie so the choice is stable run to run.
 */
export function mapStoreMaster(rows: StoreMasterRow[], normalise: (s: string) => string): MappedStore[] {
  const best = new Map<string, MappedStore>();
  for (const r of rows) {
    const m = mapStoreRow(r);
    if (!m) continue;
    const key = normalise(m.finalStore);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, m);
      continue;
    }
    const better =
      Boolean(m.branchCode) !== Boolean(prev.branchCode)
        ? Boolean(m.branchCode)
        : m.soCode < prev.soCode;
    if (better) best.set(key, m);
  }
  return [...best.values()];
}
