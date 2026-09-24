"use server";

// Logistics Tracker writes. Gated here, server-side, on every call — hiding
// the tab is navigation, not security.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { parseTrackerInput, type TrackerErrors, type TrackerFields } from "@/lib/logistics-tracker";
import { canUseTracker } from "@/lib/rbac";
import { currentUser } from "@/lib/session";

export type TrackerSaveResult = { ok: true } | { ok: false; error?: string; errors?: TrackerErrors };

/** YYYY-MM-DD → the Date Prisma writes to a @db.Date column (UTC midnight). */
const day = (s: string | null) => (s ? new Date(`${s}T00:00:00.000Z`) : null);

function toDb(f: TrackerFields) {
  return {
    ...f,
    dispatchDate: day(f.dispatchDate)!,
    expectedDate: day(f.expectedDate),
    deliveredDate: day(f.deliveredDate),
    orderPlacedDate: day(f.orderPlacedDate),
  };
}

/** Create (no id) or update one tracker entry. */
export async function saveTrackerEntry(raw: Record<string, unknown>, id?: string): Promise<TrackerSaveResult> {
  try {
    const user = await currentUser();
    if (!canUseTracker(user.role)) return { ok: false, error: "Only logistics and admin can edit the tracker" };
    const parsed = parseTrackerInput(raw);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const data = toDb(parsed.data);
    if (id) {
      await prisma().logisticsEntry.update({ where: { id }, data: { ...data, updatedByName: user.name } });
    } else {
      await prisma().logisticsEntry.create({ data: { ...data, createdByName: user.name, updatedByName: user.name } });
    }
    revalidatePath("/tracker");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}
