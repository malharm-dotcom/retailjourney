# PRD — RetailJourney (Snitch B2B Retail Distribution Tracker)

> **RetailJourney** — the baton passing cleanly between Merchandising → Warehouse → Logistics → Store.
> (Working codename. Trivial to rename — it's a find-replace on `retailjourney` / `RetailJourney`. Alternatives if you prefer: *Waypoint*, *Transit*, *Dispatch*.)
>
> **What this file is.** The single source of truth for building RetailJourney. Point Claude Code at it every session
> (`Read PRD.md fully before doing anything`). Keep it in the repo root. Edit this file first when scope changes, then implement.

**App slug:** `retailjourney`  ·  **Domain:** `retailjourney.snitch-workflow.com`  ·  **Owner:** Malhar M  ·  **Process owner:** Maddy (Mahadevan Pillai)

---

## 1. Problem & Goal

A B2B retail order (warehouse → store replenishment) is tracked today across **two disconnected Google Sheets** plus a stack of Metabase/SQL views, with manual courier follow-ups:

1. **Store Goods Tracker – WH Sheet** — merchandising pastes UC orders; warehouse updates status by hand.
2. **B2B Logistics Summary** — logistics copies dispatched orders and chases couriers for status per LR.

The full journey *already exists as SQL* (the three attached extracts — see §13), but it's read-only reporting: no write layer, no live status, no cross-functional workspace. So the Retail Head spends the day pinging Logistics for "where is my shipment," breaches surface late, and reconciliation lives elsewhere.

**Goal:** one modern web app that carries a B2B order end-to-end — **UC order creation → WH processing → Logic push → dispatch → in-transit → delivered → store inward (shortage/excess)** — with **live status from the UC + eShipz APIs**, cross-functional visibility, and the **distribution rulebook** driving suggested timelines and per-leg SLA. Order creation stays in UC; everything after is owned here.

**The spine:** every order is one record keyed by **`SO_NUMBER`** (a.k.a. `ORDER_NAME`) and later **`DC_NUMBER`** / **`LR_NUMBER`**. The two sheets are two phases of the *same* record. The app reproduces the existing SQL journey/SLA logic natively and keeps it live.

---

## 2. Non-negotiables (read first)

- **Live via API, direct.** Primary data comes from the **UC API** (orders + processing lifecycle) and the **eShipz API** (shipment tracking). **Do not build on Snowflake or n8n at runtime** — those pipelines exist for reporting and we're not re-plumbing/migrating them into this app.
- **Snowflake / Metabase is an *optional plug-in*, not day-1.** Keep integrations behind a clean adapter interface (§8) so a Snowflake or Metabase read-source *could* be dropped in later, but ship on the direct APIs.
- **The app owns the journey + SLA logic.** Port the computation from the existing SQL (§13) into the app — status rollup, rulebook targets, per-leg TAT/SLA. Don't depend on an external view to compute it.
- **Manual override is always available** on every status/field, even auto-synced ones. Track `source` (`SYNCED` | `MANUAL`) and `lastEditedBy` per mutable field. Manual wins on conflict, but both are logged.
- **Rulebook is advisory, never blocking.** During B2C sale periods the warehouse must process in any order. Rulebook drives *suggested* timelines and SLA colouring only.
- **Facility model:** floor roles are locked to one facility; **certain roles can switch facility, and a multi-facility "All" view exists** (§3). Enforce entitlements server-side — a user can only switch to facilities they're granted. Facilities: `SAPL-NORTH-TAURU`, `SAPL-WH1`, `SAPL-WH2`.
- **IST everywhere.** Business dates stored `YYYY-MM-DD` in IST, no tz drift; timestamps stored UTC, rendered IST; epoch math (`+5.5h`) in a shared `lib/ist.ts`. `TZ=Asia/Kolkata`.
- **Design must not look vibe-coded** — no default lucide set, no purple-gradient AI aesthetic (§9).
- **Build order: design & flow first.** M1 is a fully navigable UI on seed data. Live API integration comes after the flow feels right (§12).

---

## 3. Personas & Access (RBAC + facility model)

| Role | Who | Can do | Facility |
|---|---|---|---|
| **Admin** | Malhar, Maddy | Everything: rulebook, users, integrations, all facilities | **Switch + All view** |
| **Merchandising** | Yuvraj, Priyanka, Anish, Srushti | Create/accept orders; set `TYPE`, `PRIORITY`, campaign tag (`REMARKS`) | **Switch + All view** (global) |
| **Warehouse Supervisor** | Floor leads | WH status transitions, box/weight/invoice, not-found/unfulfillable, RTS-Logic, dispatch handover | **Switch across own WHs** |
| **Warehouse Operator** | Pickers/packers | Same as above, execution-focused | **Locked to one facility** |
| **Logistics** | Logistics team | Courier/LR/DC assign, shipment status, NDR/attempts, delivered | **All facilities** |
| **Retail Head / Area Manager** | Leadership, AMs (Sonit Tandon, Sasmit, Subham, Kuldeep …) | **Read-only** dashboards + live in-transit board; filter to own AM/stores | **All view**, AM-scoped |
| **Store** *(phase 2)* | Store staff | Confirm receipt, log shortage/excess | Own store |

**Facility switcher** is a persistent top-bar control for entitled roles, with an **"All facilities"** option that unions the data (multi-facility view). Locked roles don't see the switcher. The active facility (or "All") scopes every query server-side; never trust a client facility value.

---

## 4. The Order Journey — canonical state machine

One order moves through phases. Store both a granular `status` and a phase rollup `overallStatus` (the four-stage summary the SQL already emits).

### `overallStatus` (dashboard rollup)
```
WH PROCESSING  →  PICKUP PENDING  →  IN TRANSIT  →  DELIVERED
```

### Phase A — Warehouse Processing (granular `status`)
```
NOT_STARTED → PICKING → PACKING → READY_TO_DISPATCH → RTS_LOGIC → DISPATCHED_TO_STORE
                 ↘ ON_HOLD (reversible)   ↘ CANCELLED (terminal)   ↘ UNFULFILLABLE (from UC, terminal)
```
Capture the UC lifecycle timestamps that already exist in `b2b_journey`: `createdTs, pickingTs, pickedTs, packedTs, rtsTs, manifestedTs, dispatchedTs, shippedTs, deliveredTs, cancelledTs`, plus `ucStatus`, `latestStatus`. `READY_TO_DISPATCH` = UC processing done (RFID-verified, invoice generated). `RTS_LOGIC` captures `saleInvoiceNumber`, `rtsLogicDate`. `DISPATCHED_TO_STORE` captures `dcNumber`, `lrNumber`, `logisticsPartner` (incl. `SELF`), `vehicleNumber`, `eWayBill`, `rtdDate`, `dispatchedDate` — and flips the order onto the Logistics board.

### Phase B — In Transit (eShipz)
```
IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED (terminal)
        ↘ DELIVERY_FAILED (NDR) → attempts++ → back to IN_TRANSIT/OFD
```
Synced from eShipz keyed on `lrNumber`/`trackingNumber`; manual override always. Capture `eshipStatus`, `trackingStatus`, `trackingSubStatus`, `trackingLatestLocation`, `trackingLatestMessage`, `lastCheckpointCity/State/Remark`, `trackingLink`, `podLink`, `expectedDate`, `deliveredDate`, `deliveryAttempts`, `pickupAttempts`, `firstOfdDate`, `latestOfdDate`, `newLrNo`. **`SELF` (self-delivery) has no eShipz feed — manual status only** (known gap).

### Phase C — Store Receipt / Reconciliation (Logic STI)
```
RECEIVED → INWARDED → CLOSED
```
Capture `orderReceivedDate`, `boxesReceived`, `totalCount`, `inwardedDate`, `stiBillNo`, `stiSku/Qty`, `receivingPv`, `shortageQty`, `excessQty` (`EX_SHORT`), `shortageExcessFileUrl`, `adjustmentOnLogic`, `entryStatus (OPEN|CLOSED)`. Returns (phase 2): `returnInitiateDate`, `returnReason`.

### Per-leg SLA (rulebook-driven — 4-state)
For each leg compute `targetTs` (rulebook) vs `actualTs`, then:
```
FUTURE SLA        target still ahead, not yet due
WITHIN_SLA        completed on/before target
BREACHED          completed after target
BREACHED-PENDING  target passed, action not yet done (…FOR PROCESS / …FOR DELIVERY)
```
Legs: **Creation/Placement, Merch Handover, WH Processing, Pickup, Delivery, Logistics Delivery, Perfect Order** (perfect = all legs within SLA AND zero shortage/excess). These map 1:1 to the SQL columns `ORDER_PLACEMENT_SLA, HANDOVER_SLA, PICKUP_SLA, DELIVERY_SLA, LOGISTICS_DELIVERY_SLA, PERFECT_ORDER_SLA`.

---

## 5. Data Model (Prisma sketch — refine, don't copy blindly)

Prisma 7 + `@prisma/adapter-pg`, PostgreSQL. `Order` aggregate + `OrderEvent` audit + rulebook masters.

```prisma
model Order {
  id                String   @id @default(cuid())
  soNumber          String   @unique          // SO_NUMBER / ORDER_NAME — spine key
  orderDate         DateTime @db.Date
  orderTimestamp    DateTime
  facility          String                     // SAPL-NORTH-TAURU | SAPL-WH1 | SAPL-WH2
  channel           String                     // FRANCHISE_STORE | OWN_STORE
  storeId           String
  storeNameFormat   String
  finalStore        String                     // "SNITCH - FOCO - BOPAL"
  ownership         String?                    // COCO | FOCO | COFO (from store name)
  state             String
  zone              String?                    // NORTH | WEST | SOUTH | EAST | UNMAPPED
  type              OrderType                  // FRESH | RPL | Q_COMM | ACC | NON_TRADING | OTHER
  qty               Int
  priority          String?
  campaignTag       String?                    // REMARKS e.g. "YUVRAJ - SUMMER CAPSULE"
  merchandiser      String?                    // Yuvraj | Priyanka | Anish | Srushti
  areaManager       String?
  category          String?                    // Shirts | T-Shirts ...

  // Phase A — WH processing + UC lifecycle
  status            OrderStatus @default(NOT_STARTED)
  statusSource      Source      @default(MANUAL)
  overallStatus     OverallStatus @default(WH_PROCESSING)
  ucStatus          String?
  createdTs pickingTs pickedTs packedTs rtsTs manifestedTs dispatchedTs shippedTs deliveredTs cancelledTs DateTime?
  weightKg          Float?
  pickedQty         Int?
  fulfilledQty      Int?
  unfulfillableQty  Int?
  boxCount          Int?
  saleInvoiceNumber String?
  rtsLogicDate      DateTime? @db.Date

  // Handoff
  dcNumber          String?
  lrNumber          String?
  logisticsPartner  String?                    // MUDITACARGO | MOVEMATE | BLUEDART | EKART B2B | SELF ...
  courierPartner    String?
  vehicleNumber     String?
  eWayBill          String?
  rtdDate           DateTime? @db.Date
  dispatchedDate    DateTime? @db.Date
  dispatchType      String?                    // PTL ...
  laneClassification String?                   // Milk Run Lane | Dedicated Vehicle Lane | North-1 ...

  // Phase B — shipment (eShipz)
  shipmentStatus    ShipmentStatus?
  shipmentSource    Source?
  eshipStatus       String?
  trackingNumber    String?
  trackingStatus    String?
  trackingSubStatus String?
  trackingLatestLocation String?
  trackingLatestMessage  String?
  lastCheckpointCity String?
  lastCheckpointState String?
  trackingLink      String?
  podLink           String?
  expectedDate      DateTime? @db.Date
  deliveredDate     DateTime? @db.Date
  deliveryAttempts  Int @default(0)
  pickupAttempts    Int @default(0)
  firstOfdDate      DateTime?
  latestOfdDate     DateTime?
  newLrNo           String?
  logisticsComments String?

  // Phase C — inward / reconciliation
  orderReceivedDate DateTime? @db.Date
  boxesReceived     Int?
  totalCount        Int?
  inwardedDate      DateTime? @db.Date
  stiBillNo         String?
  receivingPv       String?
  shortageQty       Int?
  excessQty         Int?
  shortageExcessFileUrl String?
  adjustmentOnLogic Boolean?
  entryStatus       EntryStatus?

  // Derived SLA (computed in-app from rulebook)
  creationSla creationTs handoverSla handoverTat pickupSla pickupTat deliverySla deliveryTat perfectOrderSla String?
  ageing            Int?

  events            OrderEvent[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([facility, overallStatus])
  @@index([shipmentStatus])
  @@index([areaManager]) @@index([storeId, orderDate])
}

model OrderEvent {                             // audit timeline — powers the journey view
  id String @id @default(cuid())
  orderId String
  order Order @relation(fields:[orderId], references:[id])
  field String                                // "status" | "shipmentStatus" | ...
  fromValue String?
  toValue String
  source Source                               // SYNCED | MANUAL
  actorId String?                             // null = system/API
  note String?
  createdAt DateTime @default(now())
}

model Store {                                  // store master
  id String @id @default(cuid())
  branchCode String @unique
  storeName String
  finalStore String
  ownership String?                            // COCO | FOCO | COFO
  channel String                              // FRANCHISE_STORE | OWN_STORE
  storeCity String?
  storeState String?
  zone String?
  facility String                             // serving WH
  areaManager String?
  merchandiser String?
  rank Int?                                    // store rank
  sales30d Float?
  rules RulebookEntry[]
}

model RulebookEntry {                          // per store × order-type schedule (matches warehouse_b2b_performance)
  id String @id @default(cuid())
  storeId String
  store Store @relation(fields:[storeId], references:[id])
  orderType OrderType                          // FRESH | RPL | OTHER ...
  laneClassification String?
  zone String?
  bestTatDays Int?
  targetOrderDay String?                       // Mon..Sun
  targetOrderCutoff String?                    // "11AM" ...
  targetHandoverDay String?
  targetHandoverCutoff String?
  targetPickupDay String?
  targetDeliveryDay String?
  effectiveFrom DateTime @db.Date              // versioned monthly
  effectiveTo DateTime? @db.Date
  @@index([storeId, orderType, effectiveFrom])
}

enum OrderType     { FRESH RPL Q_COMM ACC NON_TRADING OTHER }
enum OrderStatus   { NOT_STARTED PICKING PACKING ON_HOLD READY_TO_DISPATCH RTS_LOGIC DISPATCHED_TO_STORE CANCELLED UNFULFILLABLE }
enum OverallStatus { WH_PROCESSING PICKUP_PENDING IN_TRANSIT DELIVERED }
enum ShipmentStatus{ IN_TRANSIT OUT_FOR_DELIVERY DELIVERED DELIVERY_FAILED }
enum EntryStatus   { OPEN CLOSED }
enum Source        { SYNCED MANUAL }
```
Rulebook is **versioned monthly** (`effectiveFrom/To`) to match the Apr/May/Jun republish cadence; an order's SLA uses the version in effect on its `orderDate`.

---

## 6. Screens / IA

1. **Dashboard (Control Tower)** — role-aware landing. KPI strip by `overallStatus` (WH Processing / Pickup Pending / In Transit / Delivered), breaches today, shortage/excess open. Facility switcher / All view up top.
2. **Live In-Transit Board** *(headline screen)* — every dispatched-not-delivered shipment: store, LR, courier, dispatched/expected date, ageing bucket, tracking status + latest checkpoint message, attempts, POD link. Filter by store / AM / courier / facility / ageing. Auto-refresh. Kills the Retail-Head-pinging-Logistics loop.
3. **Warehouse Queue** — facility-scoped kanban (Not Started → Picking → Packing → Ready → RTS-Logic → Dispatched). Inline status, box/weight/invoice, not-found/unfulfillable. Rulebook due-today highlight.
4. **Logistics Queue** — orders at `DISPATCHED_TO_STORE`+; courier/LR/DC, shipment status, NDR/attempts, delivered. Self-delivery manual lane called out.
5. **Order Detail / Journey** — full `OrderEvent` timeline across all phases; every field with source badge + edit; reconciliation panel; tracking checkpoints + POD.
6. **Rulebook** — weekly schedule grid (days × stores, colour by leg), store table, lane/zone view, CSV upload + edit UI + version history.
7. **Reports** — §10, all filterable + CSV export.
8. **Admin** — users/roles/facility entitlements, integration health, sync logs.

**Order intake:** merch accepts auto-created orders that appear when a new B2B SO lands via the UC API, or CSV-imports in the *Store Goods Tracker* shape; merch only sets `TYPE`/`PRIORITY`/campaign tag.

---

## 7. Distribution Rulebook module

First-class feature. Structure taken directly from `warehouse_b2b_performance`: per store × order-type → `laneClassification`, `zone`, `bestTatDays`, `targetOrderDay/Cutoff`, `targetHandoverDay/Cutoff`, `targetPickupDay`, `targetDeliveryDay`. Derived at runtime: `orderCutoffTs`, `handoverDeadlineTs`, `idealDeliveryDate` (port the existing SQL date math — same logic as `placement_sla`).

**Maintenance:** in-app admin — CSV upload (monthly bulk refresh, creates a version) **+** inline edit UI. Old versions retained for historical SLA.

**Visualisations (required):** weekly schedule grid (days × stores, colour-coded per leg); lane/zone map; rulebook-vs-actual adherence. Advisory only.

---

## 8. Integrations (direct API primary; Snowflake as optional plug-in)

Adapter interface with the direct API as the shipped implementation; a Snowflake/Metabase reader can be added later behind the same interface without touching callers.

```ts
interface OrderSource    { fetchNewB2BOrders(since): OrderSeed[]; fetchLifecycle(soNumbers): UcLifecycle[] }
interface TrackingSource { fetchTracking(lrNos): TrackingUpdate[] }
// day-1 impls: UcApiOrderSource, EshipzTrackingSource
// later plug-ins (optional): SnowflakeOrderSource, MetabaseTrackingSource
```

### 8a. Unicommerce API (day-1)
Fetch new B2B SOs (`FRANCHISE_STORE_B2B`, `OWN_STORE_B2B`) and the processing lifecycle (created→picked→packed→RTS→manifested→dispatched, `UNFULFILLABLE`, fulfilled qty). Scheduled poll from an internal route/worker (not n8n). Upsert on `soNumber`; never silently overwrite a `MANUAL` field.
**Discovery (do before M-integration):** UC API base URL, auth (token/OAuth), the B2B order + shipment endpoints, poll vs webhook, rate limits.

### 8b. eShipz API (day-1)
Track by `lrNumber`/`trackingNumber` → map to `ShipmentStatus` + checkpoints + POD. Write `source=SYNCED`; manual override on the Logistics Queue.
**Discovery:** eShipz tracking endpoint, auth, poll vs webhook, response shape (the `trackingLink` / `podLink` / checkpoint fields already appear in `distribution_analytics`, so the payload shape is largely known).

### 8c. Auth — Google SSO + password fallback
NextAuth: **Google provider restricted to `snitch.com`** (`hd` param + server-side domain check) **+ credentials (bcrypt) fallback**. New `@snitch.com` login creates a pending user an Admin activates + assigns role/facility entitlements.

Sync health (last run, counts, failures) shown in Admin. All sync writes flow through `OrderEvent`.

---

## 9. Design direction — "flawless and flowy," Snitch-branded, not vibe-coded

Default AI look (lucide icons, indigo gradients, rounded-everything, Inter-only) is banned. Lean into Snitch's editorial brand: cream ground, bold near-black ink, hash-mark motif, high contrast, generous whitespace.

- **Icons:** **Phosphor Icons** (duotone/regular) primary — not lucide. (Tabler acceptable alternate.) One consistent weight.
- **Type:** strong grotesque for UI (*Geist* or *Inter Tight*) + heavier display cut for headers; tabular numerals in tables.
- **Palette:** cream surface (`~#F5F1E8`), near-black ink (`~#111`), one signal accent; **semantic, consistent status colours** (in-transit / OFD / delivered / breached / on-hold) always paired with label + icon, never colour alone.
- **Status as first-class UI:** every status a pill with icon + label + source badge (synced ● / manual ✎). The journey timeline is the emotional core — beautiful and scannable.
- **Motion:** subtle, purposeful; optimistic UI on status changes; smooth kanban lane transitions.
- **Density done right:** data-heavy tables, sticky headers, frozen SO/store columns, keyboard nav, inline edit; mobile-responsive for floor + on-the-go leadership.
- **shadcn/ui as a re-themed base** (custom tokens/radius/shadows) so it never reads as a template.

> Before building any UI, read `/mnt/skills/public/frontend-design/SKILL.md` and follow its tokens/guidance.

---

## 10. Reports (every leg, every stakeholder)

Filter by date range, facility (or All), store, AM, merchandiser, courier, order type, lane, zone, campaign tag. CSV export. Read-optimised.

1. **Order lookup / journey** — any SO/DC/LR → full timeline.
2. **SLA adherence per leg** — Creation, Handover, WH Processing, Pickup, Delivery, Perfect Order; WITHIN/FUTURE/BREACHED/BREACHED-PENDING %; 4-week trend for leadership.
3. **Live in-transit + ageing** — buckets from `AGEING`; breaching-soon.
4. **Courier scorecard** — per-partner on-time %, TAT, attempts/NDR, breaches (aligns with the B2B forward scorecard).
5. **Shortage / excess reconciliation** — open vs closed, qty, Logic-adjustment status, file links.
6. **WH throughput** — orders/qty/boxes per facility per day; status funnel.
7. **Rulebook adherence** — actual leg day vs rulebook day, per store/type/lane.
8. **Store / AM / merchandiser view** — self-serve slice for leadership.

---

## 11. Tech stack & deployment (match existing Snitch infra)

- **Next.js 14 (App Router) + TypeScript + Tailwind**, mobile-first.
- **Prisma 7 + `@prisma/adapter-pg`**, **PostgreSQL** (`postgres:18-alpine`).
- **Coolify** self-hosted (`168.144.81.147`), **GitHub** `github.com/malharm-dotcom/retailjourney` (private), Nixpacks, domain `retailjourney.snitch-workflow.com`.

**Gotchas (bake in from the start):**
- Nixpacks defaults to Node 22.11 → breaks Prisma 7 (needs 22.12+). Add `.nvmrc` (`22`), `nixpacks.toml` (`nixPkgs = ["nodejs_22"]`), `"engines": { "node": ">=22.12.0" }`.
- `schema.prisma`: `previewFeatures = ["driverAdapters"]`, `output = "../src/generated/prisma"` (gitignored, regenerated at build).
- **Read `SESSION_SECRET`/env lazily inside function bodies**, never at module load.
- Post-deploy: `npx prisma migrate deploy` from Coolify **app** terminal (fallback `db push`).
- App + Postgres on the **same Coolify Docker network** from the start.
- `TZ=Asia/Kolkata`; IST via `lib/ist.ts`; business dates `@db.Date` in IST.

**Non-functional:** audit via `OrderEvent`; optimistic UI + server reconciliation; server-side role/facility checks; idempotent sync (upsert on `soNumber`/`lrNumber`); graceful degradation if UC/eShipz is down (manual entry keeps working).

---

## 12. Build plan (design & flow first)

**M0 — Scaffold & deploy skeleton.** Next.js 14 + TS + Tailwind + Prisma 7 + adapter-pg; the three Nixpacks/Node files; NextAuth (Google `@snitch.com` + credentials fallback); Coolify Postgres + app; a protected hello-world live on the domain.

**M1 — Design system + navigable flow (SEED DATA, no live APIs).** *This is where we start.* Build the design tokens (§9), the shell (top bar + facility switcher/All view + nav), and all §6 screens wired to seed data derived from the three extracts (§13). Kanban, In-Transit Board, Journey timeline, Rulebook grid — all clickable and beautiful, statuses/SLA computed in-app. Goal: the flow *feels* right before any integration.

**M2 — Data model + manual core.** Full Prisma schema; CSV import (Store Goods Tracker shape); Warehouse Queue manual transitions + `OrderEvent`; Order Detail. Replaces Sheet #1.

**M3 — Logistics + shipment (manual).** Logistics Queue, dispatch handoff, shipment status/attempts/delivered, In-Transit Board live on real records. Replaces Sheet #2.

**M4 — Rulebook.** Store + RulebookEntry masters, CSV upload + edit + versioning, weekly grid, in-app SLA computation (port the SQL date math).

**M5 — Live integrations.** UC API order/lifecycle sync + eShipz tracking sync behind the adapter interface; sync-health admin; source badges; manual-wins conflict rule. *(Do UC/eShipz API discovery here.)*

**M6 — Reports & polish.** All §10 reports + filters + export; reconciliation (Phase C) UI; design pass to the §9 bar.

**Phase 2 backlog:** optional Snowflake/Metabase plug-in source; Store persona (receipt confirmation); breach/NDR alerts reusing the existing Evolution/WhatsApp ecosystem; returns handling; JIT status field.

---

## 13. Source extracts → app (canonical field dictionary)

The three tracking extracts are the field/logic reference. The app **reproduces** this, sourced live from APIs — it does **not** read these at runtime.

- **`b2b_journey`** (119 cols) — the fully-joined journey: UC lifecycle timestamps, both sheet fields, logistics OUT_/IN_/L_ blocks, rulebook `FRESH_DAY`/`RPL_DAY`, and computed `WH_PROCESSED, SLA_STATUS, AGEING, HANDOVER_TAT/SLA, LOGISTICS_TAT/SLA, FINAL_STATUS, DETAILED_STATUS`. → the master reference for the `Order` model + status machine.
- **`warehouse_b2b_performance`** (62 cols) — rulebook targets (`LANE_CLASSIFICATION, BEST_TAT, TARGET_ORDER/HANDOVER/PICKUP/DELIVERY_DAY` + cutoffs, `ZONE`) + derived (`ORDER_CUTOFF_TS, HANDOVER_DEADLINE_TS, IDEAL_DELIVERY_DATE`) + per-leg SLA + `MERCHANDISER, AREA_MANAGER, RANK, SALES_30D` + eShipz tracking (`TRACKING_LINK, POD_LINK`, checkpoints). → the master reference for `RulebookEntry` + SLA computation.
- **`distribution_analytics`** (63 cols, SKU-grain) — STO bills (`STO_BILL_NO, DOC_NUMBER, TO_PARTY, FROM_PARTY, NET_AMOUNT`), inward (`INWARDED_DATE, STI_SKU/QTY, RECEIVING_PV`), excess/short (`EX_SHORT`), returns (`RETURN_INITIATE_DATE, RETURN_REASON`). → the master reference for Phase C reconciliation + the SKU-level analytical reports.

**Key vocab (live values observed):** order types `FRESH / RPL / OTHER / Q_COMM / ACC / NON_TRADING`; channels `FRANCHISE_STORE / OWN_STORE`; ownership `COCO/FOCO/COFO`; lanes `Milk Run / Dedicated Vehicle / Dedicated PTL / North-1 / West-2 / East-2 / South-1/3 / Central`; zones `NORTH/WEST/SOUTH/EAST/UNMAPPED`; couriers `MUDITACARGO / MOVEMATE / BLUEDART / EKART B2B / SELF`; SLA `WITHIN_SLA / FUTURE SLA / BREACHED / BREACHED-PENDING`; overall `WH Processing / Pickup Pending / In transit / Delivered`.

## Appendix — Session start prompt for Claude Code

```
Read PRD.md in full before doing anything. We are building RetailJourney, the Snitch B2B
retail distribution tracker. Follow the tech stack (§11) and gotchas exactly — must
deploy on our existing Coolify pattern. We are on milestone M1: design system +
fully navigable flow on SEED DATA, no live integrations yet (§12). Reproduce the
journey/SLA logic natively from the field dictionary in §13. Confirm the state
machine (§4), the facility switcher + All-view model (§3), and the design bar (§9),
then propose the screen/route plan before writing code. Manual override and
OrderEvent audit are mandatory on every status change.
```
