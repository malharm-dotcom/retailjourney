// Unit tests for the Snowflake distribution_analytics mapper — the grain
// change (Order + OrderShipment children), the pollability rule and the IST
// NTZ conversions must hold before real rows flow.

import { describe, expect, it } from "vitest";
import {
  isPollableAwb,
  mapDistributionRows,
  normFacility,
  normOverallStatus,
} from "./distribution-map";
import { isoFromIstNtz, istDateFromNtz } from "./ist";
import { rollupOverall, rollupShipments } from "./journey";
import type { DistributionRow } from "./snowflake";

/** All-null row skeleton — tests override only what they assert on. */
function row(over: Partial<DistributionRow> & { ORDER_NAME: string }): DistributionRow {
  const keys = [
    "ORDER_TIMESTAMP", "ORDER_DATE", "ORDER_TYPE", "WAREHOUSE_NAME", "QUANTITY", "STORE",
    "INVOICE_NUMBER", "MANIFESTED_TIMESTAMP", "MERCHANDISER", "AREA_MANAGER", "SALES_30D",
    "RANK", "LANE_CLASSIFICATION", "BEST_TAT", "ZONE", "RECEIVER_CITY", "RECEIVER_STATE",
    "RECEIVER_POSTAL_CODE", "TARGET_ORDER_DAY", "TARGET_ORDER_CUTOFF", "TARGET_HANDOVER_DAY",
    "TARGET_HANDOVER_CUTOFF", "TARGET_PICKUP_DAY", "TARGET_DELIVERY_DAY", "ORDER_CUTOFF_TS",
    "HANDOVER_DEADLINE_TS", "PICKUP_TAT", "IDEAL_DELIVERY_DATE", "DELIVERY_TAT",
    "ORDER_PLACEMENT_SLA", "HANDOVER_SLA", "OVERALL_STATUS", "FINAL_STATUS", "TRACKING_NUMBER",
    "COURIER_PARTNER", "ESHIP_STATUS", "STATUS", "LOGISTICS_CREATED_TIMESTAMP",
    "TRACKING_PICK_DATE", "LOGISTICS_DELIVERY_TIMESTAMP", "LOGISTICS_EXPECTED_DELIVERY_DATE",
    "FIRST_OFD_DATE", "LATEST_OFD_DATE", "DELIVERY_ATTEMPTS", "PICKUP_ATTEMPTS", "TRACKING_LINK",
    "TRACKING_STATUS", "TRACKING_SUB_STATUS", "TRACKING_LATEST_LOCATION",
    "TRACKING_LATEST_MESSAGE", "LAST_CHECKPOINT_CITY", "LAST_CHECKPOINT_STATE",
    "LAST_CHECKPOINT_REMARK", "LAST_CHECKPOINT_SUBTAG", "LAST_CHECKPOINT_TAG", "POD_LINK",
    "PACKAGE_COUNT", "PICKUP_SLA", "DELIVERY_SLA", "LOGISTICS_DELIVERY_SLA", "PERFECT_ORDER_SLA",
  ] as const;
  const base = Object.fromEntries(keys.map((k) => [k, null])) as unknown as DistributionRow;
  return { ...base, ...over };
}

describe("ist NTZ conversion", () => {
  it("treats Snowflake NTZ wall clocks as IST, not UTC", () => {
    expect(isoFromIstNtz("2026-07-08 14:30:00.000")).toBe("2026-07-08T09:00:00.000Z");
    expect(isoFromIstNtz("2026-07-08T00:00:00")).toBe("2026-07-07T18:30:00.000Z");
    expect(isoFromIstNtz("2026-07-08")).toBe("2026-07-07T18:30:00.000Z"); // IST midnight
    expect(isoFromIstNtz(null)).toBeUndefined();
    expect(isoFromIstNtz("garbage")).toBeUndefined();
  });

  it("keeps DATE columns as IST business dates", () => {
    expect(istDateFromNtz("2026-07-08")).toBe("2026-07-08");
    expect(istDateFromNtz("2026-07-08 00:00:00.000")).toBe("2026-07-08");
    expect(istDateFromNtz(null)).toBeUndefined();
  });
});

