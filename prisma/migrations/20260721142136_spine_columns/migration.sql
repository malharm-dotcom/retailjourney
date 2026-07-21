-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryTargetEdd" TIMESTAMP(3),
ADD COLUMN     "exShort" INTEGER,
ADD COLUMN     "rulebookCovered" BOOLEAN,
ADD COLUMN     "stiQty" INTEGER,
ADD COLUMN     "storeChannel" TEXT;

-- AlterTable
ALTER TABLE "OrderShipment" ADD COLUMN     "shipmentBill" TEXT;
