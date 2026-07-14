// One-off: find which Snowflake deployment hosts locator XP62486 by real
// JWT login. Delete after the account identifier is confirmed.
import { config as loadEnv } from "dotenv";
loadEnv({ path: [".env.local", ".env"] });

import { querySnowflake } from "../src/lib/snowflake";

const CANDIDATES = [
  "XP62486.ap-south-1.aws",
  "XP62486.ap-southeast-1",
  "XP62486.ap-southeast-2",
  "XP62486.ap-northeast-1.aws",
  "XP62486.us-east-1",
  "XP62486.us-east-2.aws",
  "XP62486",
  "XP62486.eu-west-1",
  "XP62486.eu-central-1",
  "XP62486.central-india.azure",
  "XP62486.southeast-asia.azure",
  "XP62486.east-us-2.azure",
  "XP62486.us-central1.gcp",
];

async function main() {
  for (const account of CANDIDATES) {
    process.env.SNOWFLAKE_ACCOUNT = account;
    const t0 = Date.now();
    try {
      const rows = await querySnowflake<{ R: number }>("SELECT 1 AS R");
      console.log(`SUCCESS: ${account} (${Date.now() - t0}ms, rows=${rows.length})`);
      return;
    } catch (e) {
      console.log(`fail: ${account} — ${e instanceof Error ? e.message : e} (${Date.now() - t0}ms)`);
    }
  }
  console.log("no candidate worked");
}

main();
