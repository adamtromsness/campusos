# Cycle 20 Handoff — Food Service

**Status:** Cycle 20 **COMPLETE + APPROVED at `911554c`** — Round 2 verdict from REVIEW-CYCLE20-CHATGPT. Wave 4 (Campus Operations) cycle 2. Tag chain: `cycle20-complete` at `48b6c74`; `cycle20-approved` at `911554c`. Cycle 20 ships the M63 Food Service module — 16 of the 31 ERD tables in scope (15 deferred to Cycle 20.1: recipe costing, full inventory management, student pre-order system, staff meal accounts). The Food Service Manager (FSM) is the **seventh specialist operator persona** after the nurse, counsellor, librarian, athletic director, enrolment officer, and Transportation Coordinator.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle20-implementation-plan.html`
**Vertical-slice deliverable:** FSM creates a 5-day "Week A" menu cycle → adds 8 menu items with structured `allergen_codes` (Chicken Nuggets [WHEAT,SOYBEANS], Grilled Cheese [MILK,WHEAT], PBJ [PEANUTS,WHEAT], Pasta [WHEAT], Fresh Fruit [], Garden Salad [], Apple Juice [], Chocolate Milk [MILK]) → builds Monday + Tuesday lunch menus → registers "Main Cafeteria Register" POS device → opens a LUNCH service session → Maya scans her ID at the POS, allergen check fires (Maya has CRITICAL PEANUTS from Cycle 10 health data), today's items don't contain PEANUTS → transaction proceeds → Ethan scans, orders Grilled Cheese — **Ethan has CRITICAL MILK** → POS BLOCKS with 422 + matched allergens → supervisor Rivera retries with `supervisorOverrideId` → 201 with `allergen_override_required=true` and audit trail → free-meal-eligible student scans → `payment_method=FREE_MEAL`, $0.00 → FSM closes session → cash reconciliation flags $0.15 variance → FSM logs walk-in fridge at 3.2°C (compliant) and hot hold at 58°C (NON-COMPLIANT, corrective action recorded) → David Chen submits dietary update request to add HALAL for Maya → FSM approves → admin generates monthly USDA reimbursement claim from transaction data.

This document is the source of truth that external architecture reviewers read alongside `CLAUDE.md`.

---

## Step status

| Step | Title                                                            | Status   |
| ---- | ---------------------------------------------------------------- | -------- |
| 1    | Menu + Item Catalogue Schema                                     | Complete |
| 2    | POS + Transactions + Reconciliation Schema                       | Complete |
| 3    | Dietary + Allergen + Eligibility + Safety Schema                 | Complete |
| 4    | Seed Data + FDS-001..004 IAM grants                              | Complete |
| 5    | Menu + Item Catalogue NestJS Module                              | Complete |
| 6    | POS + Transaction NestJS Module (allergen keystone)              | Complete |
| 7    | Dietary + Eligibility + Safety NestJS Module                     | Complete |
| 8    | Food Service UI — Menus + POS + Sessions                         | Complete |
| 9    | Food Service UI — Dietary + Eligibility + Safety + Parent Portal | Complete |
| 10   | Vertical Slice Integration Test                                  | Complete |
| —    | REVIEW-CYCLE20 Round 1 fixes (migration 071 + service-layer)     | Complete |

---

## REVIEW-CYCLE20 fix log (Round 1, 2026-05-06)

The reviewer flagged 6 BLOCKING + 5 MAJOR items. The fix commit lands all 6 BLOCKING + 4 actionable MAJORs (7 / 8 / 10 / 11) with live verification on `tenant_demo`. MAJOR 9 (FSM role split) is recommendation-class and joins the Phase 2 punch list as item 32. See `REVIEW-CYCLE20-CHATGPT.md` for the triage table.

- **BLOCKING 1** — `AllergenAlertService.listForStudent(studentId, actor)` row-scope: admin / STAFF any student; guardian via `sis_student_guardians`; student via `platform_students.person_id`; others 404. Verified live: parent for Maya 200, parent for Ethan 404, admin 200.
- **BLOCKING 2** — `EligibilityService.list(args, actor)` row-scope: guardians see applications they submitted OR for any of their linked children; students see own; others empty. Verified live: admin sees seed 1 row, parent sees own children only.
- **BLOCKING 3** — `TransactionService.assertPatronInCurrentTenant(patronId, patronType)` resolves STUDENT via `sis_students` joined through `platform_students.person_id` and STAFF via `hr_employees.person_id`; bogus / cross-tenant / wrong patronType all reject 400. Verified live: bogus 400, admin@ Platform Admin person 400, Maya 201.
- **BLOCKING 4** — `TransactionService.create` wraps INSERT in `executeInTenantTransaction` with `SELECT … FOR UPDATE` on `fds_meal_service_sessions`; refuses closed sessions; validates `fds_pos_devices.is_active=true`. Verified live: closed 400, inactive device 400, happy 201.
- **BLOCKING 5** — `isFreeMealEligible(studentTenantId)` checks `fds_student_dietary_profiles.free_meal_eligible=true` OR active determination in (FREE/REDUCED) inside the effective window; FREE_MEAL also requires `patronType=STUDENT`. Verified live: non-eligible Ethan 403, eligible Maya 201.
- **BLOCKING 6** — `EligibilityService.generateClaim` requires `academicYearId` and validates against `sis_academic_years`. Migration `071` adds defensive partial UNIQUE `(school_id, month_year) WHERE academic_year_id IS NULL`. Verified live: missing 400, bogus year 400, real year 201.
- **MAJOR 7** — Handoff status updated to COMPLETE with this fix log appended.
- **MAJOR 8** — `syncFromHealth()` now upserts deterministically by `source_health_alert_id` so severity / display_name / is_active changes from Health propagate. Migration `071` adds `UNIQUE(source_health_alert_id)` as the conflict target. Live verification deferred until `hlth_health_alerts` exists in tenant schema (today the read model is forward-compatible — sync gracefully no-ops when the relation is missing).
- **MAJOR 9** — _Carried to Phase 2 punch list item 32._ Generic Staff currently grants all FDS-001..004 read+write tiers as a stand-in for the FSM persona. Pre-pilot, a dedicated Food Service Manager role moves these write permissions out of generic Staff. Joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 in the broader role-split work.
- **MAJOR 10** — `EligibilityService.submit` else-branch validates studentId for staff/admin submitters before insert. Verified live: bogus studentId 400.
- **MAJOR 11** — `SessionService.close()` enumerates pos_device_ids that posted CASH activity and inserts one `fds_cash_drawer_reconciliation` row per (session, device) with `expected_closing_balance` set to that device's CASH total, all inside the same locked tenant tx as the close. Idempotent on conflict. Verified live: 1 reconciliation row materialised after close.

**Migration 071_fds_review_cycle20_indexes.sql** is splitter-safe additive idempotent — 29th migration in a row to clear the audit on first provision attempt (Cycles 4–20 unbroken streak). Tenant base table count unchanged at 279 (constraint + partial index only). Both `tenant_demo` and `tenant_test` re-provisioned cleanly.

---

## What this cycle adds on top of Cycle 19

**Greenfield — clean `fds_*` namespace.** Cycle 20 ships the entire M63 Food Service core from scratch.

- **16 new tenant base tables** across 3 migrations (068 + 069 + 070). Tenant base table count after Cycle 19's 067 migration was 263 → **279** after Cycle 20.
- **1 new backend module** (FoodServiceModule) with 12 services + 1 controller + ~38 endpoints under `fds-001:read/write/admin` through `fds-004:read/write/admin`.
- **1 new Kafka emit topic**: `fds.transaction.completed` (every successful POS transaction).
- **9 new web routes**: `/food-service` dashboard, `/food-service/menus` planner, `/food-service/pos` checkout (allergen safety UI keystone), `/food-service/sessions` manager, `/food-service/dietary`, `/food-service/eligibility`, `/food-service/safety`, `/food-service/usda-claims`, `/children/[id]/food-service` parent portal.
- **4 existing permission codes wired up**: `FDS-001` (Menu Management), `FDS-002` (POS Operations), `FDS-003` (Dietary + Eligibility), `FDS-004` (Food Safety + Compliance) — already in `permissions.json`. Catalogue stays at **151 functions × 3 tiers = 453 codes**.

**Three structural keystones for the cycle:**

1. **POS allergen cross-check (life-safety).** `fds_student_allergen_alerts` is a read model populated from Cycle 10's health module (manual sync this cycle; Kafka consumer wiring is Phase 2 per the plan). On every POS transaction, the service intersects each item's `allergen_codes[]` against the patron's active alerts. **CRITICAL** matches return **422 BLOCKED** with the matched allergens; the operator must retry with `supervisorOverrideId` → the transaction lands with `allergen_override_required=true` for audit. **WARNING** matches return 200 with a warnings array. **INFO** displays only.
2. **GIN-indexed allergen catalogue.** `fds_menu_items.allergen_codes TEXT[]` carries machine-readable codes (MILK, EGG, FISH, SHELLFISH, TREE_NUTS, PEANUTS, WHEAT, SOYBEANS, SESAME). A **GIN INDEX** on `(school_id, allergen_codes)` backs the cross-check query. The Step 5 service exposes `GET /food-service/menu-items/allergen-check?codes=MILK,WHEAT` that returns items containing any of the specified allergens via `array_overlaps`.
3. **Health-to-Food read model (ADR-030).** `fds_student_allergen_alerts` mirrors `hlth_health_alerts` from Cycle 10. Food Service never reads `hlth_*` tables directly; instead the future Kafka consumer subscribes to `hlth.allergy_alert.changed` and upserts the read model. This cycle ships the schema + seed + a manual sync admin endpoint; the consumer wiring is Phase 2.

**Existing-system touchpoints:**

- `iam_person(id)` — soft refs on `fds_meal_transactions.patron_id` (students + staff via the ADR-055 person model), `fds_meal_service_sessions.opened_by`, `fds_temperature_logs.logged_by`, `fds_dietary_update_requests.submitted_by`, `fds_eligibility_applications.submitted_by`.
- `sis_students(id)` — soft FK on `fds_student_dietary_profiles`, `fds_student_allergen_alerts`, `fds_dietary_update_requests`, `fds_eligibility_applications`, `fds_eligibility_determinations`.
- `sis_academic_years(id)` — soft FK on `fds_eligibility_applications`, `fds_usda_reimbursement_claims`.
- `hlth_health_alerts(id)` — soft polymorphic FK on `fds_student_allergen_alerts.source_health_alert_id`. Read at sync time only.

What does not change: every existing module continues to function. Cycle 20 is purely additive on a clean `fds_*` namespace.

---

## Step 1 — Menu + Item Catalogue Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/068_fds_menus.sql`. 4 logical base tables.

