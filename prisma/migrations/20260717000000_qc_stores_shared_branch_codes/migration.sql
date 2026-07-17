-- branchCode is a physical-location code, not a row identity: a quick-commerce
-- (QC) store operates out of its parent store's premises and shares the
-- parent's branch code. Dropping uniqueness is the data model catching up with
-- reality — nothing in the app joins on branchCode.
DROP INDEX "Store_branchCode_key";

-- Quick-commerce flag: QC stores inherit their parent's TAT via the shared code.
ALTER TABLE "Store" ADD COLUMN "isQuickCommerce" BOOLEAN NOT NULL DEFAULT false;

-- Parent finalStore an order's TAT was inherited from (QC orders only).
ALTER TABLE "Order" ADD COLUMN "tatInheritedFrom" TEXT;
