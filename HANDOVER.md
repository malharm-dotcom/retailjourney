# RetailJourney — Session Handover

> First instruction to a fresh session: **"Read PRD.md and HANDOVER.md in full before doing anything."**
> PRD.md is the product spec (source of truth for intent). This doc is the *current operational state* —
> what is built, what is deployed, and what an operator must do next.
>
> **Last updated:** 2026-07-22, after the RETAIL_JOURNEY_SPINE reader repoint + the INWARDED enum fix.

---

## 1. Identity & coordinates

| | |
|---|---|
| **Product** | RetailJourney (formerly "Relay") — Snitch B2B retail distribution tracker |
| **Repo** | `github.com/malharm-dotcom/retailjourney` (private) · branch `main` |
| **Local path** | `C:\Malhar\retail_flow` (Windows, PowerShell) |
| **Server** | Coolify, bare IP `168.144.81.147`, Nixpacks. **Runs a BUILT IMAGE — manual redeploy only.** |
| **Owner** | Malhar M · process owner Maddy (Mahadevan Pillai) |
| **Spec** | `PRD.md` in repo root. Design prototype `relay-in-transit-v2.html` kept as an artifact. |
| **Push/deploy policy** | Pushing to `main` is fine on request. **Never trigger a deploy** — it is a manual Coolify redeploy. Every arc ends with a redeploy reminder, not an action. |

## 2. Where we are — DB-backed, authenticated, live Snowflake spine

The app is **past the M1 prototype**. It is now a persistence-backed product: Prisma 7 + `@prisma/adapter-pg` +
PostgreSQL, real password auth, and a live Snowflake reader feeding the order spine. The in-memory seed repo
still exists but is only the **fallback when `DATABASE_URL` is unset** (local dev without a DB).

### What is real now (built + committed on `main`)
- **Database (Prisma/Postgres).** `PrismaRepo` behind the `OrderRepo` interface; `repo.ts` selects Prisma when
  `DATABASE_URL` is set, else the in-memory seed. Domain⇄row mapping in `prisma-map.ts`. Migrations apply on
  boot via `scripts/start.mjs` (`prisma migrate deploy`).
- **Auth = real sign-in + RBAC** (commit `482c203`). Email + password (bcrypt) credentials provider,
  server-side session, middleware redirect to `/login`, per-action RBAC re-checks. **The old passwordless
  "persona" bypass is GONE** — it authenticated on a user id alone. No self-signup; accounts are created by
  `scripts/seed-admin.mts` (TTY-only, echo off, only the bcrypt hash is stored). `NEXTAUTH_SECRET` is mandatory
  in a deployed environment (the app refuses to sign sessions with the dev fallback).
- **Order spine = Snowflake `RETAIL_JOURNEY_SPINE`** (commits `d71979a`, `b2d02fe`, `c10cd3a`, `6f35ed2`).
  Repointed from the older `distribution_analytics`, which *gated out* any order the rulebook did not cover.
  The spine keeps those orders visible, flagged `rulebookCovered = false` and running on a fallback delivery
  target (eShipz EDD). Hourly in-app reader; grain is order + shipment_bill + AWB child.
- **Transit = eShipz** — 15-min poller (`isPollable` AWBs) + real-time webhook. Unchanged this arc.
- **Read precedence: manual override > eShipz poller > Snowflake (base).** Snowflake is the sole transit
  authority only for non-pollable pseudo-AWBs (self-delivery/porter `^SN\d+$`). Pinned by
  `sync-precedence.test.ts` (10 tests) — **do not alter this chain.**
- **Sync observability** (commit `64fd58c`). Scheduler boot logs its env-gate verdict; a `SCHEDULER` boot
  marker row proves the timers armed; every tick failure (incl. skipped/unconfigured) persists a **failed**
  `SyncRun` so the freshness strip goes red instead of drifting silently stale.
- **All 8 screens** from PRD §6 wired to live data: Control Tower, In-Transit board, Warehouse kanban,
  Logistics, Order Journey, Rulebook (live Snowflake view), Reports (+CSV), Admin (sync-health + unmatched-
  channel review queue).
- **Warehouse board + motion** (commits `6f84b38`, `9b1962c`): fixed-width horizontally-scrolling lanes,
  optimistic status advance, skeleton loaders, route transitions, and a real `prefers-reduced-motion` floor.
- **Out-of-rulebook badge** on the warehouse card (neutral pending token `#9A9080`, not breach red).

### Confirmed design decisions (don't re-litigate)
- Design source of truth = the v2 prototype. Bricolage Grotesque (display) + Hanken Grotesk (UI); Solar duotone
  icons (subset at build time); cream `#F1EEE6` / ink `#232019` / sage `#3E5D4C`; status transit `#4C7A99` ·
  OFD `#B67F2E` · delivered `#3E7A5C` · breach `#BE5340` · pending `#9A9080`. Tokens in `tailwind.config.ts`.
