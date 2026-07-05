// Extracts only the Solar icons actually referenced in src/ into a small JSON
// subset, so the client bundle doesn't ship the whole ~2 MB collection.
// Runs automatically via `prebuild`; run manually after adding a new icon.

import { promises as fs } from "node:fs";
import path from "node:path";
import { icons as solar } from "@iconify-json/solar";
import { getIcons } from "@iconify/utils";

const SRC = path.resolve("src");
const OUT = path.resolve("src/generated/icons.json");

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield p;
    }
  }
}

const known = new Set([...Object.keys(solar.icons), ...Object.keys(solar.aliases ?? {})]);
const used = new Set();

for await (const file of walk(SRC)) {
  const text = await fs.readFile(file, "utf8");
  for (const m of text.matchAll(/["'`]([a-z0-9]+(?:-[a-z0-9]+)+)["'`]/g)) {
    if (known.has(m[1])) used.add(m[1]);
  }
}

const subset = getIcons(solar, [...used].sort());
if (!subset) throw new Error("Failed to build icon subset");
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(subset), "utf8");
console.log(`icons.json: ${used.size} icons, ${(JSON.stringify(subset).length / 1024).toFixed(1)} KB`);
