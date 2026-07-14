-- Snowflake distribution_analytics as the order data source (replaces the
-- abandoned UC integration): Order gains Snowflake-authoritative spine,
-- deadline and Phase-A SLA columns; OrderShipment is the new child grain
-- (one row per AWB — split dispatches stop collapsing); Source gains the
-- SYNCED_SNOWFLAKE provenance tier.

-- AlterEnum
ALTER TYPE "Source" ADD VALUE 'SYNCED_SNOWFLAKE';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "receiverCity" TEXT,
ADD COLUMN     "receiverState" TEXT,
ADD COLUMN     "receiverPostalCode" TEXT,
ADD COLUMN     "sales30d" DOUBLE PRECISION,
ADD COLUMN     "storeRank" INTEGER,
ADD COLUMN     "bestTat" INTEGER,
ADD COLUMN     "targetOrderDay" TEXT,
ADD COLUMN     "targetOrderCutoff" TEXT,
ADD COLUMN     "targetHandoverDay" TEXT,
ADD COLUMN     "targetHandoverCutoff" TEXT,
ADD COLUMN     "targetPickupDay" TEXT,
ADD COLUMN     "targetDeliveryDay" TEXT,
ADD COLUMN     "orderCutoffTs" TIMESTAMP(3),
ADD COLUMN     "handoverDeadlineTs" TIMESTAMP(3),
ADD COLUMN     "pickupTat" TIMESTAMP(3),
ADD COLUMN     "idealDeliveryDate" DATE,
ADD COLUMN     "deliveryTat" TIMESTAMP(3),
ADD COLUMN     "orderPlacementSla" TEXT,
ADD COLUMN     "handoverSla" TEXT;

-- CreateTable
CREATE TABLE "OrderShipment" (
    "id" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL,
    "awb" TEXT NOT NULL,
    "courier" TEXT,
    "isPollable" BOOLEAN NOT NULL DEFAULT false,
    "shipmentStatus" "ShipmentStatus",
    "eshipStatus" TEXT,
    "logisticsCreatedTs" TIMESTAMP(3),
    "trackingPickTs" TIMESTAMP(3),
    "deliveredTs" TIMESTAMP(3),
    "expectedDeliveryDate" DATE,
    "firstOfdTs" TIMESTAMP(3),
    "latestOfdTs" TIMESTAMP(3),
    "deliveryAttempts" INTEGER,
    "pickupAttempts" INTEGER,
    "trackingLink" TEXT,
    "trackingStatus" TEXT,
    "trackingSubStatus" TEXT,
    "trackingLatestLocation" TEXT,
    "trackingLatestMessage" TEXT,
    "lastCheckpointCity" TEXT,
    "lastCheckpointState" TEXT,
    "lastCheckpointRemark" TEXT,
    "lastCheckpointSubtag" TEXT,
    "lastCheckpointTag" TEXT,
    "podLink" TEXT,
    "packageCount" DOUBLE PRECISION,
    "pickupSla" TEXT,
    "deliverySla" TEXT,
    "logisticsDeliverySla" TEXT,
    "perfectOrderSla" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SNOWFLAKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderShipment_awb_idx" ON "OrderShipment"("awb");

-- CreateIndex
CREATE INDEX "OrderShipment_isPollable_shipmentStatus_idx" ON "OrderShipment"("isPollable", "shipmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OrderShipment_soNumber_awb_key" ON "OrderShipment"("soNumber", "awb");

-- AddForeignKey
ALTER TABLE "OrderShipment" ADD CONSTRAINT "OrderShipment_soNumber_fkey" FOREIGN KEY ("soNumber") REFERENCES "Order"("soNumber") ON DELETE CASCADE ON UPDATE CASCADE;
