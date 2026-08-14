// advanceOrdersBulk, driven through the REAL action against the in-memory repo,
// so the guards it claims to reuse are the ones actually running: the facility
// assert, the REQUIRED_CAPTURES allowlist, and repo.transitionStatus with its
// ladder check and terminal lock.
//
// The point of this suite is that the bulk path is a wrapper. If it ever grows
// its own write semantics, the mixed-outcome and forged-capture cases below are
// what should fail first.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Facility, Order, OrderStatus, Role, User } from "@/lib/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ currentUser: vi.fn(), FACILITY_COOKIE: "facility" }));
vi.mock("@/lib/repo", () => ({ repo: { getOrder: vi.fn(), transitionStatus: vi.fn() } }));

import { repo } from "@/lib/repo";
import { currentUser } from "@/lib/session";
import { advanceOrdersBulk } from "@/app/bulk-actions";

const WH1: Facility = "SAPL-WH1";
const WH2: Facility = "SAPL-WH2";

function actor(over: Partial<User> = {}): User {
  return {
    id: "usr_wh",
    name: "Floor Lead",
    email: "lead@snitch.com",
    role: "WH_SUPERVISOR" as Role,
    facilities: [WH1],
    allView: false,
    active: true,
    ...over,
  };
}

/** Orders the fake repo knows about, keyed by SO. */
let world: Map<string, { status: OrderStatus; facility: Facility } & Partial<Order>>;

function seed(entries: Record<string, { status: OrderStatus; facility?: Facility } & Partial<Order>>) {
  world = new Map(
    Object.entries(entries).map(([so, o]) => [so, { facility: WH1, ...o } as never]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentUser).mockResolvedValue(actor() as never);

  vi.mocked(repo.getOrder).mockImplementation(async (so: string) => {
    const o = world.get(so);
    return o ? ({ soNumber: so, ...o } as Order) : undefined;
  });

  // Stands in for the real repo write, reproducing only the two refusals the
  // bulk action must classify: the ladder/terminal check and the required-field
  // check. The real guard is exercised by journey.test.ts.
  vi.mocked(repo.transitionStatus).mockImplementation(
    async (so: string, to: OrderStatus, _actor, captures: Partial<Order> = {}) => {
      const o = world.get(so)!;
      const { canTransition } = await import("@/lib/journey");
      if (!canTransition(o.status, to)) throw new Error(`Invalid transition ${o.status} → ${to}`);
      const { REQUIRED_CAPTURES } = await import("@/lib/journey");
      for (const req of REQUIRED_CAPTURES[to] ?? []) {
        const v = (captures as Record<string, unknown>)[req.field as string] ?? o[req.field as keyof typeof o];
        if (!req.optional && (v == null || v === "")) {
          throw new Error(`Missing required field for ${to}: ${req.label}`);
        }
      }
      world.set(so, { ...o, ...captures, status: to } as never);
      return {} as Order;
    },
  );
});

const outcomes = (r: Awaited<ReturnType<typeof advanceOrdersBulk>>) =>
  r.ok ? Object.fromEntries(r.results.map((x) => [x.soNumber, x.outcome])) : r.error;

describe("captureless bulk advance", () => {
  it("advances a whole column in one call", async () => {
    seed({ A: { status: "NOT_STARTED" }, B: { status: "NOT_STARTED" }, C: { status: "NOT_STARTED" } });
    const res = await advanceOrdersBulk({ orderIds: ["A", "B", "C"], toStatus: "PICKING" });
    expect(res.ok).toBe(true);
    expect(res.ok && res.advanced).toBe(3);
    expect(world.get("A")!.status).toBe("PICKING");
  });

  it("de-duplicates ids so an overlapping range-select cannot double-write", async () => {
    seed({ A: { status: "NOT_STARTED" } });
    const res = await advanceOrdersBulk({ orderIds: ["A", "A", "A"], toStatus: "PICKING" });
    expect(res.ok && res.total).toBe(1);
    expect(vi.mocked(repo.transitionStatus)).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty selection", async () => {
    seed({});
    expect((await advanceOrdersBulk({ orderIds: [], toStatus: "PICKING" })).ok).toBe(false);
  });
});

