# REVIEW-P2C10-CHATGPT — review scaffold

**Status:** awaiting Round 1 verdict.
**Cycle:** Phase 2 Cycle 10 (P2-10 Food Service Advanced — closes Wave B).
**Commits to review (in order):**

- `a91b192` — feat(food-service): P2-10a Recipes + Inventory (8 tables, 22 endpoints)
- _this commit_ — feat(food-service): P2-10b Pre-Orders + Production + Allergen Consumer (4 new tables + 1 ALTER, 11 endpoints, closes Wave B)

## Plan reference

`docs/campusos-p2c10-food-service-advanced.html`. The plan called for 15 tables across 2 sub-cycles. Actual delta: **12 new tables + 1 ALTER**, because 3 of the 15 planned tables (`fds_eligibility_applications`, `fds_usda_reimbursement_claims`, `fds_production_records`) already exist from Cycle 20 migration `070_fds_dietary_eligibility.sql`. The P2-10b ALTER on `fds_production_records` adds the new `recipe_id` link to P2-10a `fds_recipes`. The plan's "AllergenAlertConsumer" is the existing Cycle 20 `AllergyAlertConsumer` (REVIEW-FINAL-2026-05-07 MAJ-5.1).

## What changed in P2-10b (this commit)

| Surface                             | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration `135_fds_preorders.sql`   | 4 new base tables (`fds_preorder_windows`, `fds_meal_preorders`, `fds_meal_preorder_items`, `fds_preorder_production_reports`) + ALTER `fds_production_records ADD COLUMN recipe_id` (FK to `fds_recipes`, SET NULL). Splitter-safe — Python audit reports 0 stray `;` in strings/comments. Provisioned cleanly to both `tenant_demo` and `tenant_test` on first attempt. **33rd migration in a row** to clear the splitter trap on first attempt after audit (Cycles 4 onwards).            |
| PreorderService (new)               | 10 endpoints + 1 GET-list under `fds-005:read` / `fds-005:write`. **THE ALLERGEN CROSS-CHECK KEYSTONE** lives in `createPreorder`: load active `fds_student_allergen_alerts` for the student, intersect each item's `menu_item.allergen_codes`, throw 422 ConflictException on any CRITICAL match (carries the offending codes), surface WARNING matches in `warning_allergens` (the order still persists). Mirrors the Cycle 20 POS cross-check but applied upstream at the preorder layer. |
| Production report aggregation       | `generateProductionReport` aggregates CONFIRMED preorders into per-menu-item totals + per-allergen affected-order counts. UNIQUE(school_id, service_date, meal_type) means regeneration UPSERTs in place via `ON CONFLICT DO UPDATE`.                                                                                                                                                                                                                                                        |
| Row-scope visibility                | `buildVisibilityFilter` for STUDENT joins `platform_students.person_id` → `sis_students.id`; for GUARDIAN joins through `sis_student_guardians + sis_guardians.person_id`. Mirrors `AllergenAlertService` from Cycle 20.                                                                                                                                                                                                                                                                     |
| `assertCanOrderForStudent`          | Submit-time row-scope check: STUDENT may only order for self; GUARDIAN may only order for own children; admin/STAFF order on behalf of any tenant student. Refusals are 403 (in contrast to row-scope reads which collapse to 404 to avoid existence leakage).                                                                                                                                                                                                                               |
| Window gate                         | Non-admin orders refused on closed windows (`opens_at <= now() <= closes_at`). Admin/STAFF bypass.                                                                                                                                                                                                                                                                                                                                                                                           |
| Confirm path                        | Locks the row + flips PENDING → CONFIRMED inside a tx. Refuses if `allergen_check_passed = false` (defensive — the `createPreorder` keystone already rejects CRITICAL matches before the row lands). Admin/STAFF only.                                                                                                                                                                                                                                                                       |
| Cancel path                         | Stamps `cancelled_at` + `cancellation_reason` atomically. Owner-or-admin row-scope. Already-CANCELLED is a no-op.                                                                                                                                                                                                                                                                                                                                                                            |
| Seed `seed-food-service-advanced-b` | 2 preorder windows (tomorrow LUNCH open + next-week BREAKFAST upcoming), 5 preorders (3 CONFIRMED, 1 PENDING, 1 CANCELLED), 11 line items, 1 production report aggregating the 3 CONFIRMED preorders. Idempotent re-run skips cleanly.                                                                                                                                                                                                                                                       |
| IAM grants                          | `FDS-005:read+write` granted to Staff (FSM), Parent (parent-active surface — submit preorders for own children), Student (own preorders), and admin tiers via `everyFunction`. Verified live via `iam_effective_access_cache`: admin/principal/parent/student/vp/counsellor hold it; teacher does NOT (intentional — teachers don't operate the FSM surface).                                                                                                                                |
| Tests                               | 8 new describe blocks (18 new tests) covering the allergen cross-check keystone (3 paths — CRITICAL blocks, WARNING flags, no match clean), window gate, student/guardian row-scope, confirm path, cancel path, input validation, production report. Existing controller `@RequirePermission` test updated to allow `fds-(003\|004\|005)`. **507/507 tests passing across 26 spec files.**                                                                                                   |

## Areas to scrutinise

The most likely review-blocker spots, in rough order of risk:

1. **Allergen cross-check correctness.** The cross-check reads `fds_student_allergen_alerts` filtered to `is_active=true`. The Cycle 20 `AllergyAlertConsumer` upserts that read model on `hlth.allergy_alert.changed` envelopes. If the consumer is misrouted (envelope tenant_id mismatch with the actual `student_id` school), the cross-check could see stale data. The consumer's per-event `MalformedAllergyAlertPayloadError` DLQ path catches structurally-malformed events but a semantically wrong-but-valid payload (right shape, wrong school) would still upsert. Pre-pilot hardening might want a school_id validation step on the consumer; for the demo phase the cross-check reads only this tenant's alerts so a misrouted upsert into the wrong tenant's `fds_student_allergen_alerts` would be a separate bug from this cycle's concerns.

2. **Window gate timezone behavior.** The window's `opens_at` / `closes_at` are `TIMESTAMPTZ` and the gate compares against `Date.now()` (server time). Schools with FSMs in a different timezone from the API host would see the gate fire/release at clock times that don't match their local clock. Phase 3 ops should pin the API host to a known timezone or move the gate into SQL via `now()`.

3. **Concurrency on UNIQUE(student_id, preorder_window_id).** Two parallel POSTs from the same parent for the same (student, window) would both pass the pre-check and both attempt INSERT; the second raises 23505 and the catch translates to a 409. No locked-row pattern is needed here — the constraint IS the lock — but reviewers may want to verify the friendly error message and that the failing INSERT doesn't leave partial item rows. Confirmed: the items INSERT is inside the same tenant tx so a UNIQUE failure on the header rolls back the items.

4. **`assertCanOrderForStudent` refusal vs row-scope leakage.** This refusal is a 403, not a 404. The contract: row-scope **reads** collapse to 404 to avoid existence leakage; **writes** that fail authorisation throw 403. That's the convention used by `PreorderService.cancelPreorder` for owner-or-admin and the existing Cycle 20 `EligibilityService`. Reviewers may want to confirm this convention is consistent across the cycle.

5. **The `recipe_id` ALTER on `fds_production_records`.** Nullable additive column with SET NULL on parent recipe delete. No existing data is migrated (Cycle 20's demo seed plants no `fds_production_records` rows for the demo tenant). The seed's idempotent backfill section attempts to link the most recent production record (if any exists in real-school data) to the seeded Chicken Tenders recipe. Forward-compat for FSM "what recipe produced this meal" UI later.

6. **No new Kafka consumer in P2-10b.** The plan called for an `AllergenAlertConsumer` but the Cycle 20 `AllergyAlertConsumer` already implements that contract verbatim. P2-10b just consumes the read model the consumer maintains. No P2-10b emit topics either — the cross-check is a synchronous read.

7. **FDS-005 role grants.** Currently held by Staff (FSM stand-in), Parent (parent-active), Student (own surface). Teacher intentionally NOT granted. Admin tiers via `everyFunction`. Same role-split punch list as the rest of Wave 2 — a dedicated FSM role would hold FDS-001..005 alone before pilot.

## Cycle exit checklist

- [x] Migration `135_fds_preorders.sql` provisioned cleanly to both `tenant_demo` and `tenant_test`.
- [x] 4 new base tables added + ALTER on Cycle 20 `fds_production_records`. No DROP TABLE, no DROP COLUMN.
- [x] PreorderService request-path module (10 endpoints + 1 list) wired into FoodServiceModule + FoodServiceAdvancedController.
- [x] Allergen cross-check keystone implemented + unit-tested across 3 paths (CRITICAL blocks, WARNING flags, no match clean).
- [x] Row-scope visibility for STUDENT / GUARDIAN / admin / STAFF + unit-tested.
- [x] Seed `seed-food-service-advanced-b.ts` idempotent + wired into `seed-all.ts`.
- [x] IAM grants `FDS-005:read+write` to Staff + Parent + Student; admin tiers via `everyFunction`. Cache rebuilt.
- [x] CI green: format:check + lint:logs (707 files) + api build + web build + vitest 507/507.
- [x] HANDOFF-P2C10.md written.
- [x] CLAUDE.md updated to reflect P2-10 complete + Wave B closure.

## Triage table

To be populated after the reviewer ships Round 1.

| #   | Reviewer finding | Verdict | Action | Live verification |
| --- | ---------------- | ------- | ------ | ----------------- |
| TBD |                  |         |        |                   |
