-- Logistics Tracker: the B2B logistics team's dispatch log (was the
-- "B2B Forward Outstation" sheet). Additive only: a new table, no existing
-- row is touched.
-- CreateTable
CREATE TABLE "LogisticsEntry" (
    "id" TEXT NOT NULL,
    "dispatchDate" DATE NOT NULL,
    "dcNumber" TEXT,
    "lrNumber" TEXT,
    "quantity" INTEGER,
    "boxes" INTEGER,
    "storeName" TEXT NOT NULL,
    "storeCity" TEXT,
    "storeState" TEXT,
    "expectedDate" DATE,
    "orderType" TEXT,
    "dispatchType" TEXT,
    "shipmentStatus" TEXT,
    "deliveredDate" DATE,
    "orderPlacedDate" DATE,
    "soNumber" TEXT,
    "facility" TEXT,
    "allocationType" TEXT,
    "courierPartner" TEXT,
    "remarks" TEXT,
    "createdByName" TEXT NOT NULL,
    "updatedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogisticsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LogisticsEntry_dispatchDate_idx" ON "LogisticsEntry"("dispatchDate");

-- CreateIndex
CREATE INDEX "LogisticsEntry_soNumber_idx" ON "LogisticsEntry"("soNumber");

-- CreateIndex
CREATE INDEX "LogisticsEntry_lrNumber_idx" ON "LogisticsEntry"("lrNumber");