- `fds_menu_cycles` — UNIQUE(school_id, name); `cycle_length_days INT > 0` CHECK; `is_active BOOLEAN DEFAULT true`.
- `fds_menu_items` — 5-value `category` CHECK (MAIN, SIDE, DESSERT, DRINK, SNACK); `allergen_codes TEXT[] NOT NULL DEFAULT '{}'` for the structured POS cross-check; `allergens TEXT[]` free-text for display; bool flags `is_vegetarian` / `is_vegan` / `is_gluten_free` / `is_preorderable`. **GIN INDEX (school_id, allergen_codes)** for the allergen cross-reference hot path. INDEX(school_id, category).
- `fds_daily_menus` — UNIQUE(school_id, menu_date, meal_type); 4-value `meal_type` CHECK (BREAKFAST, LUNCH, DINNER, SNACK); soft FK to `fds_menu_cycles`.
- `fds_daily_menu_items` — UNIQUE(daily_menu_id, menu_item_id); `quantity_prepared / quantity_served / quantity_wasted` non-negative CHECKs.

---

## Step 2 — POS + Transactions + Reconciliation Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/069_fds_pos_transactions.sql`. 4 logical base tables.

- `fds_pos_devices` — 3-value `device_type` CHECK (CASHIER_STAFFED, SELF_SERVICE_KIOSK, MOBILE_CART); `is_active BOOLEAN`; UNIQUE(school_id, device_name).
- `fds_meal_service_sessions` — 4-value `meal_type` CHECK; UNIQUE(school_id, service_date, meal_type); multi-column `closed_chk` keeps `closed_at` consistent with state.
- `fds_meal_transactions` — **POS TRANSACTION with ALLERGEN SAFETY**. 2-value `patron_type` CHECK (STUDENT, STAFF), 5-value `payment_method` CHECK (LUNCH_ACCOUNT, INVOICE, CASH, FREE_MEAL, STAFF_ACCOUNT), `items JSONB`, `total NUMERIC(6,2) >= 0` CHECK, `allergen_override_required BOOLEAN`, `supervisor_override_id UUID` nullable + multi-column `override_chk` (TRUE requires supervisor_override_id NOT NULL). INDEX(patron_id, served_at DESC). Partition-ready for RANGE(served_at).
- `fds_cash_drawer_reconciliation` — 3-value `status` CHECK (OPEN, RECONCILED, VARIANCE_FLAGGED); UNIQUE(session_id, pos_device_id); multi-column `reconciled_chk` keeps `reconciled_by` + `reconciled_at` in lockstep with the non-OPEN states.

