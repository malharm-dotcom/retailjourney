-- Adds the VIEWER role: the landing state for a self-provisioned @snitch.com
-- Google sign-in — read-only across every facility until an admin assigns a
-- real role. Append-only by necessity: ALTER TYPE ADD VALUE cannot insert.
ALTER TYPE "Role" ADD VALUE 'VIEWER';
