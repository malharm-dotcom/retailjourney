import { describe, expect, it } from "vitest";
import { liveMatch, parseTrackerInput, type LiveOrder } from "./logistics-tracker";

const base = { dispatchDate: "2026-09-23", storeName: "SNITCH - COCO - HSR LAYOUT" };

describe("parseTrackerInput", () => {
  it("needs only a dispatch date and a store; blanks store as null", () => {
    const r = parseTrackerInput({ ...base, dcNumber: "  ", quantity: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dcNumber).toBeNull();
      expect(r.data.quantity).toBeNull();
    }
    const bad = parseTrackerInput({});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["dispatchDate", "storeName"]);
  });

  it("normalises the match keys the way the app stores them", () => {
    const r = parseTrackerInput({ ...base, soNumber: " hsrlay16990 ", lrNumber: "9064 1429" });
    expect(r.ok && r.data.soNumber).toBe("HSRLAY16990");
    expect(r.ok && r.data.lrNumber).toBe("90641429");
  });

  it("refuses counts that are not whole numbers, bad dates, and delivery before dispatch", () => {
    const r = parseTrackerInput({ ...base, quantity: "-3", boxes: "2.5", expectedDate: "23/09/2026", deliveredDate: "2026-09-20" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["boxes", "deliveredDate", "expectedDate", "quantity"]);
  });

  it("caps free text", () => {
    const r = parseTrackerInput({ ...base, remarks: "x".repeat(1001) });
    expect(r.ok).toBe(false);
  });
});

describe("liveMatch", () => {
  const o = (soNumber: string): LiveOrder => ({ soNumber, overallStatus: "IN_TRANSIT" });
  const bySo = new Map([["HSRLAY16990", o("HSRLAY16990")]]);
  const byAwb = new Map([["90641429", o("DAHISA15562")]]);

  it("matches on the SO first, then on the LR/AWB", () => {
    expect(liveMatch({ soNumber: "HSRLAY16990", lrNumber: "90641429" }, bySo, byAwb)?.soNumber).toBe("HSRLAY16990");
    expect(liveMatch({ soNumber: "CARRY BAG", lrNumber: "90641429" }, bySo, byAwb)?.soNumber).toBe("DAHISA15562");
  });

  it("a dispatch the app has never seen matches nothing", () => {
    expect(liveMatch({ soNumber: "DIFFUSER OIL", lrNumber: null }, bySo, byAwb)).toBeUndefined();
  });
});
