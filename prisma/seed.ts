// Dev/demo seed — ports the M1 in-memory generators into Postgres.
// DESTRUCTIVE for Order/OrderEvent/RulebookEntry; Stores and Users are
// upserted (admin edits like Store.channelCode and User.active survive).
//
// The dev DATABASE_URL may point at the shared Coolify database, so this
// refuses to run without explicit confirmation:
//   SEED_CONFIRM=1 npx prisma db seed
//
// Run via tsx (configured in prisma.config.ts) — imports stay relative.

import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"] });

import { prisma } from "../src/lib/db";
import { orderToDb, ruleToDb } from "../src/lib/prisma-map";
import { seedData } from "../src/lib/seed/orders";
import { RULEBOOK } from "../src/lib/seed/rulebook";
import { STORES } from "../src/lib/seed/stores";
import { USERS } from "../src/lib/seed/users";

async function main() {
  if (process.env.SEED_CONFIRM !== "1") {
    console.error(
      "Refusing to seed: this wipes Order/OrderEvent/RulebookEntry in the target database.\n" +
        "The dev DATABASE_URL may be the shared Coolify database. Re-run with SEED_CONFIRM=1 if you mean it.",
    );
    process.exit(1);
  }

  const db = prisma();
  const { orders, events } = seedData();

  console.log("Seeding stores (upsert, channelCode preserved) ...");
  for (const s of STORES) {
    const { channelCode: _ignored, ...data } = s;
    await db.store.upsert({ where: { id: s.id }, create: data, update: data });
  }

  console.log("Seeding users (upsert, existing records untouched) ...");
  for (const u of USERS) {
    await db.user.upsert({ where: { id: u.id }, create: u, update: {} });
  }

  console.log("Replacing rulebook ...");
  await db.rulebookEntry.deleteMany();
  await db.rulebookEntry.createMany({
    data: RULEBOOK.map(ruleToDb) as never[],
  });

  console.log(`Replacing orders (${orders.length}) + events (${events.length}) ...`);
  await db.order.deleteMany(); // cascades to OrderEvent
  await db.order.createMany({ data: orders.map((o) => orderToDb(o)) as never[] });
  await db.orderEvent.createMany({
    data: events.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })),
  });

  const counts = {
    stores: await db.store.count(),
    users: await db.user.count(),
    rules: await db.rulebookEntry.count(),
    orders: await db.order.count(),
    events: await db.orderEvent.count(),
  };
  console.log("Seed complete:", counts);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