---

## Step 3 — Dietary + Allergen + Eligibility + Safety Schema (pending)

**Migration:** `packages/database/prisma/tenant/migrations/070_fds_dietary_eligibility.sql`. 8 logical base tables.

- `fds_student_dietary_profiles` — UNIQUE on `student_id`; 6-value `meal_plan_type` CHECK (STANDARD, VEGETARIAN, VEGAN, HALAL, KOSHER, OTHER); `free_meal_eligible BOOLEAN DEFAULT false` mirrors NSLP determination.
- `fds_student_allergen_alerts` — **SAFETY KEYSTONE**. 3-value `severity` CHECK (INFO, WARNING, CRITICAL); soft `source_health_alert_id` UUID to `hlth_health_alerts`; **partial UNIQUE(student_id, allergen_code) WHERE is_active=true**.
- `fds_dietary_update_requests` — 6-value `change_type` CHECK; 3-value `status` CHECK; multi-column `reviewed_chk` lockstep on `reviewed_by`+`reviewed_at`.
- `fds_eligibility_applications` — 3-value `application_type` CHECK (INCOME_BASED, CATEGORICAL, DIRECT_CERTIFICATION); 5-value `status` CHECK; `annual_household_income NUMERIC(10,2)` (encrypted-at-rest is Phase 2 ops; for now it's plain text per the plan).
- `fds_eligibility_determinations` — 4-value `eligibility_category` CHECK (FREE, REDUCED, PAID, DENIED); UNIQUE on `application_id`; `effective_chk` requires `effective_to >= effective_from`.
- `fds_usda_reimbursement_claims` — 4-value `status` CHECK (DRAFT, SUBMITTED, APPROVED, REJECTED); meal counts non-negative CHECK; UNIQUE(school_id, academic_year_id, month_year).
- `fds_temperature_logs` — 7-value `check_location` CHECK; `is_compliant BOOLEAN NOT NULL` auto-computed by the service from the (`safe_range_min`, `safe_range_max`) range; multi-column `corrective_chk` requires `corrective_action` when `is_compliant=false`. Partial INDEX `(school_id, is_compliant, logged_at DESC) WHERE is_compliant=false` for the non-compliant dashboard.
- `fds_production_records` — UNIQUE(school_id, meal_service_date, meal_type, menu_item_id); meal counts non-negative CHECKs.

**Cycle 20 schema phase total:** 16 fds\_\* tables, ~20 intra-tenant FKs, 0 cross-schema FKs. Tenant base table count: 263 → **279**.

---

## Step 4 — Seed Data + FDS-001..004 IAM grants (pending)

**`packages/database/src/seed-food-service.ts`** (idempotent, gated on `fds_menu_cycles` row count) wired as `seed:food-service`. Sections:

- **A) 1 menu cycle + 8 items**: "Week A" (5 days). Items with realistic `allergen_codes`.
- **B) 2 daily menus + items**: Monday + Tuesday lunch.
- **C) 1 POS device + 1 session**: "Main Cafeteria Register" CASHIER_STAFFED. Yesterday's LUNCH session COMPLETED with 3 transactions.
- **D) 3 sample transactions**: Maya (LUNCH_ACCOUNT $3.50), Ethan (CASH $3.50), free-meal student (FREE_MEAL $0.00).
- **E) 3 dietary profiles**: Maya STANDARD, Ethan STANDARD, third student VEGETARIAN + free_meal_eligible=true.
- **F) 2 allergen alerts (SAFETY KEYSTONE SEED)**: Maya PEANUTS CRITICAL + Ethan MILK CRITICAL. Mirrors Cycle 10 hlth_health_alerts.
- **G) 1 NSLP application + determination**: Third student CATEGORICAL (SNAP), APPROVED FREE.
- **H) 2 temperature logs**: Walk-in fridge 3.2°C compliant; Hot hold 58°C NON-COMPLIANT with corrective action.
- **I) 1 cash reconciliation**: Yesterday's session opening $50, expected $57, actual $56.85, variance -$0.15, VARIANCE_FLAGGED.

