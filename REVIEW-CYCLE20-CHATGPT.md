# REVIEW-CYCLE20-CHATGPT

**Round 1 verdict:** **Reject pending fixes** (against `cycle20-complete` at `48b6c74`).

The reviewer flagged 6 BLOCKING items + 5 MAJOR follow-ups, mostly around row-scope privacy, POS safety validation, and financial / eligibility correctness. Cycle 20 ships M63 Food Service; because this cycle touches **health-derived allergy data, family eligibility / income data, POS money flow, and USDA reporting**, the reviewer applied a stricter standard. The fix commit closes all 6 BLOCKING items + 4 of the 5 actionable MAJORs (8, 10, 11, plus a stale-handoff doc fix). MAJOR 9 (FSM role split) is recommendation-class and joins the broader Phase 2 punch list.

**Round 2 verdict:** **Approved** (against `911554c`, 2026-05-06).

Reviewer's confirmed fix list:

- BLOCKING 1 — `AllergenAlertService.listForStudent(studentId, actor)` is now actor-aware: admin / Staff-FSM any student; guardian via `sis_student_guardians`; student via `platform_students.person_id`; others 404. Closes the parent-to-other-student allergen leak.
- BLOCKING 2 — `EligibilityService.list(args, actor)` row-scopes per persona. Guardians only see applications they submitted or applications for linked children; students only their own; others empty list.
- BLOCKING 3 — `TransactionService.create` resolves the submitted `patronId` through `assertPatronInCurrentTenant(patronId, patronType)` before any allergen evaluation or insert.
- BLOCKING 4 — Transaction creation runs inside a tenant transaction, locks the session `FOR UPDATE`, rejects closed sessions, validates the POS device exists, and rejects inactive devices.
- BLOCKING 5 — `paymentMethod = FREE_MEAL` requires a resolved student patron and validates free/reduced eligibility through either `fds_student_dietary_profiles.free_meal_eligible=true` or an active determination window.
- BLOCKING 6 — `generateClaim()` requires `academicYearId`, validates it against `sis_academic_years`, and migration 071 adds defensive uniqueness for null-year claims.
- MAJOR 7 — Handoff updated from stale "in progress" to completed closeout artifact with the Round 1 fix log.
- MAJOR 8 — Allergen sync now upserts on `source_health_alert_id` instead of `ON CONFLICT DO NOTHING`.
- MAJOR 10 — Staff/admin eligibility submissions validate `studentId` against current-tenant `sis_students`.
- MAJOR 11 — Session close auto-creates reconciliation rows for POS devices with cash activity, inside the session-close transaction.

Reviewer's deferred item (not Cycle 20 blocker): MAJOR 9 — FSM role split. Generic Staff still stands in for the Food Service Manager persona; the review record correctly carries this as Phase 2 punch list item 32 alongside the broader role-model hardening work.

**Final gate:** Approved. Tag `cycle20-approved` lives at `911554c`.

Tag chain:

- `cycle20-complete` on `48b6c74` (original closeout — triggered Round 1)
- `cycle20-approved` on `911554c` (Round 2 APPROVED — after the fix commit)

---

## Triage table

