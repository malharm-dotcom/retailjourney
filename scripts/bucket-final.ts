/**
 * STEP-0 READ-ONLY — definitive disjoint bucket table.
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/bucket-final.ts
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { ntzValue, querySnowflake, SPINE_TABLE } from "../src/lib/snowflake";
import { istDateOf, istToday, daysBetween } from "../src/lib/ist";
import { transitAgeDays } from "../src/lib/transit-anchor";

const today = istToday();
const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
// NULL-timestamp normalisation comes from lib/snowflake (ntzValue): Snowflake
// renders a NULL TIMESTAMP_NTZ as the literal string "NULL", which is truthy.
const head = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

interface Cp { tag?: string; subtag?: string; remark?: string }

async function main() {
  const db = prisma();
  const orders = await db.order.findMany({
    where: { overallStatus: { in: ["PICKUP_PENDING", "IN_TRANSIT", "WH_PROCESSING"] } },
    select: {
      soNumber: true, status: true, overallStatus: true, shipmentStatus: true, trackingNumber: true,
      lrNumber: true, podLink: true, checkpoints: true, trackingLatestMessage: true,
      trackingSubStatus: true, dispatchedTs: true, dispatchedDate: true, manifestedTs: true,
      orderDate: true, deliveredDate: true,
      shipments: { select: { awb: true, shipmentStatus: true, podLink: true, pickedUpTs: true, trackingPickTs: true, isPollable: true } },
    },
  });

  const list = orders.map((o) => `'${o.soNumber.replace(/'/g, "''")}'`).join(",");
  const spine = await querySnowflake<Record<string, string | null>>(
    `SELECT ORDER_NAME, TRACKING_NUMBER, STATUS, POD_LINK, LOGISTICS_DELIVERY_TIMESTAMP
     FROM ${SPINE_TABLE} WHERE ORDER_NAME IN (${list})`,
  );
  const spineBySo = new Map<string, Record<string, string | null>[]>();
  for (const r of spine) {
    const k = String(r.ORDER_NAME);
    const cur = spineBySo.get(k);
    if (cur) cur.push(r); else spineBySo.set(k, [r]);
  }

  const rows = orders.map((o) => {
    const age =
      transitAgeDays(
        { dispatchedTs: iso(o.dispatchedTs), dispatchedDate: o.dispatchedDate ? istDateOf(o.dispatchedDate) : undefined, manifestedTs: iso(o.manifestedTs) },
        o.shipments.map((c) => ({ pickedUpTs: iso(c.pickedUpTs), trackingPickTs: iso(c.trackingPickTs) })),
        today,
      ) ?? daysBetween(istDateOf(o.orderDate), today);
    const cps = ((o.checkpoints as Cp[] | null) ?? []);
    const text = [
      ...cps.map((c) => `${c.tag} ${c.subtag} ${c.remark}`),
      o.trackingLatestMessage, o.trackingSubStatus,
    ].join(" | ").toUpperCase();
    const sp = spineBySo.get(o.soNumber) ?? [];
    return {
      o, age, cps, text,
      appPod: Boolean(o.podLink) || o.shipments.some((c) => c.podLink),
      appDeliveredCp: cps.some((c) => (c.tag ?? "").toUpperCase() === "DELIVERED") || /PODDC/.test(text),
      appChildDelivered: o.shipments.some((c) => c.shipmentStatus === "DELIVERED"),
      spineDelivered: sp.some(
        (r) =>
          (ntzValue(r.STATUS) ?? "").toUpperCase() === "DELIVERED" ||
          Boolean(ntzValue(r.POD_LINK)) ||
          Boolean(ntzValue(r.LOGISTICS_DELIVERY_TIMESTAMP)),
      ),
      spineAwbUnlinked: sp.some((r) => ntzValue(r.TRACKING_NUMBER) && !o.shipments.some((c) => c.awb === r.TRACKING_NUMBER)),
      hasSpineRow: sp.length > 0,
      rto: /\bRTO\b|RETURN TO ORIGIN|RTOINITIATED/.test(text),
      rejected: /\bREJECTED\b|CANCEL|NOT PICKED|BOOKING/.test(text),
      ndr: /UNDELIVERED|\bNDR\b|CONSIGNEE|PREMISES.?CLOSED|REFUSED/.test(text),
    };
  });

  head(`APP-OPEN POPULATION: ${rows.length}  (aged >10d: ${rows.filter((r) => r.age > 10).length})`);

  // Disjoint assignment, in precedence order: POD/delivered > RTO > rejected > NDR > spine-only-delivered > residual
  const buckets = new Map<string, typeof rows>();
  const put = (k: string, r: (typeof rows)[number]) => { const a = buckets.get(k); if (a) a.push(r); else buckets.set(k, [r]); };
  for (const r of rows) {
    if (r.appPod || r.appDeliveredCp || r.appChildDelivered) put("A app-side POD/Delivered → DELIVERED", r);
    else if (r.rto) put("B RTO/return signal → RETURN", r);
    else if (r.rejected) put("C rejected/not-picked → REJECTED", r);
    else if (r.ndr) put("D failed attempts, no POD → DELIVERY_FAILED", r);
    else if (r.spineDelivered) put("F2 spine-only DELIVERED (app has no signal at all)", r);
    else if (!r.hasSpineRow) put("R2 no spine row (older than spine retention)", r);
    else put("R1 residual — app open AND spine open", r);
  }
  for (const [k, v] of [...buckets].sort()) {
    const aged = v.filter((r) => r.age > 10).length;
    console.log(`\n${k}: ${v.length}   (aged >10d: ${aged})`);
    for (const r of v.slice(0, 6)) {
      console.log(
        `   ${r.o.soNumber.padEnd(14)} age=${String(r.age).padStart(3)}d ovr=${r.o.overallStatus.padEnd(15)} ship=${(r.o.shipmentStatus ?? "∅").padEnd(15)} awb=${(r.o.trackingNumber ?? r.o.lrNumber ?? "∅").padEnd(14)} kids=[${r.o.shipments.map((c) => `${c.awb}:${c.shipmentStatus ?? "∅"}`).join(",") || "none"}] spineDelivered=${r.spineDelivered} unlinkedSpineAwb=${r.spineAwbUnlinked}`,
      );
    }
  }

  head("ORDER-LEVEL OFF-LADDER STATES STUCK ON THE BOARD");
  for (const s of ["DELIVERY_FAILED", "RETURN"] as const) {
    const xs = rows.filter((r) => r.o.shipmentStatus === s);
    const withDeliveredEvidence = xs.filter((r) => r.appPod || r.appDeliveredCp || r.appChildDelivered || r.spineDelivered);
    console.log(`order.shipmentStatus=${s}: ${xs.length} open orders; of those with delivered evidence: ${withDeliveredEvidence.length}; overallStatus values: ${[...new Set(xs.map((r) => r.o.overallStatus))].join(",")}`);
  }

  head("SPLIT ORDERS: one child delivered + one child still in flight (must STAY open)");
  const split = rows.filter(
    (r) => r.o.shipments.length > 1 && r.o.shipments.some((c) => c.shipmentStatus === "DELIVERED") && r.o.shipments.some((c) => c.shipmentStatus !== "DELIVERED" && c.shipmentStatus !== "RETURN"),
  );
  console.log(`count: ${split.length}`);
  for (const r of split.slice(0, 10)) console.log(`   ${r.o.soNumber} kids=[${r.o.shipments.map((c) => `${c.awb}:${c.shipmentStatus ?? "∅"}`).join(",")}] ship=${r.o.shipmentStatus ?? "∅"} ovr=${r.o.overallStatus}`);

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