describe("isPollableAwb", () => {
  it("rejects pseudo-AWBs and self/porter couriers", () => {
    expect(isPollableAwb("SN417", "SELF_DELIVERY")).toBe(false);
    expect(isPollableAwb("SN4130", null)).toBe(false); // pseudo pattern alone suffices
    expect(isPollableAwb("12345678901", "Porter")).toBe(false);
    expect(isPollableAwb(null, "BLUEDART")).toBe(false);
    expect(isPollableAwb("", "BLUEDART")).toBe(false);
  });

  it("accepts real courier AWB formats", () => {
    expect(isPollableAwb("53667523140", "BLUEDART")).toBe(true); // 11-digit
    expect(isPollableAwb("12345678", "MUDITACARGO")).toBe(true); // 8-digit
    expect(isPollableAwb("BNG26CST00791", "MOVEMATE")).toBe(true); // alnum
    expect(isPollableAwb("1234567890", "EKART B2B")).toBe(true); // 10-digit
    // "SNITCH"-prefixed real AWBs would not match ^SN\d+$ (needs digits only)
    expect(isPollableAwb("SN12AB34", "MOVEMATE")).toBe(true);
  });
});

describe("mapDistributionRows — grain", () => {
  it("a split order produces exactly 1 order + 2 shipments (SPMARG15638, live rows)", () => {
    const rows = [
      row({
        ORDER_NAME: "SPMARG15638",
        STORE: "SNITCH - FOCO - PRAYAGRAJ",
        INVOICE_NUMBER: "2627/94/WS-4120",
        TRACKING_NUMBER: "53668790195",
        COURIER_PARTNER: "BLUEDART",
        STATUS: "RETURN", // dead label — RTO'd, replaced by the second AWB
        ESHIP_STATUS: "cancelled", // internal state — must not drive status
        OVERALL_STATUS: "Pickup Pending",
      }),
      row({
        ORDER_NAME: "SPMARG15638",
        STORE: "SNITCH - FOCO - PRAYAGRAJ",
        INVOICE_NUMBER: "2627/94/WS-4120",
        TRACKING_NUMBER: "53668827505",
        COURIER_PARTNER: "BLUEDART",
        STATUS: "DELIVERED",
        ESHIP_STATUS: "pickup_schedule",
        LOGISTICS_DELIVERY_TIMESTAMP: "2026-07-10 18:05:00.000",
        OVERALL_STATUS: "Delivered",
      }),
    ];
    const mapped = mapDistributionRows(rows);
    expect(mapped).toHaveLength(1);
    const m = mapped[0];
    expect(m.soNumber).toBe("SPMARG15638");
    expect(m.storeKey).toBe("SNITCH - FOCO - PRAYAGRAJ");
    expect(m.shipments).toHaveLength(2);
    expect(m.shipments[0].shipmentStatus).toBe("RETURN");
    expect(m.shipments[1].shipmentStatus).toBe("DELIVERED");
    expect(m.shipments[1].deliveredTs).toBe("2026-07-10T12:35:00.000Z");

    // The RETURN label is dead — the delivered replacement decides the order.
    const rolled = rollupShipments(m.shipments.map((s) => s.shipmentStatus));
    expect(rolled).toBe("DELIVERED");
    expect(rollupOverall({ status: "DISPATCHED_TO_STORE", shipmentStatus: rolled })).toBe(
      "DELIVERED",
    );
  });

  it("self-delivery maps isPollable=false; a WH-stage row maps zero shipments", () => {
    const mapped = mapDistributionRows([
      row({
        ORDER_NAME: "SPX1",
        TRACKING_NUMBER: "SN417",
        COURIER_PARTNER: "SELF_DELIVERY",
        STATUS: "Delivered",
      }),
      row({ ORDER_NAME: "SPX2", MANIFESTED_TIMESTAMP: "2026-07-09 10:00:00.000" }),
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped[0].shipments[0].isPollable).toBe(false);
    expect(mapped[0].shipments[0].shipmentStatus).toBe("DELIVERED"); // same normalizer
    expect(mapped[1].shipments).toHaveLength(0);
    expect(mapped[1].patch.manifestedTs).toBe("2026-07-09T04:30:00.000Z");
  });

  it("maps deadlines verbatim and timestamps through IST", () => {
    const [m] = mapDistributionRows([
      row({
        ORDER_NAME: "SPX3",
        ORDER_TIMESTAMP: "2026-07-06 09:15:00.000",
        ORDER_DATE: "2026-07-06",
        TARGET_ORDER_DAY: "Mon",
        TARGET_ORDER_CUTOFF: "11AM",
        ORDER_CUTOFF_TS: "2026-07-06 11:00:00.000",
        HANDOVER_DEADLINE_TS: "2026-07-08 18:00:00.000",
        PICKUP_TAT: "2026-07-09 23:59:59.000", // NTZ deadline ts (verified live)
        IDEAL_DELIVERY_DATE: "2026-07-11 23:59:59.000",
        DELIVERY_TAT: "2026-07-11 23:59:59.000",
        ORDER_PLACEMENT_SLA: "WITHIN_SLA",
      }),
    ]);
    expect(m.patch.orderTimestamp).toBe("2026-07-06T03:45:00.000Z");
    expect(m.patch.orderDate).toBe("2026-07-06");
    expect(m.patch.targetOrderDay).toBe("Mon");
    expect(m.patch.orderCutoffTs).toBe("2026-07-06T05:30:00.000Z");
    expect(m.patch.handoverDeadlineTs).toBe("2026-07-08T12:30:00.000Z");
    expect(m.patch.pickupTat).toBe("2026-07-09T18:29:59.000Z");
    expect(m.patch.idealDeliveryDate).toBe("2026-07-11");
    expect(m.patch.deliveryTat).toBe("2026-07-11T18:29:59.000Z");
    expect(m.patch.orderPlacementSla).toBe("WITHIN_SLA");
  });
});

describe("normalizers", () => {
  it("maps OVERALL_STATUS vocab (seed only)", () => {
    expect(normOverallStatus("WH Processing")).toBe("WH_PROCESSING");
    expect(normOverallStatus("Pickup Pending")).toBe("PICKUP_PENDING");
    expect(normOverallStatus("In transit")).toBe("IN_TRANSIT");
    expect(normOverallStatus("Delivered")).toBe("DELIVERED");
    expect(normOverallStatus(null)).toBeUndefined();
  });

  it("maps warehouse names to facilities, passing unknowns through", () => {
    expect(normFacility("North_Wh")).toBe("SAPL-NORTH-TAURU");
    expect(normFacility("TAURU")).toBe("SAPL-NORTH-TAURU");
    expect(normFacility("WH1")).toBe("SAPL-WH1");
    expect(normFacility("Warehouse 2")).toBe("SAPL-WH2");
    expect(normFacility("Mystery DC")).toBe("Mystery DC");
    expect(normFacility(null)).toBeUndefined();
  });
});

describe("rollupShipments", () => {
  it("least-progressed ACTIVE child wins; DELIVERY_FAILED needs attention", () => {
    expect(rollupShipments([])).toBeUndefined();
    expect(rollupShipments(["DELIVERED", "DELIVERED"])).toBe("DELIVERED");
    expect(rollupShipments(["DELIVERED", "IN_TRANSIT"])).toBe("IN_TRANSIT");
    expect(rollupShipments(["OUT_FOR_DELIVERY", "DELIVERY_FAILED"])).toBe("DELIVERY_FAILED");
  });

  it("a delivered AWB beats an unscanned sibling (dead label)", () => {
    expect(rollupShipments(["DELIVERED", undefined])).toBe("DELIVERED");
    expect(rollupShipments(["IN_TRANSIT", undefined])).toBe("IN_TRANSIT");
    expect(rollupShipments([undefined, undefined])).toBeUndefined();
  });

  it("RETURN children are excluded unless the order has nothing else", () => {
    expect(rollupShipments(["RETURN", "DELIVERED"])).toBe("DELIVERED");
    expect(rollupShipments(["RETURN", "IN_TRANSIT"])).toBe("IN_TRANSIT");
    expect(rollupShipments(["RETURN", undefined])).toBeUndefined();
    expect(rollupShipments(["RETURN", "RETURN"])).toBe("RETURN");
  });
});