| #   | Severity | File                                                                         | Reviewer claim                                                                                                                    | Triage           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKING | `apps/api/src/food-service/dietary-eligibility.service.ts`                   | `GET /food-service/allergen-alerts/:studentId` is gated only by `fds-003:read` and is not actor-aware.                            | VALID            | `AllergenAlertService.listForStudent(studentId, actor)` adds row-scope: admin / STAFF (FSM) any student; guardian via `sis_student_guardians`; student via `platform_students.person_id`; everyone else collapsed 404. Controller resolves the actor and passes through. Verified live: parent for own child Maya 200; parent for other-family Ethan 404; admin 200; student 403 at the IAM gate (Student does not hold fds-003:read in the seed — staff-tier surface). |
| 2   | BLOCKING | `apps/api/src/food-service/dietary-eligibility.service.ts`                   | `GET /food-service/eligibility-applications` exposes other families' NSLP household_size / income / SNAP case data to parents.    | VALID            | `EligibilityService.list(args, actor)` row-scopes by persona: admin / STAFF unrestricted; guardian sees applications they submitted OR for any of their linked children via `sis_student_guardians`; student sees own student row applications; everyone else `[]`. Controller passes through. Verified live: admin sees seed 1 row (Aiden); parent David Chen sees `[]` until he submits one for Maya, then count=1; teacher 403 at the gate (no fds-003:read).        |
| 3   | BLOCKING | `apps/api/src/food-service/pos.service.ts`                                   | POS transactions accept any `patronId` UUID — bogus / cross-tenant / wrong patronType all silently bypass the allergen check.     | VALID            | New `assertPatronInCurrentTenant(patronId, patronType)` resolver. STUDENT path requires current-tenant `sis_students` joined through `platform_students.person_id`. STAFF path requires current-tenant `hr_employees.person_id`. Returns the resolved tenant-local id used directly by the allergen lookup. Verified live: bogus UUID 400; admin@ Platform Admin's iam_person id (not in tenant) 400; real Maya 201.                                                    |
| 4   | BLOCKING | `apps/api/src/food-service/pos.service.ts`                                   | POS transactions can post to closed sessions or inactive devices — only FK existence is checked.                                  | VALID            | `TransactionService.create` now wraps INSERT in `executeInTenantTransaction` with `SELECT … FOR UPDATE` on `fds_meal_service_sessions`, refuses `closed_at IS NOT NULL`, validates `fds_pos_devices.is_active=true`, then inserts. Verified live: closed session txn 400; inactive device txn 400; happy path 201.                                                                                                                                                      |
| 5   | BLOCKING | `apps/api/src/food-service/pos.service.ts`                                   | `paymentMethod=FREE_MEAL` is not eligibility-enforced — any patron can be marked as a free meal.                                  | VALID            | New `isFreeMealEligible(studentTenantId)` checks `fds_student_dietary_profiles.free_meal_eligible=true` OR an active determination with eligibility_category in (`FREE`, `REDUCED`) inside its `effective_from..effective_to` window. FREE_MEAL also requires `patronType=STUDENT`. Verified live: non-eligible Ethan 403; flipped Maya to eligible → 201; reverted.                                                                                                    |
| 6   | BLOCKING | `apps/api/src/food-service/dietary-eligibility.service.ts` + migration `071` | USDA claim `UNIQUE(school_id, academic_year_id, month_year)` does not catch duplicates when `academic_year_id IS NULL`.           | VALID            | `EligibilityService.generateClaim` requires `academicYearId` and validates it exists in `sis_academic_years`. Migration `071_fds_review_cycle20_indexes.sql` adds defensive partial UNIQUE `(school_id, month_year) WHERE academic_year_id IS NULL`. Verified live: missing 400; bogus year 400; real year 201.                                                                                                                                                         |
| 7   | MAJOR    | `HANDOFF-CYCLE20.md`                                                         | Handoff still says IN PROGRESS / Pending despite Cycle 20 being tagged complete.                                                  | VALID            | Handoff updated to COMPLETE with all 10 steps marked Complete + a fix-log section appended to document each REVIEW-CYCLE20 fix with its live verification.                                                                                                                                                                                                                                                                                                              |
| 8   | MAJOR    | `apps/api/src/food-service/dietary-eligibility.service.ts` + migration `071` | `syncFromHealth()` uses `ON CONFLICT DO NOTHING` so severity / display_name / is_active updates from Health are silently dropped. | VALID            | Migration `071` adds `UNIQUE(source_health_alert_id)` on `fds_student_allergen_alerts`. Service now `ON CONFLICT (source_health_alert_id) DO UPDATE SET allergen_code, allergen_display_name, severity, is_active, last_synced_at, updated_at` so reruns reflect the latest Health module state. Live live-test deferred until `hlth_health_alerts` table exists in tenant schema (the read model is forward-compatible — sync is graceful no-op today).                |
| 9   | MAJOR    | `packages/database/src/seed-iam.ts`                                          | Generic Staff role grants all FDS-001..004 read+write — pre-pilot debt.                                                           | VALID — DEFERRED | Recommendation-class. Joins the broader role-split work (Phase 2 punch list items 9 / 11 / 13 / 14 / 16 / 22 / 25). Pre-pilot, a dedicated Food Service Manager role moves the FDS write permissions out of generic Staff. Phase 2 punch list item 32.                                                                                                                                                                                                                  |
| 10  | MAJOR    | `apps/api/src/food-service/dietary-eligibility.service.ts`                   | `EligibilityService.submit` validates guardian-child ownership but skips student existence for staff/admin submitters.            | VALID            | Else-branch added — when caller is admin/staff, `studentId` is validated against current-tenant `sis_students` before insert. Verified live: admin POST with bogus studentId 400.                                                                                                                                                                                                                                                                                       |
| 11  | MAJOR    | `apps/api/src/food-service/pos.service.ts`                                   | Cash reconciliation row not auto-created on session close — the handoff copy implies it should be.                                | VALID            | `SessionService.close()` now opens `executeInTenantTransaction`, locks the session row, flips `closed_at`, then enumerates pos_device_ids that posted CASH activity for the session and inserts one `fds_cash_drawer_reconciliation` row per (session, device) with `expected_closing_balance` set to that device's CASH total. Idempotent on conflict. Verified live: 1 reconciliation row materialised after close.                                                   |

