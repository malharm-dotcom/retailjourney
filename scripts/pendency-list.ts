/**
 * READ-ONLY. Every open (non-terminal) order in the app, joined to the spine's
 * current verdict, bucketed by ROOT CAUSE. SELECTs only.
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/pendency-list.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { querySnowflake, SPINE_TABLE, SPINE_SWEEP_DAYS, ntzValue } from "../src/lib/snowflake";
import { istToday, daysBetween } from "../src/lib/ist";
import { transitAnchor } from "../src/lib/transit-anchor";
import { isPollableAwb } from "../src/lib/distribution-map";

const head = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const S = (v: unknown) => ntzValue(v as string) ?? undefined;

async function main() {
  const db = prisma();
  const today = istToday();

  const open = await db.order.findMany({
    where: {
      overallStatus: { in: ["WH_PROCESSING", "PICKUP_PENDING", "IN_TRANSIT"] },
      status: { notIn: ["CANCELLED", "UNFULFILLABLE"] },
    },
    include: { shipments: true },
  });
  console.log(`open orders in app: ${open.length}`);

  // Spine verdict for exactly these SOs.
  const names = open.map((o) => `'${o.soNumber.replace(/'/g, "''")}'`);
  const spine = new Map<string, Record<string, unknown>[]>();
  for (let i = 0; i < names.length; i += 2000) {
    const rows = await querySnowflake<Record<string, unknown>>(
      `SELECT ORDER_NAME, ORDER_DATE, OVERALL_STATUS, FINAL_STATUS, STATUS, TRACKING_NUMBER,
              COURIER_PARTNER, TRACKING_PICK_DATE, LOGISTICS_DELIVERY_TIMESTAMP, INWARDED_DATE,
              POD_LINK, LAST_UPDATED
       FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${names.slice(i, i + 2000).join(",")})`,
    );
    for (const r of rows) {
      const k = String(r.ORDER_NAME);
      (spine.get(k) ?? spine.set(k, []).get(k)!).push(r);
    }
  }
  console.log(`open orders found in spine: ${spine.size}`);

  type Out = Record<string, string | number>;
  const out: Out[] = [];
  const tally = new Map<string, number>();
  const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);

  for (const o of open) {
    const anchor = transitAnchor(o as never, o.shipments as never);
    const age = anchor.date ? daysBetween(anchor.date, today) : daysBetween(o.orderDate.toISOString().slice(0, 10), today);
    const orderAge = daysBetween(o.orderDate.toISOString().slice(0, 10), today);
    const rows = spine.get(o.soNumber) ?? [];
    const sStatuses = rows.map((r) => (S(r.STATUS) ?? "").toUpperCase());
    const sOverall = (S(rows[0]?.OVERALL_STATUS) ?? "").toUpperCase();
    const sFinal = (S(rows[0]?.FINAL_STATUS) ?? "").toUpperCase();
    const delivTs = rows.map((r) => S(r.LOGISTICS_DELIVERY_TIMESTAMP)).filter(Boolean);
    const inwTs = rows.map((r) => S(r.INWARDED_DATE)).filter(Boolean);
    const spineAwbs = rows.map((r) => S(r.TRACKING_NUMBER)).filter(Boolean) as string[];
    const spineDone = sOverall === "INWARDED" || sOverall === "DELIVERED" || sFinal === "DELIVERED"
      || sStatuses.every((s) => s === "DELIVERED") && sStatuses.length > 0 || delivTs.length > 0 || inwTs.length > 0;
    const stale = orderAge > SPINE_SWEEP_DAYS;

    let cause: string;
    if (!rows.length) cause = "NO_SPINE_ROW";
    else if (spineDone && stale) cause = "A_SPINE_DONE_BUT_OUT_OF_45D_SWEEP";
    else if (spineDone) cause = "B_SPINE_DONE_BUT_APP_NOT_UPDATED";
    else if (!o.shipments.length && !spineAwbs.length) cause = orderAge > 3 ? "C_ORPHAN_NO_AWB_3D+" : "C0_NO_AWB_RECENT";
    else if (!o.shipments.length && spineAwbs.length) cause = "D_AWB_IN_SPINE_NOT_IN_APP";
    else if (o.shipments.every((s) => !s.isPollable)) cause = "E_NONPOLLABLE_AWB_NO_SPINE_MOVEMENT";
    else if (o.shipments.some((s) => s.isPollable) && !o.shipmentStatus) cause = "F_POLLABLE_NEVER_SCANNED";
    else cause = "G_GENUINELY_IN_FLIGHT";

    bump(cause);
    if (age >= 10 || cause.startsWith("A") || cause.startsWith("B") || cause.startsWith("C_") || cause.startsWith("D")) {
      out.push({
        cause, so: o.soNumber, store: o.storeNameFormat, orderDate: o.orderDate.toISOString().slice(0, 10),
        ageDays: age, orderAgeDays: orderAge, appOverall: o.overallStatus, appShip: o.shipmentStatus ?? "",
        appAwb: o.trackingNumber ?? "", courier: o.courierPartner ?? "",
        pollable: o.shipments.map((s) => `${s.awb}:${s.isPollable ? "Y" : "N"}`).join("|"),
        spineOverall: sOverall, spineStatus: [...new Set(sStatuses)].join("|"), spineFinal: sFinal,
        spineAwb: [...new Set(spineAwbs)].join("|"),
        spineDelivered: delivTs[0] ?? "", spineInwarded: inwTs[0] ?? "",
        lastUpdated: S(rows[0]?.LAST_UPDATED) ?? "", appUpdatedAt: o.updatedAt.toISOString().slice(0, 10),
        am: o.areaManager ?? "", qty: o.qty,
      });
    }
  }

  head("ROOT-CAUSE TALLY (all open orders)");
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);

  head("AGE DISTRIBUTION of open orders");
  const buckets = new Map<string, number>();
  for (const o of open) {
    const a = daysBetween(o.orderDate.toISOString().slice(0, 10), today);
    const b = a > 60 ? "60d+" : a > 45 ? "46-60d" : a > 30 ? "31-45d" : a > 14 ? "15-30d" : a > 7 ? "8-14d" : "0-7d";
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  for (const [k, v] of [...buckets].sort()) console.log(`   ${k.padEnd(8)} ${v}`);

  head("ORPHANS: manifested 3+ days, still no AWB anywhere");
  const orphans = out.filter((r) => r.cause === "C_ORPHAN_NO_AWB_3D+");
  console.log(`   ${orphans.length} orders`);
  for (const r of orphans.slice(0, 30)) console.log(`   ${r.so}  ${String(r.store).slice(0,28).padEnd(28)} ord=${r.orderDate} age=${r.orderAgeDays}d spineOverall=${r.spineOverall || "∅"}`);

  out.sort((a, b) => String(a.cause).localeCompare(String(b.cause)) || Number(b.ageDays) - Number(a.ageDays));
  const cols = Object.keys(out[0] ?? {});
  const csv = [cols.join(","), ...out.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  writeFileSync("pendency-audit.csv", csv);
  console.log(`\nwrote pendency-audit.csv — ${out.length} rows`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
