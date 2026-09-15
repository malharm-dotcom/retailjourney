/**
 * READ-ONLY. The residual exception list after the inward-seed + self-delivery
 * fixes: every open order that is NOT genuinely moving, one row each, with the
 * cause and who has to act. Recomputed from live data every run — nothing
 * hardcoded.
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/pendency-exceptions.ts
 */
import { config } from "dotenv"; config({ path: [".env.local", ".env"] });
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { querySnowflake, SPINE_TABLE, SPINE_SWEEP_DAYS, ntzValue } from "../src/lib/snowflake";
import { istToday, daysBetween } from "../src/lib/ist";
const S = (v: unknown) => ntzValue(v as string);

async function main() {
  const db = prisma(); const today = istToday();
  const open = await db.order.findMany({
    where: { overallStatus: { in: ["PICKUP_PENDING", "IN_TRANSIT"] }, status: { notIn: ["CANCELLED", "UNFULFILLABLE"] } },
    include: { shipments: true },
  });
  const names = open.map((o) => `'${o.soNumber}'`);
  const sp: Record<string, unknown>[] = [];
  for (let i = 0; i < names.length; i += 2000) sp.push(...await querySnowflake<Record<string, unknown>>(
    `SELECT ORDER_NAME, STORE_CHANNEL, OVERALL_STATUS, STATUS, TRACKING_NUMBER, SHIPMENT_BILL,
            UC_DISPATCHED_TIMESTAMP, INWARDED_DATE, SPINE_LAST_EVENT_TS
     FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${names.slice(i, i + 2000).join(",")})`));
  const by = new Map<string, Record<string, unknown>[]>();
  for (const r of sp) { const k = String(r.ORDER_NAME); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }

  const rows: Record<string, string | number>[] = [];
  for (const o of open) {
    const rs = by.get(o.soNumber) ?? [];
    const r0 = rs[0];
    const orderAge = daysBetween(o.orderDate.toISOString().slice(0, 10), today);
    const disp = S(r0?.UC_DISPATCHED_TIMESTAMP);
    const dispAge = disp ? daysBetween(disp.slice(0, 10), today) : undefined;
    const inwarded = rs.some((r) => S(r.INWARDED_DATE)) || rs.some((r) => S(r.OVERALL_STATUS) === "INWARDED");
    const lastScan = ((o.checkpoints as { date?: string }[] | null) ?? []).map((c) => c.date).filter(Boolean).sort().pop();
    const scanAge = lastScan ? daysBetween(lastScan.slice(0, 10), today) : undefined;
    const channel = S(r0?.STORE_CHANNEL) ?? "";
    let cause = "", owner = "", action = "";

    if (o.shipments.length && o.shipments.every((c) => c.shipmentStatus === "DELIVERED")) {
      cause = "APP_BUG_FROZEN_MANUAL_LOCK"; owner = "app (fix pending)";
      action = "Every AWB delivered; a manual shipmentStatus holds the order open. Closes once the freeze-branch fix ships.";
    } else if (inwarded && orderAge > SPINE_SWEEP_DAYS) {
      cause = "INWARDED_OUT_OF_SYNC_WINDOW"; owner = "app (one-off re-read)";
      action = "Store booked it in; the event predates the watermark and the 45d sweep, so no sync will ever re-read it.";
    } else if (inwarded) {
      cause = "INWARDED_REOPENED_BY_POLLER"; owner = "app (fixed, needs redeploy)";
      action = "Store booked it in. The hourly Snowflake run closes it, but pre-fix the 15-min eShipz poller reopened it from courier status. Closes and stays closed after redeploy.";
    } else if (!o.shipments.length && dispAge !== undefined && dispAge > 3) {
      cause = S(r0?.SHIPMENT_BILL) ? "ORPHAN_BILL_BUT_NO_ESHIPZ" : "ORPHAN_NO_STO_BILL";
      owner = S(r0?.SHIPMENT_BILL) ? "logistics — eShipz booking" : "logistics — Logic STO";
      action = S(r0?.SHIPMENT_BILL)
        ? "STO bill exists but no FINAL_ESHIP_TRACKING row matches it: the AWB was never booked, or booked against a different reference."
        : "UC dispatched it but there is no logic_final_sto bill, so no AWB can ever be linked.";
    } else if (!o.shipments.length) {
      continue; // dispatched <=3d ago, or not yet dispatched: inside the grace window
    } else if (scanAge !== undefined && scanAge > 7) {
      cause = channel === "FRANCHISE" ? "COURIER_SILENT_FRANCHISE_NO_BACKSTOP" : "COURIER_SILENT_7D+";
      owner = `courier — ${o.courierPartner ?? "?"}`;
      action = channel === "FRANCHISE"
        ? "No courier scan for 7+ days, and franchise stores never book STI — nothing but a courier delivered scan can close this."
        : "No courier scan for 7+ days. eShipz itself has nothing newer: chase the courier, or confirm with the store and inward it.";
    } else continue;

    rows.push({
      cause, owner, so: o.soNumber, store: o.storeNameFormat, channel, orderDate: o.orderDate.toISOString().slice(0, 10),
      orderAgeDays: orderAge, dispatchedAgeDays: dispAge ?? "", appStatus: `${o.overallStatus}/${o.shipmentStatus ?? "-"}`,
      courier: o.courierPartner ?? "", awb: o.trackingNumber ?? "", lastScan: lastScan?.slice(0, 10) ?? "",
      spineStatus: `${S(r0?.OVERALL_STATUS) ?? "-"}/${S(r0?.STATUS) ?? "-"}`, stoBill: S(r0?.SHIPMENT_BILL) ?? "",
      am: o.areaManager ?? "", action,
    });
  }
  rows.sort((a, b) => String(a.cause).localeCompare(String(b.cause)) || Number(b.orderAgeDays) - Number(a.orderAgeDays));
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(String(r.cause), (tally.get(String(r.cause)) ?? 0) + 1);
  console.log(`open PICKUP_PENDING/IN_TRANSIT: ${open.length}   residual exceptions: ${rows.length}`);
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)}  ${k}`);
  const cols = Object.keys(rows[0] ?? {});
  writeFileSync("pendency-exceptions.csv", [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n"));
  console.log(`\nwrote pendency-exceptions.csv`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