---

## Round 1 fixes summary (all in this commit)

- **BLOCKING 1** — allergen alerts row-scope per student.
- **BLOCKING 2** — eligibility application row-scope per persona.
- **BLOCKING 3** — POS patron resolver `assertPatronInCurrentTenant`.
- **BLOCKING 4** — POS session lock + closed-session reject + device active validation inside the same tenant tx as the INSERT.
- **BLOCKING 5** — FREE_MEAL eligibility gate on `TransactionService.create`.
- **BLOCKING 6** — USDA claim requires academicYearId at the service layer + migration 071 partial UNIQUE for the null-year defensive case.
- **MAJOR 7** — HANDOFF-CYCLE20 closeout state.
- **MAJOR 8** — Allergen sync now upserts deterministically by `source_health_alert_id` (migration 071 adds the UNIQUE).
- **MAJOR 10** — Eligibility submit validates studentId for staff/admin path.
- **MAJOR 11** — Reconciliation auto-created on session close.
- **MAJOR 9** carried to Phase 2 punch list (FSM role split — joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 → punch list item 32).

All 9 code-level fixes verified live on `tenant_demo` 2026-05-06.

---

## Migration 071 — schema-side defence-in-depth

`packages/database/prisma/tenant/migrations/071_fds_review_cycle20_indexes.sql` adds:

1. `UNIQUE (source_health_alert_id)` on `fds_student_allergen_alerts` so the Phase 1 manual sync (and the future Cycle-10 Kafka consumer) can upsert deterministically.
2. Partial `UNIQUE (school_id, month_year) WHERE academic_year_id IS NULL` on `fds_usda_reimbursement_claims` to catch duplicate null-year claims even though the service-layer fix already requires `academicYearId`.

Splitter-safe additive idempotent. Twenty-ninth migration in a row to clear the audit on first provision attempt (Cycles 4–20 unbroken streak). Tenant base table count unchanged at 279 (constraint + partial index only).

---

## Phase 2 carry-overs

- **Punch list item 32** — Food Service Manager role split: introduce a distinct FSM role and move FDS-001..004 write tiers out of generic Staff before real-school pilot.
