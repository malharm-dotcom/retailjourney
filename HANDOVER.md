# RetailJourney — Session Handover

> First instruction to a fresh session: **"Read PRD.md and HANDOVER.md in full before doing anything."**
> PRD.md is the product spec (source of truth for intent). This doc is the *current operational state* —
> what is built, what is deployed, and what an operator must do next.
>
> **Last updated:** 2026-09-18, after the cancellation-backstop ceiling guard + the UC store-prefix fallback.
> This file supersedes the 2026-07-22 version and the pasted 2026-09-18 ~00:15 handover block.

---

## 1. Identity & coordinates

| | |
|---|---|
| **Product** | RetailJourney — Snitch B2B retail distribution tracker |
| **Repo** | `github.com/malharm-dotcom/retailjourney` (private) · branch `main` |
| **Local path** | `C:\Malhar\retail_flow` (Windows, PowerShell) |
| **Server** | Coolify, prod DB `168.144.81.147`, Nixpacks. **Runs a BUILT IMAGE — manual redeploy only.** |
| **Owner** | Malhar M · process owner Maddy (Mahadevan Pillai) |
| **Spec** | `PRD.md` in repo root. Design prototype `relay-in-transit-v2.html` kept as an artifact. |
| **Push/deploy policy** | Pushing to `main` is fine on request. **Never trigger a deploy** — the user redeploys. Every arc ends with a redeploy reminder, not an action. |
| **Prod scripts** | Refuse to connect unless run as `RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/<name>.ts` |
| **Checks** | `npx vitest run` (**574 passing**) · `npx tsc --noEmit` (clean) · `npx next build` (exit 0 — tsc does NOT catch RSC server/client boundary errors) |

---

## 2. ⚠ DEPLOY STATE — FOUR COMMITS PUSHED, NOT DEPLOYED

```
dc016c6  fix(sync): UC learns a store from a prior order with the same SO prefix
89f2805  fix(sync): an order newer than the spine is not a cancelled order
1d1c063  fix(in-transit): delivered work leaves the board overnight, not in three days
36f1df5  fix(sync): eShipz day-first dates were read month-first
```

Everything up to and including `119481b` is deployed (user confirmed 09-17).

### Order of operations matters

`scripts/fix-wrongly-cancelled.ts` must run **AFTER** the redeploy. On the currently-deployed code the next
hourly Snowflake sync re-cancels every repaired order within the hour, because the ceiling guard that stops it
lives in `89f2805`.

1. **User redeploys** (Coolify).
2. `RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/fix-wrongly-cancelled.ts` — dry, prints the count.
3. Same command `--apply` to write.
4. Verify: North ~215 orders across 09-17/09-18 on the Warehouse board; board ~469 rows; delivered rows only
   from today; `/reports` panels switch via tabs; `/reports/logistics-followup` opens on the breached list and
   Copy pastes as a table; today's orders show real store names, not "(store unmapped)".

**Status of the repair as of the last screenshot:** the North queue read "217 orders / 68 cancelled in this
scope", which is consistent with the repair having already been applied. **Do not assume it** — re-run the
script dry; it is re-runnable and reports 0 when there is nothing left to fix.

---

## 3. Data sources (all live)

- **Snowflake spine** `SNITCH_DB.MAPLEMONK.RETAIL_JOURNEY_SPINE` — hourly, watermark on `SPINE_LAST_EVENT_TS`,
  45-day dated sweep as the backstop. Grain: order + shipment_bill + AWB child.
