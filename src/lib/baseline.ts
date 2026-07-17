// Baseline bootstrap — makes a freshly migrated database usable without the
// destructive dev seed: reference Stores/Users are upserted (admin edits like
// Store.channelCode and User.active survive). Orders are NEVER touched, and the
// rulebook is no longer seeded — the Rulebook tab reads live from Snowflake and
// the RulebookEntry table stays dormant. Idempotent; runs on every boot.

import { databaseConfigured, prisma } from "./db";
import { STORES } from "./seed/stores";
import { USERS } from "./seed/users";

export async function ensureBaseline(): Promise<void> {
  if (!databaseConfigured()) return;
  const db = prisma();

  for (const s of STORES) {
    const { channelCode: _ignored, ...data } = s;
    // branchCode is excluded from the update: real branch codes loaded from
    // the store-branch-codes file must survive the boot upsert (the seed's
    // synthetic SN1xx values are create-time placeholders only).
    const { branchCode: _seedCode, ...update } = data;
    await db.store.upsert({ where: { id: s.id }, create: data, update });
  }

  for (const u of USERS) {
    await db.user.upsert({ where: { id: u.id }, create: u, update: {} });
  }
}
