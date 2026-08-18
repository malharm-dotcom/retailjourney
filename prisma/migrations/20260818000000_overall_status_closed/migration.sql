-- AlterEnum
-- Off-ladder terminal for dead labels (RTO'd / failed-and-not-re-attempted), so
-- they leave the open population instead of ageing forever as "In Transit".
-- Additive only: appends a value, rewrites no rows, and no existing row uses it
-- until the app writes one.
ALTER TYPE "OverallStatus" ADD VALUE 'CLOSED';
