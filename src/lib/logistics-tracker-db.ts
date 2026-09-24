// The Logistics Tracker's one read against the order data: every SO and LR on
// the page resolved to the app's live order, in one batch.

import { prisma } from "./db";
import type { LiveOrder } from "./logistics-tracker";
import type { OverallStatus, ShipmentStatus } from "./types";

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

export async function loadLiveOrders(
  sos: string[],
  lrs: string[],
): Promise<{ bySo: Map<string, LiveOrder>; byAwb: Map<string, LiveOrder> }> {
  const bySo = new Map<string, LiveOrder>();
  const byAwb = new Map<string, LiveOrder>();
  if (!sos.length && !lrs.length) return { bySo, byAwb };
  const db = prisma();
  const select = { soNumber: true, overallStatus: true, shipmentStatus: true, deliveredDate: true, trackingNumber: true, lrNumber: true } as const;
  const [orders, kids] = await Promise.all([
    db.order.findMany({ where: { OR: [{ soNumber: { in: sos } }, { trackingNumber: { in: lrs } }, { lrNumber: { in: lrs } }] }, select }),
    lrs.length ? db.orderShipment.findMany({ where: { awb: { in: lrs } }, select: { awb: true, soNumber: true } }) : [],
  ]);
  // An AWB known only at child grain points at an order the first read missed.
  const known = new Set(orders.map((o) => o.soNumber));
  const missing = [...new Set(kids.map((k) => k.soNumber).filter((s) => !known.has(s)))];
  const all = missing.length ? [...orders, ...(await db.order.findMany({ where: { soNumber: { in: missing } }, select }))] : orders;
  for (const o of all) {
    const l: LiveOrder = {
      soNumber: o.soNumber,
      overallStatus: o.overallStatus as OverallStatus,
      shipmentStatus: (o.shipmentStatus ?? undefined) as ShipmentStatus | undefined,
      deliveredDate: ymd(o.deliveredDate),
    };
    bySo.set(o.soNumber, l);
    if (o.trackingNumber) byAwb.set(o.trackingNumber, l);
    if (o.lrNumber) byAwb.set(o.lrNumber, l);
  }
  for (const k of kids) {
    const l = bySo.get(k.soNumber);
    if (l) byAwb.set(k.awb, l);
  }
  return { bySo, byAwb };
}
