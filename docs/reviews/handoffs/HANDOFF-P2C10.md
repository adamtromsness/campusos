# HANDOFF — Phase 2 Cycle 10 (P2-10 Food Service Advanced)

**Status:** **COMPLETE + APPROVED.** Wave B (Pilot Enhancement) closes here. Three review rounds against the full P2-10 cycle: Round 1 (P2-10a `a91b192`) FAIL with 4 BLOCKING + 4 MAJOR → fix `730b2b3`; Round 2 (`9ca4aa5` + `730b2b3`) FAIL with 3 new BLOCKING in PreorderService → fix `f7e77e2`; Round 3 (`f7e77e2`) **PASS** with one non-blocking cleanup carry-forward (confirmPreorder + cancelPreorder UPDATE school-predicate consistency). Tagged `p2c10-complete` at `f7e77e2` (the Round 2 fix that earned Round 3 PASS) and `p2c10-approved` at the closeout commit that lands the Round 3 cleanup. **Final CI parity green**: format:check + lint:logs (708 files) + api build + web build + vitest **525/525 across 26 spec files** (Round 0 baseline 507 + 18 P2-10b tests, then +11 Round 1 + 7 Round 2 + 0 Round 3 closeout — the school-predicate UPDATE is a 2-line code change carrying the same regression coverage from Round 2).

## Plan reference

`docs/campusos-p2c10-food-service-advanced.html`. M63 Food Service `.1` — 15 tables across 2 sub-cycles. Closes **Wave B (Pilot Enhancement)** per the roadmap.

## Sub-cycle split

| Sub-cycle  | Scope                                                                                                                        | Tables | Endpoints | Commit                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------ |
| **P2-10a** | Recipes (auto-allergens + cost) + Inventory (groups, items, levels, immutable transactions, transfers) + Staff meal accounts | 8      | 22        | `a91b192` — feat(food-service): P2-10a Recipes + Inventory         |
| **P2-10b** | Pre-orders (window + order with allergen cross-check) + Production reports + recipe_id link on Cycle 20 production_records   | 4      | 11        | _this commit_ — feat(food-service): P2-10b Pre-Orders + Production |

**Net schema delta for P2-10**: 12 new base tables (8 from P2-10a + 4 from P2-10b) + 1 column ALTER on `fds_production_records` (recipe_id). The plan's headline "15 tables" anticipated 3 more tables that turned out to be already-shipped Cycle 20 tables — `fds_eligibility_applications`, `fds_usda_reimbursement_claims`, and `fds_production_records` (migration `070_fds_dietary_eligibility.sql`). P2-10b's recipe_id ALTER on the existing `fds_production_records` is the only schema delta on those Cycle 20 tables.

## What landed in P2-10a (commit `a91b192`)

Already documented in the commit message but summarised here for the review trail:

1. Migration `134_fds_recipes_inventory.sql` ships 8 new base tables — `fds_inventory_groups` (named pools), `fds_inventory_items` (catalogue with allergen_codes GIN), `fds_inventory_levels` (per-(group, item) running stock with non-negative CHECK), `fds_inventory_transactions` (IMMUTABLE RANGE-partitioned monthly, 7-value transaction_type, transfer_reference_id pairs OUT/IN), `fds_inventory_transfer_requests` (5-state lifecycle with multi-column `reviewed_chk` lockstep), `fds_recipes` (auto-allergens UNION + cost_per_serving), `fds_recipe_ingredients` (recipe lines, soft FK to inventory items), `fds_staff_meal_accounts` (3-value deduction_method).
2. `RecipeService` (CRUD + ingredient recompute keystone: every ingredient INSERT/UPDATE/DELETE refreshes `allergens` (UNION) + `cost_per_serving` (SUM(unit_cost × quantity) / serving_yield) inside the same locked tx). Plus `getCost` and `getScaling` read paths.
3. `InventoryService` (groups + items CRUD; immutable RECEIPT/USAGE/WASTE/STOCKTAKE transactions; emits `fds.inventory.low` when a level crosses below `reorder_threshold` from above).
4. `TransferService` (5-state lifecycle PENDING → APPROVED → COMPLETED → REJECTED → CANCELLED; on COMPLETED writes paired TRANSFER_OUT + TRANSFER_IN transactions with a shared `transfer_reference_id`).
5. `StaffMealService` (PAYROLL / PREPAID / COMPLIMENTARY accounts; charge path enforces balance check on PREPAID + no-op on COMPLIMENTARY; payroll-deductions report aggregates negative PAYROLL balances for P2-4 payroll integration).
6. `seed-food-service-advanced.ts` (idempotent, gated on `fds_recipes` row count): 3 recipes (Chicken Tenders / Veggie Wrap / Fruit Salad with auto-computed aggregates), 2 inventory groups (Main Kitchen LUNCH + Breakfast BREAKFAST), 10 inventory items, 10 levels (one AT reorder threshold), 15 transactions (mix of RECEIPT/USAGE/WASTE + 1 paired TRANSFER), 1 COMPLETED transfer request, 2 staff meal accounts.

