/**
 * STEP-0 READ-ONLY DIAGNOSTIC — shipment-tracking correctness investigation.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/tracking-diagnostics.ts
 *
 * SELECTs only. No writes, no schema touches, no eShipz calls. Prints per-bucket
 * counts and sample AWBs/SOs so the misclassification population can be sized
 * before any code or data changes. Throwaway instrument — not part of the app.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { istDateOf, istToday, daysBetween } from "../src/lib/ist";
import { transitAgeDays } from "../src/lib/transit-anchor";

const today = istToday();
const iso = (d: Date | null): string | undefined => (d ? d.toISOString() : undefined);
const S = (v: unknown) => (v == null ? "" : String(v)).toUpperCase();

interface Cp { tag?: string; subtag?: string; remark?: string; date?: string }

function sample<T>(xs: T[], n = 8): T[] {
  return xs.slice(0, n);
}

function head(t: string) {
  console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
}

async function main() {
  const db = prisma();

  const orders = await db.order.findMany({
    select: {
      soNumber: true, status: true, overallStatus: true, shipmentStatus: true,
      shipmentSource: true, trackingNumber: true, lrNumber: true,
      logisticsPartner: true, courierPartner: true, podLink: true,
      eshipStatus: true, trackingStatus: true, trackingSubStatus: true,
      trackingLatestMessage: true, checkpoints: true,
      deliveredTs: true, deliveredDate: true, deliveryAttempts: true,
      dispatchedTs: true, dispatchedDate: true, manifestedTs: true,
      orderDate: true, manualFields: true,
      shipments: {
        select: {
          awb: true, isPollable: true, shipmentStatus: true, eshipStatus: true,
          podLink: true, trackingStatus: true, trackingSubStatus: true,
          lastCheckpointTag: true, lastCheckpointSubtag: true, lastCheckpointRemark: true,
          trackingLatestMessage: true, deliveredTs: true, trackingPickTs: true,
          pickedUpTs: true, courier: true, deliveryAttempts: true, pickupAttempts: true,
        },
      },
    },
  });

  head(`POPULATION — ${orders.length} orders in the app database`);
  const byOverall = new Map<string, number>();
  for (const o of orders) byOverall.set(o.overallStatus, (byOverall.get(o.overallStatus) ?? 0) + 1);
  console.log("overallStatus:", [...byOverall].map(([k, v]) => `${k}=${v}`).join("  "));
  const byShip = new Map<string, number>();
  for (const o of orders) byShip.set(o.shipmentStatus ?? "∅", (byShip.get(o.shipmentStatus ?? "∅") ?? 0) + 1);
  console.log("order.shipmentStatus:", [...byShip].map(([k, v]) => `${k}=${v}`).join("  "));
  const childShip = new Map<string, number>();
  for (const o of orders) for (const c of o.shipments) childShip.set(c.shipmentStatus ?? "∅", (childShip.get(c.shipmentStatus ?? "∅") ?? 0) + 1);
  console.log("child.shipmentStatus:", [...childShip].map(([k, v]) => `${k}=${v}`).join("  "));

  // ---- raw-persistence census -------------------------------------------
  head("RAW PERSISTENCE — what is actually stored per order/shipment");
  const withCp = orders.filter((o) => Array.isArray(o.checkpoints) && (o.checkpoints as unknown[]).length > 0);
  console.log(`orders with a persisted checkpoints[] array : ${withCp.length}/${orders.length}`);
  const cpTagged = withCp.filter((o) => (o.checkpoints as Cp[]).some((c) => c.tag));
  console.log(`  ... of those, carrying tag on ≥1 checkpoint: ${cpTagged.length}`);
  console.log(`orders with order.podLink                    : ${orders.filter((o) => o.podLink).length}`);
  console.log(`children with child.podLink                  : ${orders.flatMap((o) => o.shipments).filter((c) => c.podLink).length}`);
  const eshipVals = new Map<string, number>();
  for (const o of orders) for (const c of o.shipments) if (c.eshipStatus) eshipVals.set(c.eshipStatus, (eshipVals.get(c.eshipStatus) ?? 0) + 1);
  console.log("child.eshipStatus values:", [...eshipVals].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));
  const oEship = new Map<string, number>();
  for (const o of orders) if (o.eshipStatus) oEship.set(o.eshipStatus, (oEship.get(o.eshipStatus) ?? 0) + 1);
  console.log("order.eshipStatus values:", [...oEship].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));
  const subtags = new Map<string, number>();
  for (const o of orders) for (const c of (o.checkpoints as Cp[] | null) ?? []) if (c.subtag) subtags.set(c.subtag, (subtags.get(c.subtag) ?? 0) + 1);
  console.log("checkpoint subtags (top 30):", [...subtags].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}=${v}`).join("  "));

  // ---- open population with age -----------------------------------------
  const OPEN = new Set(["PICKUP_PENDING", "IN_TRANSIT"]);
  const rows = orders.map((o) => {
    const ships = o.shipments.map((c) => ({
      pickedUpTs: iso(c.pickedUpTs),
      trackingPickTs: iso(c.trackingPickTs),
    }));
    const age = transitAgeDays(
      { dispatchedTs: iso(o.dispatchedTs), dispatchedDate: o.dispatchedDate ? istDateOf(o.dispatchedDate) : undefined, manifestedTs: iso(o.manifestedTs) },
      ships,
      o.deliveredDate ? istDateOf(o.deliveredDate) : today,
    );
    const cps = ((o.checkpoints as Cp[] | null) ?? []);
    const cpText = cps.map((c) => `${S(c.tag)} ${S(c.subtag)} ${S(c.remark)}`).join(" | ");
    const childText = o.shipments
      .map((c) => `${S(c.shipmentStatus)} ${S(c.eshipStatus)} ${S(c.lastCheckpointTag)} ${S(c.lastCheckpointSubtag)} ${S(c.lastCheckpointRemark)} ${S(c.trackingLatestMessage)}`)
      .join(" | ");
    const all = `${cpText} | ${childText} | ${S(o.trackingStatus)} ${S(o.trackingSubStatus)} ${S(o.trackingLatestMessage)} ${S(o.eshipStatus)}`;
    return {
      o,
      age: age ?? (o.orderDate ? daysBetween(istDateOf(o.orderDate), today) : 0),
      hasAnchor: age !== undefined,
      cps,
      cpText,
      all,
      pod: Boolean(o.podLink) || o.shipments.some((c) => c.podLink),
      deliveredCp: cps.some((c) => S(c.tag) === "DELIVERED") || /\bPODDC\b/.test(all) || /\bDELIVERED\b/.test(cpText),
      childDelivered: o.shipments.some((c) => c.shipmentStatus === "DELIVERED"),
      childReturn: o.shipments.some((c) => c.shipmentStatus === "RETURN"),
      rto: /\bRTO\b|RETURN TO ORIGIN|INSTRUCTED TO RTO|\bRTS\b.*RETURN|RETURNED TO/.test(all),
      cancelled: /CANCEL|BOOKING.?REJECT|REJECTED|NOT PICKED/.test(all),
      ndr: /UNDELIVERED|\bNDR\b|DELIVERY.?FAIL|ATTEMPT.?FAIL|CONSIGNEE|REFUSED|PREMISES.?CLOSED/.test(all),
    };
  });

  const open = rows.filter((r) => OPEN.has(r.o.overallStatus));
  const openAged = open.filter((r) => r.age > 10);
  head(`FAMILY 1 — open (PICKUP_PENDING/IN_TRANSIT) = ${open.length}; of those age >10d = ${openAged.length}`);
  console.log(`  (no transit anchor at all: ${open.filter((r) => !r.hasAnchor).length} — age fell back to order age)`);

  const A = openAged.filter((r) => r.pod || r.deliveredCp || r.childDelivered);
  const B = openAged.filter((r) => !A.includes(r) && (r.rto || r.childReturn));
  const C = openAged.filter((r) => !A.includes(r) && !B.includes(r) && r.cancelled);
  const D = openAged.filter((r) => !A.includes(r) && !B.includes(r) && !C.includes(r) && r.ndr);
  const E = rows.filter((r) => r.o.shipmentStatus === "DELIVERED" && r.o.overallStatus !== "DELIVERED");
  const RESIDUAL = openAged.filter((r) => ![...A, ...B, ...C, ...D].includes(r));

  const show = (label: string, xs: typeof rows) => {
    console.log(`\n${label}: ${xs.length}`);
    for (const r of sample(xs)) {
      console.log(
        `   ${r.o.soNumber.padEnd(14)} age=${String(r.age).padStart(3)}d ovr=${r.o.overallStatus.padEnd(15)} ship=${(r.o.shipmentStatus ?? "∅").padEnd(15)} awb=${(r.o.trackingNumber ?? r.o.lrNumber ?? "∅").padEnd(14)} kids=[${r.o.shipments.map((c) => `${c.awb}:${c.shipmentStatus ?? "∅"}:${c.eshipStatus ?? "∅"}${c.podLink ? ":POD" : ""}`).join(", ")}]`,
      );
      console.log(`      msg="${(r.o.trackingLatestMessage ?? "").slice(0, 90)}" cp0="${r.cps[0] ? `${r.cps[0].tag}/${r.cps[0].subtag}/${(r.cps[0].remark ?? "").slice(0, 60)}` : "∅"}"`);
    }
  };

  show("(A) POD or Delivered checkpoint present, still open  → DELIVERED", A);
  show("(B) RTO / return signal, still open                   → RETURN", B);
  show("(C) cancelled / booking-rejected, still open          → REJECTED", C);
  show("(D) failed attempts, no POD/delivered, still open     → DELIVERY_FAILED", D);
  show("(E) order.shipmentStatus=DELIVERED but overall != DELIVERED", E);
  show("(6) RESIDUAL — aged >10d with NO definitive terminal signal (do NOT touch)", RESIDUAL);

  // ---- Family 2: spine-vs-app divergence, from the app side --------------
  head("FAMILY 2 — app open but a CHILD (spine-sourced) row is terminal");
  const fam2 = rows.filter(
    (r) =>
      (OPEN.has(r.o.overallStatus) || r.o.overallStatus === "WH_PROCESSING") &&
      r.o.shipmentStatus !== "DELIVERED" &&
      r.o.shipments.some((c) => c.shipmentStatus === "DELIVERED" || c.shipmentStatus === "RETURN" || S(c.eshipStatus) === "DELIVERED"),
  );
  console.log(`count: ${fam2.length}`);
  for (const r of sample(fam2, 15)) {
    console.log(
      `   ${r.o.soNumber.padEnd(14)} age=${String(r.age).padStart(3)}d ovr=${r.o.overallStatus.padEnd(15)} ship=${(r.o.shipmentStatus ?? "∅").padEnd(12)} order.awb=${(r.o.trackingNumber ?? "∅").padEnd(14)} lr=${(r.o.lrNumber ?? "∅").padEnd(12)} kids=[${r.o.shipments.map((c) => `${c.awb}:${c.shipmentStatus ?? "∅"}:pollable=${c.isPollable}`).join(", ")}]`,
    );
  }
  const awbMismatch = rows.filter(
    (r) => r.o.shipments.length > 0 && r.o.trackingNumber && !r.o.shipments.some((c) => c.awb === r.o.trackingNumber),
  );
  console.log(`\norders whose order.trackingNumber matches NO child AWB: ${awbMismatch.length}`);
  for (const r of sample(awbMismatch)) console.log(`   ${r.o.soNumber} order.awb=${r.o.trackingNumber} kids=${r.o.shipments.map((c) => c.awb).join(",")}`);
  const noAwbButChild = rows.filter((r) => !r.o.trackingNumber && r.o.shipments.length > 0);
  console.log(`orders with children but NULL order.trackingNumber: ${noAwbButChild.length}`);
  for (const r of sample(noAwbButChild)) console.log(`   ${r.o.soNumber} lr=${r.o.lrNumber ?? "∅"} kids=${r.o.shipments.map((c) => `${c.awb}:${c.shipmentStatus ?? "∅"}`).join(",")}`);

  // ---- named specimens ---------------------------------------------------
  head("NAMED SPECIMENS from the brief");
  for (const so of ["ANSAPL16017"]) {
    const r = rows.find((x) => x.o.soNumber === so);
    if (!r) { console.log(`${so}: NOT PRESENT in the app database`); continue; }
    console.log(`${so}: status=${r.o.status} overall=${r.o.overallStatus} shipmentStatus=${r.o.shipmentStatus ?? "∅"} src=${r.o.shipmentSource ?? "∅"}`);
    console.log(`   order.trackingNumber=${r.o.trackingNumber ?? "∅"} lrNumber=${r.o.lrNumber ?? "∅"} partner=${r.o.logisticsPartner ?? "∅"} courier=${r.o.courierPartner ?? "∅"}`);
    console.log(`   podLink=${r.o.podLink ?? "∅"} eshipStatus=${r.o.eshipStatus ?? "∅"} trackingStatus=${r.o.trackingStatus ?? "∅"}/${r.o.trackingSubStatus ?? "∅"} msg=${r.o.trackingLatestMessage ?? "∅"}`);
    console.log(`   manifestedTs=${iso(r.o.manifestedTs) ?? "∅"} dispatchedTs=${iso(r.o.dispatchedTs) ?? "∅"} age=${r.age}d anchored=${r.hasAnchor}`);
    console.log(`   checkpoints persisted: ${r.cps.length}`);
    for (const c of r.o.shipments) console.log(`   child ${c.awb}: status=${c.shipmentStatus ?? "∅"} eship=${c.eshipStatus ?? "∅"} pollable=${c.isPollable} courier=${c.courier ?? "∅"} pick=${iso(c.trackingPickTs) ?? "∅"} pickedUp=${iso(c.pickedUpTs) ?? "∅"} delivered=${iso(c.deliveredTs) ?? "∅"} pod=${c.podLink ?? "∅"}`);
    const evs = await db.orderEvent.findMany({
      where: { order: { soNumber: so } }, orderBy: { createdAt: "asc" }, take: 60,
      select: { field: true, fromValue: true, toValue: true, source: true, note: true, createdAt: true },
    });
    console.log(`   events (${evs.length}):`);
    for (const e of evs) console.log(`     ${e.createdAt.toISOString()} ${e.source} ${e.field}: ${e.fromValue ?? "∅"} → ${e.toValue} ${e.note ? `(${e.note})` : ""}`);
  }
  for (const awb of ["90641740", "90642894"]) {
    const kids = await db.orderShipment.findMany({ where: { awb } });
    const parents = await db.order.findMany({ where: { OR: [{ trackingNumber: awb }, { lrNumber: awb }] }, select: { soNumber: true, overallStatus: true, shipmentStatus: true, eshipStatus: true, trackingStatus: true, trackingSubStatus: true, podLink: true, trackingLatestMessage: true } });
    console.log(`\nAWB ${awb}: ${kids.length} child row(s), ${parents.length} order(s) holding it order-level`);
    for (const k of kids) console.log(`   child so=${k.soNumber} status=${k.shipmentStatus ?? "∅"} eship=${k.eshipStatus ?? "∅"} pollable=${k.isPollable} courier=${k.courier ?? "∅"} pod=${k.podLink ?? "∅"} msg=${k.trackingLatestMessage ?? "∅"}`);
    for (const p of parents) console.log(`   order ${p.soNumber} overall=${p.overallStatus} ship=${p.shipmentStatus ?? "∅"} eship=${p.eshipStatus ?? "∅"} track=${p.trackingStatus ?? "∅"}/${p.trackingSubStatus ?? "∅"} pod=${p.podLink ?? "∅"}`);
  }

  // ---- sync health -------------------------------------------------------
  head("SYNC HEALTH / WATERMARK");
  const runs = await db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 12 });
  for (const r of runs) {
    console.log(`   ${r.startedAt.toISOString()} ${r.source.padEnd(15)} ok=${r.ok} fetched=${r.rowsFetched} upserted=${r.rowsUpserted} conflicts=${r.conflicts} wm=${r.watermark ?? "∅"} err=${r.errors ? JSON.stringify(r.errors).slice(0, 160) : "∅"}`);
  }
  const enums = await db.$queryRawUnsafe<{ enumlabel: string }[]>(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ShipmentStatus' ORDER BY e.enumsortorder`,
  );
  console.log(`\nlive ShipmentStatus enum members: ${enums.map((e) => e.enumlabel).join(", ")}`);
  const migs = await db.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null }[]>(
    `SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 6`,
  );
  console.log("last migrations:", migs.map((m) => `${m.migration_name}${m.finished_at ? "" : " (UNFINISHED)"}`).join(" | "));

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
