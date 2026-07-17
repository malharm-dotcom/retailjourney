// QC TAT inheritance + store-key normalization (Task: QC stores share the
// parent's branchCode and inherit its TAT; edge cases surface, never guess).

import { describe, expect, it } from "vitest";
import {
  buildInheritedTat,
  hasOwnDeadlines,
  isExcludedStoreKey,
  isQcStoreKey,
  normStoreKey,
  parseStoreKey,
  resolveQcParent,
  shouldInheritQcTat,
  toWeekday,
} from "./qc-tat";
import { facilityWhGroup, flattenRulebook, rulebookTemplateFor, whGroupOf } from "./rulebook-map";
import type { RulebookSourceRow } from "./snowflake-rulebook";
import type { Order, Store } from "./types";

function store(over: Partial<Store>): Store {
  return {
    id: "s1",
    branchCode: "52",
    isQuickCommerce: false,
    storeName: "COFO - KALYAN NAGAR",
    finalStore: "SNITCH - COFO - KALYAN NAGAR",
    ownership: "COFO",
    channel: "FRANCHISE_STORE",
    storeCity: "Bengaluru",
    storeState: "Karnataka",
    zone: "SOUTH",
    facility: "SAPL-WH1",
    ...over,
  } as Store;
}

describe("normStoreKey", () => {
  it("collapses whitespace runs (live drift: 'QC  KALYAN NAGAR')", () => {
    expect(normStoreKey("SNITCH - COFO - QC  KALYAN NAGAR")).toBe("SNITCH - COFO - QC KALYAN NAGAR");
  });
  it("unifies hyphen spacing ('HSR LAYOUT-2' vs 'HSR LAYOUT - 2')", () => {
    expect(normStoreKey("SNITCH - COCO - HSR LAYOUT-2")).toBe(normStoreKey("SNITCH - COCO - HSR LAYOUT - 2"));
    expect(normStoreKey("SNITCH - COCO - HINJAWADI PHASE -1")).toBe(
      normStoreKey("SNITCH - COCO - HINJAWADI PHASE - 1"),
    );
  });
});

describe("parseStoreKey vocabulary", () => {
  it("parses MFC as an ownership", () => {
    expect(parseStoreKey("SNITCH - MFC - HYDERABAD")).toEqual({
      ownership: "MFC",
      storeName: "MFC - HYDERABAD",
    });
  });
  it("parses SUVIDHA destinations", () => {
    expect(parseStoreKey("SUVIDHA STORES - SONIPAT").ownership).toBe("SUVIDHA");
  });
  it("flags QC-prefixed names, not MFC or plain stores", () => {
    expect(isQcStoreKey("SNITCH - COFO - QC KALYAN NAGAR")).toBe(true);
    expect(isQcStoreKey("SNITCH - COCO - QC  CG ROAD")).toBe(true);
    expect(isQcStoreKey("SNITCH - MFC - HYDERABAD")).toBe(false);
    expect(isQcStoreKey("SNITCH - COFO - KALYAN NAGAR")).toBe(false);
  });
  it("excludes warehouse/corporate nodes", () => {
    expect(isExcludedStoreKey("B2BCORPORATE")).toBe(true);
    expect(isExcludedStoreKey("SAPL-NORTH-TAURU")).toBe(true);
    expect(isExcludedStoreKey("SNITCH - COFO - KALYAN NAGAR")).toBe(false);
  });
});

describe("resolveQcParent", () => {
  const qc = store({ id: "qc", finalStore: "SNITCH - COFO - QC KALYAN NAGAR", isQuickCommerce: true });

  it("QC with parent: the one non-QC store sharing the branch code", () => {
    const parent = store({ id: "p" });
    const r = resolveQcParent(qc, [qc, parent, store({ id: "other", branchCode: "13" })]);
    expect(r.parent?.id).toBe("p");
  });

  it("QC without parent: surfaces NO_PARENT instead of guessing", () => {
    const r = resolveQcParent(qc, [qc, store({ id: "other", branchCode: "13" })]);
    expect(r.parent).toBeUndefined();
    expect("reason" in r && r.reason).toBe("NO_PARENT");
  });

  it("two non-QC stores on one code: AMBIGUOUS, no guess", () => {
    const r = resolveQcParent(qc, [qc, store({ id: "a" }), store({ id: "b" })]);
    expect(r.parent).toBeUndefined();
    expect("reason" in r && r.reason).toBe("AMBIGUOUS");
  });
});

