// Baseline bootstrap — makes a freshly migrated database usable without the
// destructive dev seed: reference Stores/Users are upserted (admin edits like
// Store.channelCode and User.active survive) and the rulebook is filled only
// when empty. Orders are NEVER touched. Idempotent; runs on every boot.

import { databaseConfigured, prisma } from "./db";
import { ruleToDb } from "./prisma-map";
import { RULEBOOK } from "./seed/rulebook";
import { STORES } from "./seed/stores";
import { USERS } from "./seed/users";

export async function ensureBaseline(): Promise<void> {
  if (!databaseConfigured()) return;
  const db = prisma();

  for (const s of STORES) {
    const { channelCode: _ignored, ...data } = s;
    await db.store.upsert({ where: { id: s.id }, create: data, update: data });
  }

  for (const u of USERS) {
    await db.user.upsert({ where: { id: u.id }, create: u, update: {} });
  }

  if ((await db.rulebookEntry.count()) === 0) {
    await db.rulebookEntry.createMany({ data: RULEBOOK.map(ruleToDb) as never[] });
  }
}
