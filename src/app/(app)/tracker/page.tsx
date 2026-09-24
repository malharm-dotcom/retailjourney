// Logistics Tracker — the logistics team's dispatch log (their "B2B Forward
// Outstation" sheet, moved in). Every dispatch is entered here, including the
// ones never placed on UC; where a row's SO or LR matches an order the app
// knows, the app's own live status sits beside what the team entered.

import { notFound } from "next/navigation";
import { PageHead } from "@/components/shell/page-head";
import { databaseConfigured, prisma } from "@/lib/db";
import { liveMatch } from "@/lib/logistics-tracker";
import { loadLiveOrders } from "@/lib/logistics-tracker-db";
import { canUseTracker } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { TrackerTable, type TrackerRow } from "./table";

export const metadata = { title: "Logistics Tracker" };
export const dynamic = "force-dynamic";

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

export default async function TrackerPage() {
  const { user } = await requireSession();
  // Not "forbidden" — for everyone else the page does not exist.
  if (!canUseTracker(user.role)) notFound();

  const db = databaseConfigured() ? prisma() : undefined;
  const entries = db
    ? await db.logisticsEntry.findMany({ orderBy: [{ dispatchDate: "desc" }, { createdAt: "desc" }] })
    : [];

  // Live status: one batched read for every SO and LR on the page.
  const sos = [...new Set(entries.map((e) => e.soNumber).filter((s): s is string => Boolean(s)))];
  const lrs = [...new Set(entries.map((e) => e.lrNumber).filter((s): s is string => Boolean(s)))];
  const { bySo, byAwb } = db ? await loadLiveOrders(sos, lrs) : { bySo: new Map(), byAwb: new Map() };

  const rows: TrackerRow[] = entries.map((e) => ({
    id: e.id,
    dispatchDate: ymd(e.dispatchDate)!,
    dcNumber: e.dcNumber ?? undefined,
    lrNumber: e.lrNumber ?? undefined,
    quantity: e.quantity ?? undefined,
    boxes: e.boxes ?? undefined,
    storeName: e.storeName,
    storeCity: e.storeCity ?? undefined,
    storeState: e.storeState ?? undefined,
    expectedDate: ymd(e.expectedDate),
    orderType: e.orderType ?? undefined,
    dispatchType: e.dispatchType ?? undefined,
    shipmentStatus: e.shipmentStatus ?? undefined,
    deliveredDate: ymd(e.deliveredDate),
    orderPlacedDate: ymd(e.orderPlacedDate),
    soNumber: e.soNumber ?? undefined,
    facility: e.facility ?? undefined,
    allocationType: e.allocationType ?? undefined,
    courierPartner: e.courierPartner ?? undefined,
    remarks: e.remarks ?? undefined,
    updatedByName: e.updatedByName,
    updatedAt: e.updatedAt.toISOString(),
    live: liveMatch(e, bySo, byAwb),
  }));

  return (
    <>
      <PageHead
        title="Logistics Tracker"
        sub="Every dispatch the logistics team sends, including the ones never placed on UC. Where the SO or LR matches an order the app tracks, its live status shows beside yours."
      />
      <TrackerTable rows={rows} />
    </>
  );
}
