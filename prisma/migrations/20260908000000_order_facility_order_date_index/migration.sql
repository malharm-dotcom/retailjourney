-- Serves both reads on the /orders list: the 30-day default floor and a
-- date-range search, each already narrowed to one facility by the session
-- scope. NOT run by CC — apply manually.
CREATE INDEX "Order_facility_orderDate_idx" ON "Order"("facility", "orderDate");
