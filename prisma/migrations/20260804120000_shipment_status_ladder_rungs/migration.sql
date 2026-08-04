-- Adds the two missing lower rungs of the shipment ladder.
--
-- Ladder: INFORECEIVED -> PICKED_UP -> IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED
--
-- Until now rung 0 was represented as a NULL shipmentStatus plus
-- OverallStatus.PICKUP_PENDING, and the eShipz "PickedUp" tag collapsed into
-- IN_TRANSIT. Both now have their own value.
--
-- Deliberately additive only. Existing IN_TRANSIT rows that were really pickups
-- are NOT reclassified — there is no backfill here and none is wanted: the
-- scan history that would tell pickup from transit is not reliably retained on
-- older rows, so a guess would corrupt the SLA pickup leg. Only new syncs
-- populate the new rungs.
--
-- BEFORE 'IN_TRANSIT' keeps the Postgres enum sort order aligned with the
-- ladder order declared in schema.prisma.

ALTER TYPE "ShipmentStatus" ADD VALUE IF NOT EXISTS 'INFORECEIVED' BEFORE 'IN_TRANSIT';
ALTER TYPE "ShipmentStatus" ADD VALUE IF NOT EXISTS 'PICKED_UP' BEFORE 'IN_TRANSIT';
