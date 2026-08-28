// previewCsvImport / runCsvImport, driven through the REAL actions against a
// fake repo — so the guards they claim to reuse are the ones actually running:
// the facility assert, the REQUIRED_CAPTURES allowlist, assertForward, and
// repo.transitionStatus with its ladder check.
//
// The two properties this suite exists to protect:
//   1. PREVIEW WRITES NOTHING. A dry run that touches the database is not a dry
//      run, and the whole point of the import is that 290 rows get inspected
//      before any of them move.
//   2. ONE BAD ROW DOES NOT ABORT THE BATCH. An import of a real day's work
//      will contain a cancelled order and a typo; those are reported, and
//      everything else still goes.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Facility, Order, OrderStatus, Role, User } from "@/lib/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ currentUser: vi.fn(), FACILITY_COOKIE: "facility" }));
vi.mock("@/lib/repo", () => ({ repo: { getOrder: vi.fn(), transitionStatus: vi.fn() } }));

import { repo } from "@/lib/repo";
import { currentUser } from "@/lib/session";
import { previewCsvImport, runCsvImport } from "@/app/import-actions";

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

let world: Map<string, { status: OrderStatus; facility: Facility } & Partial<Order>>;

function seed(entries: Record<string, { status: OrderStatus; facility?: Facility } & Partial<Order>>) {
  world = new Map(
    Object.entries(entries).map(([so, o]) => [so, { facility: WH1, qty: 100, ...o } as never]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentUser).mockResolvedValue(actor() as never);

  vi.mocked(repo.getOrder).mockImplementation(async (so: string) => {
    const o = world.get(so);
    return o ? ({ soNumber: so, finalStore: `STORE ${so}`, ...o } as Order) : undefined;
  });

  vi.mocked(repo.transitionStatus).mockImplementation(
    async (so: string, to: OrderStatus, _actor, captures: Partial<Order> = {}) => {
      const o = world.get(so)!;
      const { REQUIRED_CAPTURES, canTransition } = await import("@/lib/journey");
      if (!canTransition(o.status, to)) throw new Error(`Invalid transition ${o.status} → ${to}`);
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

const RTS_HEAD = "SO_NUMBER,BOX_COUNT,WEIGHT_KG,SALE_INVOICE_NO,RTS_LOGIC_DATE,QUANTITY,NOTE";
const rtsRow = (so: string, over: Partial<Record<string, string>> = {}) =>
  [so, over.box ?? "6", over.kg ?? "42.5", over.inv ?? `SI-${so}`, over.date ?? "17-07-2026", over.qty ?? "", over.note ?? ""].join(",");
const rtsFile = (...rows: string[]) => [RTS_HEAD, ...rows].join("\r\n");

const verdicts = (r: Awaited<ReturnType<typeof previewCsvImport>>) =>
  r.ok ? Object.fromEntries(r.rows.map((x) => [x.soNumber, x.verdict])) : r.error;

describe("previewCsvImport writes nothing", () => {
  it("classifies every row and never calls the repo write", async () => {
    seed({
      A: { status: "READY_TO_DISPATCH" }, // ready
      B: { status: "PACKING" }, // not there yet
      C: { status: "RTS_LOGIC" }, // already advanced
      D: { status: "READY_TO_DISPATCH", facility: WH2 }, // out of scope
    });
    const res = await previewCsvImport({
      to: "RTS_LOGIC",
      csvText: rtsFile(rtsRow("A"), rtsRow("B"), rtsRow("C"), rtsRow("D"), rtsRow("MISSING")),
    });

    expect(res.ok).toBe(true);
    expect(verdicts(res)).toEqual({ A: "ready", B: "skip", C: "skip", D: "skip", MISSING: "skip" });
    expect(res.ok && res.ready).toBe(1);
    expect(vi.mocked(repo.transitionStatus)).not.toHaveBeenCalled();
    expect(world.get("A")!.status).toBe("READY_TO_DISPATCH");
  });

  it("names the reason for each refusal so the row can be fixed", async () => {
    seed({
      B: { status: "PACKING" },
      C: { status: "RTS_LOGIC" },
      D: { status: "READY_TO_DISPATCH", facility: WH2 },
    });
    const res = await previewCsvImport({
      to: "RTS_LOGIC",
      csvText: rtsFile(rtsRow("B"), rtsRow("C"), rtsRow("D"), rtsRow("MISSING")),
    });
    const reason = (so: string) => (res.ok ? res.rows.find((r) => r.soNumber === so)?.reason : undefined);
    expect(reason("B")).toMatch(/not at expected stage/);
    expect(reason("C")).toBe("already advanced");
    expect(reason("D")).toBe("out of scope");
    expect(reason("MISSING")).toBe("SO not found");
  });

  it("reports a bad row as an error, distinct from a skip", async () => {
    seed({ A: { status: "READY_TO_DISPATCH" } });
    const res = await previewCsvImport({
      to: "RTS_LOGIC",
      csvText: rtsFile(rtsRow("A"), rtsRow("E", { box: "six" })),
    });
    expect(res.ok && res.invalid).toBe(1);
    expect(res.ok && res.rows[1].verdict).toBe("error");
  });

  it("refuses an empty file and the wrong template outright", async () => {
    seed({});
    expect((await previewCsvImport({ to: "RTS_LOGIC", csvText: "" })).ok).toBe(false);
    expect((await previewCsvImport({ to: "DISPATCHED_TO_STORE", csvText: rtsFile(rtsRow("A")) })).ok).toBe(false);
  });
});

describe("runCsvImport writes per row, independently", () => {
  it("moves each order through the guarded action with ITS OWN captures", async () => {
    seed({ A: { status: "READY_TO_DISPATCH" }, B: { status: "READY_TO_DISPATCH" } });
    const res = await runCsvImport({
      to: "RTS_LOGIC",
      csvText: rtsFile(rtsRow("A", { box: "6", inv: "SI-A" }), rtsRow("B", { box: "11", inv: "SI-B" })),
    });

    expect(res.ok && res.moved).toBe(2);
    // The whole point: two different box counts, not one applied to both.
    expect(world.get("A")!.boxCount).toBe(6);
    expect(world.get("B")!.boxCount).toBe(11);
    expect(world.get("A")!.saleInvoiceNumber).toBe("SI-A");
    expect(world.get("B")!.saleInvoiceNumber).toBe("SI-B");
    expect(world.get("A")!.status).toBe("RTS_LOGIC");
  });

  it("one bad row does not abort the batch", async () => {
    seed({
      A: { status: "READY_TO_DISPATCH" },
      C: { status: "RTS_LOGIC" },
      D: { status: "READY_TO_DISPATCH", facility: WH2 },
      E: { status: "READY_TO_DISPATCH" },
    });
    const res = await runCsvImport({
      to: "RTS_LOGIC",
      csvText: rtsFile(rtsRow("A"), rtsRow("BAD", { box: "six" }), rtsRow("C"), rtsRow("D"), rtsRow("E")),
    });

    expect(res.ok).toBe(true);
    expect(res.ok && res.moved).toBe(2);
    expect(res.ok && res.skipped).toBe(3);
    expect(world.get("A")!.status).toBe("RTS_LOGIC");
    expect(world.get("E")!.status).toBe("RTS_LOGIC");
    // Untouched, both of them.
    expect(world.get("D")!.status).toBe("READY_TO_DISPATCH");
    expect(world.get("C")!.status).toBe("RTS_LOGIC");
  });

  it("returns a per-row result for every row, in the promised shape", async () => {
    seed({ A: { status: "READY_TO_DISPATCH" }, C: { status: "RTS_LOGIC" } });
    const res = await runCsvImport({ to: "RTS_LOGIC", csvText: rtsFile(rtsRow("A"), rtsRow("C")) });
    expect(res.ok && res.results).toEqual([
      { soNumber: "A", success: true, error: null },
      { soNumber: "C", success: false, error: "already advanced" },
    ]);
  });

  it("fills a blank QUANTITY from the ordered qty and honours one that is typed", async () => {
    seed({ A: { status: "READY_TO_DISPATCH", qty: 240 }, B: { status: "READY_TO_DISPATCH", qty: 240 } });
    await runCsvImport({
      to: "RTS_LOGIC",
      csvText: rtsFile(rtsRow("A"), rtsRow("B", { qty: "231" })),
    });
    expect(world.get("A")!.fulfilledQty).toBe(240);
    expect(world.get("B")!.fulfilledQty).toBe(231);
    // Neither touches the sync-owned ordered quantity.
    expect(world.get("A")!.qty).toBe(240);
    expect(world.get("B")!.qty).toBe(240);
  });

  it("scopes facility server-side, never from the file", async () => {
    seed({ A: { status: "READY_TO_DISPATCH", facility: WH2 } });
    const res = await runCsvImport({ to: "RTS_LOGIC", csvText: rtsFile(rtsRow("A")) });
    expect(res.ok && res.moved).toBe(0);
    expect(vi.mocked(repo.transitionStatus)).not.toHaveBeenCalled();
  });

  it("refuses the whole call for a role without the warehouse right", async () => {
    seed({ A: { status: "READY_TO_DISPATCH" } });
    vi.mocked(currentUser).mockResolvedValue(actor({ role: "VIEWER" as Role }) as never);
    const res = await runCsvImport({ to: "RTS_LOGIC", csvText: rtsFile(rtsRow("A")) });
    expect(res.ok).toBe(false);
    expect(vi.mocked(repo.transitionStatus)).not.toHaveBeenCalled();
  });

  it("writes the dispatch template's fields, optionals included when present", async () => {
    seed({ A: { status: "RTS_LOGIC" }, B: { status: "RTS_LOGIC" } });
    const res = await runCsvImport({
      to: "DISPATCHED_TO_STORE",
      csvText: [
        "SO_NUMBER,DC_NUMBER,LR_NUMBER,LOGISTICS_PARTNER,VEHICLE_NO,E_WAY_BILL,NOTE",
        "A,DC-1,LR-1,MUDITACARGO,HR55AB1234,281004417901,",
        "B,DC-2,LR-2,SELF,,,own vehicle",
      ].join("\r\n"),
    });
    expect(res.ok && res.moved).toBe(2);
    expect(world.get("A")!.vehicleNumber).toBe("HR55AB1234");
    expect(world.get("B")!.vehicleNumber).toBeUndefined();
    expect(world.get("B")!.logisticsPartner).toBe("SELF");
  });
});
