// Cancellation backstop — the guards that decide when an ABSENT spine row is
// allowed to mean "cancelled on Unicommerce".
//
// Absence is a negative signal, so every test here is really asking the same
// question: can this be made to condemn an order it should not? Measured
// against the live spine on 2026-08-19 — 79 app-open orders had no spine row,
// warehouse_sla_performance confirmed all 79 cancelled (every line CANCELLED,
// 0 partial), all 79 WH_PROCESSING with no AWB, and the aged-out /
// excluded-by-rule / name-mismatch buckets were all empty.

import { describe, expect, it } from "vitest";
import { isProbeableOrderName } from "../snowflake";
import { type CancelCandidate, cancelledUpstream } from "./sync";

const FLOOR = "2026-06-19"; // the live spine's MIN(ORDER_DATE)

function candidate(over: Partial<CancelCandidate> = {}): CancelCandidate {
  return {
    soNumber: "RAJPUR15824",
    orderDate: "2026-07-24",
    status: "NOT_STARTED",
    overallStatus: "WH_PROCESSING",
    ...over,
  };
}

const none = new Set<string>();

describe("cancelledUpstream — the order really did leave the spine", () => {
  it("condemns a WH order above the floor with no spine row (the live case)", () => {
    expect(cancelledUpstream([candidate()], none, FLOOR).map((c) => c.soNumber)).toEqual(["RAJPUR15824"]);
  });

  it("spares an order the spine still carries", () => {
    expect(cancelledUpstream([candidate()], new Set(["RAJPUR15824"]), FLOOR)).toEqual([]);
  });

  it("matches presence case- and whitespace-insensitively — a false miss cancels a live order", () => {
    expect(cancelledUpstream([candidate({ soNumber: " rajpur15824 " })], new Set(["RAJPUR15824"]), FLOOR)).toEqual([]);
  });
});

describe("cancelledUpstream — absence that does NOT mean cancellation", () => {
  it("spares an order older than the retention floor (aged out, not cancelled)", () => {
    expect(cancelledUpstream([candidate({ orderDate: "2026-06-18" })], none, FLOOR)).toEqual([]);
  });

  it("keeps an order exactly ON the floor — that row is still in retention", () => {
    expect(cancelledUpstream([candidate({ orderDate: FLOOR })], none, FLOOR)).toHaveLength(1);
  });

  it("cancels NOTHING when the floor is unreadable — silence is not evidence", () => {
    expect(cancelledUpstream([candidate()], none, undefined)).toEqual([]);
  });

  it("condemns nothing when a rebuilt spine raises the floor above the population", () => {
    // The disaster case, and the reason no separate blast-radius cap is needed:
    // a truncated spine moves the floor up and the whole population falls below it.
    const pop = [candidate({ soNumber: "A15001" }), candidate({ soNumber: "B15002" })];
    expect(cancelledUpstream(pop, none, "2026-08-18")).toEqual([]);
  });
});

describe("cancelledUpstream — bounded to the only stage UC can cancel at", () => {
  // Confirmed with Malhar: UC does not allow a completed order to be cancelled,
  // so a real cancellation is only ever visible at WH_PROCESSING. Anything
  // further along that goes missing is a DATA problem and must stay visible.
  it.each(["PICKUP_PENDING", "IN_TRANSIT", "DELIVERED", "INWARDED", "CLOSED"] as const)(
    "leaves a missing %s order alone",
    (overallStatus) => {
      expect(cancelledUpstream([candidate({ overallStatus })], none, FLOOR)).toEqual([]);
    },
  );

  it.each(["CANCELLED", "UNFULFILLABLE"] as const)("skips an already-terminal %s order", (status) => {
    expect(cancelledUpstream([candidate({ status })], none, FLOOR)).toEqual([]);
  });

  it("still condemns a manually-advanced PACKING order — UC outranks a manual status", () => {
    // 5 of the live 79 carried a manual status (4 PACKING). Malhar's call: an
    // operator marking an order PACKING does not make it exist to pick.
    expect(cancelledUpstream([candidate({ status: "PACKING" })], none, FLOOR)).toHaveLength(1);
  });
});

describe("isProbeableOrderName — an unverifiable name is never condemned", () => {
  it("accepts the live order-name shapes", () => {
    for (const n of ["RAJPUR15824", "ANSAPL16017", "SPMARG15638"]) expect(isProbeableOrderName(n)).toBe(true);
  });

  it("rejects anything that would break out of the SQL literal", () => {
    for (const n of ["O'BRIEN15001", "A'); DROP TABLE X;--", "", "  "]) {
      expect(isProbeableOrderName(n)).toBe(false);
    }
  });

  it("spares an unprobeable name instead of condemning it", () => {
    // The trap this closes: a rejected name is dropped from the presence query,
    // so it can never appear in `presentInSpine` and would otherwise read as
    // absent — cancelling an order purely because its name was unaskable.
    expect(cancelledUpstream([candidate({ soNumber: "O'BRIEN15001" })], none, FLOOR)).toEqual([]);
  });
});