- `channelCode` is a **secondary store-matcher key** (not UC-source code) — kept, load-bearing on the Snowflake
  sweep. Do not remove or weaken it.
- `OverallStatus` has a 5th terminal stage **`INWARDED`** (store has booked stock in). It arrives ONLY from the
  spine's raw `OVERALL_STATUS` via the childless-order seed path; `rollupOverall` never emits it, so no
  delivered order is reclassified.

## 3. Architecture map (key files)

```
src/lib/
  types.ts          Domain types (OverallStatus incl. INWARDED, StoreChannel, spine fields)
  ist.ts            IST time math + Snowflake NTZ→ISO conversions. ALL time logic lives here.
  journey.ts        State machine: WH transitions, rollupOverall, required captures, labels
  sla.ts            Rulebook target derivation + per-leg SLA verdicts (advisory, never blocks)
  rbac.ts           Role→permissions + facility entitlements. Asserted server-side everywhere.
  db.ts             Prisma singleton + PROD-DB guard (RETAILJOURNEY_DEPLOY_ENV / ALLOW_PROD_DB)
  repo.ts           OrderRepo selection: PrismaRepo when DATABASE_URL set, else in-memory seed
  repo-prisma.ts    PrismaRepo implementation
  prisma-map.ts     Domain⇄Prisma row mapping (TS/DATE field sets)
  users.ts          User lookups + findPasswordHash (hash kept OUT of the domain User type)
  auth.ts           *** THE single auth module *** credentials provider; Google-SSO swap is one file
  session.ts        requireSession() → validated {user, scope}
  snowflake.ts      *** Spine reader *** SPINE_TABLE, SPINE_QUERY, DistributionRow, SPINE_PENDING_COLUMNS
  distribution-map.ts  Spine row → Order(parent)+OrderShipment(children). pickParentRow, normOverallStatus
  ui.ts / reports.ts   Status→presentation; 8 report builders
  integrations/
    sync.ts         *** Sync orchestration *** runSnowflakeSync, precedence, applySyncPatch, SyncRun writers
    eshipz-source.ts / eshipz-map.ts   eShipz poller + webhook + tag normalizer (the ONE status vocabulary)

src/app/
  actions.ts              Single mutation gateway ("use server"): RBAC → validate → repo → OrderEvent
  middleware.ts           Redirects unauthenticated traffic to /login (coarse net; actions re-check)
  instrumentation.ts / instrumentation-node.ts   Boot + the two sync schedulers (env-gated)
  login/                  page.tsx + login-panel.tsx (real email+password form)
  (app)/                  Route group behind auth — one folder per screen, each with a loading.tsx skeleton
    warehouse/kanban.tsx  The board (lanes, optimistic advance, out-of-rulebook badge)

scripts/
  start.mjs               Prod entrypoint: migrate deploy → next start, with boot preflight warnings
  seed-admin.mts          *** Create/update an account *** TTY-only password, only the hash is stored
  snowflake-dryrun.ts     Spine reader diagnostic (shape/vocabulary summaries, no bulk dump)
  gen-icons.mjs           Build-time Solar icon subset
```

## 4. Deployment state & the operator runbook

**Everything below is committed and pushed. Nothing has been deployed by the assistant — deploys are manual.**

### Migrations created but NOT yet applied to the deployed DB
`start.mjs` runs `prisma migrate deploy` on boot, so a redeploy applies these automatically, in order:
- `20260721060410_user_password_credentials` — adds `User.passwordHash`, `User.createdAt`
- `20260721142136_spine_columns` — adds `Order.storeChannel/rulebookCovered/deliveryTargetEdd/stiQty/exShort`,
  `OrderShipment.shipmentBill` (all additive, nullable)
- `20260722103257_overall_status_inwarded` — `ALTER TYPE "OverallStatus" ADD VALUE 'INWARDED'`

To apply by hand instead (Coolify Terminal): `RETAILJOURNEY_ALLOW_PROD_DB=1 npx prisma migrate deploy`.
⚠ `ALTER TYPE … ADD VALUE` cannot run inside a transaction on older Postgres. PG 12+ handles it; if it errors,
run the one line via `psql` then `npx prisma migrate resolve --applied 20260722103257_overall_status_inwarded`.

### Coolify environment — required BEFORE the next redeploy
| Var | Why |
|---|---|
| `RETAILJOURNEY_DEPLOY_ENV=production` | **The sync scheduler is gated on this.** Without it `bootNode()` returns early and NEITHER poller runs — this was the 3-day silent-stall incident (root cause in `64fd58c`). |
| `NEXTAUTH_SECRET=<32-byte random>` | Mandatory now that real sessions exist; the app refuses to sign with the dev fallback in production. |
| `DATABASE_URL`, `TZ=Asia/Kolkata` | DB + IST (already set). |
| `SNOWFLAKE_*` (account, username, private key, passphrase, role, warehouse, db, schema) | Spine reader (already set). |
| `ESHIPZ_API_TOKEN` | eShipz poller/webhook (already set). |
| ~~`RETAILJOURNEY_DEV_PERSONA`~~ | **REMOVE it.** Now unused, and it was the flag that enabled the passwordless bypass. |
| ~~`UC_*`~~ | Dead — the UC integration was removed (`1a89b50`). Safe to drop. |

