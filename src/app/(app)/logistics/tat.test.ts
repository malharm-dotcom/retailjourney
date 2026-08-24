import { describe, expect, it } from "vitest";
import { perRulebook, tatStatusOf } from "./tat";

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