describe("mixed outcomes are a success, not a regression", () => {
  it("reports ok / skipped per order and still advances the rest", async () => {
    seed({
      A: { status: "NOT_STARTED" }, // advances
      B: { status: "PACKING" }, // already past PICKING — forward-only skip
      C: { status: "NOT_STARTED", facility: WH2 }, // outside the actor's facility
      D: { status: "CANCELLED" }, // terminal lock
      E: { status: "NOT_STARTED" }, // advances
    });
    const res = await advanceOrdersBulk({ orderIds: ["A", "B", "C", "D", "E"], toStatus: "PICKING" });

    expect(res.ok).toBe(true);
    expect(outcomes(res)).toEqual({ A: "ok", B: "skipped", C: "skipped", D: "skipped", E: "ok" });
    expect(res.ok && res.advanced).toBe(2);
    expect(res.ok && res.skipped).toBe(3);
    expect(res.ok && res.failed).toBe(0);
    // The two that could not move were not touched.
    expect(world.get("C")!.status).toBe("NOT_STARTED");
    expect(world.get("D")!.status).toBe("CANCELLED");
  });

  it("scopes facility per order, never from the client", async () => {
    seed({ A: { status: "NOT_STARTED", facility: WH2 }, B: { status: "NOT_STARTED", facility: WH2 } });
    const res = await advanceOrdersBulk({ orderIds: ["A", "B"], toStatus: "PICKING" });
    // Nothing advanced, nothing written, and the run still reports cleanly.
    expect(res.ok && res.advanced).toBe(0);
    expect(res.ok && res.skipped).toBe(2);
    expect(res.ok && res.results[0].reason).toMatch(/entitlement for facility/i);
  });

  // The single-card menu deliberately offers "Back to Picking" etc., so
  // WH_TRANSITIONS permits a one-step reversal. That is right for one card
  // chosen on purpose and dangerous for a sweep: without the bulk-only forward
  // guard, selecting a column and advancing it would drag every order that was
  // already further along back DOWN the flow.
  it("never moves an order backwards, even though the transition map allows it", async () => {
    const { canTransition } = await import("@/lib/journey");
    expect(canTransition("PACKING", "PICKING")).toBe(true); // the map says yes

    seed({ A: { status: "NOT_STARTED" }, B: { status: "PACKING" }, C: { status: "RTS_LOGIC" } });
    const res = await advanceOrdersBulk({ orderIds: ["A", "B", "C"], toStatus: "PICKING" });

    expect(outcomes(res)).toEqual({ A: "ok", B: "skipped", C: "skipped" });
    expect(world.get("B")!.status).toBe("PACKING");
    expect(world.get("C")!.status).toBe("RTS_LOGIC");
  });

  it("skips an order already sitting at the target", async () => {
    seed({ A: { status: "PICKING" } });
    const res = await advanceOrdersBulk({ orderIds: ["A"], toStatus: "PICKING" });
    expect(res.ok && res.skipped).toBe(1);
  });

  it("refuses off-flow targets as bulk destinations", async () => {
    // ON_HOLD / CANCELLED / UNFULFILLABLE are per-card decisions with their own
    // confirmation, never something to apply to a whole selection at once.
    seed({ A: { status: "NOT_STARTED" }, B: { status: "NOT_STARTED" } });
    for (const to of ["ON_HOLD", "CANCELLED", "UNFULFILLABLE"] as OrderStatus[]) {
      const res = await advanceOrdersBulk({ orderIds: ["A", "B"], toStatus: to });
      expect(res.ok && res.advanced).toBe(0);
    }
    expect(world.get("A")!.status).toBe("NOT_STARTED");
  });

  it("classifies an unexpected error as failed, not as a skip", async () => {
    seed({ A: { status: "NOT_STARTED" } });
    vi.mocked(repo.transitionStatus).mockRejectedValueOnce(new Error("connection refused"));
    const res = await advanceOrdersBulk({ orderIds: ["A"], toStatus: "PICKING" });
    expect(res.ok && res.failed).toBe(1);
    expect(res.ok && res.results[0].outcome).toBe("failed");
  });
});