describe("inheritance gate", () => {
  it("non-QC orders are never touched", () => {
    expect(shouldInheritQcTat(store({}), {})).toBe(false);
  });
  it("QC order with no deadlines inherits", () => {
    expect(shouldInheritQcTat(store({ isQuickCommerce: true }), {})).toBe(true);
  });
  it("QC order that gains its own rulebook TAT upstream wins over inheritance", () => {
    const own: Partial<Order> = { orderCutoffTs: "2026-07-13T03:30:00.000Z" };
    expect(hasOwnDeadlines(own)).toBe(true);
    expect(shouldInheritQcTat(store({ isQuickCommerce: true }), own)).toBe(false);
  });
});

describe("buildInheritedTat", () => {
  it("normalizes both live day formats", () => {
    expect(toWeekday("Mon")).toBe("Mon");
    expect(toWeekday("Monday")).toBe("Mon");
    expect(toWeekday("nonsense")).toBeUndefined();
  });

  it("re-anchors the parent's pattern on the QC order's own date", () => {
    // 2026-07-13 is a Monday; parent pattern: order Mon 9 AM.
    const patch = buildInheritedTat("2026-07-13", {
      targetOrderDay: "Mon",
      targetOrderCutoff: "9 AM",
      targetHandoverDay: "Monday",
      targetHandoverCutoff: "6 PM",
      targetPickupDay: "Monday",
      targetDeliveryDay: "Tuesday",
      bestTat: 2,
    });
    expect(patch).toBeDefined();
    // 9 AM IST on 2026-07-13 = 03:30 UTC
    expect(patch!.orderCutoffTs).toBe("2026-07-13T03:30:00.000Z");
    expect(patch!.handoverDeadlineTs).toBeDefined();
    expect(patch!.pickupTat).toBeDefined();
    expect(patch!.idealDeliveryDate).toBeDefined();
    // Static pattern is carried through for display parity with real rows.
    expect(patch!.targetOrderDay).toBe("Mon");
    expect(patch!.bestTat).toBe(2);
  });

  it("returns undefined when the parent has no usable pattern (No TAT, not a false breach)", () => {
    expect(buildInheritedTat("2026-07-13", {})).toBeUndefined();
  });
});

// Rulebook-sourced inheritance (Task STEP 3): QC TAT now reads the parent's
// rulebook row, not the parent's most-recent order. These cover the flatten +
// serving-WH lookup that feed buildInheritedTat.
function rbRow(over: Partial<RulebookSourceRow>): RulebookSourceRow {
  return {
    UPLOAD_DATE: "2026-06-01",
    WH: "North WH",
    STORE_NAME: "SNITCH - COFO - KALYAN NAGAR",
    STORE_TYPE: "HS",
    CITY: "Bengaluru",
    PINCODE: 560043,
    LANE_CLASSIFICATION: "Milk Run Lane",
    ZONE: "South",
    BEST_TAT: 2,
    BEST_COURIER_PARTNER: "Milk Run",
    FRESH_ORDER_CUTOFF: "Friday 9 AM",
    FRESH_TAT: "Friday 6 PM",
    FRESH_HANDOVER_DAY: "Saturday",
    FRESH_DELIVERY_DAY: "Monday",
    RPL_ORDER_CUTOFF: "Monday 4 PM",
    RPL_TAT: "Tuesday 5 AM",
    RPL_HANDOVER_DAY: "Tuesday",
    RPL_DELIVERY_DAY: "Thursday",
    ...over,
  };
}

