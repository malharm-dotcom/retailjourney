import { describe, expect, it } from "vitest";
import { actionReason, perRulebook, tatStatusOf } from "./tat";

describe("tatStatusOf", () => {
  const today = "2026-08-24";

  it("reads delivery against the EDD, not against today", () => {
    expect(tatStatusOf("2026-08-20", "2026-08-18", today)).toBe("early");
    expect(tatStatusOf("2026-08-20", "2026-08-20", today)).toBe("ontime");
    expect(tatStatusOf("2026-08-20", "2026-08-22", today)).toBe("late");
  });

  it("an undelivered shipment past its EDD is late, not pending", () => {
    expect(tatStatusOf("2026-08-23", undefined, today)).toBe("late");
    expect(tatStatusOf("2026-08-24", undefined, today)).toBe("pending");
    expect(tatStatusOf("2026-08-30", undefined, today)).toBe("pending");
  });

  it("no EDD is no cue at all — never a silent on-time", () => {
    expect(tatStatusOf(undefined, "2026-08-18", today)).toBeUndefined();
  });
});

describe("perRulebook", () => {
  // 2026-08-23 is a Sunday.
  it("matches the spelled-out rulebook day against the pickup weekday", () => {
    expect(perRulebook("Sunday", "2026-08-23")).toBe(true);
    expect(perRulebook("Monday", "2026-08-23")).toBe(false);
    expect(perRulebook("Sun", "2026-08-23")).toBe(true);
  });

  it("is undefined — not N — when either side is missing", () => {
    expect(perRulebook(undefined, "2026-08-23")).toBeUndefined();
    expect(perRulebook("Sunday", undefined)).toBeUndefined();
  });
});

describe("actionReason — the coordinator's to-do list", () => {
  const today = "2026-09-24";
  const tomorrow = "2026-09-25";
  const base = { attempts: 0, breaching: false };

  it("a courier-reported failure is the first thing to act on, until a person decides", () => {
    expect(actionReason({ ...base, shipment: "DELIVERY_FAILED", breaching: true }, today, tomorrow)).toBe("failed");
    expect(actionReason({ ...base, shipment: "DELIVERY_FAILED", source: "MANUAL" }, today, tomorrow)).toBeUndefined();
  });

  it("an attempt that failed and is being retried is an NDR", () => {
    expect(actionReason({ ...base, shipment: "IN_TRANSIT", attempts: 1 }, today, tomorrow)).toBe("ndr");
  });

  it("breached now, then at risk — due today or tomorrow and not out for delivery", () => {
    expect(actionReason({ ...base, shipment: "IN_TRANSIT", breaching: true }, today, tomorrow)).toBe("breached");
    expect(actionReason({ ...base, shipment: "INFORECEIVED", edd: tomorrow }, today, tomorrow)).toBe("at-risk");
    expect(actionReason({ ...base, edd: tomorrow }, today, tomorrow)).toBe("at-risk");
    expect(actionReason({ ...base, shipment: "IN_TRANSIT", edd: tomorrow }, today, tomorrow)).toBeUndefined();
    expect(actionReason({ ...base, shipment: "IN_TRANSIT", courierEdd: today }, today, tomorrow)).toBe("at-risk");
    expect(actionReason({ ...base, shipment: "OUT_FOR_DELIVERY", edd: today }, today, tomorrow)).toBeUndefined();
    expect(actionReason({ ...base, shipment: "IN_TRANSIT", edd: "2026-09-28" }, today, tomorrow)).toBeUndefined();
  });

  it("delivered, inwarded and returned shipments need nothing", () => {
    expect(actionReason({ ...base, overall: "INWARDED", shipment: "IN_TRANSIT", attempts: 1 }, today, tomorrow)).toBeUndefined();
    expect(actionReason({ ...base, delivered: today, attempts: 2 }, today, tomorrow)).toBeUndefined();
    expect(actionReason({ ...base, shipment: "RETURN", breaching: true }, today, tomorrow)).toBeUndefined();
  });
});