describe("shared-capture dispatch — the one-truck case", () => {
  const FIVE = {
    dcNumber: "DC-1",
    lrNumber: "LR-9",
    logisticsPartner: "Delhivery",
    vehicleNumber: "HR-55-1234",
    eWayBill: "EWB-7",
  } as Partial<Order>;

  it("applies one set of captures to every selected order", async () => {
    seed({ A: { status: "RTS_LOGIC" }, B: { status: "RTS_LOGIC" }, C: { status: "RTS_LOGIC" } });
    const res = await advanceOrdersBulk({
      orderIds: ["A", "B", "C"],
      toStatus: "DISPATCHED_TO_STORE",
      sharedCaptures: FIVE,
    });
    expect(res.ok && res.advanced).toBe(3);
    for (const so of ["A", "B", "C"]) {
      expect(world.get(so)).toMatchObject({ status: "DISPATCHED_TO_STORE", dcNumber: "DC-1", lrNumber: "LR-9" });
    }
  });

  it("skips an order that is not yet at the dispatch rung", async () => {
    seed({ A: { status: "RTS_LOGIC" }, B: { status: "PACKING" } });
    const res = await advanceOrdersBulk({
      orderIds: ["A", "B"],
      toStatus: "DISPATCHED_TO_STORE",
      sharedCaptures: FIVE,
    });
    expect(outcomes(res)).toEqual({ A: "ok", B: "skipped" });
  });

  it("rejects a forged capture key outright — the whole request, before any write", async () => {
    seed({ A: { status: "RTS_LOGIC" }, B: { status: "RTS_LOGIC" } });
    const res = await advanceOrdersBulk({
      orderIds: ["A", "B"],
      toStatus: "DISPATCHED_TO_STORE",
      // `facility` is not on this transition's prompt list. Writing it would be
      // the mass-assignment hole the allowlist exists to close.
      sharedCaptures: { ...FIVE, facility: WH2 } as Partial<Order>,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/not captured on this transition/i);
    expect(vi.mocked(repo.transitionStatus)).not.toHaveBeenCalled();
    expect(world.get("A")!.status).toBe("RTS_LOGIC");
  });

  it("refuses a server-clock timestamp passed as a capture", async () => {
    seed({ A: { status: "RTS_LOGIC" } });
    const res = await advanceOrdersBulk({
      orderIds: ["A"],
      toStatus: "DISPATCHED_TO_STORE",
      // dispatchedTs is written from the server clock; accepting it would let a
      // caller forge the anchor the SLA legs are measured from.
      sharedCaptures: { ...FIVE, dispatchedTs: "2020-01-01T00:00:00.000Z" } as Partial<Order>,
    });
    expect(res.ok).toBe(false);
    expect(vi.mocked(repo.transitionStatus)).not.toHaveBeenCalled();
  });
});

describe("RTS_LOGIC captures are per-order, not shareable", () => {
  it("advances only the orders that already carry their own values", async () => {
    // The four RTS captures (box count, weight, invoice, RTS date) describe one
    // order each — there is no one-truck value to enter once — so a bulk move
    // to this rung takes no shared captures and skips whatever is not ready.
    seed({
      A: { status: "READY_TO_DISPATCH", boxCount: 4, weightKg: 12, saleInvoiceNumber: "INV-1", rtsLogicDate: "2026-08-14" },
      B: { status: "READY_TO_DISPATCH", boxCount: 2 }, // missing invoice/weight/date
    });
    const res = await advanceOrdersBulk({ orderIds: ["A", "B"], toStatus: "RTS_LOGIC" });
    expect(outcomes(res)).toEqual({ A: "ok", B: "skipped" });
    expect(res.ok && res.results.find((r) => r.soNumber === "B")!.reason).toMatch(/missing required field/i);
  });
});

describe("role gate", () => {
  it("refuses a role without canEditWarehouse before any order is read", async () => {
    seed({ A: { status: "NOT_STARTED" } });
    vi.mocked(currentUser).mockResolvedValue(actor({ role: "LOGISTICS" as Role }) as never);
    const res = await advanceOrdersBulk({ orderIds: ["A"], toStatus: "PICKING" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/canEditWarehouse/i);
    expect(vi.mocked(repo.getOrder)).not.toHaveBeenCalled();
  });

  it("allows WH_OPERATOR, which also holds the warehouse right", async () => {
    seed({ A: { status: "NOT_STARTED" } });
    vi.mocked(currentUser).mockResolvedValue(actor({ role: "WH_OPERATOR" as Role }) as never);
    expect((await advanceOrdersBulk({ orderIds: ["A"], toStatus: "PICKING" })).ok).toBe(true);
  });
});