describe("WH group mapping", () => {
  it("maps rulebook WH labels to a group", () => {
    expect(whGroupOf("North WH")).toBe("NORTH");
    expect(whGroupOf("South WH")).toBe("SOUTH");
    expect(whGroupOf(null)).toBeUndefined();
  });
  it("maps a serving facility to its rulebook WH group", () => {
    expect(facilityWhGroup("SAPL-NORTH-TAURU")).toBe("NORTH");
    expect(facilityWhGroup("SAPL-WH1")).toBe("SOUTH");
    expect(facilityWhGroup("SAPL-WH2")).toBe("SOUTH");
    expect(facilityWhGroup(undefined)).toBeUndefined();
  });
});

describe("flattenRulebook", () => {
  it("splits the FRESH/RPL columns into per-order-type target rows (DA semantics)", () => {
    const rows = flattenRulebook([rbRow({})]);
    const fresh = rows.find((r) => r.orderType === "FRESH")!;
    // targetOrderDay+cutoff come from *_ORDER_CUTOFF ("Friday 9 AM")
    expect(fresh.targetOrderDay).toBe("Fri");
    expect(fresh.targetOrderCutoff).toBe("9 AM");
    // handover from *_TAT ("Friday 6 PM"), pickup from *_HANDOVER_DAY, delivery from *_DELIVERY_DAY
    expect(fresh.targetHandoverDay).toBe("Fri");
    expect(fresh.targetHandoverCutoff).toBe("6 PM");
    expect(fresh.targetPickupDay).toBe("Sat");
    expect(fresh.targetDeliveryDay).toBe("Mon");
    expect(fresh.zone).toBe("SOUTH");
    expect(fresh.bestTatDays).toBe(2);

    const rpl = rows.find((r) => r.orderType === "RPL")!;
    expect(rpl.targetOrderDay).toBe("Mon");
    expect(rpl.targetOrderCutoff).toBe("4 PM");
    expect(rpl.targetDeliveryDay).toBe("Thu");
  });
});

describe("rulebookTemplateFor", () => {
  const rows = flattenRulebook([
    rbRow({ WH: "North WH", LANE_CLASSIFICATION: "Milk Run Lane", BEST_TAT: 2 }),
    rbRow({ WH: "South WH", LANE_CLASSIFICATION: "South-1", BEST_TAT: 5 }),
  ]);

  it("prefers the parent's serving-WH row", () => {
    const north = rulebookTemplateFor(rows, "SNITCH - COFO - KALYAN NAGAR", "FRESH", "SAPL-NORTH-TAURU");
    expect(north?.laneClassification).toBe("Milk Run Lane");
    const south = rulebookTemplateFor(rows, "SNITCH - COFO - KALYAN NAGAR", "FRESH", "SAPL-WH1");
    expect(south?.laneClassification).toBe("South-1");
  });

  it("falls back to any WH when the serving WH has no row", () => {
    const northOnly = flattenRulebook([rbRow({ WH: "North WH" })]);
    const r = rulebookTemplateFor(northOnly, "SNITCH - COFO - KALYAN NAGAR", "FRESH", "SAPL-WH1");
    expect(r?.wh).toBe("North WH");
  });

  it("returns undefined when the parent has no rulebook row", () => {
    expect(rulebookTemplateFor(rows, "SNITCH - COCO - NOWHERE", "FRESH", "SAPL-WH1")).toBeUndefined();
  });

  it("feeds buildInheritedTat: a parent rulebook row re-anchors on the QC order date", () => {
    const tmpl = rulebookTemplateFor(rows, "SNITCH - COFO - KALYAN NAGAR", "FRESH", "SAPL-NORTH-TAURU")!;
    const patch = buildInheritedTat("2026-07-13", {
      targetOrderDay: tmpl.targetOrderDay,
      targetOrderCutoff: tmpl.targetOrderCutoff,
      targetHandoverDay: tmpl.targetHandoverDay,
      targetHandoverCutoff: tmpl.targetHandoverCutoff,
      targetPickupDay: tmpl.targetPickupDay,
      targetDeliveryDay: tmpl.targetDeliveryDay,
      bestTat: tmpl.bestTatDays,
    });
    expect(patch).toBeDefined();
    expect(patch!.orderCutoffTs).toBeDefined();
    expect(patch!.idealDeliveryDate).toBeDefined();
  });
});