### First-run after deploy
**There is no self-signup.** Create the first admin before anyone tries to log in, or nobody (including you) can:
```
RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/seed-admin.mts
```

## 5. Gotchas / operational notes
- **PROD-DB guard.** `db.ts` refuses to connect to `168.144.81.147` from a non-deployed process unless
  `RETAILJOURNEY_ALLOW_PROD_DB=1` (per-invocation) — deploys carry `RETAILJOURNEY_DEPLOY_ENV=production` instead.
- **Env read lazily** inside function bodies (never at module load) — Coolify injects runtime vars after eval.
- **Snowflake NTZ is IST wall-clock.** Session TZ forced to Asia/Kolkata, DATE/TIMESTAMP fetched as strings and
  converted in `ist.ts`. Don't let a driver reinterpret them as UTC.
- **Windows build quirk (local only):** `next build` here does not emit `.next/server/instrumentation.js`, so a
  local `next start` never runs the scheduler. Linux/Coolify is unaffected; `start.mjs` warns if it recurs.
- **PowerShell + git:** push writes progress to stderr, which PowerShell surfaces as a red `NativeCommandError`
  even on success — check the `main -> main` line and exit code, not the colour.
- Node 22.12+ required (`.nvmrc`, `nixpacks.toml` pin it). `gh` CLI installed but not authenticated; push via Git
  Credential Manager (malharm-dotcom over HTTPS).

## 6. Known open items / parked
- **Spine SELECT is missing 4 columns** the app can use. `RETAIL_JOURNEY_SPINE` carries `distribution_analytics`
  as a CTE, so add `RECEIVER_POSTAL_CODE`, `LAST_CHECKPOINT_REMARK`, `LAST_CHECKPOINT_SUBTAG`,
  `LAST_CHECKPOINT_TAG` to its final SELECT — then to `SPINE_QUERY` and they light up (row type already declares
  them optional; see `SPINE_PENDING_COLUMNS`). Verified safe to run without them: zero AWB rows have a null
  STATUS, so the `statusForTag` fallback never fires.
- **540 orders in the 20-day window have no delivery target** — both `IDEAL_DELIVERY_DATE` and
  `DELIVERY_TARGET_EDD` are NULL at source. Populate upstream if a target is wanted.
- **Inward is DATA-ONLY.** `stiQty`, `exShort`, `inwardedDate`, `storeChannel` are mapped and persisted but no UI
  reads them yet — a deferred increment. Note `INWARDED` now exists in BOTH `OverallStatus` (spine headline) and
  the older `ReceiptStatus` (manual Phase-C lifecycle); reconcile when the inward UI is built.
- **Journey stepper** (`orders/[soNumber]/page.tsx`) has a hardcoded 4-stage `STAGES` array; an INWARDED order
  gets `stageIdx = -1` (no stage lit). Cosmetic, out of scope so far.
- `LAST_UPDATED` and `PACKED_TIMESTAMP`/`STO_BILL_DATE`/`STATE` exist in the spine but are unused. `LAST_UPDATED`
  would let the reader go incremental instead of re-pulling 20 days hourly.

## 7. Commit history since M1 (newest first)
```
6f35ed2  fix(schema): add INWARDED to the OverallStatus Prisma enum
c10cd3a  feat(warehouse): flag out-of-rulebook orders on the card
b2d02fe  feat(spine): map store channel, delivery target, coverage and inward data
cb85bd0  test(spine): pin the order+AWB grain against split-bill orders
d71979a  feat(snowflake): repoint the hourly reader to RETAIL_JOURNEY_SPINE
9b1962c  feat(motion): optimistic status advance, skeletons, reduced-motion floor
6f84b38  refactor(warehouse): fixed-width scrolling lanes
482c203  feat(auth): real sign-in with password credentials + server-side RBAC
64fd58c  fix(sync): make scheduler boot observable and never fail silently
1a89b50  refactor: remove dead UC order-source code
6a3c060  feat(design): sidebar nav, board regression fix, motion, wordmark
d98ca28  feat(rulebook): live Snowflake view + QC TAT re-point + purge fake seed
520748f  feat: deploy-environment gate — local processes cannot touch prod
b16759f  feat: per-source sync freshness in the shell
a7d3b9d  test: precedence regression suite — poller vs Snowflake authority
```
Full tree state at time of writing: 77 tests green, tsc/lint/build clean, `main` level with `origin/main`.
