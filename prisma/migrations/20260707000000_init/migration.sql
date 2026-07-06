-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('FRESH', 'RPL', 'Q_COMM', 'ACC', 'NON_TRADING', 'OTHER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NOT_STARTED', 'PICKING', 'PACKING', 'ON_HOLD', 'READY_TO_DISPATCH', 'RTS_LOGIC', 'DISPATCHED_TO_STORE', 'CANCELLED', 'UNFULFILLABLE');

-- CreateEnum
CREATE TYPE "OverallStatus" AS ENUM ('WH_PROCESSING', 'PICKUP_PENDING', 'IN_TRANSIT', 'DELIVERED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('RECEIVED', 'INWARDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('SYNCED', 'MANUAL');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MERCHANDISING', 'WH_SUPERVISOR', 'WH_OPERATOR', 'LOGISTICS', 'RETAIL_HEAD');

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL,
    "orderDate" DATE NOT NULL,
    "orderTimestamp" TIMESTAMP(3) NOT NULL,
    "facility" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeNameFormat" TEXT NOT NULL,
    "finalStore" TEXT NOT NULL,
    "ownership" TEXT,
    "state" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "type" "OrderType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "priority" TEXT,
    "campaignTag" TEXT,
    "merchandiser" TEXT,
    "areaManager" TEXT,
    "category" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "statusSource" "Source" NOT NULL DEFAULT 'MANUAL',
    "overallStatus" "OverallStatus" NOT NULL DEFAULT 'WH_PROCESSING',
    "ucStatus" TEXT,
    "createdTs" TIMESTAMP(3),
    "pickingTs" TIMESTAMP(3),
    "pickedTs" TIMESTAMP(3),
    "packedTs" TIMESTAMP(3),
    "rtsTs" TIMESTAMP(3),
    "manifestedTs" TIMESTAMP(3),
    "dispatchedTs" TIMESTAMP(3),
    "shippedTs" TIMESTAMP(3),
    "deliveredTs" TIMESTAMP(3),
    "cancelledTs" TIMESTAMP(3),
    "weightKg" DOUBLE PRECISION,
    "pickedQty" INTEGER,
    "fulfilledQty" INTEGER,
    "unfulfillableQty" INTEGER,
    "boxCount" INTEGER,
    "saleInvoiceNumber" TEXT,
    "rtsLogicDate" DATE,
    "dcNumber" TEXT,
    "lrNumber" TEXT,
    "logisticsPartner" TEXT,
    "courierPartner" TEXT,
    "vehicleNumber" TEXT,
    "eWayBill" TEXT,
    "rtdDate" DATE,
    "dispatchedDate" DATE,
    "dispatchType" TEXT,
    "laneClassification" TEXT,
    "shipmentStatus" "ShipmentStatus",
    "shipmentSource" "Source",
    "eshipStatus" TEXT,
    "trackingNumber" TEXT,
    "trackingStatus" TEXT,
    "trackingSubStatus" TEXT,
    "trackingLatestLocation" TEXT,
    "trackingLatestMessage" TEXT,
    "lastCheckpointCity" TEXT,
    "lastCheckpointState" TEXT,
    "trackingLink" TEXT,
    "podLink" TEXT,
    "expectedDate" DATE,
    "deliveredDate" DATE,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "pickupAttempts" INTEGER NOT NULL DEFAULT 0,
    "firstOfdDate" TIMESTAMP(3),
    "latestOfdDate" TIMESTAMP(3),
    "newLrNo" TEXT,
    "logisticsComments" TEXT,
    "checkpoints" JSONB,
    "receiptStatus" "ReceiptStatus",
    "orderReceivedDate" DATE,
    "boxesReceived" INTEGER,
    "totalCount" INTEGER,
    "inwardedDate" DATE,
    "stiBillNo" TEXT,
    "receivingPv" TEXT,
    "shortageQty" INTEGER,
    "excessQty" INTEGER,
    "shortageExcessFileUrl" TEXT,
    "adjustmentOnLogic" BOOLEAN,
    "entryStatus" "EntryStatus",
    "manualFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "finalStore" TEXT NOT NULL,
    "ownership" TEXT,
    "channel" TEXT NOT NULL,
    "storeCity" TEXT,
    "storeState" TEXT,
    "zone" TEXT,
    "facility" TEXT NOT NULL,
    "areaManager" TEXT,
    "merchandiser" TEXT,
    "rank" INTEGER,
    "sales30d" DOUBLE PRECISION,
    "channelCode" TEXT,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RulebookEntry" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "laneClassification" TEXT,
    "zone" TEXT,
    "bestTatDays" INTEGER,
    "targetOrderDay" TEXT,
    "targetOrderCutoff" TEXT,
    "targetHandoverDay" TEXT,
    "targetHandoverCutoff" TEXT,
    "targetPickupDay" TEXT,
    "targetDeliveryDay" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,

    CONSTRAINT "RulebookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "facilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allView" BOOLEAN NOT NULL DEFAULT false,
    "areaManager" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "rowsFetched" INTEGER NOT NULL DEFAULT 0,
    "rowsUpserted" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "note" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedChannel" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "sampleSoNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "UnmatchedChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_soNumber_key" ON "Order"("soNumber");

-- CreateIndex
CREATE INDEX "Order_facility_overallStatus_idx" ON "Order"("facility", "overallStatus");

-- CreateIndex
CREATE INDEX "Order_shipmentStatus_idx" ON "Order"("shipmentStatus");

-- CreateIndex
CREATE INDEX "Order_areaManager_idx" ON "Order"("areaManager");

-- CreateIndex
CREATE INDEX "Order_storeId_orderDate_idx" ON "Order"("storeId", "orderDate");

-- CreateIndex
CREATE INDEX "Order_lrNumber_idx" ON "Order"("lrNumber");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Store_branchCode_key" ON "Store"("branchCode");

-- CreateIndex
CREATE UNIQUE INDEX "Store_channelCode_key" ON "Store"("channelCode");

-- CreateIndex
CREATE INDEX "RulebookEntry_storeId_orderType_effectiveFrom_idx" ON "RulebookEntry"("storeId", "orderType", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "SyncRun_source_startedAt_idx" ON "SyncRun"("source", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedChannel_channel_key" ON "UnmatchedChannel"("channel");

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
