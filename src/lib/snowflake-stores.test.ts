// gs_store_details → Store mapping. The store master is a hand-maintained
// Google Sheet, so every one of these cases is a real row shape observed live.

import { describe, expect, it } from "vitest";
import { normStoreKey } from "./qc-tat";
import { mapStoreMaster, mapStoreRow, type StoreMasterRow } from "./snowflake-stores";

function row(over: Partial<StoreMasterRow> = {}): StoreMasterRow {
  return {
    SO_CODE: "AIRIAM",
    BRANCH_CODE: "70",
    STORE_NAME_FORMAT: "SNITCH - COCO - AIRIA MALL",
    CHANNEL: "OWN_STORE",
    STATE: "Haryana",
    CITY: "Gurugram",
    ...over,
  };
}

describe("mapStoreRow", () => {
  it("splits the banner, ownership and store name", () => {
    expect(mapStoreRow(row())).toMatchObject({
      soCode: "AIRIAM",
      branchCode: "70",
      storeName: "COCO - AIRIA MALL",
      finalStore: "SNITCH - COCO - AIRIA MALL",
      ownership: "COCO",
      channel: "OWN_STORE",
      storeCity: "Gurugram",
      storeState: "Haryana",
      isQuickCommerce: false,
    });
  });

  it("takes CHANNEL over the ownership code — they genuinely disagree", () => {
    // Live: SNITCH - COCO - ANSA PLAZA is a FRANCHISE_STORE. Deriving channel
    // from "COCO" would get this wrong for 79 of 147 stores.
    const m = mapStoreRow(row({ STORE_NAME_FORMAT: "SNITCH - COCO - ANSA PLAZA", CHANNEL: "FRANCHISE_STORE" }));
    expect(m).toMatchObject({ ownership: "COCO", channel: "FRANCHISE_STORE" });
  });

  it("falls back to the ownership code only when CHANNEL is absent", () => {
    expect(mapStoreRow(row({ CHANNEL: null })!)?.channel).toBe("OWN_STORE");
    expect(mapStoreRow(row({ CHANNEL: null, STORE_NAME_FORMAT: "SNITCH - COFO - NASHIK" }))?.channel)
      .toBe("FRANCHISE_STORE");
  });

  it("flags quick-commerce from the SO_CODE prefix", () => {
    const m = mapStoreRow(row({ SO_CODE: "QC-HSR", STORE_NAME_FORMAT: "SNITCH - COCO - QC HSR LAYOUT", BRANCH_CODE: "13" }));
    expect(m?.isQuickCommerce).toBe(true);
  });

  it("does not flag a store whose NAME merely contains QC", () => {
    expect(mapStoreRow(row({ SO_CODE: "AIRIAM", STORE_NAME_FORMAT: "SNITCH - COCO - QCITY MALL" }))?.isQuickCommerce)
      .toBe(false);
  });

  it("keeps a hyphenated store name intact", () => {
    const m = mapStoreRow(row({ STORE_NAME_FORMAT: "SNITCH - COCO - BHUMI WORLD - FO" }));
    expect(m?.storeName).toBe("COCO - BHUMI WORLD - FO");
    expect(m?.ownership).toBe("COCO");
  });

  it("carries non-banner names whole and claims no ownership code", () => {
    // Live rows that are not in the three-part shape at all.
    for (const name of ["B2BCORPORATE", "SAPL-NORTH-TAURU", "SUVIDHA STORES - SONIPAT"]) {
      const m = mapStoreRow(row({ STORE_NAME_FORMAT: name }));
      expect(m?.finalStore, name).toBe(name);
      expect(m?.storeName, name).toBe(name);
      expect(m?.ownership, name).toBeUndefined();
    }
  });

  it("collapses the sheet's internal double spaces for display", () => {
    const m = mapStoreRow(row({ STORE_NAME_FORMAT: "SNITCH - COFO - QC  KALYAN NAGAR" }));
    expect(m?.finalStore).toBe("SNITCH - COFO - QC KALYAN NAGAR");
    expect(m?.storeName).toBe("COFO - QC KALYAN NAGAR");
  });

  it("tolerates a missing branch code", () => {
    expect(mapStoreRow(row({ BRANCH_CODE: null }))?.branchCode).toBe("");
  });

  it("drops a row with no name or no so_code", () => {
    expect(mapStoreRow(row({ STORE_NAME_FORMAT: null }))).toBeUndefined();
    expect(mapStoreRow(row({ STORE_NAME_FORMAT: "  " }))).toBeUndefined();
    expect(mapStoreRow(row({ SO_CODE: null }))).toBeUndefined();
  });
});

describe("mapStoreMaster deduplication", () => {
  // The live collision: one name, two so_codes, only one with a branch code.
  const KALYAN = "SNITCH - COFO - QC  KALYAN NAGAR";
  const withBranch = row({ SO_CODE: "QC-HRB", STORE_NAME_FORMAT: KALYAN, BRANCH_CODE: "52" });
  const noBranch = row({ SO_CODE: "QC-KAL", STORE_NAME_FORMAT: KALYAN, BRANCH_CODE: null });

  it("keeps the row carrying a branch code, whichever order they arrive in", () => {
    for (const rows of [[withBranch, noBranch], [noBranch, withBranch]]) {
      const out = mapStoreMaster(rows, normStoreKey);
      expect(out).toHaveLength(1);
      expect(out[0].soCode).toBe("QC-HRB");
      expect(out[0].branchCode).toBe("52");
    }
  });

  it("breaks a remaining tie on so_code, so runs agree", () => {
    const a = row({ SO_CODE: "QC-ZZZ", STORE_NAME_FORMAT: KALYAN, BRANCH_CODE: "52" });
    const b = row({ SO_CODE: "QC-AAA", STORE_NAME_FORMAT: KALYAN, BRANCH_CODE: "52" });
    expect(mapStoreMaster([a, b], normStoreKey)[0].soCode).toBe("QC-AAA");
    expect(mapStoreMaster([b, a], normStoreKey)[0].soCode).toBe("QC-AAA");
  });

  it("treats whitespace drift as the same store", () => {
    // normStoreKey is the same normaliser the order lookup uses, so the double
    // space in "QC  KALYAN NAGAR" cannot split one store into two rows.
    const spaced = row({ SO_CODE: "QC-HRB", STORE_NAME_FORMAT: "SNITCH - COFO - QC KALYAN NAGAR", BRANCH_CODE: "52" });
    expect(mapStoreMaster([withBranch, spaced], normStoreKey)).toHaveLength(1);
  });

  it("keeps genuinely different stores apart", () => {
    const out = mapStoreMaster([row(), row({ SO_CODE: "NASHIK", STORE_NAME_FORMAT: "SNITCH - COFO - NASHIK" })], normStoreKey);
    expect(out).toHaveLength(2);
  });
});
