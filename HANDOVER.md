# RetailJourney — Session Handover

> Drop this in the repo root next to `PRD.md`. First instruction to a fresh Claude Code session:
> **"Read PRD.md and HANDOVER.md in full before doing anything."** This doc captures everything the
> previous session held in cache, so nothing is lost when that session is cleared.

---

## 1. Identity & coordinates

| | |
|---|---|
| **Product** | RetailJourney (renamed from "Relay") — Snitch B2B retail distribution tracker |
| **Repo** | `github.com/malharm-dotcom/retailjourney` (private) · branch `main` · 3 commits |
| **Local path** | `C:\Malhar\retail_flow` |
| **Domain (planned)** | `retailjourney.snitch-workflow.com` → DNS A-record to `168.144.81.147` |
| **Owner** | Malhar M · process owner Maddy (Mahadevan Pillai) |
| **Spec** | `PRD.md` in repo root — the source of truth. Section refs below (§4, §7…) point to it. |
| **Design reference** | `relay-in-transit-v2.html` — the approved prototype, left in repo as an artifact |

## 2. Where we are — M1 is COMPLETE, pushed, not yet deployed

**M1 = design system + fully navigable flow on in-memory SEED DATA. No database, no live integrations.**
Built, verified in Chrome, committed, and pushed. ~66 files, 3 commits (`f8dad00`, `76b4411`, `23bcbbb`).

**This is a functional prototype to validate the flow, UX, and domain logic — not a persistence-backed product yet.** The *logic* is real (state machine, SLA, RBAC, audit all genuinely implemented); only the *data* is fake and in-memory (~120 deterministic seed orders that reset on every server restart).

### What works right now
- All 8 screens from PRD §6, wired to seed data: Control Tower, In-Transit Board (pixel-faithful port of the v2 prototype), Warehouse kanban, Logistics queue, Order Journey (timeline + per-field override grid), Rulebook (weekly grid / stores / lanes), Reports (8 reports + working CSV export), Admin.
- **State machine (§4)** — granular WH `status` → `shipmentStatus` → receipt, rolled up to 4-stage `overallStatus`. Transitions validated; required-field captures on advance (box/weight → Ready; invoice → RTS-Logic; DC/LR/partner → Dispatched).
- **SLA engine (§7)** — rulebook targets derived per order (orderCutoffTs → handoverDeadlineTs → pickup → idealDeliveryDate), 4-state per-leg verdicts (FUTURE / WITHIN / BREACHED / BREACHED-PENDING) + Perfect Order. Monthly-versioned rulebook. **Advisory only — never blocks a transition.**
- **Facility model (§3)** — top-bar switcher with "All" union view for entitled roles; facility cookie is a preference **validated server-side against entitlements on every read/mutation**. Verified: WH Operator persona (Suresh) gets no switcher and sees only WH-1.
- **Audit (§2)** — every status change and field override goes through server actions → appends an `OrderEvent` (field, from, to, source `SYNCED`/`MANUAL`, actor, note). Manual override always available; manual wins.
- **Auth scaffold (§8c)** — NextAuth wired (routes, middleware, session `{user, role, facilities[]}`). Google provider is env-gated (hidden until credentials set). In dev/M1 a **persona switcher** in the top bar signs in as any seed user so every role is demoable without OAuth.

### Confirmed design decisions (don't re-litigate)
- **Design source of truth = the v2 prototype.** Bricolage Grotesque (display) + Hanken Grotesk (UI); Solar duotone icons (Iconify, subset at build time); cream `#F1EEE6` / ink `#232019` / sage `#3E5D4C`; status colours transit `#4C7A99` · OFD `#B67F2E` · delivered `#3E7A5C` · breach `#BE5340` · pending `#9A9080`. All tokens live in `tailwind.config.ts`.
- **Auth = scaffold + dev persona bypass** (chosen for M1).

## 3. Architecture map (key files)

```
src/lib/
  types.ts        Domain types — mirror of PRD §5 Prisma sketch (so M2 is a schema drop-in)
  ist.ts          IST time math (epoch +5.5h, YYYY-MM-DD business dates). ALL time logic lives here.
  journey.ts      State machine: transitions, status→overallStatus rollup, required captures, status timestamps
  sla.ts          Rulebook target derivation + 4-state per-leg SLA + perfect order + ageing buckets
  rbac.ts         Role→permissions + facility-entitlement map (§3). Asserted server-side everywhere.
  repo.ts         *** OrderRepo interface + InMemoryRepo *** — THE SWAP SEAM for M2 (see below)
  auth.ts         NextAuth options (Google @snitch.com + credentials/dev-persona). Env read lazily.
  session.ts      requireSession() → validated {user, scope}. resolveScope() re-validates the cookie.
  data.ts         Read-side: orders joined with rule + computed SLA (scopedOrders, orderBySo)
  ui.ts           Status→presentation (icon+label+colour). cn() helper.
  reports.ts      8 report builders (pure functions over scoped rows)
  seed/
    stores.ts     ~30 stores (names/zones/lanes/AMs from prototype + §13 vocab)
    users.ts      Seed users / demo personas (Malhar, Maddy, merch, WH sup/operator, logistics, retail head)
    rulebook.ts   Per store × order-type weekly targets, monthly-versioned
    orders.ts     Deterministic ~120-order generator with coherent lifecycles + pre-built OrderEvent history

src/app/
  actions.ts              *** Single mutation gateway *** — "use server". RBAC → validate transition → repo → OrderEvent → revalidate
  layout.tsx, globals.css, not-found.tsx
  login/                  page.tsx + login-panel.tsx (Google btn env-gated + dev persona sign-in)
  api/auth/[...nextauth]/route.ts
  (app)/                  Route group behind auth
    layout.tsx            TopBar + requireSession()
    page.tsx              Control Tower
    in-transit/           page.tsx + board.tsx (headline screen)
    warehouse/            page.tsx + kanban.tsx
    logistics/            page.tsx + table.tsx
    orders/[soNumber]/    page.tsx + field-grid.tsx (Journey)
    rulebook/             page.tsx + tabs.tsx
    reports/              page.tsx + [slug]/page.tsx + [slug]/table.tsx
    admin/                page.tsx

src/components/  icon.tsx, shipment-dialog.tsx, ui/{pill,primitives,dialog,dropdown,kpi}.tsx,
                 shell/{nav,facility-switcher,persona-menu,top-bar,page-head}.tsx
src/middleware.ts        Protects all app routes except /login, /api/auth, static
scripts/gen-icons.mjs    Build-time Solar subset → src/generated/icons.json (keeps client bundle ~140 KB)
```

