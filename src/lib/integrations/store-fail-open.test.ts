// Store resolution must FAIL OPEN. An order is never held out of processing
// because its store is missing from the app's local Store table.
//
// The bug this pins: the app's Store table is a static hand-seeded list that
// nothing reconciles against gs_store_details, while the spine's STORE column
// IS gs_store_details.store_name_format (joined LEFT(order_name,6) = so_code).
// Intake resolved the store against the LOCAL table and `continue`d on a miss,
// so 140 live orders across 9 real stores never became rows at all — even
// though the spine had already resolved every one of their names correctly.

import { describe, expect, it } from "vitest";
import type { MappedOrder } from "../distribution-map";
import { storeFieldsFor } from "./sync";
import type { Order, Store } from "../types";

function mapped(over: Partial<MappedOrder> = {}): MappedOrder {
  return { soNumber: "PACIFI15834", patch: {}, shipments: [], ...over };
}

function store(over: Partial<Store> = {}): Store {
  return {
    id: "st_001",
    branchCode: "SN101",
    isQuickCommerce: false,
    storeName: "COCO - DAHISAR",
    finalStore: "SNITCH - COCO - DAHISAR",
    ownership: "COCO",
    channel: "OWN_STORE",
    storeState: "Maharashtra",
    facility: "SAPL-WH1",
    ...over,
  } as Store;
}

describe("storeFieldsFor — with a local Store row", () => {
  it("takes every store column from the Store row", () => {
    const f = storeFieldsFor(mapped({ storeKey: "SNITCH - COCO - DAHISAR" }), store());
    expect(f).toMatchObject({
      storeId: "st_001",
      storeNameFormat: "COCO - DAHISAR",
      finalStore: "SNITCH - COCO - DAHISAR",
      ownership: "COCO",
      channel: "OWN_STORE",
      state: "Maharashtra",
    });
  });

  it("a mapped store is never marked unmapped", () => {
    expect(storeFieldsFor(mapped(), store()).storeId).not.toBe("");
  });
});

describe("storeFieldsFor — no local Store row (the fail-open path)", () => {
  // The eight stores from the live review queue. Every one of these IS present
  // in gs_store_details with this exact store_name_format — the spine resolved
  // them, the stale local table did not have them.
  const QUEUED = [
    ["SNITCH - COCO - BOULEWARD WALK", "COCO - BOULEWARD WALK", "COCO", "OWN_STORE"],
    ["SNITCH - COCO - PUNJABI BAGH", "COCO - PUNJABI BAGH", "COCO", "OWN_STORE"],
    ["SNITCH - COCO - PACIFIC JASOLA", "COCO - PACIFIC JASOLA", "COCO", "OWN_STORE"],
    ["SNITCH - COCO - GOLDUST PATIALA", "COCO - GOLDUST PATIALA", "COCO", "OWN_STORE"],
    ["SNITCH - COCO - RR NAGAR", "COCO - RR NAGAR", "COCO", "OWN_STORE"],
    ["SNITCH - COFO - NASHIK", "COFO - NASHIK", "COFO", "FRANCHISE_STORE"],
    ["SNITCH - COFO - SGS MALL", "COFO - SGS MALL", "COFO", "FRANCHISE_STORE"],
    ["SNITCH - COFO - VIKRAMPURI", "COFO - VIKRAMPURI", "COFO", "FRANCHISE_STORE"],
  ] as const;

  it.each(QUEUED)("resolves %s from the spine alone", (key, name, ownership, channel) => {
    const f = storeFieldsFor(mapped({ storeKey: key }), undefined);
    expect(f.finalStore).toBe(key);
    expect(f.storeNameFormat).toBe(name);
    expect(f.ownership).toBe(ownership);
    expect(f.channel).toBe(channel);
    // Flagged for reconciliation, but the NAME above is fully resolved.
    expect(f.storeId).toBe("");
  });

  it("keeps a hyphenated store name intact", () => {
    // "BHUMI WORLD - FO" — the trailing segment is part of the name, not a
    // fourth field. Splitting must not lose it.
    const f = storeFieldsFor(mapped({ storeKey: "SNITCH - COCO - BHUMI WORLD - FO" }), undefined);
    expect(f.finalStore).toBe("SNITCH - COCO - BHUMI WORLD - FO");
    expect(f.storeNameFormat).toBe("COCO - BHUMI WORLD - FO");
    expect(f.ownership).toBe("COCO");
  });

  it("prefers the spine's STORE_CHANNEL over the ownership code", () => {
    const f = storeFieldsFor(
      mapped({ storeKey: "SNITCH - COCO - PUNJABI BAGH", patch: { storeChannel: "FRANCHISE" } }),
      undefined,
    );
    expect(f.channel).toBe("FRANCHISE_STORE");
  });

  it("takes state from the spine's receiver state", () => {
    const f = storeFieldsFor(
      mapped({ storeKey: "SNITCH - COFO - NASHIK", patch: { receiverState: "Maharashtra" } }),
      undefined,
    );
    expect(f.state).toBe("Maharashtra");
  });

  it("still produces every NOT NULL column when STORE itself is absent", () => {
    // The historical "(no store)" queue row. Order.storeId / storeNameFormat /
    // finalStore / state / channel are all NOT NULL, so the order can only be
    // created if each one has a value.
    const f = storeFieldsFor(mapped({ storeKey: undefined }), undefined);
    for (const k of ["storeId", "storeNameFormat", "finalStore", "state", "channel"] as const) {
      expect(f[k as keyof Order], k).toBeDefined();
    }
    expect(f.finalStore).toBe("(store unmapped)");
    expect(f.ownership).toBeUndefined();
  });

  it("does not invent an ownership code for an unrecognised one", () => {
    expect(storeFieldsFor(mapped({ storeKey: "SNITCH - XXXX - SOMEWHERE" }), undefined).ownership)
      .toBeUndefined();
  });
});
