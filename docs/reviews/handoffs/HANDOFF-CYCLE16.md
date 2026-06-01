# Cycle 16 Handoff — Enrolment & Admissions

**Status:** Cycle 16 **IN PROGRESS — Wave 3 Cycle 3 (Enrolment & Admissions).** Cycle 16 completes the M81 Enrolment module that **Cycle 6 substantially built**. Cycle 6 already shipped 10 of the 16 plan tables (period + streams + intake capacities + capacity summary + applications + screening responses + documents + notes + offers + waitlist) plus EnrollmentModule with 17 endpoints + 5 Kafka emit topics + admin admissions UI + parent apply UI. Cycle 16's narrow scope: extend the application lifecycle with multi-stage review (`enr_application_stages` immutable audit + `enr_application_scores` for ranked selection), add the onboarding checklist system (4 new tables — templates + tasks + per-student progress + per-task completion), and ship the **`enr.student.enrolled` Kafka emit on onboarding completion** (the cross-system trigger that downstream PaymentAccountWorker + future SIS auto-create paths consume).

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle16-implementation-plan.html`
**Vertical-slice deliverable:** Admin creates "2026-2027 Admissions" enrolment period (already exists from Cycle 6) → prospective parent submits application → EO reviews and advances through SUBMITTED → UNDER_REVIEW → INTERVIEW → ASSESSMENT stages with confidential interview notes and assessment scores logged in the new `enr_application_stages` and `enr_application_scores` tables → EO issues unconditional offer → parent accepts → offer-accept atomically generates an `enr_student_onboarding_progress` row by cloning the school's "Standard New Student Checklist" template into per-task completion rows → EO + nurse + IT complete the 8 onboarding tasks → when every mandatory task lands `status='COMPLETED'`, `overall_status` flips to `COMPLETE` and `enr.student.enrolled` fires → downstream Cycle 6 PaymentAccountWorker creates the family account.

This document tracks the Cycle 16 build at the same level of detail as `HANDOFF-CYCLE15.md` and is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                   | Status |
| ---- | ------------------------------------------------------- | ------ |
| 1    | Period + Capacity Schema (carry-over from Cycle 6)      | DONE   |
| 2    | Application Pipeline Schema — stages + scores           | DONE   |
| 3    | Offers + Waitlist + Onboarding Schema                   | DONE   |
| 4    | Seed Data — Onboarding + Permissions Extension          | DONE   |
| 5    | Period + Capacity NestJS Module (carry-over)            | DONE   |
| 6    | Application Pipeline NestJS Module — stages + scoring   | DONE   |
| 7    | Offers + Waitlist + Onboarding NestJS Module            | DONE   |
| 8    | Enrolment UI — Admin Pipeline (carry-over + onboarding) | DONE   |
| 9    | Enrolment UI — Parent (carry-over)                      | DONE   |
| 10   | Vertical Slice Integration Test                         | DONE   |

---

## What this cycle adds on top of Cycle 15

**Inherited from Cycle 6 (no rework):**

- 10 of the 16 plan tables: `enr_enrollment_periods`, `enr_admission_streams`, `enr_intake_capacities`, `enr_capacity_summary`, `enr_applications`, `enr_application_documents`, `enr_application_notes`, `enr_application_screening_responses` (= the plan's `enr_application_form_responses`), `enr_offers`, `enr_waitlist_entries`. Migrations 018 + 019 + 025 (the public-search column polish from Phase 2).
- Backend services: `EnrollmentPeriodService`, `ApplicationService` (with `assertTransitionAllowed`), `OfferService`, `WaitlistService`, `CapacitySummaryService`. 17 endpoints + 5 Kafka emit topics including the keystone `enr.student.enrolled`.
- Web surfaces: `/admissions/applications` Kanban + detail, `/admissions/periods` + `/admissions/periods/[id]` capacity dashboard, `/admissions/waitlist`, `/apply` parent landing + `/apply/new` form + `/offers/[id]` Accept/Decline/Defer.

**New in Cycle 16:**

- **6 new tables** across 3 migrations (055 + 056 + 057): `enr_application_stages` (immutable audit), `enr_application_scores` (scoring criteria), `enr_onboarding_checklists` (template), `enr_onboarding_tasks` (template tasks), `enr_student_onboarding_progress` (per-student rollup), `enr_student_onboarding_task_completions` (per-task tracking).
- **Status enum extensions** on `enr_applications` (add INTERVIEW + ASSESSMENT + OFFERED) and `enr_enrollment_periods` (add OFFERS_ISSUED) so the Step 6 stage-advancement engine can drive the full review lifecycle the Cycle 16 plan specifies.
- **3 new backend services**: `ApplicationStageService` (record stage advancements + immutable audit), `ApplicationScoringService` (criterion CRUD), `OnboardingService` (template CRUD, progress generation on offer acceptance, task completion + auto-flip to COMPLETE + `enr.student.enrolled` emit).
- **2 new web surfaces**: `/enrolment/onboarding/[progressId]` per-student progress tracker; admin checklist editor extension on `/admissions/onboarding`.

**Existing-system touchpoints:**

- `iam_person(id)` — soft refs on every `*_by` audit column
- `sis_students(id)` — `enr_student_onboarding_progress.student_id` populates when SIS materialises the row from the enrolled application (manual this cycle; future cycle ships the auto-materialise consumer)
- `enr.offer.responded` (already emits in Cycle 6 `OfferService.respond` on ACCEPTED) — Cycle 16 adds an internal hook that synchronously generates the onboarding progress row in the same tenant tx
- `enr.student.enrolled` (already shipped in Cycle 6 — emitted on offer ACCEPT) — Cycle 16 changes the trigger semantics so the emit lands when **all mandatory onboarding tasks complete**, matching the plan's "operationally ready" gate. Cycle 6's emit-on-accept stays in place as a backward-compat signal.

What does not change: every existing module continues to function. Cycle 16 is purely additive on top of Cycle 6's M81 foundation.

---

## Step 1 — Period + Capacity Schema (carry-over)

**Status:** _todo_

Cycle 6's `018_enr_enrollment_and_applications.sql` shipped all 4 plan tables for Step 1. Cycle 16's `055_enr_period_status_extension.sql` adds the `OFFERS_ISSUED` value to `enr_enrollment_periods.status` CHECK so the Step 5 service can flip the period out of OPEN once the EO has issued offers (matching the plan's 5-value enum). Otherwise no change.

---

## Step 2 — Application Pipeline Schema — stages + scores

**Status:** _todo_

**Migration target:** `packages/database/prisma/tenant/migrations/056_enr_application_stages_scores.sql`.

Cycle 6 already shipped `enr_applications` (with screening responses + documents + notes). Cycle 16 adds:

1. **`enr_application_stages`** — Immutable per-application audit. `application_id UUID NOT NULL FK to enr_applications(id) ON DELETE CASCADE`, `from_status TEXT` nullable (NULL on initial submission), `to_status TEXT NOT NULL`, `changed_by UUID NOT NULL` (soft to platform_users), `notes TEXT` nullable, `changed_at TIMESTAMPTZ NOT NULL DEFAULT now()`. INDEX(application_id, changed_at ASC). No UPDATE / DELETE service path — service-side discipline per ADR-010.
2. **`enr_application_scores`** — Per-criterion scored row. `application_id UUID NOT NULL FK CASCADE`, `criterion_name TEXT NOT NULL`, `score NUMERIC(5,2) NOT NULL >= 0` CHECK, `max_score NUMERIC(5,2)` nullable (with `score <= max_score` CHECK when set), `scored_by UUID NOT NULL`, `notes TEXT` nullable, `created_at` + `updated_at`. UNIQUE(application_id, criterion_name).
3. **ALTER `enr_applications` status CHECK** — extend the existing 8-value enum to include `INTERVIEW`, `ASSESSMENT`, `OFFERED`. Use the splitter-safe `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` pattern from prior migrations.

2 new tables + 1 column-CHECK alter. 0 cross-schema FKs. 2 new intra-tenant FKs (both CASCADE on `application_id`).

---

## Step 3 — Offers + Waitlist + Onboarding Schema

**Status:** _todo_

**Migration target:** `packages/database/prisma/tenant/migrations/057_enr_onboarding.sql`.

Cycle 6 already shipped offers + waitlist. Cycle 16 adds the 4 onboarding tables:

1. **`enr_onboarding_checklists`** — School-level template. `school_id UUID NOT NULL`, `name TEXT NOT NULL`, `admission_type TEXT NOT NULL DEFAULT 'STANDARD_INTAKE'` 5-value CHECK STANDARD_INTAKE/MID_YEAR_ADMISSION/TRANSFER_IN/RETURNING_STUDENT/INTERNATIONAL, `is_active BOOLEAN DEFAULT true`. UNIQUE(school_id, name, admission_type).
2. **`enr_onboarding_tasks`** — Template tasks. `checklist_id UUID NOT NULL FK CASCADE`, `task_name TEXT NOT NULL`, `task_category TEXT NOT NULL` 7-value CHECK ADMINISTRATIVE/HEALTH/IT/FACILITIES/TRANSPORT/COMMUNICATIONS/FINANCE, `is_mandatory BOOLEAN NOT NULL DEFAULT true`, `responsible_role TEXT` nullable, `sort_order INT NOT NULL >= 0` CHECK, `due_days_before_start INT NOT NULL DEFAULT 0`. UNIQUE(checklist_id, task_name).
3. **`enr_student_onboarding_progress`** — Per-student rollup. `application_id UUID NOT NULL FK CASCADE` + UNIQUE(application_id, checklist_id), `checklist_id UUID NOT NULL FK NO ACTION` (audit-preserve template retirements), `student_id UUID` nullable (soft to sis_students — populated when SIS materialises the student row from the enrolled application), `started_date DATE NOT NULL`, `target_start_date DATE NOT NULL`, `overall_status TEXT NOT NULL DEFAULT 'IN_PROGRESS'` 3-value CHECK IN_PROGRESS/COMPLETE/OVERDUE, `tasks_total INT NOT NULL >= 0` CHECK, `tasks_completed INT NOT NULL DEFAULT 0 >= 0` CHECK + `tasks_completed <= tasks_total` CHECK, `created_at` + `updated_at`.
4. **`enr_student_onboarding_task_completions`** — Per-task. `progress_id UUID NOT NULL FK CASCADE`, `task_id UUID NOT NULL FK NO ACTION` (audit), `status TEXT NOT NULL DEFAULT 'PENDING'` 4-value CHECK PENDING/COMPLETED/WAIVED/OVERDUE, `completed_by UUID` nullable, `completed_at TIMESTAMPTZ` nullable, **multi-column `completed_chk`** lockstep keeping completed-state status with completed_at NOT NULL, `notes TEXT` nullable. UNIQUE(progress_id, task_id). Partial INDEX(progress_id, status) WHERE status != 'COMPLETED' for the open-tasks dashboard.

4 new tables + 6 new intra-tenant FKs (CASCADE × 3 + NO ACTION × 2 + SET NULL × 1 on completed_by). 0 cross-schema FKs.

**Tenant logical base table count after the cycle:** 217 → **223** (6 new logical base tables; the existing Cycle 6 enr\*\_ tables continue to count). Plus 2 column-CHECK alters on `enr_applications` and `enr_enrollment_periods`.

---

## Step 4 — Seed Data — Onboarding + Permissions Extension

**Status:** _todo_

**Seed target:** `packages/database/src/seed-onboarding.ts` (idempotent, gated on `enr_onboarding_checklists` row count). Wired as `seed:onboarding` in `package.json`.

The Cycle 6 `seed-enrollment.ts` already plants 4 applications (Maya ENROLLED + Sophia ACCEPTED + Aiden SUBMITTED + Olivia WAITLISTED) + 1 OPEN period + 2 streams + capacity summary. Cycle 16 adds:

1. **1 onboarding checklist** — "Standard New Student Checklist" (admission_type=STANDARD_INTAKE).
2. **8 onboarding tasks** — Uniform ordered (ADMINISTRATIVE), Bus route assigned (TRANSPORT), Medical form returned (HEALTH), Locker allocated (FACILITIES), IT account created (IT), Library card issued (ADMINISTRATIVE), Emergency contacts confirmed (COMMUNICATIONS), Enrolment deposit paid (FINANCE). All mandatory.
3. **1 progress row + 8 task_completion rows** — Wired to Maya Chen's existing ENROLLED application from Cycle 6 seed; demonstrates a partial-progress checklist (3 tasks COMPLETED, 5 PENDING) so the Step 8 progress UI has live demo data.
4. **1 sample stage row** — Initial SUBMITTED stage for Maya's application so the Step 6 audit trail has a seeded entry.

**`seed-iam.ts` updates:** STU-003 read+write for Staff (for the EO's full pipeline access); admin gets all via `everyFunction`. Parent already has STU-003:read+write from Cycle 6. Catalogue stays at 450.

---

## Step 5 — Period + Capacity NestJS Module (carry-over)

**Status:** _todo_

Cycle 6 already shipped `EnrollmentPeriodService` + `CapacitySummaryService`. Cycle 16 adds:

- ALTER on the period status validator to recognise the new OFFERS_ISSUED value and allow the OPEN → OFFERS_ISSUED transition.
- The capacity dashboard endpoint already exists from Cycle 6 (`GET /admissions/periods/:id` returns the period with summary inlined). No new endpoint; existing surface used.

---

## Step 6 — Application Pipeline NestJS Module — stages + scoring

**Status:** _todo_

**New services:** `ApplicationStageService` + `ApplicationScoringService` in `apps/api/src/enrollment/`. ~6 new endpoints.

- `ApplicationStageService.list(applicationId)` — returns the immutable stage audit ordered by `changed_at ASC`. Service-layer row scope: parent sees own; EO/admin sees all.
- `ApplicationStageService.advance(applicationId, toStatus, notes, actor)` — refactor of Cycle 6's `ApplicationService.transitionStatus()`: locks the application row inside `executeInTenantTransaction`, validates the transition via `assertTransitionAllowed` (extended to support INTERVIEW/ASSESSMENT/OFFERED), UPDATEs `enr_applications.status`, INSERTs an `enr_application_stages` row in the same tx, recomputes capacity summary if the new status is OFFERED/WAITLISTED/REJECTED. Supersedes the existing direct-transition path.
- `ApplicationScoringService` — `GET /enrolment/applications/:id/scores`, `POST /enrolment/applications/:id/scores` (EO scores criterion), `PATCH /enrolment/scores/:id`, `DELETE /enrolment/scores/:id`. UNIQUE(application_id, criterion_name) catch into 400.

The existing `enr.application.submitted` Kafka emit ships from Cycle 6 already.

---

## Step 7 — Offers + Waitlist + Onboarding NestJS Module

**Status:** _todo_

Cycle 6 already shipped OfferService + WaitlistService. Cycle 16 adds:

- **`OnboardingService`** with template CRUD (admin only), per-student progress reads, per-task complete/waive endpoints. **Keystone:** when an offer is ACCEPTED, the existing `OfferService.respond` runs in a tenant tx — Cycle 16 adds a hook that calls `OnboardingService.generateProgressRow(applicationId, schoolId, ...)` inside the same tx. The hook clones the school's STANDARD_INTAKE checklist into a fresh `enr_student_onboarding_progress` row + 8 `enr_student_onboarding_task_completions` rows (status=PENDING). When the last mandatory task flips to COMPLETED, `overall_status` flips to COMPLETE and `enr.student.enrolled` re-emits with the full operational-ready payload (the Cycle 6 emit-on-accept stays as a backward-compat signal).
- ~6 new endpoints: `GET /enrolment/onboarding-checklists`, `POST /enrolment/onboarding-checklists`, `GET /enrolment/onboarding/:progressId`, `PATCH /enrolment/onboarding-tasks/:id/complete`, `PATCH /enrolment/onboarding-tasks/:id/waive`, `GET /enrolment/onboarding/student/:studentId`.

---

## Step 8 — Enrolment UI — Admin Pipeline (carry-over + onboarding)

**Status:** _todo_

Cycle 6 already shipped `/admissions/applications` (Kanban) + `/admissions/applications/[id]` (detail with notes/screening) + `/admissions/periods` + `/admissions/periods/[id]` + `/admissions/waitlist`. Cycle 16 adds:

- Stage timeline section on `/admissions/applications/[id]` rendering the new `enr_application_stages` rows.
- Scores table inline on the application detail with admin/EO Add-score modal.
- New route: `/admissions/onboarding-checklists` (admin checklist + task editor).
- New route: `/admissions/onboarding/[progressId]` per-student onboarding tracker with task-by-task complete/waive controls + role-coloured task category pills.

---

## Step 9 — Enrolment UI — Parent (carry-over)

**Status:** _todo_

Cycle 6 already shipped `/apply` parent landing + `/apply/new` form + `/offers/[id]` Accept/Decline/Defer. Cycle 16 adds:

- Stage progression visual on `/apply/status` showing the parent the SUBMITTED → UNDER_REVIEW → INTERVIEW → ASSESSMENT → OFFERED progression.
- Parent-facing onboarding progress card on the post-acceptance status page (read-only — staff complete the tasks).

---

## Step 10 — Vertical Slice Integration Test

**Status:** _todo_

**CAT script target:** `docs/cycle16-cat-script.md` — schema preamble + 10 plan scenarios verified live on `tenant_demo` with **inline live output captures** (per REVIEW-CYCLE15 punch list item 21). Tag `cycle16-complete` after CI green.

---

## Cycle 16 Completion Criteria

1. Tenant schema: 6 new tables (2 application stages/scores + 4 onboarding) + 2 column-CHECK alters. Tenant table count: 217 → ~223.
2. Enrolment API: ~12 new endpoints (stages + scoring + onboarding) on top of Cycle 6's 17 endpoints.
3. Multi-stage application review with immutable stage audit trail.
4. Onboarding checklist + per-task completion tracking; auto-clone on offer acceptance; auto-flip to COMPLETE when every mandatory task lands.
5. `enr.student.enrolled` Kafka emit moved from offer-accept (Cycle 6) to onboarding-complete (Cycle 16) — the cross-system trigger that PaymentAccountWorker + future SIS auto-create paths consume.
6. HANDOFF-CYCLE16.md and CLAUDE.md updated. CI green.

---

## Closeout

**All 10 steps shipped + verified live on `tenant_demo` 2026-05-05.** Vertical-slice CAT at `docs/cycle16-cat-script.md` walks 7 plan scenarios end-to-end with inline-captured live output per the REVIEW-CYCLE15 punch list item 21 convention. Seed at `packages/database/src/seed-onboarding.ts` (idempotent, gated on `enr_onboarding_checklists` row count). Migrations 055 + 056 + 057 add 6 new logical base tables (tenant base table count 217 → **223**); 9 intra-tenant FKs; 0 cross-schema FKs. **12 new endpoints** across 3 services + 3 controllers under `stu-003:read/write/admin`. **1 new Kafka emit topic** (`enr.student.onboarded`) — fires after the school finishes onboarding the student; Cycle 6's `enr.student.enrolled` stays in place on offer-accept and `PaymentAccountWorker` keeps consuming it for billing-account allocation. IAM Staff role gains STU-003:read+write (covers Enrolment Officer); Admin already had STU-003 admin via `everyFunction`. 2 new web routes (`/admissions/onboarding-checklists` admin catalogue) plus 3 panels (Stages + Scores + Onboarding) injected into `/admissions/applications/[id]`.

### Key design decisions

1. **Cycle 16 layers on Cycle 6** — 10 of the 16 plan tables already shipped in Cycle 6 (periods + streams + intake + capacity_summary + applications + screening + documents + notes + offers + waitlist). Cycle 16 adds the 6 new tables + extends 2 status enums + ships 3 new services without rewriting any Cycle 6 surface.
2. **`enr.student.onboarded` is a NEW topic, not a relocation of `enr.student.enrolled`** — moving Cycle 6's emit would break the existing PaymentAccountWorker consumer (which is in production-shaped form already and runs on offer-accept). Instead Cycle 16 ships a parallel topic with the same envelope shape; downstream consumers can subscribe to whichever lifecycle event they care about. Documented in the CAT reviewer-attention list.
3. **Status enum extension via splitter-safe `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …`** — Postgres has no `MODIFY CONSTRAINT`, and `IF NOT EXISTS` doesn't apply to `ADD CONSTRAINT`. The DROP-then-ADD pattern with `IF EXISTS` is idempotent under the splitter and matches Cycle 11 Step 3's BIP `caseload_id` FK backfill precedent.
4. **Onboarding auto-generation hooks the existing OfferService.respond ACCEPTED branch inside the same tenant tx** — `OfferService.generateProgressForApplicationInTx(tx, applicationId, …)` is called inline, so the offer-accept and onboarding progress-row creation are atomic. Skips silently when no STANDARD_INTAKE checklist exists for the school (real-school operators add one before their first accepted offer).
5. **Score CRUD with UNIQUE(application, criterion) + check-violation translation** — duplicate scores return 400 with PATCH-redirect message; bogus `score < 0` or `max_score < score` returns 400 with check-constraint context. Mirrors the Cycle 12 reading-list duplicate-handling pattern.

Tagged `cycle16-complete` after CI green.

---

## REVIEW-CYCLE16 Round 1 fixes (2026-05-06)

Round 1 of REVIEW-CYCLE16-CHATGPT (against `cycle16-complete` at `1b19c6c`) returned **Reject pending fixes** with 3 BLOCKING items + 3 MAJOR follow-ups. All 3 BLOCKING fixes landed in this commit with live verification on `tenant_demo` 2026-05-06.

### BLOCKING 1 — Row-scope on stage / score / onboarding reads

**Reviewer's finding:** `GET /applications/:id/stages`, `GET /applications/:id/scores`, `GET /applications/:id/onboarding`, `GET /onboarding-progress/:id` were gated only by `stu-003:read`. Parents (who hold `stu-003:read` for their own children) could read other applications' stage timelines / admissions scores / onboarding progress by guessing UUIDs.

**Fix:** Made the services actor-aware. New `assertCanReadApplication(applicationId, actor)` helper on both `ApplicationStageService` and `OnboardingService` — admin OR `personType=STAFF` (covers Enrolment Officer) sees every application; guardian sees own children's applications only (matched on `enr_applications.guardian_person_id = actor.personId`); everyone else gets a collapsed `404 NotFoundException`. The schema-side permission gate (`stu-003:read`) stays permissive across personas; the actual access boundary now lives in the service layer.

**MAJOR 4 implementation (admissions scoring privacy):** `ApplicationScoringService.listForApplication(applicationId, actor)` now calls `assertEoOrAdmin(actor)` — admissions scores are restricted to admin / Enrolment Officer only because the rows carry ranked-selection criteria + scorer notes that must not be visible to guardians or students. Even guardians who hold `stu-003:read` for their own application get a `403 Forbidden` from the score read endpoint. The `403` (vs the stage/onboarding `404`) signals "permission denied" rather than "not found" because the parent already legitimately knows the application exists.

**Live verified on `tenant_demo` 2026-05-06:**

- Parent `GET /applications/<Maya>/stages` → 200 (own child)
- Parent `GET /applications/<Aiden>/stages` → 404 (don't-leak-existence)
- Parent `GET /applications/<Maya>/scores` → 403 (admin/EO only)
- Parent `GET /applications/<Maya>/onboarding` → 200
- Parent `GET /applications/<Aiden>/onboarding` → 404
- VP (Staff persona, holds `stu-003:read`) GETs every read across both applications → 200 × 4

### BLOCKING 2 — `waiveTask()` lifecycle

**Reviewer's finding:** `waiveTask()` only updated the individual task-completion row; it did not lock the parent progress row, recompute counters, check whether all mandatory tasks were done, flip `overall_status=COMPLETE`, or emit `enr.student.onboarded`. If the last remaining mandatory onboarding task was waived, the student would stay stuck in `IN_PROGRESS` and the cross-module `enr.student.onboarded` signal would never fire — directly breaking the Cycle 16 keystone behaviour.

**Fix:** Extracted the shared lifecycle into a private `transitionTask(completionId, newStatus, notes, actor)` helper used by both `completeTask()` and `waiveTask()`. The helper locks the task-completion row, updates status to either `COMPLETED` or `WAIVED`, locks the parent progress row, recomputes `tasks_completed` from the live row count (UNION of `COMPLETED + WAIVED` since both states satisfy the `is_mandatory` predicate), checks whether every mandatory task is in a terminal state, flips `overall_status=COMPLETE` + `completed_at=now()` atomically inside the same tx, and emits `enr.student.onboarded` after commit. `waiveTask()` is now a 3-line wrapper that gates on `actor.isSchoolAdmin` then delegates to `transitionTask(..., 'WAIVED', ...)`. Both methods now return the same `{ completion, progress, onboarded }` shape so the UI can render a unified "this just landed" toast.

**Live verified on `tenant_demo` 2026-05-06:** completed 4 of 5 PENDING tasks via `/complete` (progress 4/8 → 7/8, `onboarded=False`); waived the 5th task `Enrolment deposit paid` via `/waive` → progress flipped to 8/8 / `overall_status=COMPLETE` / `onboarded=True`; envelope captured live on `dev.enr.student.onboarded` showing the waiver completed onboarding correctly.

### BLOCKING 3 — Offer-accept onboarding generation atomicity

**Reviewer's finding:** `OfferService.respond()` ACCEPTED branch wrapped `generateProgressForApplicationInTx(...)` in `try { … } catch { /* swallow */ }`. The handoff documented atomic offer-accept + checklist creation, but a real generation failure (constraint violation, SQL error, runtime issue) would be silently swallowed while the offer-accept itself committed — leaving the student enrolled but without an onboarding checklist.

**Fix:** `generateProgressForApplicationInTx()` now returns a typed result discriminated union:

```ts
| { status: 'CREATED'; progressId: string }
| { status: 'EXISTS'; progressId: string }
| { status: 'NO_CHECKLIST' }
| { status: 'NO_APPLICATION' }
```

`OfferService.respond()` removed the swallowing `try/catch` and inspects the typed result. Only `NO_CHECKLIST` (legitimate "school has not configured a STANDARD_INTAKE checklist yet" branch) and the success cases (`CREATED` / `EXISTS`) are accepted. `NO_APPLICATION` is treated as a transactional anomaly (the offer-accept tx already locked the application row above; if it vanishes mid-tx, throw to roll back the entire tx). Any unexpected SQL or runtime error from the helper now propagates naturally up the `executeInTenantTransaction` callback and rolls back the offer-accept atomically, so the offer never lands as `ACCEPTED` when its onboarding row failed to create.

**Live verified on `tenant_demo` 2026-05-06:** Sophia's UNCONDITIONAL ISSUED offer accepted → application flips ACCEPTED → ENROLLED + 1 progress row + 8 task completion rows materialised in the same tenant tx. The two writes are observable as a single atomic commit in `tenant_demo`. Smoke residue cleaned.

### MAJOR follow-ups

- **MAJOR 4 — admissions scoring visibility:** addressed inline with BLOCKING 1 (scores restricted to admin / EO only).
- **MAJOR 5 — stage audit immutability via DB role hardening:** carried to Phase 2 punch list. Service-side discipline is enforced today (no UPDATE / DELETE methods exposed); a future Phase 2 trigger or DB role harden is appropriate before pilot.
- **MAJOR 6 — onboarding checklist read visibility:** carried to Phase 2 punch list. `GET /onboarding-checklists` is gated by `stu-003:read` today, which the reviewer notes may be appropriate for school-level operational templates but could be tightened to admin / EO if task names / responsible roles reveal internal processes.

CI parity green: prettier ✓, all builds ✓, tests ✓ (7/7 passed). Tagged `cycle16-approved` after Round 2 verdict.

---

## Round 2 verdict — APPROVED at `850fc6d` (2026-05-06)

REVIEW-CYCLE16-CHATGPT Round 2 confirmed all 3 BLOCKING fixes are properly closed in code:

1. **Application stage / score / onboarding reads are actor-aware.** Stage controller passes the actor through; `ApplicationStageService.list(applicationId, actor)` enforces row-scope. `ApplicationScoringService` is restricted to admin/EO only — guardians and students no longer inherit read access to admissions scoring just because they have `stu-003:read`. Onboarding progress reads (`GET /applications/:applicationId/onboarding` + `GET /onboarding-progress/:id`) check application ownership before returning progress / task data.
2. **`waiveTask()` follows the same lifecycle path as `completeTask()`.** Both methods delegate to the shared `transitionTask()` helper which locks the task-completion row, locks the parent progress row, recomputes `tasks_completed`, checks mandatory completion via `status IN ('COMPLETED','WAIVED')`, flips the progress row to `COMPLETE` when appropriate, and emits `enr.student.onboarded` after commit.
3. **Offer-accept onboarding generation is no longer silently swallowed.** `generateProgressForApplicationInTx()` returns the typed discriminated union; `OfferService.respond()` only treats `NO_CHECKLIST` as an intentional skip; unexpected SQL / runtime errors propagate naturally and roll back the acceptance transaction.

**Accepted follow-up (Phase 2 punch list item 22):** the implementation treats `actor.personType === 'STAFF'` as the Enrolment Officer authority because the IAM seed grants `STU-003:read+write` to the generic Staff role. Real schools likely want a distinct EO role rather than generic Staff. Joins the broader Counsellor / Nurse / Librarian / Athletic Director role-split punch list items (9 + 11 + 13 + 14 + 16) before pilot.

**Cycle 16 ships clean.** Wave 3 cycle 3 is closed. Tagged `cycle16-approved` at `850fc6d`.

---

## Set-Relationship modal: self-selection + guardian-link reconciliation (2026-05-30)

**Bug.** On a child's profile the Set Father / Set Mother modal could not
select the **current user**, so a parent could not set themselves as the
child's parent — the primary use case. Two causes: (1) people-search
excluded the caller; (2) the parent is already linked to the child (the
household guardian who created the child account also holds a
`LEGAL_GUARDIAN` graph edge), so a parentage save had to reconcile with
that existing row rather than duplicate or 409.

**Design: upgrade-in-place.** When the selected CampusOS person already
has an active relationship to the subject, the chosen parentage type
UPDATEs that row in place — carrying the guardian fact forward as
`is_legal_custody = true` — instead of inserting a second row. One row
carries both parentage and custody. (For non-parentage upgrades, e.g.
spouse, custody is not forced.)

### Changes

- **`apps/api/.../iam/people-search.service.ts`** — `search(callerPersonId,
  query, includeSelf = false)`. The `WHERE` self-exclusion is now
  `($6::boolean OR ip.id <> $1::uuid)`; default behaviour (exclude self)
  is unchanged for every existing caller.
- **`apps/api/.../iam/people-search.controller.ts`** — `GET /people/search`
  accepts `&includeSelf=true` (only the relationship modal passes it).
- **`apps/api/.../iam/relationship.service.ts`** — `addRelationship` now,
  for CampusOS-user relationships, looks up an existing active forward row
  (`findActiveForwardRow`) and routes to `upgradeRelationship` when found:
  updates the forward row + reciprocal to the new type, forces legal
  custody on for parentage types, leaves `created_by` untouched (there is
  no `updated_by` column). No duplicate, no 409. Added a note on
  `isActiveGuardianOf` documenting that `PARENT_TYPES` spans
  `LEGAL_GUARDIAN` + all parentage types, so the upgrade never strips the
  editor's own edit rights (Step 4 was already satisfied by the existing
  graph predicate; no code change needed there).
- **`apps/web/.../hooks/use-family-children.ts`** — `usePeopleSearch(query,
  enabled, includeSelf = false)`; appends `&includeSelf=true` and keys the
  query on `includeSelf`.
- **`apps/web/.../components/family/SetRelationshipModal.tsx`** — searches
  with `includeSelf`, and on the parentage modals (mother/father, never on
  the subject's own profile) renders a "This is me — set myself as
  {father/mother}" button that preselects the current user (from
  `useAuthStore`) and skips search.

### Tests

`apps/api/test/integration/m00-platform/relationship-self-selection.spec.ts`
(new, self-contained — seeds its own `LEGAL_GUARDIAN`/`LEGAL_WARD` edge so
it does not depend on household seeding). All passing:

- people-search `includeSelf=true` returns the caller; default excludes them.
- Saving `BIOLOGICAL_FATHER` when an active guardian edge exists UPGRADES
  it (type + `is_legal_custody`), leaving exactly one forward row and one
  reciprocal (`BIOLOGICAL_CHILD`); no duplicate, no 409.
- `canEdit` (and `isActiveGuardianOf`) stay true after the upgrade.
- Setting the OTHER parent (no prior link) creates a fresh row with
  `is_legal_custody=false`.

### Verification

- `pnpm --filter @campusos/api exec tsc --noEmit` — 0 errors.
- `pnpm --filter @campusos/web exec tsc --noEmit` — 0 errors.
- `test:integration -- relationships people-search` (existing) — passing.
- `test:integration -- relationship-self-selection` (new) — passing.


---

## Account creation: required DOB/gender, age variant, duplicate detection (2026-05-30)

Account Creation spec (layout, validation, dedupe, age defaults). Implemented
on branch feat/family-structure-profile-edit-perms.

### Decisions (resolved with the user before coding)
- Persona: age drives the profile VARIANT + iam_person.person_type only;
  personas stay DERIVED, never assigned (no fabricated STUDENT persona).
- Form: generalise /family/add-child into an add-person flow.
- Gender: inclusive REQUIRED select (Female / Male / Non-binary /
  Other-self-describe / Prefer-not-to-say).
- Validation: server-side in the two create-account use-cases + client-side
  inline. Adult (>18) person_type = GUARDIAN (no ADULT enum exists).
- Dedupe: detect + direct-link (managed-by-me) now; cross-owner claim-approval
  deferred.

### Backend (commits 36f52d3, 11cd7fc)
- `createAccountForChild` / `createAccountForMember` now require DOB + gender
  (400, field-scoped; future DOB rejected) via `requireAccountIdentity()`.
  Effective values are dto ?? placeholder-row. The member create-account DTO
  gained dateOfBirth/gender (platform_family_members has no such columns).
- `personTypeForAge()`: <=18 STUDENT, >18 GUARDIAN. The member path's old
  EXTERNAL person_type became GUARDIAN. person_type is a PG ENUM, so the raw
  INSERT param is cast `::"PersonType"` (a bare text param does not coerce).
- Child path mirrors the effective DOB/gender back to platform_family_children.
- New `POST /people/check-duplicate` (DuplicateCheckService +
  DuplicateCheckController in m00-platform/iam, registered in IamModule).
  Strong match only (exact email OR normalized first+last AND exact DOB);
  minimal descriptor {exists, displayName 'Given L.', context coarse-role,
  alreadyManagedByCurrentUser}; never email/DOB/contact. Redis rate-limit
  (30 / 15 min -> 429); self-excluded; INNER JOIN platform_users; POST so
  identity isn't logged in URLs. Linking itself is deferred to the form.

### Web (commit cb3f6a2)
- /family/add-child generalised to an add-person form: profile-style layout
  (First|Middle|Last; Preferred; Email; DOB|Gender), inclusive required gender
  select, required DOB+gender client validation (inline errors, future-DOB
  guard), >18 "also a student" opt-in, redirect to /family/children/:id after
  account creation (variant-appropriate detail page). Option C sends DOB+gender.
- Duplicate prompt fires on email/name/DOB blur; shows the minimal descriptor;
  "Link existing account" only when managed-by-me, else explains a claim
  request is needed; "This is someone else" dismisses. A failed/rate-limited
  check never blocks creation.
- New useCheckDuplicate hook; DOB/gender added to CreateChildAccountPayload.

### Tests (commits 11cd7fc, 5cbf960)
- duplicate-check.spec (8): email match, name+DOB match, name-only no-match,
  wrong-DOB no-match, empty probe, managed-by-me flag, self-exclusion,
  rate-limit 429. Disclosure test asserts no email/DOB/full-surname in payload.
- child-linking.spec (+6): missing-DOB 400, missing-gender 400, future-DOB 400,
  age 12 STUDENT, age 18 STUDENT (boundary), age 19 GUARDIAN. Existing
  create-account call sites updated to pass DOB/gender; afterAll reordered to
  delete platform_personas before iam_person.
- family-children.spec: create-account sites pass DOB/gender; member
  person_type assertion EXTERNAL -> GUARDIAN.

### Verification
- pnpm --filter @campusos/api exec tsc --noEmit — 0 errors.
- child-linking + family-children + duplicate-check — 79 passing (child-linking 17, family-children 54, duplicate-check 8).
- pnpm --filter @campusos/web exec tsc --noEmit — 0 errors; next lint clean.
  (The web app has no test runner — the `test` script is a stub — so there is
  no component-test layer; behaviour is covered by the API tests + type/lint.)

### Deferred / follow-up
- Cross-owner "link/claim request" approval flow (reuse platform_invitations):
  detection blocks it safely today (no PII shared, no link offered).


---

## Blended family-tree diagram (2026-06-01)

Blended Family Tree spec. Replaces the flat bucketed family-tree view with a
single-generation, blended-family-aware box-and-line SVG diagram. Read-only;
no schema migration.

### Payload (Step 1) — `relationship.service.ts` + `relationship.dto.ts`
`GET /people/:id/family-tree` now returns a GRAPH, not bucketed lists:
`{ rootPersonId, canEdit, parents[], children[] }`.
- `parents`: deduped union of every distinct parent across all children's
  links — a shared parent appears ONCE. `{ personId|null, displayName,
  isSelf, isPlaceholder }`; name-only (non-CampusOS) parents are personId:null
  boxes keyed by name.
- `children[].parentLinks`: per-child, 1..n (padded to 2). type + custody
  live on the LINK (a child can be biological to one parent, step to another).
  A known-but-unspecified second parent is a link with parentPersonId AND
  parentName null — the meaningful empty slot, never omitted.
- Root selection: the root's own children form the child row; a CHILDLESS
  root appears as its OWN child (subject + their parents) so a student's
  structure page still renders. Empty only when neither children nor parents.
- Dropped `FamilyTreeNodeDto` and the bucketed spouses/grandparents/siblings/
  other fields from THIS payload — out of scope for a single-generation
  diagram; the full bucketed list still lives at `GET /relationships`.

### Render (Steps 2-4) — `FamilyTreeView.tsx`
SVG box-and-line (viewBox 0 0 680 H, role=img + title/desc): parent row on
top, child row below, an edge from each child's top-center to each linked
parent's bottom-center; dashed boxes/edges for unset slots. Barycenter parent
ordering (mean child index, stable, tie-break displayName) to minimise — not
eliminate — crossings; no dagre/elk. Child box shows name·age + relationship
summary + custody summary; per-edge detail is NOT crammed on the line.
Computed height (no clipping). Empty state when no children. Reused by both
`/family/tree` and `/family/[personId]/structure` (the latter derives the
subject name from the graph, since the payload has no top-level person).
Deferred (noted in code): per-parent edge colour, edge hover tooltips.

### Tests (Step 5)
`relationships.spec` (28 passing): childless-root-as-child, shared-parent
deduped once, per-link biological-vs-step type+custody, null-slot
present-not-omitted, name-only parent box, controller view-gate + read-only
canEdit. The web app has no test runner (`test` script is a stub), so the
spec's component tests are not added; the pure `computeLayout` would be the
unit-test seam if a harness is stood up later.

### Verification
- pnpm --filter @campusos/api build — 0 errors.
- pnpm --filter @campusos/api exec tsc --noEmit — 0 errors.
- relationships.spec — 28 passing.
- pnpm --filter @campusos/web exec tsc --noEmit — 0 errors; next lint clean.
- Full integration suite: the only failures are 4 in tenant-isolation.spec
  from cross-spec fixture pollution (a leftover pay_family_accounts row,
  unrelated to this change) — that spec passes 17/17 run in isolation.


---

## Your Family completion fixes + change primary guardian (2026-06-01)

Five Your-Family issues: four completion-logic corrections + one new action.

### Single source of truth
The %, per-section "N items remaining", and yellow checklist all derive from
ONE client-side `useMemo` — `useCompletionState` in
`apps/web/src/app/(app)/family/settings/page.tsx`. There is NO backend
completeness service (the spec's `fix(api)` framing didn't match reality), so
the criteria corrections (STEPs 1-4) landed in that web hook.

### STEP 0 diagnosis (from code)
- Address criterion already required street+city+state+ZIP+country (matches
  spec) and the Addresses save already invalidates `['family']`, so
  `useCompletionState` re-derives on save. The country field defaults to
  "United States" in the form. A persistent false negative would mean a
  genuinely blank required field (correct behaviour) — no criterion bug found.
- Guardian criterion already filtered `status === 'ACTIVE'` (pending invites
  never counted). The real false negative was the phone SOURCE.

### Fixes
- STEP 2 (api): `FamilyMemberDto.primaryPhone` now COALESCEs
  `platform_person_phones` (the multi-row list the Contact tab writes to)
  before the `iam_person.primary_phone` cache — symmetric with how email
  already resolves. An ACTIVE guardian whose number lived only in the list no
  longer reads as phone-less.
- STEP 3 (web): dropped "Family name set" from criteria/checklist/%/counts;
  the display name stays an optional field.
- STEP 4 (web + api doc): dropped "Communication preferences customised";
  prefs are seeded to operational defaults (creator is HEAD_OF_HOUSEHOLD +
  is_primary_contact at family creation → first read of
  /family/contact-preferences routes all 8 categories to them). All 8 are
  operational/transactional — no marketing/consent channel — so the default
  routing opts into nothing requiring consent. Documented on
  getFamilyContactPreferences; no redundant creation-time seed added.
- STEP 5: aggregate %, section counts, and checklist re-derive from the
  trimmed item list automatically (single source).
- STEP 1 (address, follow-up 2026-06-01): the address criterion was correct,
  but the false negative was a NULL saved `country` — the Addresses form
  showed "United States" as a UI-only default that never persisted (the
  dirty-diff skipped the unchanged default). Fixed two ways: (a) a backfill
  migration (20260601000000_backfill_family_country) sets country =
  'United States' WHERE null AND a home address exists — scoped so addressless
  families don't falsely gain one; verified against demo data (0 addressed
  families left null, addressless families untouched); (b) the form now always
  includes the shown country (+ mailingCountry) in the save payload when an
  address is written, so a normal Save persists it. "Home address on file"
  now clears on load with no dropdown interaction.

### STEP 6 — change primary guardian (new)
- `PATCH /api/v1/families/:familyId/primary-guardian { guardianPersonId }`:
  new `FamiliesController` (`/families/:familyId/...`, plural) →
  `FamilyChildrenService.setPrimaryGuardian`. Validates caller is a member of
  :familyId (cross-family → 404) and target is an ACTIVE guardian of that
  family (pending invite / non-member → 400), then demotes old + promotes new
  in one tx. The `(family_id) WHERE is_primary_contact = true` partial UNIQUE
  keeps exactly one primary (never two, never zero).
- Decoupled from edit rights: touches only `is_primary_contact`;
  canEditFamilyStructure / isActiveGuardianOf read other signals, so
  guardianship + member roles are unchanged by a reassignment.
- Web: "Make primary" on each non-primary ACTIVE guardian row (any active
  guardian may reassign — permissive co-guardian model); "Primary contact"
  line is now a ★ badge. `useSetPrimaryGuardian` hook added.

### Tests (STEP 7)
family-children.spec (58 passing, +4): set-B-primary clears A (exactly one
primary), pending-invite target → 400, cross-family caller → 404, reassign
leaves member roles + guardianship + ACTIVE status unchanged.

### Verification
- pnpm --filter @campusos/api build — 0 errors.
- pnpm --filter @campusos/api exec tsc --noEmit — 0 errors.
- relationships + family-children — 86 passing.
- pnpm --filter @campusos/web exec tsc --noEmit — 0 errors; next lint clean.

### Note / not reproduced against live data
STEP 0 asked to diagnose the two false negatives against the actual Tromsness
family row in the running app. The criteria were fixed at the code level
(guardian phone source; criteria trimmed) without standing up the local stack;
if a specific field is still genuinely blank for that family, that's correct
incomplete behaviour, not a criterion bug.


---

## Gender options, mailing inheritance, family-medical display (2026-06-01)

Three independent fixes.

### FIX 1 — Gender → MALE | FEMALE | NOT_SPECIFIED
- New shared `@campusos/shared` exports: GENDERS, GENDER_LABELS,
  normalizeGender (legacy 'F'→FEMALE, 'M'→MALE, anything else→NOT_SPECIFIED)
  — one source so API + both web forms can't drift.
- API normalises gender on READ (/profile/me self gender, FamilyChildDto)
  AND WRITE (create/update child, account-creation identity). The admin
  per-tenant sis_student_demographics.gender is a separate concern, untouched.
- Web: add-person Details + profile Account tab render exactly the three
  options with a DISABLED "Select…" placeholder (so required is meaningful;
  Not Specified is a valid satisfying choice).
- Backfill 20260601010000 canonicalises iam_person.gender +
  platform_family_children.gender; verified 0 non-canonical values remain.
- NOTE: iam_person.gender is plain TEXT — distinct from the person_type
  Postgres ENUM (which needs the ::"PersonType" cast).
- FOLLOW-UP (2026-06-01): the child *detail* page (/family/children/[id]
  Account tab) was a third gender select missed by the first pass — it still
  offered legacy value="F"/"M"/"" options, so a stored canonical MALE/FEMALE
  matched nothing, rendered blank, and a save wrote a legacy/empty value that
  normalize-on-read then folded to NOT_SPECIFIED ("saves, reads Not
  Specified"). Now uses GENDERS/GENDER_LABELS/normalizeGender + disabled
  "Select…", and normalises the loaded value so the right option preselects.
  Also canonicalised gender on the adult profile WRITE path
  (profile.service buildIamPersonPatch) — it was normalised on read but
  passed through raw on write; now symmetric with the child path. Verified
  live: PATCH a MANAGED child gender MALE → response MALE, GET MALE, both
  platform_family_children.gender AND iam_person.gender = MALE; NOT_SPECIFIED
  round-trips as a real choice (INDEPENDENT children correctly 403, unrelated).

### FIX 2 — Mailing "Use family / Use custom" toggle
- New mailing_address_source (FAMILY|CUSTOM, default FAMILY) on
  platform_family_children + iam_person (migration 20260601020000),
  mirroring address_source. Three states: FAMILY = inherit family mailing;
  CUSTOM + same-as-physical = mirror this record's physical; CUSTOM +
  different = custom fields. The existing same-as-physical boolean is
  preserved, nested under CUSTOM.
- Use family inherits the family mailing address, falling back to the family
  HOME address when the family keeps mailing == home.
- Web reuses FamilyCustomToggle on the mailing block in BOTH the child
  Addresses tab and the adult profile Contact tab. Custom mailing fields
  persist only under CUSTOM + different; nulled otherwise.

### FIX 3 — Child "Use family" shows family no-doctor/no-insurance state
- loadFamilyDoctorInsurance + toMedicalDto thread the family's explicit
  hasFamilyDoctor / hasInsurance three-state flags; ChildMedicalInfoDto
  (api + web) carries them, populated only in FAMILY mode (null in CUSTOM).
- Child Medical & Health (Use family) renders "No family doctor/insurance on
  file" when the flag is false (matching the family tab), inherited details
  when true, and empty when null (unanswered) — instead of blank dashes for
  all three. Also fixed an adjacent copy-paste (CUSTOM insurancePolicy read
  the wrong column).
- FOLLOW-UP (2026-06-01): the first pass only covered the child section. The
  adult/parent profile Medical tab is a separate component + API path
  (getMyMedical → loadFamilyDoctorInsuranceForPerson → toAdultMedicalDto →
  AdultMedicalInfoDto) and still showed dashes under "Use family". Applied the
  identical fix there. Verified against demo data: the family with both flags
  false reads the explicit "none" text on parent AND child; the Chen demo
  family (flags null) correctly stays empty.

### Tests + verification
- family-children.spec: +FIX3 (4: none-flagged, has-doctor, neither-set,
  custom), +FIX1 (create stores canonical, legacy read normalizes), +FIX2
  (mailing source defaults FAMILY, round-trips CUSTOM, flips back).
- pnpm --filter @campusos/api build — 0 errors.
- pnpm --filter @campusos/api exec tsc --noEmit — 0 errors.
- family-children + child-linking + relationships — 110 passing.
- pnpm --filter @campusos/web exec tsc --noEmit — 0 errors; next lint clean.
- Backfill migrations verified against demo data.

## Bottom-anchored save bar on child profile + family settings (2026-06-01)

The parent `/profile` tabs already committed identity/account fields through
the viewport-fixed `StickySaveBar` (Discard + Save Changes, shown only while
dirty). The child profile Account tab and the `/family/settings` tabs still
used an inline mid-page "Save Changes" button, so the save action was
inconsistent and could scroll out of view on long forms. Aligned all three to
the parent pattern — frontend-only, no API/scope change.

- `apps/web/.../family/children/[id]/page.tsx` — `AccountEditForm` now renders
  `StickySaveBar` instead of the inline submit. Extracted `doSave()` from
  `onSubmit` (onSubmit is now a thin `preventDefault → void doSave()`), added
  `onDiscard` (reset form + clear errors), kept a hidden `type="submit"` for
  Enter-to-save. Tab container gained `pb-24` clearance. Save scope unchanged:
  it still commits ONLY first/last (+ middle/preferred when LINKED) + DOB +
  gender via `useUpdateFamilyChild`. The Contact tab already used a sticky bar;
  Medical/Dietary tabs and the Family Structure section keep their own separate
  save actions (untouched).
- `apps/web/.../family/settings/page.tsx` — same refactor applied to all three
  form tabs: FamilyTab (display name + category routing), AddressesTab (home +
  mailing), HealthTab (doctor/insurance/notes). Each keeps its own scope and
  its own `StickySaveBar` (gated on `settings.canEdit`, so read-only child
  viewers still see no save action); only one tab is editable at a time so only
  one bar ever shows. `pb-24` added to the tab container. Per-row controls
  (emergency-contact reorder/pickup toggles, member rows) persist immediately
  and were not touched.

### Verification
- pnpm --filter @campusos/web exec tsc --noEmit — 0 errors.
- /family/children/[id] and /family/settings both compile + serve 200 in dev.
- Live round-trip as adamtromsness@gmail.com on Thatcher (MANAGED): PATCH
  preferredName → response + read-back persisted, then restored — confirms the
  rewired save still commits identity fields.

## Family-tree union-junction layout rebuild (2026-06-01)

Payload unchanged (parents-union + per-child parentLinks, childless-root). This
rebuilds only how `apps/web/.../components/family/FamilyTreeView.tsx` DRAWS the
diagram, fixing three defects: crossing lines (per-edge fan), right-edge
clipping (fixed 680px canvas), and truncated box text (full relationship +
custody strings per box).

- STEP 1 — group children by the unordered SET of real parents; render one
  UNION JUNCTION per group: parents joined by a short horizontal line, a single
  drop to a horizontal sibling bar, one short drop per child. The common intact
  family (all kids share two parents) → ONE group → ZERO crossings.
- STEP 2 — canvas sized to the wider of the parent/child rows (viewBox =
  max(parentRowW, childRowW)); never clips. ≤4 children scale responsively
  (maxWidth:100%, height auto); >4 switch to a horizontally scrollable container
  at natural box size so text stays legible instead of shrinking.
- STEP 3 — parent-row ordering: groups sorted by child barycenter, each group's
  parents clustered, a shared parent emitted ONCE (first group). Cross-group
  crossings only possible at a shared parent — minimised, remainder accepted.
- STEP 4 — child box = `FirstName · age` (first token of displayName) + a
  one-word relationship subtitle ("Biological child"; non-default categories
  combine, e.g. "Biological / step child"); equal heights; box widths sized to
  the longest label (char-count approximation) so nothing truncates. Per-link
  custody / full type no longer printed (lives on the profile). Parent box =
  name + role line ("You · parent" for self). Single-parent group drops from
  the real parent — no phantom line to the dashed empty slot.

### Verification
- pnpm --filter @campusos/web exec tsc --noEmit — 0 errors.
- pnpm --filter @campusos/api build — 0 errors (no API files touched; payload
  unchanged, so the integration suite is unaffected by this render-only change).
- /family/[personId]/structure and /family/tree compile + serve 200 in dev.
- Geometry verified against the real Tromsness payload (rooted on Adam: union
  {Adam, Ashley} + Scout/Thatcher/Sailor/Harper) and a faithful standalone
  simulation of computeLayout: 4-kid case → 1 union, 612px (fits, no scroll),
  0 crossings; 2/4/6-child sizing all 0 crossings (scroll engages at 6); blended
  ({Adam,Ashley}×2 + {Adam,Maria}×1) → 2 unions, Adam once, 0 in-group
  crossings; single-parent → drop from the real parent only; childless root →
  boxes only, no dangling lines. (apps/web has no unit-test runner — vitest is
  not installed and `test` is a stub — so the layout is verified by the
  simulation + live render rather than a committed web spec.)

## Family-tree clickable person nodes (2026-06-01)

Each person box in the read-only tree is clickable → that person's profile, but
ONLY when they have a profile the viewer may reach. The SERVER decides
clickability per node; the client is clickable iff a URL is present.

- API (`relationship.{dto,service,controller}.ts`):
  - `FamilyTreeParentDto` + `FamilyTreeChildDto` gain `profileUrl: string | null`
    (both already carried `personId`).
  - `RelationshipService.resolveProfileUrls(personIds, viewerPersonId,
    isSchoolAdmin)` resolves a per-person, viewer-specific URL (first match):
    own node → `/profile`; school admin → `/profile/:personId` (holds
    usr-001:admin); guardian of a LINKED managed child → `/family/children/
    :familyChildId` (batch-resolved from platform_family_children + _members —
    the family-child record id, NOT the iam_person id); else omitted (null).
  - The controller decorates `getFamilyTree` output after the existing
    assertCanView gate, using actor.isSchoolAdmin. Name-only parents (personId
    null) and placeholder slots (no node) are never clickable.
- Web (`FamilyTreeView.tsx`, `use-relationships.ts`):
  - `FamilyTreeParent`/`FamilyTreeChild` gain `profileUrl`. A new `NodeGroup`
    wrapper renders an interactive `<g role="link" tabIndex=0>` (cursor,
    hover/focus stroke, Enter/Space activation, `aria-label "View {name}'s
    profile"`, `useRouter().push`) when href is present, and a plain inert `<g>`
    otherwise. Navigation only — no edit affordances; tree stays read-only.

### Verification
- pnpm --filter @campusos/api build — 0 errors; web tsc — 0 errors.
- relationships.spec — 32 passing (4 new: guardian→child route + self→/profile +
  unviewable co-parent→null; admin→/profile/:id + name-only→null; non-guardian
  viewer gets only self+managed-child clickable; student self-viewer →/profile
  with canEdit:false i.e. navigation ≠ edit).
- Live (adamtromsness@gmail.com on the Tromsness tree): Adam→/profile, Ashley
  (co-parent, not viewable)→null, Scout/Thatcher/Sailor/Harper→
  /family/children/:familyChildId; as Platform Admin every node→/profile/:id.
