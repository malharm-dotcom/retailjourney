/**
 * Create or update an app account, interactively.
 *
 *   RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/seed-admin.mts
 *
 * There is no public signup, so this is the only way an account comes into
 * existence. It is deliberately interactive and deliberately opt-in:
 *
 *  - the production DB guard in lib/db.ts refuses to connect without the
 *    RETAILJOURNEY_ALLOW_PROD_DB=1 claim, so running this by accident cannot
 *    touch prod;
 *  - the password is READ FROM THE TTY with echo off. It is never a CLI
 *    argument (those land in shell history and `ps`), never an env var, never
 *    logged, and never written to disk - only the bcrypt hash is persisted.
 */

import { createInterface } from "node:readline";
import { hash } from "bcryptjs";
import { prisma } from "../src/lib/db.js";
import type { Role } from "../src/lib/types.js";

const ROLES: Role[] = ["ADMIN", "MERCHANDISING", "WH_SUPERVISOR", "WH_OPERATOR", "LOGISTICS", "RETAIL_HEAD"];
const BCRYPT_ROUNDS = 12;

// Control bytes read in raw mode, built by code point so no literal control
// characters live in the source.
const ETX = String.fromCharCode(3); // Ctrl-C
const DEL = String.fromCharCode(127); // backspace key on macOS/Linux
const BS = String.fromCharCode(8); // backspace key on Windows

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

/** Prompt without echoing. Raw mode so the password never reaches the
 *  terminal, the scrollback, or anything that reads the tty buffer. */
function askSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error("stdin is not a TTY - run this interactively; the password is never taken from a pipe or argv."));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === ETX) {
          // Restore the terminal before dying, or the shell is left in raw mode.
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (c === DEL || c === BS) buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  if (process.env.RETAILJOURNEY_ALLOW_PROD_DB !== "1" && process.env.RETAILJOURNEY_DEPLOY_ENV !== "production") {
    console.log(
      "Note: RETAILJOURNEY_ALLOW_PROD_DB is not set. If DATABASE_URL points at production, lib/db.ts will refuse the connection.",
    );
  }

  const email = (await ask("Email: ")).toLowerCase();
  if (!email.includes("@")) throw new Error("A valid email is required.");

  const db = prisma();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) console.log(`Existing account: ${existing.name} (${existing.role}) - this will set a new password.`);

  const name = existing ? existing.name : await ask("Full name: ");
  if (!name) throw new Error("A name is required.");

  const roleInput = existing ? "" : (await ask(`Role [${ROLES.join(" | ")}] (default ADMIN): `)).toUpperCase();
  const role = (existing?.role ?? (roleInput || "ADMIN")) as Role;
  if (!ROLES.includes(role)) throw new Error(`Unknown role ${role}.`);

  const password = await askSecret("Password (not echoed): ");
  if (password.length < 12) throw new Error("Use at least 12 characters.");
  const again = await askSecret("Confirm password: ");
  if (password !== again) throw new Error("Passwords do not match.");

  const passwordHash = await hash(password, BCRYPT_ROUNDS);

  const user = await db.user.upsert({
    where: { email },
    // allView is what lets an admin see every facility; a fresh admin with no
    // facility list and allView=false would land on a single facility.
    create: { email, name, role, passwordHash, active: true, allView: role === "ADMIN" },
    update: { passwordHash, active: true },
  });

  console.log(`\nOK - ${user.email} (${user.role}) is active. Only the bcrypt hash was stored.`);
}

main()
  .catch((e) => {
    console.error(`\nFailed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => void prisma().$disconnect());