**`seed-iam.ts`** — FDS-001..004 already in catalogue. Grants:

- Teacher / Student / Parent: `FDS-001:read` (view menus).
- Parent: `FDS-003:read` (view child's dietary profile + eligibility).
- Staff (covers FSM): `FDS-001:read+write`, `FDS-002:read+write`, `FDS-003:read+write`, `FDS-004:read+write`.
- School Admin / Platform Admin: all 4 codes admin tier via everyFunction.

---

## Step 5 — Menu + Item Catalogue NestJS Module (pending)

**`apps/api/src/food-service/`** — FoodServiceModule. Step 5 services:

- `MenuCycleService` — 3 endpoints under `fds-001:read/write` (list / create / patch).
- `MenuItemService` — 5 endpoints — list with category + allergen filters using GIN, get, create, patch, `GET /food-service/menu-items/allergen-check?codes=…` returning items containing any of the supplied allergens via `&&` array-overlap operator.
- `DailyMenuService` — 4 endpoints — list by date range, get-by-(date, mealType), create, add items to a daily menu, plus `POST /food-service/daily-menus/generate-from-cycle` for bulk generation.

---

## Step 6 — POS + Transaction NestJS Module — allergen keystone (pending)

- `PosService` — 3 endpoints under `fds-002:read/write` (devices CRUD).
- `SessionService` — 4 endpoints — list / get / open / close (close triggers reconciliation row creation).
- **`TransactionService`** — **ALLERGEN CROSS-CHECK KEYSTONE**:
  - `POST /food-service/transactions` resolves patron's active alerts → for each item, intersects `item.allergen_codes` with `alert.allergen_code` per severity → CRITICAL match returns **422 BLOCKED** with matched allergens unless `supervisorOverrideId` supplied → WARNING match returns 200 with `warnings` array → INSERT transaction with `allergen_override_required` flag set when an override was used.
  - `GET /food-service/patron/:patronId/check-allergens` — pre-scan allergen check before transaction (returns active alerts so the cashier UI can pre-warn).
  - `GET /food-service/transactions` — by session / patron / date.
  - Emits `fds.transaction.completed` after every successful INSERT.
- `ReconciliationService` — 2 endpoints (get + patch with auto-variance compute and VARIANCE_FLAGGED when `|variance| > $1.00`).

---

## Step 7 — Dietary + Eligibility + Safety NestJS Module (pending)

- `DietaryProfileService` — `GET/PATCH /food-service/dietary-profiles/:studentId`; `GET/POST/PATCH /food-service/dietary-update-requests` with parent submit + FSM approve/reject.
- `AllergenAlertService` — `GET /food-service/allergen-alerts/:studentId` + `GET /food-service/allergen-alerts` school-wide. **Manual sync admin endpoint** `POST /food-service/allergen-alerts/sync` (admin-only) that reads `hlth_health_alerts` directly and upserts `fds_student_allergen_alerts` keyed on `source_health_alert_id`. The Kafka consumer wiring on `hlth.allergy_alert.changed` is Phase 2 per the plan.
- `EligibilityService` — NSLP applications + determinations + USDA monthly claim generation (aggregates from `fds_meal_transactions` by `payment_method`).
- `TemperatureLogService` — `GET / POST` with `is_compliant` auto-computed at submit time from the supplied range; non-compliant dashboard endpoint.
- `ProductionRecordService` — USDA meal pattern compliance documentation.

---

## Step 8 — Food Service UI: Menus + POS + Sessions (pending)

- `Food Service` launchpad tile gated on `fds-001:read` with `routePrefix: '/food-service'` + new `UtensilsIcon`.
- `/food-service` dashboard — FSM view: today's menu, active session status, transaction count, pending dietary requests, non-compliant temp alerts. Student/parent view: today's menu with per-item allergen pills.
- `/food-service/menus` planner — cycle editor + daily menu viewer/editor + item catalogue with allergen filter chips.
- **`/food-service/pos` checkout — SAFETY KEYSTONE UI**: patron ID input → allergen warning panel (rose banner for CRITICAL with "BLOCKED — Supervisor Override Required" + supervisor PIN/ID input; amber for WARNING) → item selector → payment picker → submit.
- `/food-service/sessions` — open/close + cash reconciliation form with auto-variance + VARIANCE_FLAGGED badge.

---

## Step 9 — Food Service UI: Dietary + Eligibility + Safety + Parent (pending)

- `/food-service/dietary` — student dietary profiles with allergen alert indicators + dietary update request queue + allergen heatmap.
- `/food-service/eligibility` — NSLP application list + determination form + effective date range.
- `/food-service/safety` — temperature log entry + non-compliant dashboard + production record entry.
- `/food-service/usda-claims` — monthly claim generator with status workflow (DRAFT → SUBMITTED → APPROVED).
- `/children/[id]/food-service` parent portal — child's dietary profile + meal plan + active allergen alerts + today's menu with allergen indicators + dietary update request modal + NSLP application form + meal transaction history.

---

## Step 10 — Vertical Slice Integration Test (pending)

`docs/cycle20-cat-script.md` — schema preamble + 10 plan scenarios end-to-end on `tenant_demo`:

1. Menu setup with GIN allergen query verified.
2. POS session + clean transaction + `fds.transaction.completed` Kafka envelope captured.
3. **Allergen BLOCK keystone** — Ethan + Grilled Cheese → 422 → retry with `supervisorOverrideId` → 201 with `allergen_override_required=true`.
4. Free meal — payment_method=FREE_MEAL, total=$0.00.
5. Cash reconciliation — variance=-$0.15, VARIANCE_FLAGGED.
6. Temperature log — compliant + non-compliant with corrective action.
7. Parent dietary update — David Chen submits HALAL ADD_RESTRICTION for Maya, FSM approves.
8. NSLP eligibility — INCOME_BASED → FREE → dietary profile auto-flips.
9. USDA claim — admin generates monthly claim; counts match transactions.
10. Visibility — student/parent/teacher/FSM roles each see appropriate slices.

---

## Wave 4 status — IN PROGRESS

Cycle 20 is the **second cycle of Wave 4 (Campus Operations)**, following Cycle 19 (Transportation). Cycle 21 (Facilities Management) continues Wave 4. The 15 deferred Cycle 20 tables (recipe costing, full inventory management, student pre-order system, staff meal accounts) move to Cycle 20.1.