- **eShipz poller** — 15 min, every non-delivered order with an AWB (SN-series included) + real-time webhook.
- **Unicommerce** — live since 09-15. Fills NULLs only, plus the one dispatch→WH-complete move. **Creates orders
  ahead of the spine** (this is deliberate, and is the root of two of this session's bugs).
- **Read precedence: manual override > eShipz poller > Snowflake (base).** Pinned by `sync-precedence.test.ts`.
  **Do not alter this chain.**

### The spine LAGS, and two bugs came from ignoring it

The spine's `MAX(ORDER_DATE)` routinely sits a full day behind the app. Measured 2026-09-18: spine ceiling
`2026-09-17` while the app already held 193 orders dated `2026-09-18`. Anything that reads "absent from the
spine" as a fact about the ORDER — rather than about the spine's coverage — is wrong. Both bugs below are
instances of that one mistake.

---

## 4. This session (2026-09-18)

Reported as: *"~200+ orders placed yesterday and today for North WH are not reflecting on the tool."*

### 4a. `89f2805` — an order newer than the spine is not a cancelled order

**It was never an ingest problem.** Every order was in Postgres; 0 of 459 spine orders from the last 3 days
were missing. They had been marked `CANCELLED`, and `CANCELLED` is not in `QUEUE_STAGES`, so they silently
dropped off the Warehouse board.

Root cause in `cancelledUpstream()` (`src/lib/integrations/sync.ts`): it guarded the spine's retention **floor**
(absent = aged out) but had **no ceiling guard** (absent = the spine has not caught up). The UC path creates
orders ahead of the spine, so they were condemned for being new. Once `CANCELLED`, the backstop's own
`status: { notIn: TERMINAL_STATUSES }` filter excluded them from every later run — they never recovered.

Measured on prod before the fix:

| Order date | North | WH1 | WH2 |
|---|---|---|---|
| 09-15 | 94 | 20 | 137 |
| 09-16 | 5 | 4 | 8 |
| 09-17 | 142 | 18 | 49 |
| 09-18 | 73 | 44 | 76 |

672 of 815 orders from the last 4 days sat CANCELLED · 193 dated above the spine's own `MAX(ORDER_DATE)` ·
**209 of the previous 24h's victims were already back in the spine** — proof they were never cancelled.

**Fix:** guard 2b — condemn only when `orderDate < spineCeiling`. Strict `<` because the ceiling day may still
be mid-import. New `spineOrderDateCeiling()` in `snowflake.ts` mirrors `spineOrderDateFloor()` and rides the
same `Promise.all`, so it costs one cheap read and no latency. An unreadable ceiling cancels nothing — the same
fail-safe the floor already had. 4 new tests.

**Repair:** `scripts/fix-wrongly-cancelled.ts` — dry by default, re-runnable, finds orders **by the defect, not a
hardcoded list**. An order is repaired only if it is CANCELLED, carries a backstop event, AND either proof holds:
the spine carries it now (a genuinely cancelled order does not come back), or it sits at/above the ceiling. Each
is restored to the status its own event recorded. Dry run: **652 orders — North 308, WH2 264, WH1 80.**

### 4b. `dc016c6` — UC learns a store from a prior order with the same SO prefix

Symptom: two orders for the SAME store disagreeing. `BRIGAD16925` read "(store unmapped)" while `BRIGAD16905`
read "COFO - BRIGADE ROAD".

The two ingest paths match stores by **different keys**:

- **Spine path** matches on store NAME (`normStoreKey(finalStore)` / `channelCode`). Correct.
- **UC path** matches `LEFT(order_name,6)` against `Store.id` with `gs_` stripped. On the live master **only 13
  of 163 ids have that shape, and only 43 yield a 6-char key at all** — every other id is a cuid. Brigade Road's
  id is `cmroky5c7001h4ypbdtso4c89`, so the lookup asked for `BRIGAD` and missed.

**Fix:** `ucStoreForPrefix()` — master key first, then the `storeId` a prior order sharing that 6-char prefix
already resolved (the spine having resolved it by name). It cannot invent a store: the fallback only
dereferences an id the app itself wrote, and a stale id resolves to `undefined`, leaving the order fail-open
exactly as before. Paid only when the master misses, cached per run including misses — one indexed read per
distinct prefix. Replayed over live data: **178 of 178 resolved, 0 left unmapped, 0 resolvable by the master's
own key.** The sync note now reports `N store matches learned from a prior order's SO prefix`. 4 new tests.

**This MASKS open item 7, it does not fix it.** See §8.

---

## 5. Architecture map (key files)

```
src/lib/
  types.ts          Domain types (OverallStatus incl. INWARDED, StoreChannel, spine fields)
  ist.ts            IST time math + Snowflake NTZ→ISO conversions. ALL time logic lives here.
  journey.ts        State machine: WH_FLOW, PAST_WAREHOUSE, rollupOverall, captures, labels
  sla.ts            Rulebook target derivation + per-leg SLA verdicts (advisory, never blocks)
  rbac.ts           Role→permissions + facility entitlements. Asserted server-side everywhere.
  db.ts             Prisma singleton + PROD-DB guard (RETAILJOURNEY_DEPLOY_ENV / ALLOW_PROD_DB)
  repo.ts           OrderRepo selection: PrismaRepo when DATABASE_URL set, else in-memory seed
  repo-prisma.ts    PrismaRepo. listOrders = boards (NO window/cap); searchOrders = Orders page
  order-search.ts   DEFAULT_WINDOW_DAYS=30, ORDERS_PAGE_SIZE=100, orderDateFloor (window lift)
  data.ts           scopedOrders/boardSnapshot (60s TTL), searchOrders, orderBySo — all scoped
  prisma-map.ts     Domain⇄Prisma row mapping. :69 maps @db.Date via toISOString().slice(0,10)
  snowflake.ts      *** Spine reader *** SPINE_QUERY, spineQueryFor, spineOrderDateFloor/Ceiling
  distribution-map.ts  Spine row → Order(parent)+OrderShipment(children). normFacility, pickParentRow
  logistics-followup.ts  breachedRows / breachedCsv / breachedTsv (EDD-breached list)
  integrations/
    sync.ts         *** Sync orchestration *** runSnowflakeSync, runUcSync, cancelledUpstream,
                    reconcileCancelledUpstream, ucStoreForPrefix, storeFieldsFor, applySyncPatch
    eshipz-source.ts / eshipz-map.ts   eShipz poller + webhook + tag normalizer

src/app/(app)/
  warehouse/        Queue table. QUEUE_STAGES = WH_FLOW + ON_HOLD; excludes CANCELLED/UNFULFILLABLE
                    and anything PAST_WAREHOUSE. storeUnmapped badge = storeId === ""
  orders/           Search. First paint = last 30 days; ANY facet lifts the window to all history
  reports/          Distribution 2.0 panels behind ?panel= link tabs; logistics-followup ?view=

scripts/
  start.mjs                    Prod entrypoint: migrate deploy → next start
  seed-admin.mts               Create/update an account (TTY-only password, hash only)
  fix-wrongly-cancelled.ts     *** Repair the backstop's victims *** dry by default, --apply to write
  fix-misparsed-delivered.ts   Repair future-dated deliveredDate (finds by defect, dry by default)
  resync-orders.ts             Operator re-read of named orders the watermark can no longer reach
  spine-diagnostics.ts         READ-ONLY spine vs app divergence probe
```

---

## 6. Coolify environment

| Var | Why |
|---|---|
| `RETAILJOURNEY_DEPLOY_ENV=production` | **The sync scheduler is gated on this.** Without it NEITHER poller runs — the 3-day silent-stall incident. |
| `NEXTAUTH_SECRET` | Mandatory; the app refuses to sign sessions with the dev fallback. |
| `DATABASE_URL`, `TZ=Asia/Kolkata` | DB + IST. |
| `SNOWFLAKE_PAT` | **Required — key-pair is dead.** `N8N_OPS` is `TYPE=PERSON`, so the MFA auth policy rejects key-pair before checking the key. Expires **2027-09-09**. ⚠️ Rides a PERSONAL account (`sankeerth.r@`) and dies on offboarding. Real fix: a `TYPE=SERVICE` user — then drop this and key-pair resumes with no code change. |
| `SNOWFLAKE_*` (account, username, key, passphrase, role, warehouse, db, schema) | Spine reader; key-pair vars stay as the rollback. |
| `ESHIPZ_API_TOKEN` | eShipz poller/webhook. |
| `UC_BASE_URL`, `UC_CLIENT_ID`, `UC_USERNAME`, `UC_PASSWORD` | Direct UC intake. ⚠️ PERSONAL login — dies on password rotation or offboarding. |
| `UC_SYNC_INTERVAL_MINUTES` | UC cadence. Default 30; `<=0` disables. |
| `UC_EXPORT_JOB_TYPE` | Optional. Defaults to `4mclothingllp Sale Orders`. |

**First run after deploy:** there is no self-signup. `RETAILJOURNEY_ALLOW_PROD_DB=1 npx tsx scripts/seed-admin.mts`

---

## 7. Gotchas / operational notes

- **PROD-DB guard.** `db.ts` refuses to connect to `168.144.81.147` from a non-deployed process without
  `RETAILJOURNEY_ALLOW_PROD_DB=1`. Local dev cannot be pointed at prod — the instrumentation hook would start
  the sync scheduler against production.
- **Prod method:** SELECT-only diagnosis → dry run → write through the real sync functions. Probe pattern that
  works well: `scripts/tmp-*.ts`, run with the env var, **delete after**.
- **`statusSource` no longer identifies the creating path.** `fix-wrongly-cancelled.ts` stamps
  `SYNCED_SNOWFLAKE` on every order it reinstates, and so does the cancellation backstop. Do not use that column
  as evidence of which integration created a row.
- **Source files are CRLF.** The Write tool emits LF — write to a temp path, then convert and install:
  `node -e "fs.writeFileSync(dst, fs.readFileSync(src,'utf8').replace(/\r\n/g,'\n').replace(/\n/g,'\r\n'))"`
  (Test files under `src/lib/integrations/` are LF; check with `file` before normalising.)
- **Do NOT write JS/TS via a bash heredoc.** Inside `node -e '…'` a `\d` in a regex is eaten by the escaping
  layers — use `[0-9]`. This shipped a silently broken regex that only new tests caught.
- **Don't string-surgery the same file twice with `node -e`** — rewrite the file instead.
- **Snowflake NTZ is IST wall-clock** and a NULL comes back as the literal string `"NULL"`. Always
  `ntzValue()` / `isoFromIstNtz()`; a bare `if (row.SOME_TS)` is always true and silently wrong.
- **Prisma names that cost time:** `OrderShipment.shipmentStatus` (not `status`), `.deliveredTs`,
  `.expectedDeliveryDate`. No `TrackingCheckpoint` model — checkpoints are a Json column on `Order`.
  `OrderEvent` keys on `orderId` with `fromValue`/`toValue`/`createdAt`/`actorName`.
  `Source` enum: `SYNCED | SYNCED_SNOWFLAKE | SYNCED_UC | MANUAL`.
- **`resync-orders` will NOT repair `deliveredDate`** on an already-DELIVERED order: `applySyncPatch` writes it
  only inside a shipment-status transition, and eShipz stops polling delivered shipments. Use an explicit write
  through `repo.updateFields` (emits events, re-rolls `overallStatus`).
- **No Python.** tsx scripts can't use top-level await — wrap in `main()`.
- **Env read lazily** inside function bodies (never at module load) — Coolify injects runtime vars after eval.
- **Windows build quirk (local only):** `next build` here does not emit `.next/server/instrumentation.js`, so a
  local `next start` never runs the scheduler. Linux/Coolify unaffected.
- **PowerShell + git:** push writes progress to stderr, surfaced as a red `NativeCommandError` even on success —
  check the `main -> main` line and the exit code, not the colour.

---

## 8. Known open items (by priority)

1. **Redeploy, then run the repair** — §2. Four commits outstanding.
2. **18 orders carry `expectedDate` earlier than their own order date** — the same day/month parse bug
   (`"05-08-2026"` = 5 Aug read as May 8). The parser is fixed forward only; these rows still hold wrong courier
   EDDs, and the EDD-breached list reads exactly this field by default. No repair script written — needs a
   decision on the source of truth (spine `LOGISTICS_EXPECTED_DELIVERY_DATE` vs re-poll).
3. **Rows with sync-time delivered dates** (e.g. `BOULEW16702`: `delivered=2026-09-17` while its AWB read
   OUT_FOR_DELIVERY, EDD 09-10). New ones stop from `1d1c063`; existing ones keep the wrong date and their
   delivery SLA stays overstated.
4. **Does the UC update branch rewrite `storeId` on an EXISTING order?** NOT TRACED. `dc016c6` is proven to
   resolve the right store for all 178 currently-unmapped rows, but whether those existing rows get rewritten on
   the next UC run — versus only new orders being correct going forward — was not verified. They should
   self-heal via the spine backfill (`sync.ts`, `if (store && existingRow.storeId === "")`) once the spine covers
   09-18, which is what happened to 09-17's batch. Confirm, or write a repair.
5. **Stale checkpoint JSON on the 11 repaired orders** — the Journey timeline still shows the Nov/Dec dates.
   Display-only; the poller won't refresh a delivered shipment, so it stays until cleared.
6. **The `Delivered` chip** on the board now surfaces only today's completions. Decouple it from the server
   window if it should reach further back.
7. **UC store matching is MASKED, not fixed.** `dc016c6` hides the symptom, which removes the pressure to do the
   real migration — and it only works because the spine resolves each prefix at least once. A genuinely new
   store still lands unmapped until then (correctly). Real fix: add `soCode` to `Store` (unique), load all 163
   from the ops sheet. **Needs a schema migration — not approved.** Sheet:
   `docs.google.com/spreadsheets/d/1lnnf48sH4k9Fqeb0-J0DCi9fAqPUI92Tq5GrC450a8U` (tab `Store_details`,
   gid 1414304456; read via `gviz/tq?tqx=out:html&gid=…`).
8. **Mis-parse and mis-cancellation are only detectable at the edges.** For dates, where both day and month are
   ≤ 12 the old data is silently wrong and unrecoverable by query (11 + 18 is the floor). For cancellations, a
   genuinely cancelled order and a wrongly-cancelled one that never returns to the spine look identical — **652
   is a floor, not a full count.**
9. **Spine SELECT is missing 4 columns** the app can use: `RECEIVER_POSTAL_CODE`, `LAST_CHECKPOINT_REMARK`,
   `LAST_CHECKPOINT_SUBTAG`, `LAST_CHECKPOINT_TAG`. The spine carries `distribution_analytics` as a CTE, so add
   them to its final SELECT, then to `SPINE_QUERY`, and they light up (row type already declares them optional —
   see `SPINE_PENDING_COLUMNS`).
10. **Inward is DATA-ONLY.** `stiQty`, `exShort`, `inwardedDate`, `storeChannel` are mapped and persisted but no
    UI reads them. `INWARDED` exists in BOTH `OverallStatus` and the older `ReceiptStatus` — reconcile when the
    inward UI is built. The Journey stepper has a hardcoded 4-stage `STAGES` array, so an INWARDED order gets
    `stageIdx = -1` (cosmetic).
11. **(carried)** Conflict-event noise (~64k events/7d); `repo-prisma.ts` manual edits bypass the
    INWARDED/CLOSED holds; re-run `scripts/pendency-exceptions.ts`; 14 `QC-` orders missing from the spine;
    `spine-patch.sql` items; Pickup Pending card wording; dispatched-no-AWB rows in the Warehouse outbox (~235).
12. **(carried, still open with logistics)** `CHIKJA16468`, `CHIKJA16718`, `VIPVIZ16462` — marked RTO in the
    pendency sheet but the app says delivered/inwarded. Unresolved.

---

## 9. Measured state

**2026-09-17 ~19:30 IST**
```
overallStatus:  DELIVERED 9328 · WH_PROCESSING 543 · IN_TRANSIT 232
                PICKUP_PENDING 170 · CLOSED 135 · INWARDED 111
board rows:     944 total = 391 live + 553 delivered (59% completed work)
after redeploy: 469 total = 391 live +  78 delivered (same-day)
```

**2026-09-18 (this session)**
```
spine:          MIN(ORDER_DATE) 2026-03-02 · MAX(ORDER_DATE) 2026-09-17 · 20,315 rows
recent orders:  815 over 4 days, 672 of them CANCELLED by the backstop
repairable:     652 (North 308 · WH2 264 · WH1 80)
store master:   163 rows · 13 with the gs_ shape · 43 yielding a 6-char key
unmapped:       178 orders reading "(store unmapped)" — 178/178 resolvable by prefix fallback
```

---

## 10. Commit history (newest first)

```
dc016c6  fix(sync): UC learns a store from a prior order with the same SO prefix
89f2805  fix(sync): an order newer than the spine is not a cancelled order
1d1c063  fix(in-transit): delivered work leaves the board overnight, not in three days
36f1df5  fix(sync): eShipz day-first dates were read month-first
119481b  feat(reports): an EDD-breached list to copy to couriers; one panel at a time
23650ff  fix(sync): a lagging spine seed never reopens a closed order
16be3f2  feat(tables): sorting beside the filters on Orders, In-Transit and Reports
d967b39  fix(sync): a dispatch time completes the warehouse stage
6f35ed2  fix(schema): add INWARDED to the OverallStatus Prisma enum
c10cd3a  feat(warehouse): flag out-of-rulebook orders on the card
b2d02fe  feat(spine): map store channel, delivery target, coverage and inward data
d71979a  feat(snowflake): repoint the hourly reader to RETAIL_JOURNEY_SPINE
482c203  feat(auth): real sign-in with password credentials + server-side RBAC
64fd58c  fix(sync): make scheduler boot observable and never fail silently
520748f  feat: deploy-environment gate — local processes cannot touch prod
a7d3b9d  test: precedence regression suite — poller vs Snowflake authority
```