**Config files present and correct:** `package.json` (engines `>=22.12.0`), `.nvmrc` (`22`), `nixpacks.toml` (`nodejs_22`), `tsconfig.json`, `tailwind.config.ts`, `.env.example`, `.env.local`.

### The swap seams (how future milestones plug in without rewrites)
- **`OrderRepo` interface in `repo.ts`** — M1 ships `InMemoryRepo`; M2 adds `PrismaRepo` implementing the same interface. Callers (server actions, `data.ts`) don't change.
- **Integration adapters (planned §8)** — `OrderSource` / `TrackingSource` interfaces; M5 adds `UcApiOrderSource` + `EshipzTrackingSource`.

## 4. Gotchas / operational notes
- **In-memory state resets on every restart/redeploy.** By design until M2. Fine for flow/UI review; not fine for real usage.
- **Icons:** if you reference a new Solar icon name, run `npm run icons` to regenerate the subset (also runs on `prebuild`).
- **Env read lazily** inside function bodies (never at module load) — Coolify injects runtime vars after evaluation.
- **Node 22.12+ required** (Prisma 7 later; pinning files already handle Nixpacks' 22.11 default).
- `gh` CLI is installed on the machine but **not authenticated**; the repo was created manually. Pushing works via Git Credential Manager (malharm-dotcom over HTTPS).

## 5. What is NOT built yet (the remaining roadmap)

| Milestone | Scope | Trigger |
|---|---|---|
| **M2 — Database** | Prisma 7 + `@prisma/adapter-pg` + PostgreSQL. Add `schema.prisma` (from the §5 types), write `PrismaRepo` behind `OrderRepo`, a seed script, and post-deploy `prisma migrate deploy`. Swap the repo singleton. **This is the next milestone.** | After M1 flow is signed off / before any real usage |
| **M3** | Any remaining manual-core polish surfaced during the pilot | — |
| **M4 — Rulebook CSV** | In-app CSV upload + edit UI + versioning (button is currently stubbed with a toast) | — |
| **M5 — Live integrations** | UC API (orders/lifecycle) + eShipz API (tracking) behind the adapter interface; sync-health in Admin; **do the UC/eShipz API discovery here** (endpoints, auth, poll vs webhook) | After DB is live |
| **M6** | Reports polish, reconciliation UI depth, final design pass | — |

## 6. Coolify deployment (M1 — do this now)

**One Application service only. No database yet.**

1. **Application** → source GitHub `malharm-dotcom/retailjourney`, branch `main`, build pack **Nixpacks**. Grant Coolify's GitHub App access to the private repo.
2. **Domain** `retailjourney.snitch-workflow.com` → DNS A-record to `168.144.81.147`; enable HTTPS in Coolify.
3. **Start command:** default (`npm start`) — Nixpacks detects build/start from `package.json`. Nothing to override.
4. **Environment variables — paste exactly these four:**

```
NEXTAUTH_SECRET=<paste a freshly generated 32-byte base64 string — see below>
NEXTAUTH_URL=https://retailjourney.snitch-workflow.com
TZ=Asia/Kolkata
RETAILJOURNEY_DEV_PERSONA=1
```

- Generate the secret with `openssl rand -base64 32` (Git Bash / WSL / any Linux box) and paste the output as the value. It just has to be a long random string that stays constant.
- `RETAILJOURNEY_DEV_PERSONA=1` is **required for M1** — without it the production build hides the persona switcher and, since Google SSO isn't configured yet, you'd have no way to sign in. Remove it once SSO is live.

**Optional (only when you have Google OAuth credentials — the login page auto-shows the Google button when both are set):**
```
GOOGLE_CLIENT_ID=<from Google Cloud console>
GOOGLE_CLIENT_SECRET=<from Google Cloud console>
```

**Reminder:** every redeploy/restart resets the app to fresh seed data until M2 lands. Nothing to provision (no DB) today.

## 7. Suggested first prompt for the next Claude Code session

```
Read PRD.md and HANDOVER.md in full before doing anything. M1 (navigable flow on
in-memory seed data) is complete and pushed to github.com/malharm-dotcom/retailjourney.
We are starting M2 — the database. Add Prisma 7 + @prisma/adapter-pg + PostgreSQL:
generate schema.prisma from the domain types in src/lib/types.ts (PRD §5), implement
PrismaRepo behind the existing OrderRepo interface in src/lib/repo.ts WITHOUT changing
any callers, port the seed generators into a Prisma seed script, and follow the §11
deployment gotchas exactly. Confirm the schema against the types and propose the file
plan before writing code. Do not touch the UI or the state-machine/SLA logic.
```
