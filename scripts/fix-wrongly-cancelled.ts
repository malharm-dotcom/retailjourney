/**
 * Repair orders the cancellation backstop condemned for being AHEAD of the
 * spine rather than cancelled on Unicommerce.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-wrongly-cancelled.ts
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-wrongly-cancelled.ts --apply
 *
 * DRY BY DEFAULT — prints what it would change and writes nothing without
 * --apply.
 *
 * WHY THIS EXISTS: cancelledUpstream() guarded the spine's retention FLOOR but
 * not its CEILING. The UC path creates orders ahead of the spine by design, so
 * an order newer than MAX(ORDER_DATE) was absent merely because the spine had
 * not caught up — and absence was read as "cancelled on Unicommerce". Measured
 * 2026-09-18: 672 of 815 orders from the last 4 days sat CANCELLED, and 209 of
 * the previous 24h's victims were already back in the spine. Once CANCELLED,
 * reconcileCancelledUpstream's own `status: { notIn: TERMINAL_STATUSES }`
 * filter excludes them forever, so they never recover on their own.
 *
 * FINDS BY THE DEFECT, NOT A LIST: an order is repaired only when it is
 * CANCELLED, carries a backstop event saying it "left the spine", AND the
 * spine carries it RIGHT NOW. That last test is the proof the cancellation was
 * wrong — a genuinely cancelled order does not come back. Re-runnable: once
 * repaired, an order no longer matches.
 *
 * Each order is restored to the status it held before the backstop touched it
 * (the event's own fromValue), never to a guessed one.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { spineOrderDateCeiling, spinePresentOrderNames } from "../src/lib/snowflake";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = prisma();

  // 1. Every order sitting CANCELLED that the BACKSTOP cancelled. A cancellation
  //    from any other path (manual, UC status) has no such event and is left alone.
  const cancelled = await db.order.findMany({
    where: { status: "CANCELLED" },
    select: { id: true, soNumber: true, orderDate: true, facility: true, overallStatus: true },
  });
  if (!cancelled.length) {
    console.log("no CANCELLED orders at all — nothing to do");
    return;
  }

  const events = await db.orderEvent.findMany({
    where: {
      orderId: { in: cancelled.map((o) => o.id) },
      field: "status",
      toValue: "CANCELLED",
      note: { contains: "left the spine" },
    },
    select: { orderId: true, fromValue: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  // Newest backstop event per order — the one that actually set CANCELLED.
  const backstop = new Map<string, { fromValue: string | null; createdAt: Date }>();
  for (const e of events) if (!backstop.has(e.orderId)) backstop.set(e.orderId, e);

  const victims = cancelled.filter((o) => backstop.has(o.id));
  console.log(`CANCELLED orders: ${cancelled.length} — of which the backstop cancelled: ${victims.length}`);
  if (!victims.length) return;

  // 2. Two independent proofs that a cancellation was wrong. Either is enough.
  //
  //   a. The spine carries the order NOW. A genuinely cancelled order does not
  //      come back, so its presence proves it never left.
  //   b. The order is dated at or above the spine's MAX(ORDER_DATE). That is
  //      the exact condition the new ceiling guard refuses to condemn on: the
  //      spine cannot speak about a day it has not loaded yet. Without this
  //      second test the repair would miss TODAY's orders entirely — they are
  //      absent from the spine for the very reason they were wrongly cancelled,
  //      so proof (a) can never clear them until the spine catches up tomorrow.
  const [present, ceiling] = await Promise.all([
    spinePresentOrderNames(victims.map((v) => v.soNumber)),
    spineOrderDateCeiling(),
  ]);
  if (!ceiling) {
    console.log("spine MAX(ORDER_DATE) unreadable — refusing to guess. Nothing written.");
    return;
  }
  const backInSpine = (v: (typeof victims)[number]) => present.has(v.soNumber.trim().toUpperCase());
  const aboveCeiling = (v: (typeof victims)[number]) =>
    new Date(v.orderDate).toISOString().slice(0, 10) >= ceiling;
  const wrong = victims.filter((v) => backInSpine(v) || aboveCeiling(v));
  console.log(`spine MAX(ORDER_DATE) = ${ceiling}`);
  console.log(`of those, wrongly cancelled: ${wrong.length}`);
  console.log(`   back in the spine now          : ${victims.filter(backInSpine).length}`);
  console.log(`   at/above the spine ceiling     : ${victims.filter(aboveCeiling).length}\n`);
  if (!wrong.length) {
    console.log("nothing to repair — every backstop cancellation is still absent from the spine");
    return;
  }

  const byFacility = new Map<string, number>();
  for (const w of wrong) byFacility.set(w.facility, (byFacility.get(w.facility) ?? 0) + 1);
  for (const [f, n] of [...byFacility].sort((a, b) => b[1] - a[1])) console.log(`   ${f.padEnd(20)} ${n}`);

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN — pass --apply to write"}:`);
  let repaired = 0;
  for (const w of wrong) {
    const ev = backstop.get(w.id)!;
    // Restore what the order actually was before the backstop, never a guess.
    // A backstop event always records its fromValue; NOT_STARTED is the floor
    // of the WH flow and only stands in if that record is somehow blank.
    const restore = ev.fromValue ?? "NOT_STARTED";
    console.log(
      `   ${w.soNumber.padEnd(16)} ${new Date(w.orderDate).toISOString().slice(0, 10)} ` +
        `${w.facility.padEnd(18)} CANCELLED → ${restore}`,
    );
    if (!APPLY) continue;
    await db.$transaction([
      db.order.update({
        where: { id: w.id },
        data: { status: restore as never, statusSource: "SYNCED_SNOWFLAKE", cancelledTs: null },
      }),
      db.orderEvent.create({
        data: {
          orderId: w.id,
          field: "status",
          fromValue: "CANCELLED",
          toValue: restore,
          source: "SYNCED_SNOWFLAKE",
          actorId: null,
          note:
            "Reinstated — the order was never cancelled. The cancellation backstop read its absence " +
            "from the spine as a Unicommerce cancellation, but the order was newer than the spine's " +
            "MAX(ORDER_DATE) and the spine simply had not caught up. The spine carries it now.",
        },
      }),
    ]);
    repaired += 1;
  }

  console.log(
    APPLY
      ? `\nrepaired ${repaired} orders — they are back on the Warehouse board`
      : `\nwould repair ${wrong.length} orders — re-run with --apply`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma().$disconnect());