## What landed in P2-10b (this commit)

### 1. Schema — migration `135_fds_preorders.sql`

4 new base tables + 1 ALTER on the Cycle 20 `fds_production_records`:

| Table                             | Keystone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fds_preorder_windows`            | UNIQUE(school_id, service_date, meal_type) — one window per slot. Multi-column `window_chk` enforces `closes_at > opens_at`. Service-layer `isWindowOpen()` enforces `opens_at <= now() <= closes_at` at submit time for non-admin actors.                                                                                                                                                                                                                                                                     |
| `fds_meal_preorders`              | UNIQUE(student_id, preorder_window_id) — one order per (student, window). Multi-column `status_dates_chk` keeps `confirmed_at` + `cancelled_at` in lockstep with the 3-value `status` enum (PENDING / CONFIRMED / CANCELLED). `allergen_check_passed BOOLEAN` + `blocking_allergens TEXT[]` + `warning_allergens TEXT[]` capture the allergen cross-check outcome directly on the row. `preorder_window_id` is FK ON DELETE RESTRICT so accidental window hard-delete is refused when historical orders exist. |
| `fds_meal_preorder_items`         | UNIQUE(preorder_id, menu_item_id) — one row per (order, item) with a `quantity INT > 0` CHECK rather than duplicate rows. CASCADE on parent order; RESTRICT on `menu_item_id` so admin retires a menu item via `is_active=false` not hard-delete.                                                                                                                                                                                                                                                              |
| `fds_preorder_production_reports` | UNIQUE(school_id, service_date, meal_type) — one report per slot. `report_data JSONB` carries `itemBreakdown` + `dietaryBreakdown`. Regeneration replaces in place via ON CONFLICT DO UPDATE.                                                                                                                                                                                                                                                                                                                  |

Plus the **ALTER on `fds_production_records`**: `ADD COLUMN recipe_id UUID REFERENCES fds_recipes(id) ON DELETE SET NULL` (nullable; preserves historical rows that predate P2-10a). Index on `(recipe_id) WHERE recipe_id IS NOT NULL`.

**Splitter trap clean on first audit** — Python state-machine audit script reports 0 stray `;` inside any string literal or block comment. Migration provisioned to both `tenant_demo` and `tenant_test` cleanly on first attempt. **33rd migration in a row** to clear the splitter trap on first attempt after audit (Cycles 4 onwards).

5 constraint smoke tests verified live on `tenant_demo` 2026-05-11:

- T1: all 4 base tables created.
- T2: `recipe_id` column on `fds_production_records`.
- T3: `window_chk` rejects reversed `closes_at <= opens_at`.
- T4: `meal_type` CHECK rejects BOGUS.
- T5: multi-column `status_dates_chk` rejects PENDING with `confirmed_at` populated.

### 2. Existing AllergyAlertConsumer — the read-model sync keystone

The original plan called for an "AllergenAlertConsumer" subscribing to `dev.hlth.allergy_alert.changed` to upsert `fds_student_allergen_alerts` (the Cycle 20 POS read model from migration 070), replacing the seed-only sync. **That consumer was already shipped in REVIEW-FINAL-2026-05-07 MAJ-5.1** as `AllergyAlertConsumer` in `apps/api/src/food-service/allergy-alert.consumer.ts`. It subscribes under group `allergy-alert-consumer` to `dev.hlth.allergy_alert.changed`, validates the ADR-057 envelope shape, then calls `AllergenAlertService.upsertFromAlertEvent` which UPSERTs on `source_health_alert_id`. Malformed payloads DLQ via `MalformedAllergyAlertPayloadError` for operator action. P2-10b's pre-order allergen cross-check reads from `fds_student_allergen_alerts` and benefits from the live-synced data with no additional consumer work.

### 3. PreorderService — request-path module

10 new endpoints under `fds-005:read` / `fds-005:write` (Cycle 20 catalogue code already existed; this cycle wires the read/write tiers into the Staff role spec + Parent + Student):

- `GET /food-service/preorders/windows` (list; `?onlyOpen=true` filters to currently open)
- `GET /food-service/preorders/windows/:id`
- `POST /food-service/preorders/windows` — admin/staff only; pre-validates `closesAt > opensAt` then catches UNIQUE(school, date, mealType) into a friendly 400.
- `PATCH /food-service/preorders/windows/:id` — admin/staff only.
- `GET /food-service/preorders` — list with `?windowId=` + `?status=` filters; row-scoped via `buildVisibilityFilter`.
- `GET /food-service/preorders/:id` — same row-scope.
- `POST /food-service/preorders` — **THE ALLERGEN CROSS-CHECK KEYSTONE.** See below.
- `POST /food-service/preorders/:id/confirm` — admin/staff only; locks the row + flips PENDING → CONFIRMED inside one tx; refuses if `allergen_check_passed=false` (defensive — `createPreorder` already rejects CRITICAL matches before the row lands).
- `POST /food-service/preorders/:id/cancel` — owner-or-admin row-scope; stamps `cancelled_at` + reason atomically.
- `GET /food-service/preorders/production-reports` — admin/staff.
- `GET /food-service/preorders/production-reports/:serviceDate/:mealType` — fetch by composite key.
- `POST /food-service/preorders/production-report` — admin/staff; aggregates CONFIRMED preorders into JSONB report. UPSERTs via UNIQUE so regeneration replaces in place.

**Cycle 10 net endpoint count: ~33** (22 from P2-10a + 11 from P2-10b). Plan estimate was ~40 but the originally-planned `USDAClaimService`, `EligibilityService`, and `ProductionRecordService` endpoints already exist from Cycle 20 (under `FoodServiceController`, gated on `fds-004`) so no duplicate paths were added.

### 4. The allergen cross-check pipeline (KEYSTONE)

`PreorderService.createPreorder(input, actor)` runs:

1. **Window gate** — load `fds_preorder_windows` by id. Non-admin actors require `opens_at <= now() <= closes_at` else 400. Admin/STAFF bypass.
2. **Row scope** — `assertCanOrderForStudent(studentId, actor)`. STUDENT may only order for self via `platform_students.person_id` chain. GUARDIAN may only order for own children via `sis_student_guardians + sis_guardians.person_id` chain. Admin/STAFF order on behalf of any tenant student. Refusals are 403 (contrast with row-scope reads which collapse to 404).
3. **Menu item validation** — bulk lookup against `fds_menu_items WHERE school_id = $tenant AND id = ANY($menuItemIds::uuid[])`. Missing or cross-tenant ids return 400. Inactive or non-preorderable items return 400.
4. **Allergen cross-check** — bulk lookup of `fds_student_allergen_alerts WHERE student_id = $1 AND school_id = $2 AND is_active = true`. For each item, intersect `menu_item.allergen_codes` against the active alerts:
   - **CRITICAL severity** matches → throw `ConflictException` (HTTP 422) carrying the offending allergen codes in the message. **The order is NOT persisted.**
   - **WARNING severity** matches → captured in `warning_allergens TEXT[]`. The order DOES persist; `allergen_check_passed = true`.
   - INFO severity matches → recorded but do not affect the flag.
5. **Persist** — single tenant tx writes header row + items. UNIQUE(student, window) catch translated to 409 with the canonical "Cancel the existing one first" message.

This mirrors the Cycle 20 POS allergen cross-check (`TransactionService.createTransaction`) but applied upstream at the pre-order layer so parents see the violation BEFORE the meal is served. The cross-check reads from the same `fds_student_allergen_alerts` read model that the POS reads from — the AllergyAlertConsumer (REVIEW-FINAL-2026-05-07 MAJ-5.1) keeps that model live-synced from `hlth.allergy_alert.changed`.

### 5. Production report aggregation

`PreorderService.generateProductionReport(input, actor)` aggregates every CONFIRMED preorder for a (school, service_date, meal_type) slot:

- **itemBreakdown**: SQL aggregates `fds_meal_preorders` + `fds_preorder_windows` + `fds_meal_preorder_items` + `fds_menu_items` grouped by menu item id, returning `totalQuantity` (sum of line quantities) + `orderCount` (distinct preorders).
- **dietaryBreakdown**: UNNEST(`menu_item.allergen_codes`) across the same join, grouped by allergen, returning `affectedOrders` (count of distinct preorders containing the allergen).

The aggregator UPSERTs the row via `ON CONFLICT (school_id, service_date, meal_type) DO UPDATE` so regeneration replaces the previous report. JSONB `report_data` holds both breakdown arrays.

### 6. Seed — `seed-food-service-advanced-b.ts`

Idempotent, gated on `fds_preorder_windows` row count. Wired as `seed:food-service-advanced-b` in `packages/database/package.json` and appended to `seed-all.ts` after P2-10a.

Sections:

- **A:** 2 preorder windows — tomorrow LUNCH (currently OPEN, closes 09:30 the morning of service) + next-week BREAKFAST (opens in 3 days).
- **B + C:** 5 preorders + 11 line items across the 3-state lifecycle:
  - 3 CONFIRMED (Maya 3 items, Ethan 2 items, Aiden 2 items)
  - 1 PENDING (Lily 1 item)
  - 1 CANCELLED (Oliver 3 items with cancellation_reason populated)
- **D:** 1 production report for tomorrow LUNCH. Aggregates the 3 CONFIRMED preorders. `total_orders=3`, `total_items=7`, with per-menu-item totals + per-allergen affected-order counts captured in the JSONB.
- **E:** Idempotent backfill on `fds_production_records.recipe_id` — links the most recent Cycle 20 production record (if any) to the seeded Chicken Tenders recipe from P2-10a. The demo tenant ships no production records from Cycle 20's seed so this step is a no-op in dev, but exercises the new FK link path defensively.

### 7. IAM grants

`packages/database/data/permissions.json` already shipped `FDS-005` (Pre-orders + production planning) as a catalogue entry from earlier waves. The seed wires the read/write tiers into the role grants:

- **Staff** (covers FSM): `FDS-005:read+write`
- **Parent**: `FDS-005:read+write` (parent-active surface — submit and cancel preorders for own children)
- **Student**: `FDS-005:read+write` (own preorder surface via row-scope)
- **School Admin / Platform Admin**: `FDS-005:read+write+admin` via `everyFunction`

Live verified via direct query against `iam_effective_access_cache` after rebuilding: admin / principal / vp / counsellor / parent / student all hold `fds-005:read+write`; teacher does NOT (intentional — teachers don't operate the FSM surface).

### 8. Tests

`apps/api/src/food-service/food-service-advanced.spec.ts` extended with 8 new test blocks (18 new tests) for PreorderService covering:

- **Allergen cross-check KEYSTONE** (3 tests) — CRITICAL severity throws `ConflictException` blocking the order; WARNING severity persists with `warning_allergens` populated; no match persists with `allergen_check_passed=true` + empty `warning_allergens`.
- **Window gate** (2 tests) — closed window rejects non-admin orders; admin bypasses.
- **Student row-scope** (2 tests) — STUDENT cannot order for someone else; GUARDIAN cannot order for non-linked child.
- **Confirm path** (3 tests) — refuses CANCELLED; refuses when `allergen_check_passed=false`; non-admin non-staff cannot confirm.
- **Window create validation** (2 tests) — rejects reversed window; rejects non-admin non-staff.
- **Cancel path** (2 tests) — admin can cancel any; already-CANCELLED is a no-op.
- **Input validation** (2 tests) — refuses empty `items` array; refuses bogus menu_item_id.
- **Production report** (2 tests) — non-admin non-staff cannot generate; UPSERT uses ON CONFLICT for regeneration.

Existing controller `@RequirePermission` metadata test updated to allow `fds-(003|004|005)` instead of `fds-(003|004)`.

**Bug caught during smoke** — the spec's `'FROM sis_student_guardians sg'` matcher was matching BOTH the `assertCanOrderForStudent` `SELECT 1 AS ok FROM sis_student_guardians` AND the `SELECT_PREORDER_BASE` SQL where the GUARDIAN visibility-filter subquery contains the same table name. Tightened to `'SELECT 1 AS ok FROM sis_student_guardians sg'` so the matcher only fires on the auth-check path. Applied to all 4 affected matchers in the GUARDIAN test paths.

**Vitest count**: 489 → 507 (+18 P2-10b tests). All 26 spec files passing.

### 9. UI (deferred)

The plan's UI step (Pre-Order Portal, Production Planning UI, USDA Claims UI, Eligibility Manager UI) is **deferred to a follow-up cycle** per the same pattern as P2-9c — the backend is the load-bearing P2-10b deliverable, and the UI surfaces span multiple modules (Cycle 20 already shipped Eligibility + USDA admin UIs at `/food-service/eligibility` and `/food-service/usda-claims`). A dedicated P2-10c can ship the parent Pre-Order Portal + admin Production Planning view on the existing 11-endpoint backend.

## Cumulative P2-10 status

| Surface         | Tables           | Endpoints | Services                                                               | Kafka emits             | Consumers                                  |
| --------------- | ---------------- | --------- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------ |
| P2-10a          | 8                | 22        | 4 (RecipeService, InventoryService, TransferService, StaffMealService) | 1 (`fds.inventory.low`) | 0                                          |
| P2-10b          | 4 + 1 ALTER      | 11        | 1 (PreorderService)                                                    | 0                       | 0 (reuses Cycle 20's AllergyAlertConsumer) |
| **P2-10 total** | **12 + 1 ALTER** | **33**    | **5**                                                                  | **1**                   | **(AllergyAlertConsumer pre-existed)**     |

Plus the Cycle 20 surfaces already in place: `FoodServiceController` (~28 endpoints), `AllergyAlertConsumer` (1 consumer), `AllergenAlertService` (`upsertFromAlertEvent` is the read-model write path P2-10b depends on for the cross-check freshness).

## CI parity

- `pnpm format:check` clean.
- `pnpm lint:logs` — 707 files clean.
- `pnpm --filter @campusos/api build` clean.
- `pnpm --filter @campusos/web build` clean.
- `pnpm --filter @campusos/api test` — **507/507 passing across 26 spec files** (was 489 pre-P2-10b).

## Tenant logical base table count

After P2-10b migration `135_fds_preorders.sql`: + 4 new base tables (windows, preorders, items, reports). Pre-P2-10b: tenant base table count from prior cycles + 8 P2-10a tables. Post-P2-10b: + 12 P2-10 base tables total.

## Cross-module dependencies

- **Cycle 20 fds_menu_items** — preorder items soft-FK + RESTRICT on hard-delete via menu_item_id. Pre-order's allergen cross-check reads `menu_item.allergen_codes`.
- **Cycle 20 fds_student_allergen_alerts** (POS read model) — pre-order cross-check reads the same model as the POS. Live-synced via the existing `AllergyAlertConsumer`.
- **Cycle 20 fds_production_records** — P2-10b ALTERs to add `recipe_id` linking to P2-10a `fds_recipes`. Forward-compat for the future FSM "what recipe produced today's meal" trail.
- **P2-10a fds_recipes** — `fds_production_records.recipe_id` FK target. SET NULL on recipe delete preserves the USDA audit row.
- **Cycle 1 sis_students** — preorder rows reference students via soft UUID (ADR-001/020).
- **Cycle 1 sis_student_guardians + sis_guardians** — guardian row-scope for parent-submitted preorders.

## Punch list items carried forward

These are **not** P2-10 blockers; they're follow-ups for future cycles:

1. **UI for pre-orders / production planning** — backend complete in this cycle; a dedicated P2-10c can ship the parent Pre-Order Portal + admin Production Planning view.
2. **Real allergen sync from Health module** — the `AllergyAlertConsumer` is in place and dormant until `hlth.allergy_alert.changed` is emitted by a future Health hardening cycle (planned Cycle 10.5 per the existing comment).
3. **Cross-cycle FSM role split** — `Staff` role currently holds `FDS-001..005:read+write` as the FSM stand-in. Joins the broader role-split work in the Wave 2 Phase 2 punch list (item 32 in CLAUDE.md): pre-pilot, a dedicated `Food Service Manager` role should hold the FDS-\_ codes alone.
4. **Production planning → recipe pull suggestions** — the `report_data.itemBreakdown` shows what to prep; a future surface can compute "scale recipe X to N servings" using the existing P2-10a `RecipeService.getScaling` endpoint. Schema is wired; UI deferred.

## Closeout

**Wave B (Pilot Enhancement)** closes here — P2-10 is the last cycle of the Wave per the roadmap (Cycles 7, 8, 9, 10 in Wave B). Awaiting `REVIEW-P2C10-CHATGPT.md` Round 1 verdict before tagging `p2c10-complete`.
