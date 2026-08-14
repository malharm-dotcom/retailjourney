// Vitest ran on defaults until the Admin → Users actions needed covering: those
// live in src/app and import through the "@/" alias, which tsconfig knows about
// and a bare vitest run does not. Everything else here is the default — the
// alias is the only reason this file exists.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
