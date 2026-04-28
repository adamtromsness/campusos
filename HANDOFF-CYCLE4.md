# Cycle 4 Handoff — HR & Workforce Core

**Status:** Cycle 4 IN PROGRESS — Step 0 (HR-Employee Identity Migration) DONE. Steps 1–10 are planned and tracked in the table below; their full handoff sections will be filled in as each step lands. Phase 1 (Build the Core) closed at the end of Cycle 3 with the post-cycle architecture review APPROVED at `592d366`. Cycle 4 is the first cycle of Phase 3 (Expand) — the temporary HR-employee identity mapping that has lived since Cycle 2 has been resolved by Step 0. (Cycles 0–3 are COMPLETE; see `HANDOFF-CYCLE1.md`, `HANDOFF-CYCLE2.md`, and `HANDOFF-CYCLE3.md` for the foundation this cycle builds on.)
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle4-implementation-plan.html`
**Vertical-slice deliverable:** Admin creates an employee record for James Rivera → assigns him to the "Teacher" position → Rivera views his own profile with certifications and leave balances → Rivera submits a sick leave request → admin approves it → coverage notification fires for affected classes → Rivera's leave balance updates → compliance dashboard shows his Teaching Licence expiry in 60 days.

This document tracks the Cycle 4 build — the M80 HR/Workforce module (core subset, 18 of 48 tables) — at the same level of detail as `HANDOFF-CYCLE1.md`, `HANDOFF-CYCLE2.md`, and `HANDOFF-CYCLE3.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                   | Status                                                                                                                                                                                                                                                                                                                                          |
| ---: | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | HR-Employee Identity Migration (carry-over from Cycle 2) | **Done** — `011_hr_employees_and_positions.sql` lands `hr_employees` (UNIQUE `person_id` + UNIQUE `account_id`, CHECK on `employment_type` + `employment_status`); `seed-hr.ts` inserts 4 employee rows for `tenant_demo` (Mitchell, Rivera, Park, Hayes — `admin@` Platform Admin intentionally NOT bridged) and runs the four bridge UPDATEs (6 + 62 + 0 + 1 rows re-pointed; 0 orphans). `ActorContextService` populates `actor.employeeId`. 12 service-layer call sites substituted from `actor.personId` → `actor.employeeId` (attendance, assignment, gradebook, submission, grade, progress-note, student visibilityClause, class.service.listForTeacherEmployee, class.service.loadTeachersForClasses join, class.controller.my, audience-fan-out.worker.audienceClass). `IamModule` now imports `TenantModule`. Build clean, type-check clean, live smoke against `tenant_demo` confirmed `GET /classes/my` for teacher@ returns the same 6 classes through the bridge, `GET /students` returns 15, `GET /classes/:id/gradebook` returns 3 students for P1. CLAUDE.md "Temporary HR-Employee Identity Mapping" bullet retired; the four `COMMENT ON COLUMN` annotations now reference the permanent ADR-055 convention. Resolves REVIEW-CYCLE2 DEVIATION 4. |
|    1 | HR Schema — Employees & Positions                       | **Done** — `011_hr_employees_and_positions.sql` extended with 5 base tables on top of `hr_employees` from Step 0 (`hr_positions`, `hr_employee_positions`, `hr_emergency_contacts`, `hr_document_types`, `hr_employee_documents`). 5 intra-tenant FKs (3 to `hr_employees ON DELETE CASCADE`, 1 to `hr_positions`, 1 to `hr_document_types`), 0 cross-schema FKs. Tenant base table count: 63 (was 58). Live verification on `tenant_demo`: 5 CHECK constraints fire, FK rejection clean, happy-path multi-insert across all 5 tables succeeds, ON DELETE CASCADE drops all 3 child rows when an `hr_employees` row is deleted. |
|    2 | HR Schema — Leave Management                            | **Done** — `012_hr_leave_management.sql` lands 3 base tables (`hr_leave_types`, `hr_leave_balances`, `hr_leave_requests`) with 5 intra-tenant FKs (2 to `hr_employees ON DELETE CASCADE`, 2 to `hr_leave_types`, 1 to `sis_academic_years`), 10 CHECK constraints (status enum, date range, days > 0, all-or-nothing HR-initiated, non-negative accrual/balance/used/pending). Tenant base table count: 66 (was 63). Live verification on `tenant_demo`: 6 CHECKs fire, UNIQUE on `(employee, type, year)` rejects duplicates, happy-path inserts succeed, ON DELETE CASCADE drops balances + requests when a temp employee is deleted. |
|    3 | HR Schema — Certifications & Training                   | **Done** — `013_hr_certifications_and_training.sql` lands 5 base tables (`hr_staff_certifications` with 10 cert types + 4 verification statuses + ADR-015 reference-only DBS handling, `hr_training_requirements` with 5 frequency values + multi-column CUSTOM-frequency CHECK, `hr_training_compliance` with `linked_certification_id ON DELETE SET NULL`, `hr_cpd_requirements`, `hr_work_authorisation` with 6 document types + separate expiry / reverification dates). 7 intra-tenant FKs, 0 cross-schema FKs. Tenant base table count: 71 (was 66). Live verification on `tenant_demo`: 7 CHECKs fire, ON DELETE SET NULL on linked cert keeps compliance row, ON DELETE CASCADE on hr_employees drops cert/compliance/work_auth rows, UNIQUE(employee_id) on hr_work_authorisation rejects duplicates. |
|    4 | HR Schema — Onboarding                                  | **Done** — `014_hr_onboarding.sql` lands 3 base tables (`hr_onboarding_templates` UNIQUE(school_id, name) with optional position_id; `hr_onboarding_checklists` UNIQUE(employee_id, template_id) with multi-column CHECK enforcing status / started_at / completed_at sync; `hr_onboarding_tasks` 5 categories × 4 statuses with multi-column CHECK on completed_at sync). 3 intra-tenant FKs (1 to hr_employees CASCADE, 1 to checklists CASCADE), 0 cross-schema FKs. Tenant base table count: 74 (was 71). Live verification on `tenant_demo`: 8 CHECKs fire (status enums, started_chk lifecycle, category, due_days, completed_chk lifecycle), happy-path template + checklist + 3 tasks, UNIQUE(employee_id, template_id) rejects duplicate, ON DELETE CASCADE drops all 3 tasks when checklist is removed. |
|    5 | Seed Data — Employees, Leave, Certifications            | **Done** — `seed-hr.ts` extended with 7 idempotent layers (positions, leave types/balances/requests, certifications, training requirements + compliance, document types, onboarding). Counts in `tenant_demo` after the run: 4 employees, 5 positions + 4 assignments, 5 leave types + 20 balances + 2 leave requests, 4 certifications (Rivera Teaching Licence dynamically expires 60 days from today — drives CAT amber row), 4 training requirements + 4 compliance rows, 4 document types, 1 onboarding template + 1 checklist + 8 tasks. `seed-iam.ts` adds HR-001:read + HR-003:read+write + HR-004:read to Teacher/Staff and assigns Staff role to vp@ + counsellor@. After `build-cache.ts`: 7 account-scope pairs cached. |
|    6 | HR NestJS Module — Employee Records & Directory         | **Done** — `apps/api/src/hr/` lands EmployeeService + PositionService + EmployeeDocumentService + 12 endpoints (`GET /employees`, `GET /employees/me`, `GET /employees/:id`, `POST /employees`, `PATCH /employees/:id`, `GET /employees/:id/documents`, `POST /employees/:id/documents`, `DELETE /employees/:id/documents/:docId`, `GET /positions`, `GET /positions/:id`, `POST /positions`, `PATCH /positions/:id`). `actor.employeeId` already populated by Cycle 4 Step 0's `ActorContextService` extension. Row-scope guard on documents (own profile OR admin only). HrModule wired into AppModule between ClassroomModule and NotificationsModule. Build clean, all routes mapped on boot, 12-scenario live smoke against `tenant_demo` confirms staff directory list, /me self-resolution, parent/student permission denials, counsellor 403 on Rivera's documents, teacher 403 on `hr-001:admin`, admin POST/PATCH round-trip on positions, admin POST /employees reaches the validators. |
|    7 | HR NestJS Module — Leave & Certifications               | **Done** — LeaveService + CertificationService + TrainingComplianceService + LeaveNotificationConsumer + 11 endpoints. Kafka emits: hr.leave.{requested,approved,rejected,cancelled}, hr.certification.verified. The consumer subscribes to all 4 leave topics, notifies admins on requested + submitter on approved/rejected, and republishes hr.leave.coverage_needed with affected class ids on approve. Build clean, 22-scenario live smoke against `tenant_demo` confirms full lifecycle + balance updates + cross-persona row-scope. Caught and fixed a Step 5 seed bug where Rivera's PD balance pending was inconsistent with the seeded PENDING request. |
|    8 | Staff Directory & Employee Profile UI                   | **Done** — Three new routes (`/staff`, `/staff/[id]`, `/staff/me`) plus a "Staff" launchpad tile under `hr-001:read` (using existing `PeopleIcon`). `apps/web/src/lib/types.ts` extended with the full HR DTO surface; `apps/web/src/hooks/use-hr.ts` adds 16 hooks (12 queries + 4 mutations). Tabbed profile gates Certifications / Leave / Documents to own-profile-or-admin; Info tab is open to anyone with `hr-001:read`. Build clean — `/staff` 6.18 kB, `/staff/[id]` 6.49 kB, `/staff/me` 2.34 kB First Load JS. |
|    9 | Leave Management & Compliance Dashboard UI              | **Done** — 4 new routes (`/leave`, `/leave/new`, `/leave/approvals`, `/compliance`) + 2 new launchpad tiles (Leave under `hr-003:read`, Compliance under `sch-001:admin` OR `hr-004:admin`). Reuses the Step 8 hooks; no new hooks added. Build clean: `/leave` 5.66 kB, `/leave/new` 5.74 kB, `/leave/approvals` 6.06 kB, `/compliance` 5.65 kB First Load JS. |
|   10 | Vertical Slice Integration Test                         | Not started — `docs/cycle4-cat-script.md` will land the reproducible end-to-end walkthrough: create employee → submit leave → approve → balance update → coverage event → compliance dashboard amber row.                                                                                                                                       |

The Cycle 4 exit deliverable is the end-to-end vertical slice from the plan's Step 10 alongside the resolution of the temporary HR-employee identity mapping that has been carried since Cycle 2 Step 5. `docs/cycle4-cat-script.md` will be the reproducible CAT script.

---

## What this cycle adds on top of Cycles 0–3

Cycle 3 closed Phase 1 (Build the Core) with three complete workflow domains (attendance, grading, communications) plus a notification pipeline that fans every Kafka event out to the right people. Cycle 4 opens Phase 3 (Expand) by adding the M80 HR/Workforce module — the people-side counterpart to the SIS's student-side bookkeeping. After Cycle 4, every staff member exists as a first-class `hr_employees` row with positions, certifications, leave balances, and a compliance posture, instead of being inferred from `iam_person` plus a temporary direct-FK convention.

**Key dependencies inherited from Cycles 0–3:**

- **`iam_person` is still the canonical human-identity FK** (ADR-055). `hr_employees.person_id` is a UNIQUE soft FK to it. The Step 0 backfill simply joins on `person_id` to discover which `iam_person` row each new `hr_employees.id` should bridge to.
- **Tenant isolation discipline** — `executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a `$transaction` that runs `SET LOCAL search_path` (REVIEW-CYCLE1 fix). Every HR service uses these helpers; the leave-notification consumer reuses the `runWithTenantContextAsync` + envelope-extracted `TenantInfo` pattern from `GradebookSnapshotWorker` and the Cycle 3 notification consumers.
- **ADR-057 event envelope** — every leave Kafka emit uses `KafkaProducerService.emit(EmitOptions)` with `sourceModule: 'hr'`. The envelope shape is unchanged from Cycle 3.
- **Notification pipeline (Cycle 3 Step 5)** — leave request approval / rejection notifications flow through the existing `NotificationQueueService` and `NotificationDeliveryWorker`. The new `LeaveNotificationConsumer` enqueues `hr.leave.approved` / `hr.leave.rejected` notifications via the same path.
- **Row-level authorization pattern** from REVIEW-CYCLE1 — every HR endpoint uses `ActorContextService.resolveActor(...)` and applies a per-personType visibility predicate. Self-only reads for the `me` routes; admin-only reads for cross-employee pages; admin-only writes for approval / verification routes.
- **Staff Directory app tile + sidebar entry** — wired through `apps/web/src/components/shell/apps.tsx::getAppsForUser(user)` per the UI Design Principles in `CLAUDE.md`. The "Staff", "Leave", and "Compliance" tiles surface in both the home launchpad and the sidebar via the same single source of truth.

**Cycle-4-specific carry-overs from prior cycles:**

- **REVIEW-CYCLE2 DEVIATION 4 — Temporary HR-Employee Identity Mapping.** Documented in CLAUDE.md and annotated on the four soft-FK columns themselves via `COMMENT ON COLUMN`. Step 0 of this cycle is the additive bridge migration that resolves it.
- **REVIEW-CYCLE3 reviewer carry-over** — wire a DLQ-row dashboard / alert for `platform.platform_dlq_messages`. Tracked in the Phase 2 punch list, not in Cycle 4 scope.

---

## Step 0 — HR-Employee Identity Migration (Carry-Over from Cycle 2)

**Why this is Step 0.** The Cycle 2 architecture review (REVIEW-CYCLE2-CHATGPT, DEVIATION 4) accepted that we would temporarily store `iam_person.id` in columns whose ERD intent is a soft FK to `hr_employees(id)` — `sis_class_teachers.teacher_employee_id`, `cls_grades.teacher_id`, `cls_lessons.teacher_id`, `cls_student_progress_notes.author_id`. The justification was that creating `hr_employees` only for these four columns would have been schema theatre during Cycle 2; deferring to the cycle that ships the rest of the HR module was the right call. Cycle 4 is that cycle, and Step 0 is the additive bridge that finally resolves the deviation. Doing it before Steps 1–4 (the rest of the HR schema) means every subsequent migration can assume `hr_employees` exists and reference it directly.

### What Changes

1. **Create the `hr_employees` table.** Lives in `packages/database/prisma/tenant/migrations/011_hr_employees_and_positions.sql` alongside the rest of Step 1's tables, but the `hr_employees` portion is what unlocks Step 0. The table is scoped to its tenant schema (per ADR-001 — no DB-enforced FKs to `platform.*`). Core columns:

| Column              | Type                       | Notes                                                                                                                                                                          |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                | `UUID PK`                  | Generated in app via `generateId()` (UUIDv7 per ADR-002).                                                                                                                       |
| `person_id`         | `UUID NOT NULL UNIQUE`     | Soft FK to `platform.iam_person(id)` per ADR-055. The bridge column for Step 0's UPDATE statements. UNIQUE so there is at most one `hr_employees` row per `iam_person`.        |
| `account_id`        | `UUID NOT NULL UNIQUE`     | Soft FK to `platform.platform_users(id)` per ADR-055. Lets `EmployeeService` resolve an employee from the JWT's `sub` without a `platform.iam_person` round-trip.              |
| `school_id`         | `UUID NOT NULL`            | Soft FK to `platform.schools(id)`. The denormalised partition / scope key — every read and write is tenant-bounded already, but we keep it explicit for observability queries. |
| `employee_number`   | `TEXT`                     | Optional school-issued identifier (payroll number, badge id). Index for lookup; not unique because the empty case is allowed.                                                  |
| `employment_type`   | `TEXT NOT NULL`            | `CHECK IN ('FULL_TIME','PART_TIME','CONTRACT','TEMPORARY','INTERN','VOLUNTEER')`. Cycle 4 uses FULL_TIME for all 5 seeded employees.                                            |
| `employment_status` | `TEXT NOT NULL`            | `CHECK IN ('ACTIVE','ON_LEAVE','TERMINATED','SUSPENDED')`. ACTIVE for the 5 seeded employees.                                                                                  |
| `hire_date`         | `DATE NOT NULL`            | Backfilled to a sensible default per employee — see seed below.                                                                                                                 |
| `termination_date`  | `DATE`                     | Nullable.                                                                                                                                                                      |
| `created_at`        | `TIMESTAMPTZ NOT NULL`     | `DEFAULT now()`.                                                                                                                                                                |
| `updated_at`        | `TIMESTAMPTZ NOT NULL`     | `DEFAULT now()`. Service code sets `updated_at = now()` on every mutation, matching every prior cycle (no triggers).                                                            |

   Indexes: PK on `id`; UNIQUE on `person_id`; UNIQUE on `account_id`; INDEX on `(school_id, employment_status)` for the staff-directory hot path; INDEX on `(employee_number)` (sparse).

   `COMMENT ON COLUMN hr_employees.person_id` annotates the soft-FK rule (ADR-055) so it is discoverable from the live schema. Same for `account_id` and `school_id`. No semicolons in any COMMENT string (provision SQL splitter constraint, see Step 1 of Cycle 3).

2. **Seed `hr_employees` rows for existing staff.** Lands in `packages/database/src/seed-hr.ts` (Step 5 owns the rest of the HR seed; Step 0's portion lives in the same script). The `seed.ts` platform seed was extended to create two new staff users (`vp@` Linda Park and `counsellor@` Marcus Hayes) so we have 4 distinct school-employee `iam_person` rows to bridge. Four rows in `tenant_demo` after Step 0:

   | Source `iam_person` (display name) | Account email                  | `employee_number` | `hire_date`  | Notes                                                                                                                                                                            |
   | ---------------------------------- | ------------------------------ | ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Sarah Mitchell                     | `principal@demo.campusos.dev`   | `EMP-1001`        | `2018-08-15` | Will hold a `Principal` position assignment in Step 1.                                                                                                                          |
   | James Rivera                       | `teacher@demo.campusos.dev`     | `EMP-1002`        | `2021-08-23` | `Teacher` position. Owns the certifications + leave story for the CAT.                                                                                                          |
   | Linda Park                         | `vp@demo.campusos.dev`          | `EMP-1003`        | `2019-08-19` | `Vice Principal`. The platform seed (`seed.ts`) was extended in Step 0 to create this user.                                                                                     |
   | Marcus Hayes                       | `counsellor@demo.campusos.dev`  | `EMP-1004`        | `2022-08-22` | `Counsellor`. Platform seed extension in Step 0.                                                                                                                                |

   The `admin@demo.campusos.dev` Platform Admin persona (its own `iam_person` row "Platform Admin", separate from Sarah Mitchell) is **intentionally NOT bridged** — it represents a system administrator, not a school employee. It does not appear in the staff directory, has no leave balance, and authoring grades / progress notes from this account is rejected at the service layer with a clean 403 (since `actor.employeeId` is null).

   Net effect after Step 0 seeds: 4 rows in `hr_employees` for `tenant_demo`, every school-employee staff member has a stable `hr_employees.id` to be referenced from `sis_class_teachers` / `cls_grades` / `cls_lessons` / `cls_student_progress_notes` going forward. `tenant_test` stays empty (matches the `seed-sis` / `seed-classroom` / `seed-messaging` precedent — tests write their own fixtures).

   The seed is idempotent — gates on `hr_employees` row count and skips the bridge-pointing UPDATE if any rows are already present. Lookup-or-create on `iam_person` matches the Cycle 1 pattern.

3. **Re-point soft FKs.** Inside the same `seed-hr.ts` run (after the `hr_employees` rows are guaranteed), four UPDATE statements run inside `executeInTenantTransaction` so the bridge is atomic:

   ```sql
   UPDATE sis_class_teachers
      SET teacher_employee_id = e.id
     FROM hr_employees e
    WHERE e.person_id = sis_class_teachers.teacher_employee_id;
   ```

   And the same shape for `cls_grades.teacher_id`, `cls_lessons.teacher_id`, and `cls_student_progress_notes.author_id`. Because `hr_employees.person_id = iam_person.id` (UNIQUE), the join is one-to-one and the UPDATE is deterministic regardless of how many times the seed runs. After the bridge, the four columns hold `hr_employees.id` values; the `iam_person.id` values they previously held are no longer present anywhere in the tenant schema except via the new bridge row.

   The bridge is **additive** in the migration sense — the columns themselves do not change shape, only the values they hold. No DROP COLUMN, no DROP CONSTRAINT, no DDL beyond the new `hr_employees` table. This matches the Cycle 1 / Cycle 2 / Cycle 3 migration discipline (additive only; pre-deployment edits to fix architectural errors re-provision the tenant).

4. **Update `ActorContextService` to populate `actor.employeeId`.** `apps/api/src/iam/actor-context.service.ts::resolveActor()` currently resolves `personId` from `platform.iam_person`. Step 0 extends it to additionally do a tenant-scoped lookup against `hr_employees` keyed on `person_id`:

   ```typescript
   // Inside resolveActor, after person + accountId lookups
   const employee = await tenantPrisma.executeInTenantContext((c) =>
     c.$queryRawUnsafe<{ id: string }[]>(
       'SELECT id FROM hr_employees WHERE person_id = $1::uuid AND employment_status = \'ACTIVE\' LIMIT 1',
       personId,
     ),
   );
   return {
     ...
     personId,
     employeeId: employee[0]?.id ?? null,
     ...
   };
   ```

   `ResolvedActor` gains an `employeeId: string | null` field. Non-staff personas (parents, students) get `null` — they have no `hr_employees` row by design.

5. **Update service-layer comparisons.** Every site that currently compares `actor.personId` against one of the four bridged columns flips to compare `actor.employeeId`. Sites that changed:

   | File                                                | Method(s)                                                                          | What it does                                                                                                                |
   | --------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
   | `apps/api/src/attendance/attendance.service.ts`     | `assertCanWriteClassAttendance`                                                    | Per-class attendance write membership check.                                                                                |
   | `apps/api/src/classroom/assignment.service.ts`      | `assertCanWriteClass`, `canReadClass STAFF`, `isClassManager`                      | Class-scoped read/write/manager checks shared by every assignment + grading endpoint.                                       |
   | `apps/api/src/classroom/gradebook.service.ts`       | `assertCanViewStudent STAFF`, `isClassManager`                                     | Per-student gradebook visibility + manager check for draft visibility.                                                      |
   | `apps/api/src/classroom/submission.service.ts`      | `isManagerOfClass`, `canSeeSubmission STAFF`                                       | Submission row-level checks. STUDENT/GUARDIAN cases (compare against `ps.person_id` / `g.person_id`) correctly stay on `actor.personId`. |
   | `apps/api/src/classroom/grade.service.ts`           | `batchGrade`, `upsertGrade` (4 INSERT/UPDATE sites)                                | Writes `cls_grades.teacher_id`. Both methods now also reject 403 cleanly when `actor.employeeId` is null (e.g. Platform Admin). |
   | `apps/api/src/classroom/progress-note.service.ts`   | `upsert` (2 INSERT/UPDATE sites + 403 guard), `listForStudent STAFF`, `assertCanViewStudent STAFF` | Writes `cls_student_progress_notes.author_id`. Same 403 short-circuit as grade.service.                                                          |
   | `apps/api/src/sis/student.service.ts`               | `visibilityClause STAFF`                                                           | Teacher's row-level student visibility predicate (binds `actor.employeeId` to `ct.teacher_employee_id`).                    |
   | `apps/api/src/sis/class.service.ts`                 | `listForTeacherEmployee` (renamed from `listForTeacherPerson`); `loadTeachersForClasses` (now joins `sis_class_teachers → hr_employees → platform.iam_person`) | Teacher's "my classes" lookup; class-row teacher list join.                                                                                                                |
   | `apps/api/src/sis/class.controller.ts`              | `my`                                                                               | Resolves actor + passes `actor.employeeId` to the renamed service method; returns `[]` early when `employeeId` is null.     |
   | `apps/api/src/announcements/audience-fan-out.worker.ts` | `audienceClass` (CLASS-audience teacher branch)                                | Joins `sis_class_teachers → hr_employees → platform.platform_users.account_id` instead of the previous direct `platform_users.person_id = ct.teacher_employee_id`.                                                                                                                                                          |

   The substitution is scoped strictly to the four staff-side columns enumerated above. Endpoints that compare `personId` against `iam_person.id` directly (e.g. anything joining through `sis_student_guardians.guardian_id → sis_guardians.person_id`, or the STUDENT cases that compare against `platform_students.person_id`) do **not** change.

   `IamModule` now imports `TenantModule` so `ActorContextService` can do the tenant-scoped `hr_employees` lookup. No circular dependency — `TenantGuard` doesn't import from IAM.

6. **Update `CLAUDE.md`.** Step 0 closes by editing two CLAUDE.md sections:

   - **Project Status** — replace the deviation note with a permanent convention:
     > **Staff identity (resolved in Cycle 4 Step 0):** `sis_class_teachers.teacher_employee_id`, `cls_grades.teacher_id`, `cls_lessons.teacher_id`, and `cls_student_progress_notes.author_id` reference `hr_employees(id)`. Resolve via `actor.employeeId` from `ActorContextService.resolveActor(...)`. The Cycle 2 DEVIATION 4 temporary mapping is retired.
   - **Key Design Contracts** — remove the "Temporary HR-Employee Identity Mapping" bullet and replace with the same convention. Update the four `COMMENT ON COLUMN` annotations on the bridged columns in their original migrations from "TEMPORARY HR-EMPLOYEE IDENTITY MAPPING" to "Soft FK to hr_employees(id) per ADR-055. Resolve via actor.employeeId." Comment text changes are additive — the migrations were already idempotent on COMMENT ON.

### Files

- `packages/database/prisma/tenant/migrations/011_hr_employees_and_positions.sql` (new) — adds `hr_employees` (and the rest of Step 1's positions / contacts / documents, written in the same migration so the schema lands in one chunk). Idempotent CREATE-IF-NOT-EXISTS pattern. CHECK constraints on `employment_type` and `employment_status`. UNIQUE on `(person_id)` and `(account_id)`. Updated comments on the four bridged columns in the migrations that originally created them — `002_sis_academic_structure.sql`, `005_cls_lessons_and_assignments.sql`, `006_cls_submissions_and_grading.sql`. The COMMENT ON re-application is idempotent (PG replaces the previous comment text on each re-provision).
- `packages/database/src/seed-hr.ts` (new) — Step 0 portion seeds the 5 employee rows + runs the four bridge UPDATE statements inside one `executeInTenantTransaction`. Step 5 portion (added later) layers positions, leave types, etc. on top. Adds `seed:hr` to `packages/database/package.json`.
- `apps/api/src/iam/actor-context.service.ts` — `ResolvedActor` gains `employeeId: string | null`. `resolveActor()` does the tenant-scoped lookup.
- `apps/api/src/iam/dto/...` (if any DTO surfaces `ResolvedActor`) — typed accordingly.
- `apps/api/src/classroom/gradebook.service.ts` — 4 substitutions (`actor.personId` → `actor.employeeId`).
- `apps/api/src/classroom/submission.service.ts` — 5 substitutions.
- `apps/api/src/classroom/grade.service.ts` — 4 substitutions.
- `apps/api/src/classroom/progress-note.service.ts` — 7 substitutions.
- `apps/api/src/sis/class.service.ts` — 1 substitution + the `listForTeacherPerson` → `listForTeacherEmployee` rename. Controller call site updated.
- `apps/api/src/sis/class.controller.ts` — passes `actor.employeeId` to the renamed service method (resolves actor first).
- `CLAUDE.md` — convention update, deviation note retired.
- (Test fixtures, if any) — none in Cycle 0–3, none added here.

### Architecture (identity flow before vs after)

```
BEFORE (Cycle 2 DEVIATION 4)                  AFTER (Cycle 4 Step 0)
─────────────────────────────                  ──────────────────────

JWT.personId                                   JWT.personId
    │                                              │
    ▼                                              ▼
ActorContextService.resolveActor()             ActorContextService.resolveActor()
    │ → actor.personId (= iam_person.id)           │ → actor.personId (= iam_person.id)
    │                                              │ → actor.employeeId (= hr_employees.id)
    ▼                                              │      via SELECT id FROM hr_employees
sis_class_teachers.teacher_employee_id         │      WHERE person_id = personId
   == actor.personId                              ▼
                                               sis_class_teachers.teacher_employee_id
                                                  == actor.employeeId
```

### Authorisation / tenant isolation

The bridge introduces no new auth surface — `hr_employees` is a tenant-scoped table, every read goes through `executeInTenantContext` with `SET LOCAL search_path` (REVIEW-CYCLE1 fix), and the row-level filter pattern from REVIEW-CYCLE1 applies the same way. The `actor.employeeId` lookup happens once per request inside `resolveActor`, so it doesn't add request-path latency beyond the existing single-row `iam_person` query.

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 11 migrations applied
pnpm --filter @campusos/database provision --subdomain=demo   # idempotent re-run, 11 migrations applied (no-op)
pnpm --filter @campusos/database provision --subdomain=test   # 11 migrations applied
pnpm seed                                                     # adds vp@ + counsellor@ (now 7 platform users)
pnpm --filter @campusos/database seed:hr                       # 4 employee rows inserted; 6+62+0+1 bridge rows updated; 0 orphans
pnpm --filter @campusos/database seed:hr                       # idempotent re-run: 0 inserted, 0 bridged
pnpm --filter @campusos/api build                              # nest build → exits 0
cd apps/api && pnpm exec tsc --noEmit                          # type-check clean
pnpm --filter @campusos/api start:prod                         # boot + smoke
```

Live smoke against `tenant_demo` (recorded 2026-04-28):

| #   | Scenario                                                                                  | Expected                                                                                  | Got |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --- |
| 1   | `seed:hr` first run                                                                       | 4 inserts; sis_class_teachers bridged 6, cls_grades 62, cls_lessons 0, progress_notes 1   | ✅  |
| 2   | Orphan check after bridge across all four columns                                         | 0 orphans                                                                                 | ✅  |
| 3   | `seed:hr` second run                                                                      | 4 already-exist messages, 0 bridged, 0 orphans (idempotency confirmed)                    | ✅  |
| 4   | `pnpm --filter @campusos/api build`                                                       | exits 0, no TS errors                                                                     | ✅  |
| 5   | API boots — every module loads, no missing-dependency errors from the new TenantModule import in IamModule | NestFactory log shows IamModule, SisModule, ClassroomModule, AttendanceModule, AnnouncementsModule all initialised | ✅ |
| 6   | `POST /api/v1/auth/dev-login` for `teacher@demo.campusos.dev`                             | 200 with accessToken                                                                      | ✅  |
| 7   | Teacher's `GET /api/v1/classes/my`                                                        | 6 classes (P1 Algebra → P6 Chemistry) — matches pre-bridge baseline                       | ✅  |
| 8   | Teacher's `GET /api/v1/students`                                                          | 15 students — STAFF visibilityClause now binds `actor.employeeId` to `teacher_employee_id` | ✅  |
| 9   | Teacher's `GET /api/v1/classes/:p1ClassId/gradebook`                                      | 3 students in the P1 roster (manager-only endpoint reaches `assertCanWriteClass`)         | ✅  |
| 10  | `counsellor@` (employee with no class assignments + no `stu-001:read`) hits `/classes/my` | 403 INSUFFICIENT_PERMISSIONS at the permission gate — bridge does not grant permissions   | ✅  |

### Lessons learned during Step 0

- **Splitter `;`-in-string trap (CLAUDE.md flagged it; it bit anyway).** The first re-provision after rewriting the four `COMMENT ON COLUMN` strings failed with `ERROR: unterminated quoted string` because the new comment text contained a `;` mid-sentence. The provision SQL splitter cuts on every `;` regardless of quoting context. Fix: replace inline `;` with `—` (em-dash) or `and`. Five COMMENT strings touched (the four bridged columns plus the new `hr_employees.school_id`), all now use safe punctuation. Worth re-emphasising in CLAUDE.md — the rule applies to any string literal, not just CHECK predicates.
- **The audience-fan-out worker also needed updating.** It wasn't on the original Step 0 plan because the plan only enumerated services that compare `actor.personId` against bridged columns. The worker doesn't compare an actor — it joins a denormalised `platform.platform_users.person_id` against `ct.teacher_employee_id` to find the teacher accounts to notify on a CLASS-audience announcement. After the bridge, that join no longer matches anything. Fix: add `JOIN hr_employees he ON he.id = ct.teacher_employee_id` and select `he.account_id` directly. The `loadTeachersForClasses` SQL in `class.service.ts` had the same shape and got the same fix.
- **`grade.service.ts` and `progress-note.service.ts` need a `ForbiddenException` guard, not just a substitution.** Both write a NOT NULL column (`cls_grades.teacher_id`, `cls_student_progress_notes.author_id`). A null `actor.employeeId` is a contract violation for those write paths — letting the SQL fail with a 23502 NOT NULL constraint error would be ugly. Adding an explicit 403 at the entry of `batchGrade`, `upsertGrade`, and `upsert` gives a clean error envelope and makes the design intent ("only employees author grades / progress notes") visible in the code.

### Out-of-scope decisions for Step 0

- **No DB-enforced FK on the four bridged columns.** Tenant-tenant FKs are allowed by the codebase rules, but the columns are deliberately kept as soft refs because the partitioned-parent precedent (Cycle 1 `sis_attendance_evidence`, Cycle 3 `msg_message_attachments`) still applies — `hr_employees` is unpartitioned today but a future M16 expansion may partition by `school_id` if multi-school instances grow. Soft refs let the schema decision stay flexible; row-level integrity is enforced by the seed UPDATE + row-level service code that asserts `actor.employeeId` exists before touching the columns.
- **No retroactive rename of the columns.** `teacher_employee_id` is the right name for what the column now holds; `cls_grades.teacher_id` and friends already convey staff-side intent. No DROP COLUMN / RENAME COLUMN this cycle — the migration discipline is additive only. If a future cycle wants column renames, that's a dedicated bridge migration.
- **No retroactive change to the seed in Cycles 1–3.** `seed-sis` and `seed-classroom` continue to write the `iam_person.id` value into the four columns (matching what they did from day one). Cycle 4 Step 0's `seed-hr` is the one place where the bridge UPDATE runs. This keeps the historical seed scripts truthful — they write what the schema documented at the time they were authored, and the cycle that introduces the new convention also owns the migration.
- **The `admin@` Platform Admin persona is NOT bridged.** It has its own `iam_person` row ("Platform Admin", separate from Sarah Mitchell's `iam_person`) and represents a system administrator, not a school employee. Giving it an `hr_employees` row would imply leave balances, certifications, and a position. It does not appear in the staff directory; service code that depends on `actor.employeeId` (e.g. `cls_grades.teacher_id` writes) returns 403 cleanly when invoked from this account. The other 4 staff (`principal@` Sarah Mitchell, `teacher@` James Rivera, `vp@` Linda Park, `counsellor@` Marcus Hayes) all bridge.
- **`hr_employees` is created in `011_hr_employees_and_positions.sql`, not a separate `010b` file.** The plan calls for one Step 1 migration covering all of "Employees & Positions"; splitting Step 0 into its own migration would muddy the story for the post-cycle reviewer. The Step 0 work in this handoff section refers to the `hr_employees` portion of `011_*.sql` plus the seed bridge logic — not a separate SQL file.
- **No retroactive `COMMENT ON COLUMN` re-write in Cycles 1–3 SQL files.** The provision tool reads each migration top-to-bottom; the COMMENT updates land as additional `COMMENT ON COLUMN` statements at the bottom of the original files. Each one is idempotent (PG replaces the previous comment), so the next provision picks up the new wording without any DDL diff.
- **No new permission code added in Step 0.** HR-001/003/004 codes ship in Step 5 with the rest of the seed updates. Step 0 itself only writes data and rewires service-layer comparisons; it does not add any new endpoints or gate any existing ones.
- **`actor.employeeId` is `null` for non-staff.** Parents, students, and the synthetic Platform Admin do not get an `hr_employees` row by design (see two bullets up). Service code that depends on `employeeId` MUST guard against `null` — typically by short-circuiting the membership check and falling back to `actor.isSchoolAdmin` (admins bypass the check entirely). This is the same null-safety posture that applies to `actor.studentId` for non-students; nothing new here.
- **No Kafka emit on the bridge.** The bridge is a one-time data backfill; downstream consumers don't care about the rewrite. If a future cycle needs to broadcast staff changes (e.g. for an external HR sync), `hr.employee.created` / `hr.employee.updated` events ship later — Cycle 4 Step 7's leave events are the only HR-side emits this cycle.
- **The CAT for Step 0 is folded into Step 10's CAT.** Rather than a one-off Step 0 walkthrough, the Cycle 4 vertical slice CAT (Step 10) opens with the bridge verification queries (Scenarios 1–4 above) before walking through the leave + compliance flow. This keeps the reproducible test surface small and forces the bridge to live or die alongside the rest of the cycle.

---

## Step 1 — HR Schema — Employees & Positions

**Done.** `packages/database/prisma/tenant/migrations/011_hr_employees_and_positions.sql` (the same migration file used for Step 0) lands 5 additional base tables on top of `hr_employees`. Idempotent CREATE-IF-NOT-EXISTS pattern. Snake_case columns, `TEXT + CHECK` for enum-like fields where they appear elsewhere in HR (none in this step). All cross-schema refs to `platform.*` are soft per ADR-001/020. Intra-tenant FKs are DB-enforced where the parent is unpartitioned — the same pattern Cycle 1 / Cycle 2 used for non-partitioned parents.

### Tables (5)

| Table                   | Purpose                                                                                                                          | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_positions`          | Per-school position catalogue. Each position is a job title that can be assigned via `hr_employee_positions`.                   | `id`, `school_id`, `title`, `department_id` (soft FK to `sis_departments(id)`), `is_teaching_role BOOLEAN`, `is_active BOOLEAN`. UNIQUE(school_id, title). Partial INDEX(school_id) WHERE `is_active=true` for the position-picker hot path. Partial INDEX(department_id) WHERE NOT NULL.                                                                                                                                  |
| `hr_employee_positions` | Time-bounded position assignments. An employee can hold multiple positions (one primary), and the history is preserved via `effective_from` / `effective_to`. | `id`, `employee_id` (FK to `hr_employees(id) ON DELETE CASCADE`), `position_id` (FK to `hr_positions(id)`), `is_primary BOOLEAN DEFAULT true`, `fte NUMERIC(4,3) DEFAULT 1.000`, `effective_from DATE NOT NULL`, `effective_to DATE`. INDEX(employee_id, effective_from DESC) for "current + history" reads; INDEX(position_id) for the inverse "who holds this position" lookup; partial UNIQUE INDEX(employee_id) WHERE `is_primary AND effective_to IS NULL` so an employee has at most one current primary position. CHECK `effective_to IS NULL OR effective_to >= effective_from`. CHECK `fte > 0 AND fte <= 1.000`. |
| `hr_emergency_contacts` | Per-employee emergency contact list. Distinct from `sis_emergency_contacts` (which is for student emergencies).                  | `id`, `employee_id` (FK to `hr_employees ON DELETE CASCADE`), `name`, `relationship`, `phone NOT NULL`, `email`, `is_primary BOOLEAN`, `sort_order INT`. INDEX(employee_id, sort_order). Partial UNIQUE INDEX(employee_id) WHERE `is_primary=true` so each employee has at most one primary contact.                                                                                                                       |
| `hr_document_types`     | Per-school catalogue of document categories that may be attached to an employee record.                                          | `id`, `school_id`, `name`, `description`, `is_required BOOLEAN`, `retention_days INT` (NULL = no retention policy), `is_active BOOLEAN`. UNIQUE(school_id, name). CHECK `retention_days IS NULL OR retention_days > 0`. Partial INDEX(school_id) WHERE `is_active=true`.                                                                                                                                                  |
| `hr_employee_documents` | Per-(employee, document) attached file. The file lives in object storage; this table holds the metadata.                       | `id`, `employee_id` (FK to `hr_employees ON DELETE CASCADE`), `document_type_id` (FK to `hr_document_types`), `file_name`, `s3_key TEXT`, `content_type`, `file_size_bytes BIGINT`, `uploaded_by` (soft → `platform_users`), `uploaded_at`, `expiry_date DATE`, `is_archived BOOLEAN`. INDEX(employee_id, document_type_id). Partial INDEX(expiry_date) WHERE `expiry_date IS NOT NULL AND is_archived=false` for the certification expiry sweep. CHECK `file_size_bytes IS NULL OR file_size_bytes >= 0`. |

### FKs (intra-tenant) and soft references

| Constraint                                                  | Type                  | Notes                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hr_employee_positions.employee_id → hr_employees(id)`      | DB-enforced (CASCADE) | Both unpartitioned. Cascade because a position-history row is meaningless without its parent employee — verified live with a temp-employee delete that dropped all three child rows. |
| `hr_employee_positions.position_id → hr_positions(id)`      | DB-enforced           | No cascade — positions persist in the catalogue even if the assignment row is removed; the assignment's `effective_to` field handles end-of-tenure.                                   |
| `hr_emergency_contacts.employee_id → hr_employees(id)`      | DB-enforced (CASCADE) | Same rationale as `hr_employee_positions`.                                                                                                                                            |
| `hr_employee_documents.employee_id → hr_employees(id)`      | DB-enforced (CASCADE) | Same rationale.                                                                                                                                                                       |
| `hr_employee_documents.document_type_id → hr_document_types(id)` | DB-enforced       | No cascade — deleting a document type with active documents requires explicit migration of those documents first.                                                                  |
| `hr_positions.department_id → sis_departments(id)`          | **Soft (informational)** | Tenant-tenant ref but **deliberately unenforced**. The SIS module predates HR, the relationship is an informational hint, and a hard FK would create awkward delete coupling between SIS and HR going forward. App-layer handles the lookup. |
| `hr_employee_documents.uploaded_by`                          | Soft (cross-schema)   | Soft UUID ref to `platform.platform_users(id)` per ADR-055. Audit-only.                                                                                                              |
| `hr_*.school_id`                                            | Soft (cross-schema)   | Soft UUID ref to `platform.schools(id)` per ADR-001/020.                                                                                                                              |

### CHECK constraints

| Constraint                              | Predicate                                                            |
| --------------------------------------- | -------------------------------------------------------------------- |
| `hr_employee_positions_dates_chk`       | `effective_to IS NULL OR effective_to >= effective_from`              |
| `hr_employee_positions_fte_chk`         | `fte > 0 AND fte <= 1.000`                                            |
| `hr_document_types_retention_chk`       | `retention_days IS NULL OR retention_days > 0`                        |
| `hr_employee_documents_size_chk`        | `file_size_bytes IS NULL OR file_size_bytes >= 0`                     |
| `hr_employees_employment_type_chk`      | (Step 0) `employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','TEMPORARY','INTERN','VOLUNTEER')` |
| `hr_employees_employment_status_chk`    | (Step 0) `employment_status IN ('ACTIVE','ON_LEAVE','TERMINATED','SUSPENDED')` |

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 11 migrations applied (no-op for Steps 0+1 since CREATE IF NOT EXISTS)
pnpm --filter @campusos/database provision --subdomain=test   # same
```

Counts in `tenant_demo` after Step 1:

| What                                                             | Count |
| ---------------------------------------------------------------- | ----: |
| Logical base tables (top-level, was 58)                          |    63 |
| HR tables (`hr_*`)                                                |     6 |
| Intra-tenant FKs from Step 1 tables                              |     5 |
| Cross-schema FKs from `tenant_demo`                              |     0 |
| `hr_employees` rows (carry-over from Step 0)                      |     4 |
| Step 1 child-table rows (post-smoke cleanup)                     |     0 |

CHECK + FK + cascade smoke (live):

| Constraint / behaviour                                       | Test                                                                                                  | Outcome  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------- |
| `hr_employee_positions_dates_chk`                            | INSERT effective_from=2026-01-01, effective_to=2025-01-01                                              | ERROR ✅ |
| `hr_employee_positions_fte_chk`                              | INSERT fte=1.5                                                                                         | ERROR ✅ |
| `hr_document_types_retention_chk`                            | INSERT retention_days=0                                                                                | ERROR ✅ |
| `hr_employee_documents_size_chk`                             | INSERT file_size_bytes=-1                                                                              | ERROR ✅ |
| `hr_employee_positions_employee_id_fkey`                     | INSERT employee_id=<random uuid>                                                                       | ERROR ✅ |
| Happy-path multi-insert across all 5 new tables linked to Rivera | 1 position + 1 emergency contact + 1 document type + 1 document — all four child counts = 1          | ✅       |
| ON DELETE CASCADE on `hr_employees` (temp employee)          | Pre-delete 1/1/1, DELETE FROM hr_employees, post-delete 0/0/0 across positions/contacts/documents      | ✅       |

### Splitter `;`-in-block-comment trap (lesson)

The first re-provision after extending the migration's header block-comment failed mid-comment with `unterminated quoted string` because the block-comment text contained `` `;` `` as an example to warn future readers about the quirk. The splitter splits on every `;` regardless of quoting context, **including inside block comments**. Fix: rewrite the warning text to spell out "no semicolons" instead of using a literal `;` as an inline example. CLAUDE.md's existing warning was correct ("never put a `;` inside a string literal") — this just sharpens it: the rule applies to anywhere in the migration file, not only inside string literals.

### Out-of-scope decisions for Step 1

- **`hr_positions.department_id` is a soft FK, not a DB-enforced one.** Both tables live in the tenant schema, so a hard FK would technically be allowed, but the SIS module predates HR. Coupling SIS-side delete behaviour to HR (a department deletion would suddenly need to consider HR positions) creates an unwelcome cross-module dependency for downstream cycles. Soft ref + app-layer validation is cleaner.
- **`hr_emergency_contacts` is separate from `sis_emergency_contacts`.** The plan called this out. SIS emergency contacts are for *students*; HR ones are for *employees*. Keeping the tables separate avoids a polymorphic `contact_target_type` column and lets the two modules evolve independently.
- **No partitioning.** Every Step 1 table is unpartitioned. Volume is bounded by (employees × positions-history-depth) and (employees × emergency-contacts) — far below the partitioning threshold even at multi-school scale. If a future merger explodes employee counts past O(10⁶), partition then.
- **`uploaded_by` on `hr_employee_documents` is a soft ref.** Per ADR-055 / ADR-001/020, audit identity columns stay loose — a deactivated user shouldn't cascade into document metadata. The lifecycle is handled by the document service, not by the database.
- **`retention_days` is informational-only at the schema layer.** Step 6's `EmployeeDocumentService` (and a future scheduled retention sweeper) reads this column to decide which documents are eligible for purge — but the schema doesn't auto-enforce. Compliance flow is app-layer.
- **No Prisma model entries.** Tenant tables aren't in the Prisma schema (matches the Cycle 1–3 convention); services query via `client.$queryRawUnsafe` with explicit `$N::uuid` casts. Step 6 will surface DTOs through `class-validator`.
- **No seed yet.** Step 5 owns the rest of the HR seed (positions, emergency contacts, document types, sample documents). Step 1 is schema-only.
- **`is_primary` constraints are partial-unique-index, not table CHECKs.** Both `hr_employee_positions` and `hr_emergency_contacts` use a `WHERE` clause on the unique index so multiple non-primary rows are allowed. PostgreSQL unique constraints (vs unique indexes) don't support `WHERE` clauses, hence the `CREATE UNIQUE INDEX … WHERE` form.
- **CHECK strings still cannot contain `;`.** Carries forward from every prior cycle. Spot-checked all CHECK predicates and `COMMENT ON COLUMN` strings in 011 — none contain `;`. The only place a `;` appeared was in the migration's header block-comment, which the splitter also cuts.

Plan reference: Step 1 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 2 — HR Schema — Leave Management

**Done.** `packages/database/prisma/tenant/migrations/012_hr_leave_management.sql` lands 3 base tables. Idempotent CREATE-IF-NOT-EXISTS pattern. Snake_case columns, `TEXT + CHECK` for the request status enum. DB-enforced FKs to `hr_employees ON DELETE CASCADE`, `hr_leave_types`, and `sis_academic_years` (the latter non-cascade — deleting an academic year while balances exist is a data-integrity concern that should fail loudly).

### Tables (3)

| Table                | Purpose                                                                                                                          | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_leave_types`     | Per-school leave catalogue (Sick, Personal, Bereavement, PD, Unpaid).                                                            | `id`, `school_id`, `name`, `description`, `is_paid BOOLEAN DEFAULT true`, `accrual_rate NUMERIC(5,2) DEFAULT 0` (days/year — 0 means non-accruing), `max_balance NUMERIC(5,2)` (NULL = uncapped), `is_active BOOLEAN`. UNIQUE(school_id, name). CHECK `accrual_rate >= 0` and `max_balance IS NULL OR max_balance >= 0`. Partial INDEX(school_id) WHERE `is_active = true`.                                                                                                                          |
| `hr_leave_balances`  | Per-(employee, type, academic year) running balance. Single source of truth, derived by the approval workflow that lands in Step 7. | `id`, `employee_id` (FK to `hr_employees ON DELETE CASCADE`), `leave_type_id` (FK to `hr_leave_types`), `academic_year_id` (FK to `sis_academic_years` non-cascade), `accrued NUMERIC(5,2)`, `used NUMERIC(5,2)`, `pending NUMERIC(5,2)`. UNIQUE(employee_id, leave_type_id, academic_year_id). CHECKs: `accrued >= 0`, `used >= 0`, `pending >= 0`. INDEX(employee_id, academic_year_id) and (leave_type_id).                                                                                       |
| `hr_leave_requests`  | Request lifecycle. PENDING → APPROVED / REJECTED / CANCELLED.                                                                    | `id`, `employee_id` (FK CASCADE), `leave_type_id` (FK), `start_date DATE`, `end_date DATE`, `days_requested NUMERIC(4,1)` (half-day support), `status TEXT DEFAULT 'PENDING'`, `reason`, `submitted_at`, `reviewed_at`, `reviewed_by` (soft → `platform_users`), `review_notes`, `cancelled_at`, `is_hr_initiated BOOLEAN DEFAULT false`, `hr_initiated_by` (soft), `hr_initiated_reason TEXT`. CHECK `status IN ('PENDING','APPROVED','REJECTED','CANCELLED')`, `end_date >= start_date`, `days_requested > 0`, and a multi-column CHECK that `is_hr_initiated`, `hr_initiated_by`, and `hr_initiated_reason` are all-set or all-null together (no partial HR-initiated state). INDEX(employee_id, status); partial INDEX(status, start_date) WHERE `status IN ('PENDING','APPROVED')` for the upcoming-leave queries; INDEX(leave_type_id). |

### Approval flow at the schema layer

The schema doesn't enforce the state machine — it only accepts the four valid status values. Step 7's `LeaveService` owns the transitions:

```
submit  -> status=PENDING, balance.pending += days_requested
           Kafka emit: hr.leave.requested
approve -> status=APPROVED, reviewed_by/reviewed_at set
           balance.pending -= days_requested
           balance.used    += days_requested
           Kafka emit: hr.leave.approved (consumed by Cycle 5 Scheduling)
reject  -> status=REJECTED, reviewed_by/reviewed_at/review_notes set
           balance.pending -= days_requested
           Kafka emit: hr.leave.rejected
cancel  -> status=CANCELLED, cancelled_at set
           balance.pending -= days_requested (if was PENDING)
           or balance.used -= days_requested  (if was APPROVED)
           Kafka emit: hr.leave.cancelled
```

The non-negative balance CHECKs guarantee the math can't go below zero — if Step 7's update would underflow `pending` or `used`, the UPDATE fails loudly rather than silently corrupting the running totals.

### FKs (intra-tenant) and soft references

| Constraint                                                  | Type                  | Notes                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hr_leave_balances.employee_id → hr_employees(id)`          | DB-enforced (CASCADE) | Both unpartitioned. Cascade because a balance row without its parent employee is meaningless. Verified live with a temp-employee delete that dropped the linked balance + request rows. |
| `hr_leave_balances.leave_type_id → hr_leave_types(id)`      | DB-enforced           | No cascade — leave types persist in the catalogue across deletions; balances should not silently vanish if a type is removed (the active-flag is the right cleanup mechanism).        |
| `hr_leave_balances.academic_year_id → sis_academic_years(id)` | DB-enforced           | Tenant-tenant ref. Non-cascade so that deleting an academic year while balances still reference it fails loudly.                                                                       |
| `hr_leave_requests.employee_id → hr_employees(id)`          | DB-enforced (CASCADE) | Same rationale as balances.                                                                                                                                                           |
| `hr_leave_requests.leave_type_id → hr_leave_types(id)`      | DB-enforced           | Same as balances.                                                                                                                                                                     |
| `hr_leave_requests.reviewed_by`                             | Soft (cross-schema)   | UUID ref to `platform.platform_users(id)` per ADR-055 — audit-only.                                                                                                                   |
| `hr_leave_requests.hr_initiated_by`                         | Soft (cross-schema)   | UUID ref to `platform.platform_users(id)` per ADR-055.                                                                                                                                |
| `hr_leave_types.school_id`, `hr_leave_balances.*` (none of the school columns)   | Soft / no column      | `hr_leave_types.school_id` is a soft UUID per ADR-001/020. The balance and request rows are tenant-scoped via search_path; school_id isn't denormalised on them because every read joins through `hr_employees` already. |

### CHECK constraints

| Constraint                              | Predicate                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `hr_leave_types_accrual_chk`            | `accrual_rate >= 0`                                                                                                                |
| `hr_leave_types_max_balance_chk`        | `max_balance IS NULL OR max_balance >= 0`                                                                                          |
| `hr_leave_balances_accrued_chk`         | `accrued >= 0`                                                                                                                     |
| `hr_leave_balances_used_chk`            | `used >= 0`                                                                                                                        |
| `hr_leave_balances_pending_chk`         | `pending >= 0`                                                                                                                     |
| `hr_leave_requests_status_chk`          | `status IN ('PENDING','APPROVED','REJECTED','CANCELLED')`                                                                          |
| `hr_leave_requests_dates_chk`           | `end_date >= start_date`                                                                                                            |
| `hr_leave_requests_days_chk`            | `days_requested > 0`                                                                                                                |
| `hr_leave_requests_hr_initiated_chk`    | `(is_hr_initiated=false AND hr_initiated_by IS NULL AND hr_initiated_reason IS NULL) OR (is_hr_initiated=true AND hr_initiated_by IS NOT NULL AND hr_initiated_reason IS NOT NULL)` |

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 12 migrations applied
pnpm --filter @campusos/database provision --subdomain=test   # 12 migrations applied
```

Counts in `tenant_demo` after Step 2:

| What                                                             | Count |
| ---------------------------------------------------------------- | ----: |
| Logical base tables (top-level, was 63)                          |    66 |
| HR tables (`hr_*`)                                                |     9 |
| Intra-tenant FKs from Step 2 tables                              |     5 |
| Cross-schema FKs from `tenant_demo`                              |     0 |

CHECK + FK + UNIQUE + cascade smoke (live):

| Constraint / behaviour                                       | Test                                                                                                  | Outcome  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------- |
| `hr_leave_requests_status_chk`                               | INSERT status='BOGUS'                                                                                  | ERROR ✅ |
| `hr_leave_requests_dates_chk`                                | INSERT start=2026-05-05, end=2026-05-01                                                                | ERROR ✅ |
| `hr_leave_requests_days_chk`                                 | INSERT days_requested=0                                                                                | ERROR ✅ |
| `hr_leave_requests_hr_initiated_chk`                         | INSERT is_hr_initiated=true with hr_initiated_reason=NULL                                              | ERROR ✅ |
| `hr_leave_types_accrual_chk`                                 | INSERT accrual_rate=-1                                                                                 | ERROR ✅ |
| `hr_leave_balances_accrued_chk`                              | INSERT accrued=-1                                                                                      | ERROR ✅ |
| `hr_leave_balances_employee_type_year_uq`                    | INSERT a second balance for the same (employee, type, year) tuple                                      | ERROR ✅ |
| Happy-path multi-insert linked to Rivera                     | 2 leave types + 1 balance + 2 requests (one PENDING, one HR-initiated APPROVED)                        | ✅       |
| ON DELETE CASCADE on `hr_employees` (temp employee)          | Pre-delete: 1 balance / 1 request. DELETE FROM hr_employees. Post-delete: 0 / 0.                       | ✅       |

### Out-of-scope decisions for Step 2

- **No accrual job in this step.** The Step 7 `LeaveService` will own the at-year-start accrual run that bumps `accrued` for every (employee, type) pair. This step just lands the schema with the CHECKs that prevent negative values.
- **No leave coverage logic.** The plan calls for an `hr.leave.coverage_needed` event in Step 7, consumed by Cycle 5 Scheduling. The producer (`LeaveNotificationConsumer`) lands in Step 7; this step doesn't ship any event-shape definitions.
- **`days_requested` is denormalised relative to `end_date - start_date`.** Stored explicitly because half-days, partial-day cancellations, and weekend-skipping are all app-layer concerns. The CHECK `days_requested > 0` is the only schema-level constraint.
- **`hr_leave_balances.school_id` not denormalised.** Every read joins through `hr_employees.school_id` already; adding the column to the balance row would just be a write-time consistency concern with no query benefit.
- **`reviewed_by` and `hr_initiated_by` are soft cross-schema refs.** Audit identity columns stay loose per ADR-055.
- **No `effective_balance` computed column.** "Available days" is `accrued - used - pending`, computable in service code or a SQL expression on read. Storing it would add another non-negative CHECK to keep in sync; not worth it.
- **No partitioning.** Volume bounded by employees × leave types × years and employees × historic requests. Far below partitioning threshold even at multi-school scale.
- **No seed yet.** Step 5 owns leave-type catalogue seeding (5 types: Sick, Personal, Bereavement, PD, Unpaid), per-employee balances for the current academic year, and 2 sample request rows.
- **CHECK strings still cannot contain `;`.** Spot-checked all CHECK predicates and `COMMENT ON COLUMN` strings in 012 — none contain `;`. The block-comment header was reviewed for the "splitter cuts on every `;`" trap that bit Step 1.

Plan reference: Step 2 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 3 — HR Schema — Certifications & Training

**Done.** `packages/database/prisma/tenant/migrations/013_hr_certifications_and_training.sql` lands 5 base tables. Idempotent CREATE-IF-NOT-EXISTS pattern. Snake_case columns, `TEXT + CHECK` for the certification type and verification status enums. ADR-015 followed for DBS handling — `reference_number` + `verification_status` are the only fields stored, never raw DBS payload.

### Tables (5)

| Table                       | Purpose                                                                                                              | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_staff_certifications`   | Per-employee certification records.                                                                                  | `id`, `employee_id` (FK CASCADE), `certification_type` CHECK (10 values), `certification_name`, `issuing_body`, `reference_number`, `issued_date`, `expiry_date`, `verification_status` CHECK (PENDING / VERIFIED / EXPIRED / REVOKED, default PENDING), `verified_by` (soft → `platform_users`), `verified_at`, `document_s3_key`, `notes`. CHECK `expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date`. INDEX(employee_id, certification_type); partial INDEX(expiry_date) WHERE active; partial INDEX(verification_status) WHERE PENDING for the verification queue. |
| `hr_training_requirements`  | Per-school training mandates. Optionally scoped to a position.                                                       | `id`, `school_id`, `position_id` (FK to `hr_positions`, NULL = applies to all staff), `training_name`, `description`, `certification_type` (CHECK against the same 10 values, NULL = manual compliance), `frequency` CHECK ONE_TIME / ANNUAL / BIENNIAL / TRIENNIAL / CUSTOM, `custom_frequency_months INT`, `is_active`. UNIQUE(school_id, training_name, position_id). Multi-column CHECK that `custom_frequency_months` is set if and only if `frequency='CUSTOM'`. Partial INDEX(school_id) WHERE active; partial INDEX(position_id) WHERE NOT NULL. |
| `hr_training_compliance`    | Materialised per-(employee, requirement) compliance state. Updated nightly by `TrainingComplianceWorker` (Step 7).    | `id`, `employee_id` (FK CASCADE), `requirement_id` (FK to `hr_training_requirements ON DELETE CASCADE`), `is_compliant BOOLEAN DEFAULT false`, `last_completed_date`, `next_due_date`, `linked_certification_id` (FK to `hr_staff_certifications ON DELETE SET NULL`), `days_until_due INT` (negative when overdue, NULL when unknown), `last_evaluated_at`. UNIQUE(employee_id, requirement_id). Partial INDEX(next_due_date) WHERE not compliant; INDEX(employee_id, is_compliant).                                                                     |
| `hr_cpd_requirements`       | Per-(school, position, academic year) CPD mandates.                                                                  | `id`, `school_id`, `position_id` (FK, NULL = all staff), `academic_year_id` (FK), `required_pd_hours NUMERIC(4,1)`, `required_credit_hours NUMERIC(4,1)`. UNIQUE(school_id, position_id, academic_year_id). CHECKs both hour columns >= 0. INDEX(academic_year_id).                                                                                                                                                                                                                                                                                       |
| `hr_work_authorisation`     | Per-employee right-to-work record. UNIQUE on employee_id (each employee has at most one active work-auth record).   | `id`, `employee_id` (FK CASCADE), `document_type` CHECK (US_PASSPORT / UK_PASSPORT / UK_BRP / PERMANENT_RESIDENT_CARD / EMPLOYMENT_AUTHORISATION / OTHER), `document_reference`, `issued_date`, `expiry_date`, `verified_by` (soft), `verified_at`, `reverification_due_date`, `document_s3_key`, `notes`. UNIQUE(employee_id). CHECK on the dates. Partial INDEX(reverification_due_date) WHERE NOT NULL; partial INDEX(expiry_date) WHERE NOT NULL.                                                                                                      |

### ADR-015 — DBS / regulated background-check handling

`hr_staff_certifications` is the schema-layer mechanism for DBS records. Per ADR-015, CampusOS stores **only the reference number and the verification status** — never the raw DBS report content. The `document_s3_key` column points at a scanned cert PDF that the school's compliance officer uploaded; it must never contain raw DBS data. Inline COMMENT ON COLUMN annotations make this rule discoverable from the live schema.

The 10 certification types include both DBS variants (`DBS_BASIC`, `DBS_ENHANCED`) so the schema can model UK schools' regulated background checks alongside US-style teaching licences and First Aid certs.

### Compliance resolution

When `hr_training_requirements.certification_type` is set, the Step 7 `TrainingComplianceWorker` resolves a requirement to the most recent VERIFIED, non-expired `hr_staff_certifications` row of that type for the employee. The `linked_certification_id` on the compliance row points at the specific cert that satisfied it. If that cert is later deleted, ON DELETE SET NULL on the FK clears the link without dropping the compliance row — leaving it in a defensible "no longer satisfied by any cert" state for the next worker pass to re-evaluate. Verified live with a `DELETE FROM hr_staff_certifications` smoke that nulled the link and preserved the compliance row.

When `certification_type` is NULL, the requirement is tracked manually — the worker doesn't auto-evaluate, and the compliance row is updated by the admin marking off completion in the UI (Step 9).

### FKs (intra-tenant) and soft references

| Constraint                                                                          | Type                  | Notes                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_staff_certifications.employee_id → hr_employees(id)`                             | DB-enforced (CASCADE) | Employee delete drops their certifications.                                                                                                                                        |
| `hr_training_requirements.position_id → hr_positions(id)`                            | DB-enforced (no cascade) | Deleting a position with active requirements should fail loudly — there's no graceful auto-handling.                                                                                |
| `hr_training_compliance.employee_id → hr_employees(id)`                              | DB-enforced (CASCADE) | Same rationale as certifications.                                                                                                                                                  |
| `hr_training_compliance.requirement_id → hr_training_requirements(id)`               | DB-enforced (CASCADE) | Removing a requirement should drop its compliance materialisations.                                                                                                                |
| `hr_training_compliance.linked_certification_id → hr_staff_certifications(id)`       | DB-enforced (SET NULL) | Deleting a cert leaves the compliance row in a defensible "not satisfied" state instead of dropping it. Verified live.                                                              |
| `hr_cpd_requirements.position_id → hr_positions(id)`                                 | DB-enforced (no cascade) | Same as `hr_training_requirements`.                                                                                                                                                |
| `hr_cpd_requirements.academic_year_id → sis_academic_years(id)`                      | DB-enforced (no cascade) | Tenant-tenant ref. Deleting a year while CPD targets exist should fail loudly.                                                                                                     |
| `hr_work_authorisation.employee_id → hr_employees(id)`                               | DB-enforced (CASCADE) | Plus UNIQUE(employee_id) so each employee has at most one active work-auth record.                                                                                                  |
| `hr_staff_certifications.verified_by`, `hr_work_authorisation.verified_by`           | Soft (cross-schema)   | UUID refs to `platform.platform_users(id)` per ADR-055 — audit-only.                                                                                                                |
| `hr_*.school_id`                                                                    | Soft (cross-schema)   | UUID refs to `platform.schools(id)` per ADR-001/020.                                                                                                                                |

### CHECK constraints

| Constraint                                              | Predicate                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hr_staff_certifications_type_chk`                      | `certification_type IN ('TEACHING_LICENCE','FIRST_AID','SAFEGUARDING_LEVEL1','SAFEGUARDING_LEVEL2','DBS_BASIC','DBS_ENHANCED','FOOD_HYGIENE','FIRE_SAFETY_WARDEN','SPECIALIST_SUBJECT','CUSTOM')`                                                       |
| `hr_staff_certifications_status_chk`                    | `verification_status IN ('PENDING','VERIFIED','EXPIRED','REVOKED')`                                                                                                                                                                                    |
| `hr_staff_certifications_dates_chk`                     | `expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date`                                                                                                                                                                              |
| `hr_training_requirements_frequency_chk`                | `frequency IN ('ONE_TIME','ANNUAL','BIENNIAL','TRIENNIAL','CUSTOM')`                                                                                                                                                                                   |
| `hr_training_requirements_custom_chk`                   | `(frequency <> 'CUSTOM' AND custom_frequency_months IS NULL) OR (frequency = 'CUSTOM' AND custom_frequency_months IS NOT NULL AND custom_frequency_months > 0)`                                                                                       |
| `hr_training_requirements_cert_type_chk`                | `certification_type IS NULL OR certification_type IN (…same 10 values as above…)`                                                                                                                                                                       |
| `hr_cpd_requirements_pd_hours_chk`                      | `required_pd_hours >= 0`                                                                                                                                                                                                                               |
| `hr_cpd_requirements_credit_hours_chk`                  | `required_credit_hours >= 0`                                                                                                                                                                                                                           |
| `hr_work_authorisation_type_chk`                        | `document_type IN ('US_PASSPORT','UK_PASSPORT','UK_BRP','PERMANENT_RESIDENT_CARD','EMPLOYMENT_AUTHORISATION','OTHER')`                                                                                                                                |
| `hr_work_authorisation_dates_chk`                       | `expiry_date IS NULL OR issued_date IS NULL OR expiry_date >= issued_date`                                                                                                                                                                              |

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 13 migrations applied
pnpm --filter @campusos/database provision --subdomain=test   # 13 migrations applied
```

Counts in `tenant_demo` after Step 3:

| What                                                             | Count |
| ---------------------------------------------------------------- | ----: |
| Logical base tables (top-level, was 66)                          |    71 |
| HR tables (`hr_*`)                                                |    14 |
| Intra-tenant FKs from Step 3 tables                              |     7 |
| Cross-schema FKs from `tenant_demo`                              |     0 |

CHECK + FK + UNIQUE + cascade smoke (live):

| Constraint / behaviour                                       | Test                                                                                                  | Outcome  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------- |
| `hr_staff_certifications_type_chk`                           | INSERT certification_type='BOGUS'                                                                      | ERROR ✅ |
| `hr_staff_certifications_status_chk`                         | INSERT verification_status='BOGUS'                                                                     | ERROR ✅ |
| `hr_staff_certifications_dates_chk`                          | INSERT issued_date=2026-05-01, expiry_date=2026-04-01                                                  | ERROR ✅ |
| `hr_training_requirements_frequency_chk`                     | INSERT frequency='BOGUS'                                                                               | ERROR ✅ |
| `hr_training_requirements_custom_chk`                        | INSERT frequency='CUSTOM' without custom_frequency_months                                              | ERROR ✅ |
| `hr_work_authorisation_type_chk`                             | INSERT document_type='BOGUS'                                                                           | ERROR ✅ |
| `hr_cpd_requirements_pd_hours_chk`                           | INSERT required_pd_hours=-1                                                                            | ERROR ✅ |
| Happy path: 1 cert + 2 requirements (ANNUAL + CUSTOM) + 1 compliance row, all linked to Rivera | inserts succeed, linked_certification_id populated                                                    | ✅       |
| `linked_certification_id ON DELETE SET NULL`                 | DELETE FROM hr_staff_certifications, then SELECT compliance row — linked_certification_id=NULL, row still exists | ✅ |
| `hr_training_compliance_employee_requirement_uq`             | INSERT a duplicate (employee_id, requirement_id)                                                       | ERROR ✅ |
| `hr_work_authorisation_employee_uq`                          | INSERT a second work_auth row for the same employee                                                    | ERROR ✅ |
| ON DELETE CASCADE on `hr_employees` (temp employee)          | DELETE FROM hr_employees drops cert + compliance + work_auth (1/1/1 → 0/0/0)                           | ✅       |

### Out-of-scope decisions for Step 3

- **No expiry alert job.** The plan calls for 90/30/7-day reminders on `hr_staff_certifications.expiry_date`. The producer worker lives in Step 7 (`CertificationService` emits `hr.certification.expiring` to the existing `NotificationQueueService`); this step is schema + indexes only. The partial `hr_staff_certifications_expiry_idx` is what makes the alert sweep cheap.
- **No automated cert-status rollover.** When `expiry_date` passes, the cert's `verification_status` does NOT auto-flip to `EXPIRED`. A scheduled job in Step 7 reads the partial index and updates rows whose expiry has passed; the schema doesn't need a trigger for this.
- **`custom_frequency_months` is months only — not days.** The plan says CUSTOM is for irregular renewal cadences (e.g. 60 months for a Texas teaching licence). Day-level granularity is over-engineered for compliance windows; if a school needs sub-month precision, model it as ONE_TIME with manual updates.
- **`hr_cpd_requirements` doesn't track actual hours completed.** That's a Step 7 / future M16 concern — likely a `hr_cpd_completions` table joining to `hr_training_compliance` rows or to a future event-attendance table. This step lands the *target* hours only.
- **`hr_training_compliance.linked_certification_id` ON DELETE SET NULL is intentional asymmetry.** The compliance row references both the requirement (CASCADE — drop materialisation if requirement is removed) and the linked cert (SET NULL — keep the row to flag the gap). The asymmetry mirrors the semantics: a vanished requirement makes the compliance row meaningless, but a vanished cert just changes whether the requirement is currently satisfied.
- **`document_reference` on `hr_work_authorisation` and `reference_number` on `hr_staff_certifications` are free-text.** Different document types use wildly different reference formats (passport vs BRP vs case number). Validating format in the schema would be fragile; app-layer validation per type is the right call.
- **No partitioning.** Volume is bounded by employees × cert types × renewal cycles. Multi-school scale (10⁶ employees) is well below the partitioning threshold even with decade-long history.
- **No seed yet.** Step 5 owns the cert + training-requirement + compliance seed (Rivera's Teaching Licence expiring in 60 days drives the compliance dashboard amber row in the CAT).
- **CHECK strings still cannot contain `;`.** Spot-checked all CHECK predicates and `COMMENT ON COLUMN` strings in 013 — none contain `;`. The block-comment header was reviewed for the "splitter cuts on every `;` even inside block comments" trap that bit Step 1.

Plan reference: Step 3 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 4 — HR Schema — Onboarding

**Done.** `packages/database/prisma/tenant/migrations/014_hr_onboarding.sql` lands 3 base tables. Idempotent CREATE-IF-NOT-EXISTS pattern. Snake_case columns, `TEXT + CHECK` for the status / category enums. Multi-column CHECKs keep the `started_at` / `completed_at` lifecycle columns in sync with `status`, eliminating the entire class of "row claims COMPLETED but completed_at is NULL" bugs at the schema layer.

### Tables (3)

| Table                       | Purpose                                                                                              | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_onboarding_templates`   | Per-school template catalogue. Optional `position_id` scope.                                          | `id`, `school_id`, `name`, `description`, `position_id` (FK to `hr_positions`, NULL = generic for any new hire), `is_active BOOLEAN`. UNIQUE(school_id, name). Partial INDEX(school_id) WHERE active; partial INDEX(position_id) WHERE NOT NULL.                                                                                                                                                                                                                                                                                                                                                                          |
| `hr_onboarding_checklists`  | Instantiated checklist per new hire. One per (employee, template).                                   | `id`, `employee_id` (FK CASCADE), `template_id` (FK to `hr_onboarding_templates`), `status TEXT DEFAULT 'NOT_STARTED'`, `started_at TIMESTAMPTZ`, `completed_at TIMESTAMPTZ`, `assigned_by` (soft → `platform_users`), `assigned_at`, `notes`. UNIQUE(employee_id, template_id). CHECK `status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')`. Multi-column CHECK that the lifecycle is `NOT_STARTED ⇒ both timestamps NULL`, `IN_PROGRESS ⇒ started_at set, completed_at NULL`, `COMPLETED ⇒ both set`. INDEX(employee_id, status); INDEX(template_id).                                                                       |
| `hr_onboarding_tasks`       | Individual task rows on a checklist.                                                                  | `id`, `checklist_id` (FK CASCADE), `title`, `description`, `category TEXT DEFAULT 'OTHER'`, `is_required BOOLEAN`, `due_days_from_start INT`, `sort_order INT`, `status TEXT DEFAULT 'PENDING'`, `completed_at TIMESTAMPTZ`, `completed_by` (soft → `platform_users`), `notes`. CHECK `category IN ('DOCUMENT','TRAINING','SYSTEM_ACCESS','ORIENTATION','OTHER')`. CHECK `status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')`. CHECK `due_days_from_start IS NULL OR due_days_from_start >= 0`. Multi-column CHECK that `completed_at` is set if and only if status is COMPLETED or SKIPPED. INDEX(checklist_id, sort_order); INDEX(checklist_id, status). |

### Lifecycle CHECKs at the schema layer

The plan calls for an Onboarding Service in Step 7 that owns the state machine. The schema layer adds two multi-column CHECKs that pin the lifecycle:

```sql
-- hr_onboarding_checklists_started_chk
(status='NOT_STARTED' AND started_at IS NULL  AND completed_at IS NULL)
OR
(status='IN_PROGRESS' AND started_at IS NOT NULL AND completed_at IS NULL)
OR
(status='COMPLETED'   AND started_at IS NOT NULL AND completed_at IS NOT NULL)

-- hr_onboarding_tasks_completed_chk
(status IN ('COMPLETED','SKIPPED') AND completed_at IS NOT NULL)
OR
(status NOT IN ('COMPLETED','SKIPPED') AND completed_at IS NULL)
```

Either CHECK fails the row outright if a service-layer bug tries to set status without the matching timestamp. Verified live with 4 deliberately bogus inserts that all rejected.

### FKs (intra-tenant) and soft references

| Constraint                                                  | Type                  | Notes                                                                                                                                                                              |
| ----------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_onboarding_templates.position_id → hr_positions(id)`    | DB-enforced (no cascade) | Deleting a position with active templates should fail loudly so a school admin notices the dangling configuration.                                                                  |
| `hr_onboarding_checklists.employee_id → hr_employees(id)`   | DB-enforced (CASCADE) | Employee delete drops their checklists.                                                                                                                                            |
| `hr_onboarding_checklists.template_id → hr_onboarding_templates(id)` | DB-enforced (no cascade) | Same rationale as templates → positions.                                                                                                                                          |
| `hr_onboarding_tasks.checklist_id → hr_onboarding_checklists(id)` | DB-enforced (CASCADE) | Deleting a checklist drops its tasks. Verified live (3 tasks → 0 after parent delete).                                                                                              |
| `hr_onboarding_checklists.assigned_by`, `hr_onboarding_tasks.completed_by` | Soft (cross-schema)   | UUID refs to `platform.platform_users(id)` per ADR-055 — audit-only.                                                                                                                |
| `hr_onboarding_templates.school_id`                         | Soft (cross-schema)   | UUID ref to `platform.schools(id)` per ADR-001/020.                                                                                                                                 |

### CHECK constraints

| Constraint                                              | Predicate                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `hr_onboarding_checklists_status_chk`                   | `status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')`                                                                              |
| `hr_onboarding_checklists_started_chk`                  | (lifecycle CHECK — see above)                                                                                                       |
| `hr_onboarding_tasks_category_chk`                      | `category IN ('DOCUMENT','TRAINING','SYSTEM_ACCESS','ORIENTATION','OTHER')`                                                         |
| `hr_onboarding_tasks_status_chk`                        | `status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')`                                                                         |
| `hr_onboarding_tasks_due_days_chk`                      | `due_days_from_start IS NULL OR due_days_from_start >= 0`                                                                          |
| `hr_onboarding_tasks_completed_chk`                     | (lifecycle CHECK — see above)                                                                                                       |

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 14 migrations applied
pnpm --filter @campusos/database provision --subdomain=test   # 14 migrations applied
```

Counts in `tenant_demo` after Step 4:

| What                                                             | Count |
| ---------------------------------------------------------------- | ----: |
| Logical base tables (top-level, was 71)                          |    74 |
| HR tables (`hr_*`)                                                |    17 |
| Intra-tenant FKs from Step 4 tables                              |     3 |
| Cross-schema FKs from `tenant_demo`                              |     0 |

CHECK + FK + UNIQUE + cascade smoke (live):

| Constraint / behaviour                                       | Test                                                                                                  | Outcome  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------- |
| `hr_onboarding_checklists_status_chk` and `started_chk`      | INSERT status='BOGUS'                                                                                  | ERROR ✅ |
| `hr_onboarding_checklists_started_chk` (NOT_STARTED + started_at)  | INSERT status='NOT_STARTED' with started_at=now()                                                      | ERROR ✅ |
| `hr_onboarding_checklists_started_chk` (COMPLETED + no completed_at) | INSERT status='COMPLETED' with started_at=now() but completed_at=NULL                                 | ERROR ✅ |
| `hr_onboarding_tasks_category_chk`                           | INSERT category='BOGUS'                                                                                | ERROR ✅ |
| `hr_onboarding_tasks_status_chk`                             | INSERT status='BOGUS'                                                                                  | ERROR ✅ |
| `hr_onboarding_tasks_due_days_chk`                           | INSERT due_days_from_start=-1                                                                          | ERROR ✅ |
| `hr_onboarding_tasks_completed_chk` (PENDING + completed_at)  | INSERT status='PENDING' with completed_at=now()                                                        | ERROR ✅ |
| `hr_onboarding_tasks_completed_chk` (COMPLETED + no completed_at) | INSERT status='COMPLETED' with completed_at=NULL                                                       | ERROR ✅ |
| Happy path: 1 template + 1 checklist + 3 tasks linked to Rivera | inserts succeed, 1 task moves to COMPLETED with completed_at, checklist moves to IN_PROGRESS with started_at | ✅       |
| `hr_onboarding_checklists_employee_template_uq`              | INSERT a duplicate (employee_id, template_id)                                                          | ERROR ✅ |
| ON DELETE CASCADE on `hr_onboarding_checklists`              | DELETE FROM hr_onboarding_checklists drops 3 child tasks (3 → 0)                                       | ✅       |

### Out-of-scope decisions for Step 4

- **No assignee per task.** The plan models tasks as "assigned to the new hire" implicitly. If future schools need per-task delegation (e.g. IT handles SYSTEM_ACCESS while HR handles DOCUMENT), an `assignee_account_id` column lands later as additive — no current data needs to migrate.
- **`completed_by` is a soft cross-schema ref, not always the employee themselves.** It captures whoever marked the task done, which may be the new hire (self-service) or an admin. The audit doesn't need to be tighter than that for this cycle.
- **No checklist-level progress percentage.** Compute on read: `COUNT(status='COMPLETED') / COUNT(*)`. Storing it would be one more thing to keep in sync — and the index on `(checklist_id, status)` makes the read aggregation cheap.
- **`due_days_from_start` is a non-negative INT.** Tasks due *before* the checklist start would be admin-initiated pre-boarding work and don't really belong on a "new hire onboarding" checklist; a CHECK > 0 would be too strict (day-zero kickoff tasks are valid), so `>= 0` is the right floor.
- **No template versioning.** Editing a template doesn't propagate to existing checklists. Versioning land-patterns can ship later without touching this schema (add a `version INT` and a CHECK).
- **No partitioning.** Volume bounded by employees × templates. Far below partitioning threshold.
- **No seed yet.** Step 5 owns the "New Teacher Onboarding" template + 8 sample tasks per the plan.
- **CHECK strings still cannot contain `;`.** Spot-checked all CHECK predicates and `COMMENT ON COLUMN` strings in 014 — none contain `;`. The block-comment header was reviewed for the splitter trap.

Plan reference: Step 4 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 5 — Seed Data — Employees, Leave, Certifications

**Done.** `packages/database/src/seed-hr.ts` (existing Step 0 file) extended with seven independent layers, each gated on its own row count so re-running the seed is a no-op once a layer has been populated. `seed-iam.ts` updated to grant the Cycle 4 HR codes to Teacher/Staff and to assign roles to the two new staff (`vp@`, `counsellor@`). After `build-cache.ts`: 7 account-scope pairs cached — up from 5 — with HR codes effective.

### Seeded data in `tenant_demo`

| Layer                       | Rows | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hr_employees`              |    4 | Carry-over from Step 0 (Mitchell, Rivera, Park, Hayes; admin@ Platform Admin not bridged).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hr_positions`              |    5 | Teacher, Principal, Vice Principal, Counsellor, Administrative Assistant. The first four are tagged with `is_teaching_role` accurately (Teacher=true, others=false).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hr_employee_positions`     |    4 | One per employee, mapping each to their primary position (Mitchell→Principal, Rivera→Teacher, Park→VP, Hayes→Counsellor; the Administrative Assistant role exists in the catalogue but has no holder yet). `effective_from = employee.hire_date`, `is_primary=true`, `fte=1.000`. The 5th catalogue entry tests the "position exists but is unassigned" path that the staff directory will need to handle.                                                                                                                                                                                                                                                                                                                                  |
| `hr_leave_types`            |    5 | Sick Leave (paid, accrual 10 days, max 30), Personal Leave (paid, 3, max 9), Bereavement Leave (paid, 5, max 5), Professional Development (paid, 5, max 10), Unpaid Leave (unpaid, accrual 0, max NULL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hr_leave_balances`         |   20 | 4 employees × 5 leave types. Rivera shows non-zero used/pending so the running totals are visible in the CAT: Sick Leave `accrued=10 used=2 pending=0`, Personal Leave `accrued=3 used=1 pending=1`. Other employees have `used=0 pending=0` and the type's accrual rate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hr_leave_requests`         |    2 | (1) Rivera Sick Leave 2026-03-09 → 2026-03-10 (2 days), `APPROVED` by Mitchell on 2026-03-08, reason "Flu". (2) Rivera Professional Development 2026-05-15 (1 day), `PENDING`, reason "NCTM regional conference". Together they exercise both the APPROVED-with-reviewed-by path and the PENDING-with-no-review path the CAT will hit.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hr_staff_certifications`   |    4 | (1) Rivera **Texas Standard Teaching Licence** — issued 2021-08-01, **`expiry_date = today + 60 days`** computed at seed time. VERIFIED. This is the certification that drives the CAT compliance dashboard amber row — the dynamic expiry means re-running the seed any day still produces a "expires in 60 days" state. (2) Rivera First Aid (Red Cross) — VERIFIED, expires 2027. (3) Rivera Safeguarding Level 1 — VERIFIED, expires 2027. (4) Mitchell DBS Enhanced — VERIFIED, expires 2027 (per ADR-015 we store only the reference number, not raw DBS payload). |
| `hr_training_requirements`  |    4 | 3 school-wide (`position_id=NULL`): Annual Safeguarding Refresh (ANNUAL, links to SAFEGUARDING_LEVEL1), First Aid Recertification (BIENNIAL, links to FIRST_AID), Annual Fire Safety Briefing (ANNUAL, no linked cert type — manually-tracked). 1 position-specific: Teaching Licence Renewal (ANNUAL, scoped to the Teacher position, links to TEACHING_LICENCE).                                                                                                                                                                                                                                                                                                                                                                          |
| `hr_training_compliance`    |    4 | Rivera: compliant on Safeguarding (linked to her L1 cert) and First Aid (linked to her FA cert), **non-compliant on Teaching Licence Renewal** (linked to the cert that expires in 60 days, `days_until_due=60`). Mitchell: non-compliant on Safeguarding (no linked cert — surfaces as a red admin row).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hr_document_types`         |    4 | Employment Contract (required, retention 7 years), Background Check (required, retention 7 years), Tax Form W-4 (required, retention 5 years), Teaching Licence Copy (optional, retention 5 years).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hr_employee_documents`     |    0 | None seeded — Step 8 UI will let admins upload sample docs against the seeded document types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `hr_emergency_contacts`     |    0 | None seeded — Step 8 UI flow will exercise the "add emergency contact" form against an employee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `hr_cpd_requirements`       |    0 | Out of scope — the plan describes CPD targets but reserves them for a later sub-cycle (Step 7's compliance worker doesn't need a CPD row to pass the CAT).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hr_work_authorisation`     |    0 | Out of scope this seed — the schema is in place, but exercising the right-to-work flow is reserved for a later UI iteration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hr_onboarding_templates`   |    1 | "New Teacher Onboarding" — scoped to the Teacher position, description "Standard onboarding workflow for new teaching hires."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `hr_onboarding_checklists`  |    1 | One assigned to Rivera against the template, status=`NOT_STARTED` (so the multi-column lifecycle CHECK requires both timestamps NULL — verified by happy-path insert).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hr_onboarding_tasks`       |    8 | Submit signed contract (DOCUMENT, due_days=0); Complete I-9 / right-to-work (DOCUMENT, 3); Submit W-4 (DOCUMENT, 3); Background check authorisation (DOCUMENT, 1); Safeguarding L1 training (TRAINING, 14); First Aid certification (TRAINING, 30); Issue laptop and SIS account (SYSTEM_ACCESS, 1); Classroom orientation walkthrough (ORIENTATION, 7). All `is_required=true`, all `status=PENDING`.                                                                                                                                                                                                                                                                                                                                       |

### IAM permission map deltas (`seed-iam.ts`)

| Role          | Before Step 5 | After Step 5 | Delta                                                                                                              |
| ------------- | ------------: | -----------: | ------------------------------------------------------------------------------------------------------------------ |
| Platform Admin |          444 |          444 | unchanged — `everyFunction` already covers all HR codes.                                                           |
| School Admin  |           444 |          444 | unchanged — same.                                                                                                  |
| Teacher       |           27 |           31 | +HR-001:read, +HR-003:read, +HR-003:write, +HR-004:read.                                                            |
| Parent        |           11 |           11 | unchanged — parents have no HR access (per the plan).                                                                |
| Student       |           15 |           15 | unchanged — students have no HR access.                                                                              |
| Staff         |            6 |           10 | +HR-001:read, +HR-003:read, +HR-003:write, +HR-004:read (so VP / Counsellor / Administrative Assistant get the same self-service access as Teacher). |

### Role assignment changes

The `seed-iam.ts` role-assignment block was rewritten from "if any iam_role_assignment row exists, skip the entire block" to "per-user lookup-or-create" so the two new staff users gain Staff-role assignments without dropping existing rows. `vp@demo.campusos.dev` and `counsellor@demo.campusos.dev` now hold the Staff role at the school scope; admin/principal/teacher/student/parent assignments remain unchanged.

### IAM cache rebuild

```bash
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

After Step 5 rebuilt:

| Account                            | Effective permissions cached |
| ---------------------------------- | ---------------------------: |
| admin@demo.campusos.dev            |                          444 |
| principal@demo.campusos.dev        |                          444 |
| teacher@demo.campusos.dev          |                           31 |
| student@demo.campusos.dev          |                           15 |
| parent@demo.campusos.dev           |                           11 |
| vp@demo.campusos.dev               |                           10 |
| counsellor@demo.campusos.dev       |                           10 |

7 account-scope pairs cached (was 5). The 2 new pairs cover vp@ and counsellor@; the existing 5 pairs gain their HR codes through the Teacher / Staff role updates.

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # Teacher 4 newly added, Staff 4 newly added, vp@ and counsellor@ -> Staff
pnpm --filter @campusos/database seed:hr                     # all 7 layers populated; second run reports "already seeded — skipping" for each layer
pnpm --filter @campusos/database exec tsx src/build-cache.ts # 7 account-scope pairs cached
```

Live row counts in `tenant_demo`:

```
employees | positions | empos | leave_types | bals | leave_reqs | certs | treqs | compl | dtypes | tmpls | chks | tasks
4         | 5         | 4     | 5           | 20   | 2          | 4     | 4     | 4     | 4      | 1     | 1    | 8
```

Idempotency confirmed: re-running `seed:hr` after the first successful run produces 0 inserts across every Step 5 layer (each gates on a row count). Re-running `seed-iam.ts` reports "Role assignments already seeded".

### Out-of-scope decisions for Step 5

- **The 5th position (Administrative Assistant) has no holder.** It tests the "position exists, no employee assigned" path that the staff directory in Step 8 will need to handle gracefully. It also gives the admin UI a target for the "assign employee to position" flow.
- **`hr_emergency_contacts` and `hr_employee_documents` are not seeded.** Both are exercised through the Step 8 UI flow rather than pre-populated, since the data is per-employee personal info that schools should drive themselves. The schemas are in place; the seed just doesn't pre-fill them.
- **`hr_cpd_requirements` and `hr_work_authorisation` are not seeded.** Both schemas exist; both are reserved for a future iteration (the CAT scenarios in Step 10 don't depend on them).
- **The Teaching Licence expiry is dynamically computed at seed time as `today + 60 days`.** This is deliberate — a static date would drift. Re-running the seed any day still produces a stable "60 days until expiry" state for the CAT amber row. The pre-computed compliance row mirrors this with `days_until_due=60`.
- **The PENDING leave request stays PENDING; the seed doesn't approve it.** That's the row the CAT's "admin reviews leave queue" scenario will approve, exercising the state-transition path in Step 7's `LeaveService`.
- **Mitchell's "Annual Safeguarding Refresh" compliance is intentionally not satisfied.** She has a DBS Enhanced cert, not a SAFEGUARDING_LEVEL1 cert, so the linked-cert resolution returns NULL — making her admin-side row a flagged red "non-compliant on Safeguarding" entry that exercises the dashboard's color-coding for non-teaching staff.
- **No CAT script touched yet.** Step 10's `docs/cycle4-cat-script.md` will be authored after the NestJS modules (Steps 6–7) and UI (Steps 8–9) ship; the seeded state is the substrate that the CAT will exercise end-to-end.

Plan reference: Step 5 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 6 — HR NestJS Module — Employee Records & Directory

**Done.** `apps/api/src/hr/` lands the first HR API surface — three services, two controllers, three DTO files, 12 endpoints. The `actor.employeeId` field was already populated by `ActorContextService.resolveActor` in Cycle 4 Step 0; this step is purely additive on top.

### Files

```
apps/api/src/hr/
├── hr.module.ts                 — wires services + controllers; imports TenantModule + IamModule
├── employee.service.ts          — list / getById / getMe / create / update + position join
├── position.service.ts          — list / getById / create / update with active-assignment count
├── employee-document.service.ts — list / create / archive with own-or-admin row-scope guard
├── employee.controller.ts       — 8 endpoints under /employees (incl. /employees/:id/documents)
├── position.controller.ts       — 4 endpoints under /positions
└── dto/
    ├── employee.dto.ts          — EmployeeResponseDto, CreateEmployeeDto, UpdateEmployeeDto, ListEmployeesQueryDto
    ├── position.dto.ts          — PositionResponseDto, CreatePositionDto, UpdatePositionDto
    └── employee-document.dto.ts — EmployeeDocumentResponseDto, CreateEmployeeDocumentDto
```

### Endpoints

| Method | Path                                       | Permission     | Notes                                                                                                                                                          |
| ------ | ------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/employees`                               | `hr-001:read`  | Staff directory. Filters: `employmentStatus`, `includeInactive` (admin-only flip), `search` (LIKE across first/last name + email + employee_number).            |
| GET    | `/employees/me`                            | `hr-001:read`  | Resolves the calling user's employee record via `actor.employeeId`. 404 for parents/students/Platform Admin (no `hr_employees` row).                          |
| GET    | `/employees/:id`                           | `hr-001:read`  | Single profile with the joined position list.                                                                                                                  |
| POST   | `/employees`                               | `hr-001:write` | Admin-only (service-layer ForbiddenException for non-admins). Validates `personId` + `accountId` against the platform schema. Optional `initialPositionId`.    |
| PATCH  | `/employees/:id`                           | `hr-001:write` | Admin-only. Dynamic SET-clause builder for employee_number / employment_type / employment_status / termination_date.                                            |
| GET    | `/employees/:id/documents`                 | `hr-001:read`  | Row-scope: own employee OR admin. Returns non-archived rows joined to `hr_document_types` for the type label.                                                   |
| POST   | `/employees/:id/documents`                 | `hr-001:write` | Same row-scope. Validates the document type is active + the employee exists. `uploaded_by = actor.accountId`.                                                  |
| DELETE | `/employees/:id/documents/:docId`          | `hr-001:write` | Soft-archive (`is_archived=true`). Hard delete is intentionally not exposed.                                                                                   |
| GET    | `/positions`                               | `hr-001:read`  | Returns each position with `activeAssignments` count + joined `sis_departments.name`. `?includeInactive=true` shows soft-deactivated.                          |
| GET    | `/positions/:id`                           | `hr-001:read`  | Single position read.                                                                                                                                          |
| POST   | `/positions`                               | `hr-001:admin` | Admin-only — `hr-001:admin` is the gate (intentionally narrower than `:write` because positions are tenant-wide config).                                       |
| PATCH  | `/positions/:id`                           | `hr-001:admin` | Same gate. Updates title / department_id / is_teaching_role / is_active.                                                                                       |

### Authorisation contract

| Persona              | Directory list / read | Own profile     | Other profile          | Documents (own)  | Documents (other) | Position writes |
| -------------------- | --------------------- | --------------- | ---------------------- | ---------------- | ----------------- | --------------- |
| Platform Admin       | yes                   | 404 (no record) | yes                    | n/a              | yes               | yes             |
| School Admin         | yes                   | yes             | yes                    | yes              | yes               | yes             |
| Teacher              | yes                   | yes             | yes (info only)        | yes              | 403               | 403             |
| Staff (VP / Counsellor / Admin Asst) | yes                   | yes             | yes (info only)        | yes              | 403               | 403             |
| Parent               | 403                   | 403             | 403                    | 403              | 403               | 403             |
| Student              | 403                   | 403             | 403                    | 403              | 403               | 403             |

Notes on the matrix:
- Parents/students hold no HR codes (per `seed-iam.ts`) so every endpoint hits the global `PermissionGuard` → 403.
- Teachers and Staff share the directory (`hr-001:read` covers list + read) and `/employees/me`. They can read other profiles but the *documents* row-scope inside `EmployeeDocumentService.assertCanAccess` cuts cross-employee document access cleanly.
- The Platform Admin persona is `isSchoolAdmin=true` via the `sch-001:admin` code on the platform scope, so it bypasses the document row-scope. `actor.employeeId` is null for this persona, so `/employees/me` returns 404 — `admin@` is not an employee.

### Row-scope pattern

```ts
// EmployeeDocumentService.assertCanAccess
if (actor.isSchoolAdmin) return;
if (actor.employeeId === employeeId) return;
throw new ForbiddenException(
  'Only the owning employee or a school admin can access this employee document set',
);
```

This is the same shape as the Cycle 1 `student.service.ts::visibilityClause` and Cycle 2 `gradebook.service.ts::isClassManager`, just specialised to the (employee, document) pair.

### DTOs and validation

`EmploymentType` and `EmploymentStatus` arrays in `dto/employee.dto.ts` are exported with `as const` and used as both the `IsIn(...)` validator argument and the discriminator in `EmployeeResponseDto.employmentType`/`employmentStatus`. The values mirror the SQL CHECK constraints in `011_hr_employees_and_positions.sql` exactly — keeping the schema and the API surface in lockstep.

`ListPositionsQueryDto` uses `class-transformer`'s `@Transform` to coerce the `?includeInactive=true` query string into a boolean before `IsBoolean` runs, so the URL parses cleanly without extra controller-layer munging.

### Module wiring

```ts
@Module({
  imports: [TenantModule, IamModule],
  providers: [EmployeeService, PositionService, EmployeeDocumentService],
  controllers: [EmployeeController, PositionController],
  exports: [EmployeeService, PositionService, EmployeeDocumentService],
})
export class HrModule {}
```

`HrModule` lives between `ClassroomModule` and `NotificationsModule` in `AppModule.imports`. Step 7 will extend the same module with `LeaveService` / `CertificationService` / `TrainingComplianceService` / `LeaveNotificationConsumer` — sharing the same TenantModule + IamModule wiring and the `actor.employeeId` resolution.

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/api build           # nest build → exits 0
pnpm --filter @campusos/api start:prod      # 12 HR routes mapped on boot, AppModule init clean
```

Live smoke against `tenant_demo`:

| #   | Scenario                                                                  | Expected                                                                              | Got |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --- |
| 1   | `principal@` `GET /employees`                                              | 4 employees ordered by last name, each with employee_number + primaryPositionTitle    | ✅  |
| 2   | `teacher@` `GET /employees/me`                                             | Resolves Rivera. positions=1, primaryPositionTitle='Teacher'                          | ✅  |
| 3   | `principal@` `GET /positions`                                              | 5 positions ordered by title; Administrative Assistant has activeAssignments=0        | ✅  |
| 4   | `parent@` `GET /employees`                                                 | 403 INSUFFICIENT_PERMISSIONS at the gate (`hr-001:read` required)                     | ✅  |
| 5   | `student@` `GET /positions`                                                | 403 same                                                                              | ✅  |
| 6   | `parent@` `GET /employees/me`                                              | 403 (parents have no HR codes — gate hits before the 404 branch)                      | ✅  |
| 7   | `teacher@` `GET /employees/:rivera/documents`                              | `[]` (own profile, no docs seeded)                                                    | ✅  |
| 8   | `principal@` `GET /employees/:rivera/documents`                            | `[]` (admin can read any employee's docs)                                              | ✅  |
| 9   | `counsellor@` `GET /employees/:rivera/documents`                           | 403 from row-scope guard with the explicit "owning employee or school admin" message  | ✅  |
| 10  | `teacher@` `POST /positions`                                               | 403 (`hr-001:admin` required)                                                          | ✅  |
| 11  | `principal@` `POST /positions` then `PATCH /positions/:id` (deactivate)    | 200 round-trip; new row created with title='Smoke Position', then patched isActive=false | ✅  |
| 12  | `principal@` `POST /employees` with bogus body                              | 400 from `IsUUID` validators (proves the admin POST path is reachable)                 | ✅  |

### Out-of-scope decisions for Step 6

- **No `/employees/:id` row-scope yet.** The plan says "employees can view the staff directory and their own full profile" — but since admins also need to read everyone's profile, and teachers/staff legitimately need to see colleague info, the `GET /employees/:id` endpoint is open to anyone with `hr-001:read`. Sensitive fields (documents, leave details) are guarded individually by their own endpoints. If a future cycle wants to redact certain fields based on persona, that's a layer on `rowToDto`.
- **`POST /employees` does not create the underlying iam_person.** Plan-aligned: "Admin creates an employee record." The expectation is that the iam_person + platform_users records already exist (from Keycloak provisioning or a prior platform seed). The POST validates both exist and that they're linked to each other before inserting. New-hire signup flows that bootstrap the identity surface land in a later cycle.
- **`POST /employees/:id/documents` does not handle the file upload.** The plan describes signed-URL S3 uploads with `s3Key` returned to the client; the API endpoint accepts a pre-uploaded `s3Key`. Provisioning the actual upload pipeline (presign endpoint, bucket policy) is out of scope for Cycle 4.
- **No `expiry_date` enforcement on documents.** The schema's partial expiry index is in place for the future certification-expiry sweep, but the API does not auto-archive expired documents this cycle.
- **No `PATCH /employee-positions/:id` endpoint.** Position reassignments (promote, change FTE, end-date a current assignment) need an end-to-end "history-preserving" pattern that pairs a close on the current row with an insert of the new one. That's a Step 7+ concern alongside leave events.
- **No bulk-create endpoint.** The plan calls for individual employee creation. Bulk import is a future cycle (alongside the platform_users provisioning flow).
- **`actor.isSchoolAdmin` is the only "who can write?" gate.** Service-layer methods that check the gate (`EmployeeService.create`, `EmployeeService.update`, `PositionService.create`, `PositionService.update`, `EmployeeDocumentService.assertCanAccess`) all rely on `actor.isSchoolAdmin`. The `@RequirePermission('hr-001:write'/'hr-001:admin')` decorator is the necessary gate; the `isSchoolAdmin` check inside the service is the sufficient one — both layers agree on the answer for the seeded personas because Platform Admin and School Admin both hold the relevant codes.
- **No DTO serialisation tests.** Cycle 4's CAT (Step 10) will exercise the response shapes end-to-end through the UI; a unit-test pass is reserved for Phase 2 hardening.

Plan reference: Step 6 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 7 — HR NestJS Module — Leave & Certifications

**Done.** Lands the leave / cert / compliance request-path services + the first HR Kafka consumer. Build clean, all 11 new routes mapped, 22-scenario live smoke against `tenant_demo` passes end-to-end. The Step 6 `HrModule` is extended in place — Step 7 adds three new services, two new controllers, three new DTO files, and one Kafka consumer.

### Files added

```
apps/api/src/hr/
├── leave.service.ts                — submit / list / get / approve / reject / cancel (4 Kafka emits)
├── certification.service.ts         — list / get / create / verify / listExpiringSoon (1 Kafka emit)
├── training-compliance.service.ts   — getForEmployee / getDashboard
├── leave-notification.consumer.ts   — group leave-notification-consumer
├── leave.controller.ts              — 7 endpoints (/leave-types, /leave/me/balances, /leave-requests*)
├── certifications.controller.ts     — 3 endpoints (/certifications/{:id, :id/verify, expiring-soon})
├── compliance.controller.ts         — 1 endpoint (/compliance/dashboard, admin)
└── dto/
    ├── leave.dto.ts                 — LeaveType / LeaveBalance / LeaveRequest DTOs + Submit/Review queries
    ├── certification.dto.ts         — Cert response + create + verify DTOs (10 cert types + 4 statuses)
    └── compliance.dto.ts            — ComplianceRow + EmployeeCompliance + ComplianceDashboard
```

The existing `EmployeeController` was extended with three more endpoints — `GET /employees/:id/certifications`, `POST /employees/:id/certifications`, `GET /employees/:id/compliance` — so the per-employee surface stays under one controller. The verify endpoint lives on the standalone `CertificationsController` because it operates by cert id, not employee id.

### Endpoints (11 new — total HR endpoint count: 23)

| Method | Path                                       | Permission       | Notes                                                                                           |
| ------ | ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/leave-types`                              | `hr-003:read`    | Active leave types in the tenant.                                                                |
| GET    | `/leave/me/balances`                        | `hr-003:read`    | Per-leave-type balance for the calling employee. Returns zeros for types with no balance row.    |
| GET    | `/leave-requests`                           | `hr-003:read`    | Own history for non-admins; admin queue with `?status=` and `?employeeId=` filters.              |
| GET    | `/leave-requests/:id`                       | `hr-003:read`    | Own or admin only — non-admins get a 404 for someone else's request.                              |
| POST   | `/leave-requests`                           | `hr-003:write`   | Submit. Bumps `pending` and emits `hr.leave.requested`. Half-day support via `daysRequested>=0.5`. |
| PATCH  | `/leave-requests/:id/approve`               | `hr-003:write`   | Admin-only. Decrements `pending`, increments `used`. Emits `hr.leave.approved`.                  |
| PATCH  | `/leave-requests/:id/reject`                | `hr-003:write`   | Admin-only. Decrements `pending`. Emits `hr.leave.rejected`.                                     |
| PATCH  | `/leave-requests/:id/cancel`                | `hr-003:write`   | Owner or admin. Decrements `pending` (PENDING) or `used` (APPROVED). Emits `hr.leave.cancelled`. |
| GET    | `/employees/:id/certifications`             | `hr-004:read`    | Own or admin. Returns `daysUntilExpiry` per row computed from today.                             |
| POST   | `/employees/:id/certifications`             | `hr-004:write`   | Admin-only at the gate — `hr-004:write` is admin-only per Step 5's seeded role-perm matrix.      |
| GET    | `/employees/:id/compliance`                 | `hr-004:read`    | Own or admin per-employee breakdown with derived `urgency` per row.                              |
| GET    | `/certifications/expiring-soon`             | `hr-004:read`    | Active certs expiring within 90 days (or already overdue) — admin sweep from the partial index.  |
| GET    | `/certifications/:id`                       | `hr-004:read`    | Single cert read; row-scoped to own-or-admin.                                                    |
| PATCH  | `/certifications/:id/verify`                | `hr-004:write`   | Admin-only. Sets `verification_status` to VERIFIED / REVOKED / EXPIRED. Emits `hr.certification.verified`. |
| GET    | `/compliance/dashboard`                     | `hr-004:read`    | Admin-only at the service layer. Returns every ACTIVE employee even if they have zero compliance rows. |

### Kafka emits (5 new topics — sourceModule:'hr')

| Topic                          | Producer site                          | When                                                                                  |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `hr.leave.requested`           | `LeaveService.submit`                  | Employee submits a request.                                                           |
| `hr.leave.approved`            | `LeaveService.approve`                 | Admin approves. Triggers the `hr.leave.coverage_needed` republish in the consumer.    |
| `hr.leave.rejected`            | `LeaveService.reject`                  | Admin rejects.                                                                        |
| `hr.leave.cancelled`           | `LeaveService.cancel`                  | Owner or admin cancels. Owner-cancel is the no-notification branch in the consumer.   |
| `hr.certification.verified`    | `CertificationService.verify`          | Admin sets verification_status (VERIFIED / REVOKED / EXPIRED).                        |
| `hr.leave.coverage_needed`     | `LeaveNotificationConsumer` (republish) | When `hr.leave.approved` is consumed and the leaving employee has any class assignments. Cycle 5 Scheduling consumes this. |

### LeaveNotificationConsumer

`leave-notification.consumer.ts` reuses the Cycle 3 `unwrapEnvelope` + `processWithIdempotency` pattern. Subscribes to all 4 leave topics under group `leave-notification-consumer`. Handler dispatches by topic verb:

- `requested` → `notifyAdmins` resolves every account with `sch-001:admin` via `iam_effective_access_cache` joined to `iam_scope`/`iam_scope_type` (school + platform scope chain), enqueues `leave.requested` IN_APP per admin.
- `approved` → `notifySubmitter` enqueues `leave.approved` for the original submitter (via `payload.accountId`); then `emitCoverageNeeded` queries `sis_class_teachers` for every class the leaving employee is assigned to and republishes `hr.leave.coverage_needed` with `{requestId, employeeId, startDate, endDate, affectedClasses[]}` (each entry has classId / sectionCode / courseName for the Cycle 5 consumer).
- `rejected` → `notifySubmitter` enqueues `leave.rejected`.
- `cancelled` → no-op (the owner cancelled their own request — no notification needed); claim-after-success still fires so a redelivery is a no-op.

The consumer relies on `NotificationQueueService.enqueue()`'s default-IN_APP-when-no-preferences-row behaviour, so the new `leave.requested` / `leave.approved` / `leave.rejected` notification types deliver without any seed updates to `msg_notification_preferences`.

### Authorisation contract

| Persona              | List / read leave types | Submit own leave | Approve / reject leave | Cancel own | Cancel any | Read own certs | Verify cert | Read compliance dashboard |
| -------------------- | ----------------------- | ---------------- | ---------------------- | ---------- | ---------- | -------------- | ----------- | ------------------------- |
| Platform Admin       | yes                     | n/a (no employee row) | yes              | n/a        | yes        | yes            | yes         | yes                       |
| School Admin         | yes                     | yes              | yes                    | yes        | yes        | yes            | yes         | yes                       |
| Teacher              | yes                     | yes              | 403                    | yes (own)  | 403        | yes (own)      | 403         | 403                       |
| Staff (VP / Counsellor / Admin Asst) | yes        | yes              | 403                    | yes (own)  | 403        | yes (own)      | 403         | 403                       |
| Parent / Student     | 403                     | 403              | 403                    | 403        | 403        | 403            | 403         | 403                       |

`hr-004:write` is intentionally admin-only per the Step 5 seed. Employees can read their own certifications but cannot create / verify them through the API — admins do. This matches the plan's read/write split.

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/api build           # nest build → exits 0
docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic dev.hr.leave.{requested,approved,rejected,cancelled,coverage_needed} \
  --partitions 3 --replication-factor 1   # avoid the dev topic-auto-create race
pnpm --filter @campusos/api start:prod      # 11 new HR routes mapped + leave-notification-consumer subscribed
```

22-scenario live smoke against `tenant_demo`:

| #   | Scenario                                                                                  | Outcome  |
| --- | ----------------------------------------------------------------------------------------- | -------- |
| 1   | teacher@ `GET /leave-types`                                                                | 5 types listed (Sick, Personal, Bereavement, PD, Unpaid) ✅ |
| 2   | teacher@ `GET /leave/me/balances`                                                          | 5 rows; Sick `used=2`, PD `pending=1` post-fix ✅ |
| 3   | teacher@ `GET /leave-requests`                                                             | 2 own rows (1 APPROVED Sick, 1 PENDING PD) ✅ |
| 4   | principal@ `GET /leave-requests?status=PENDING`                                            | 1 row — Rivera PD ✅ |
| 5   | parent@ `GET /leave-types`                                                                 | 403 INSUFFICIENT_PERMISSIONS ✅ |
| 6   | teacher@ submits a 1.5-day Sick request                                                    | 201; status=PENDING; days=1.5 ✅ |
| 7   | teacher@ balances after submit                                                             | Sick `pending=1.5` ✅ |
| 8   | principal@ approves                                                                        | status=APPROVED; reviewedBy + reviewedAt set ✅ |
| 9   | teacher@ balances after approve                                                            | Sick `used=3.5 pending=0` ✅ |
| 10  | `dev.hr.leave.coverage_needed` published                                                   | envelope shows 6 affected classes (Algebra 1 → Chemistry) ✅ |
| 11  | `msg_notification_queue` after approve                                                     | 3 rows SENT — 2 `leave.requested` to admins, 1 `leave.approved` to Rivera ✅ |
| 12  | teacher@ `GET /employees/:rivera/certifications`                                           | 3 VERIFIED certs sorted by expiry, Teaching Licence at `daysUntilExpiry=60` ✅ |
| 13  | teacher@ `GET /employees/:rivera/compliance`                                               | 3 reqs: Safeguarding green, First Aid green, Teaching Licence Renewal amber ✅ |
| 14  | principal@ `GET /compliance/dashboard`                                                     | totalEmployees=4, employeesWithGaps=2 (Mitchell red, Rivera amber) ✅ |
| 15  | parent@ `GET /employees/:rivera/certifications`                                            | 403 at the gate (`hr-004:read` required) ✅ |
| 16  | teacher@ `GET /compliance/dashboard`                                                       | 403 service-layer admin check ✅ |
| 17  | principal@ `GET /certifications/expiring-soon`                                             | 1 row — Teaching Licence at `days=60` ✅ |
| 18  | teacher@ cancels seeded PENDING PD request                                                 | status=CANCELLED; cancelledAt set ✅ |
| 19  | teacher@ balances after cancel                                                             | PD `pending=0` ✅ |
| 20  | principal@ creates a new cert for Rivera                                                   | 201; status=PENDING by default ✅ |
| 21  | principal@ verifies the new cert                                                           | status=VERIFIED; verifiedBy + verifiedAt set ✅ |
| 22  | teacher@ tries to verify (admin-only)                                                      | 403 INSUFFICIENT_PERMISSIONS ✅ |

### Bug caught and fixed by the smoke

Step 5's `seed-hr.ts` seeded Rivera's Professional Development `hr_leave_balances.pending=0` while *also* seeding a PENDING PD request for `days_requested=1.0`. The two were inconsistent. When the cancel smoke (scenario 18) tried to subtract 1 from `pending=0`, the migration-012 `pending_chk >= 0` correctly fired and rejected the underflow with a clean SQLSTATE 23514 — exactly the contract documented in Step 2's "Approval flow at the schema layer" note ("if Step 7's update would underflow `pending` or `used`, the UPDATE fails loudly rather than silently corrupting the running totals").

The CHECK is doing its job; the seed was wrong. **Fix landed in Step 7's commit:** `seed-hr.ts::balanceFor` now sets Rivera's PD balance to `{ accrued: spec.accrualRate, used: 0, pending: 1.0 }` to match the seeded PENDING request. The same seed edit reset Rivera's Personal Leave to `used=0 pending=0` since no Personal request was ever seeded — those non-zeros were stale. The live demo tenant was patched in-place via SQL UPDATE so the smoke could complete in this session; on a fresh provision, `seed:hr` produces the correct shape from the start.

### Dev-cluster topic auto-creation race (carried over from Cycle 3)

The `leave-notification-consumer` hits the same KafkaJS "this server does not host this topic-partition" error that Cycle 3's `audience-fan-out-worker` hits on a fresh dev broker — the consumer subscribes before any producer has emitted to the topic, so the broker has no metadata for it yet. The fix (per the Cycle 3 handoff) is to pre-create the dev topics once with `kafka-topics.sh --create`. Step 7 ships 6 new wire topics (`dev.hr.leave.{requested,approved,rejected,cancelled,coverage_needed}` + `dev.hr.certification.verified`); pre-create them on a fresh dev cluster and the consumer subscribes cleanly. In production this race doesn't apply because topic auto-creation is centrally managed.

### Out-of-scope decisions for Step 7

- **No HR-004:write for non-admins.** Per the Step 5 seed-iam matrix, only admins hold `hr-004:write`. Employees can *read* their own certifications but cannot create / verify them via the API. Recording a new cert in the Step 9 UI flow goes through the admin (or, in a future iteration, a sub-cycle that grants `hr-004:write` to Teacher/Staff with a tighter row-scope guard). The plan documented this split.
- **No `hr.certification.expiring` alert emit.** The plan calls for 90 / 30 / 7-day pre-expiry reminders. Step 7 lands the partial-index-backed read (`/certifications/expiring-soon`) and the `hr.certification.verified` emit, but the scheduled job that fires `hr.certification.expiring` per row at the right thresholds is reserved for a future ops follow-up alongside the day-end accrual job. The query is in place; the cron driver is not.
- **No `hr.leave.coverage_needed` notification side-effect.** The plan expects Cycle 5 Scheduling to consume the topic. Step 7 publishes the event with full payload (affected classes inline) but does not enqueue any notifications for it. When Cycle 5 lands its consumer, it will produce `sched.coverage_assigned` (or similar) and feed back into `NotificationQueueService` for the substitute-teacher acknowledgement.
- **No leave-balance accrual job.** Year-start accrual (`hr_leave_balances.accrued += hr_leave_types.accrual_rate` for every (employee, type) pair) is reserved for a future scheduled task. The seed sets balances explicitly; the request path's `upsertBalance` helper materialises a balance row from the type's `accrual_rate` if one doesn't exist when an employee submits.
- **`hr_cpd_requirements` and `hr_work_authorisation` have no API surface yet.** Both schemas exist; Step 6/7 didn't surface either. They remain reserved for a later iteration alongside the Phase-2 work-authorisation reverification flow.
- **No notification preferences seed for `leave.*` types.** `NotificationQueueService.enqueue()` defaults to IN_APP when no preference row exists (Step 5 of Cycle 3), so the new types deliver out of the box. Adding explicit preference rows is reserved for the user-prefs UI.
- **Custom errors come from Prisma codes, not domain logic.** The cancel-underflow case bubbles up as a 500 with a Prisma `23514` constraint-violation error. The user-facing error envelope is fine for the smoke (and for the CAT, since the seed is now consistent), but a future polish pass could catch SQLSTATE 23514 in `LeaveService.cancel` and translate it to a clean 422 "leave balance is inconsistent with this request — contact HR".
- **CAT scenarios deferred to Step 10.** The full reproducible vertical-slice walkthrough lands in `docs/cycle4-cat-script.md` once the Step 8 + 9 UI flows are in place.

Plan reference: Step 7 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 8 — Staff Directory & Employee Profile UI

**Done.** Three new routes plus a launchpad tile, all gated on `hr-001:read`. The single-source `apps/web/src/components/shell/apps.tsx::getAppsForUser` was updated so the tile renders in both the home grid and the sidebar — same flow Cycles 1–3 established for every other persona-aware app entry.

### Files added

```
apps/web/src/
├── lib/types.ts                          — appended HR DTO surface (~150 lines)
├── hooks/use-hr.ts                       — 16 hooks (new file)
├── components/shell/apps.tsx             — Staff tile under hr-001:read
└── app/(app)/staff/
    ├── page.tsx                          — searchable directory list
    ├── [id]/page.tsx                     — tabbed profile (Info / Certifications / Leave / Documents)
    └── me/page.tsx                       — client-side redirect to /staff/:myEmployeeId
```

### Routes and persona behaviour

| Route                | Visible to                          | Behaviour                                                                                                                                                                                                          |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/staff`             | anyone with `hr-001:read`           | Searchable list of employees. Card per row: avatar (initials), name, primary position title, employee number, email. `?search=` and (admin-only) `?includeInactive=true` query string mirror the API surface.    |
| `/staff/[id]`        | anyone with `hr-001:read`           | Tabbed profile. Info tab always visible. Certifications / Leave / Documents tabs only render when `useMyEmployee().data?.id === id` OR the user holds `sch-001:admin`. Non-admins viewing someone else see Info only. |
| `/staff/me`          | anyone with `hr-001:read`           | Calls `useMyEmployee` (`/employees/me`). On success: `router.replace('/staff/:id')`. On 404 (parent / student / Platform Admin without an `hr_employees` row): shows a clean "no employee record" empty state.   |

### Tabbed profile contents

- **Info tab** — three cards. Left: avatar + full name + email. Right: `Employment` field grid (employee number, status, type, hire date, optional termination date, primary position). Bottom: full-width `Position history` list with `effective_from → effective_to` range and FTE per row, with `Primary` and `Teaching` pills where applicable.
- **Certifications tab** — 4-stat summary card (Requirements / Compliant / Expiring / Non-compliant) at the top; per-cert list with green/amber/red `UrgencyPill` derived from `verificationStatus` (EXPIRED/REVOKED → red) and `daysUntilExpiry` (≤90 → amber, otherwise green); per-requirement breakdown joined to the seeded `hr_training_compliance` rows showing `lastCompletedDate` / `nextDueDate` and the same urgency pill (driven by the API's already-derived `urgency` field).
- **Leave tab** — balance cards (own profile only — admins viewing someone else see a hint message instead, since `/leave/me/balances` is calling-employee-only by design); request history list using `useLeaveRequests({ employeeId })` which the API filters server-side.
- **Documents tab** — list view with file name, document type label, file size, and expiry. Empty state describes that uploads ship in Step 9.

The tab visibility check fires on the client only — the server-side endpoints are independently gated, so a user trying to hit `/employees/:other-id/certifications` directly still gets a 403 from the API row-scope guard. The UI just doesn't surface the tab at all.

### Hooks (`apps/web/src/hooks/use-hr.ts`)

| Hook                              | Verb / cadence                                                |
| --------------------------------- | ------------------------------------------------------------- |
| `useEmployees(args, enabled)`     | GET `/employees` — refetch on focus.                          |
| `useEmployee(id, enabled)`        | GET `/employees/:id`.                                          |
| `useMyEmployee(enabled)`          | GET `/employees/me` — `retry: false` so 404s don't loop.       |
| `usePositions(enabled)`           | GET `/positions` — 5-min stale time.                            |
| `useEmployeeDocuments(id)`        | GET `/employees/:id/documents`.                                 |
| `useEmployeeCertifications(id)`   | GET `/employees/:id/certifications`.                            |
| `useExpiringCertifications()`     | GET `/certifications/expiring-soon` — 60-s poll.                |
| `useEmployeeCompliance(id)`       | GET `/employees/:id/compliance`.                                |
| `useComplianceDashboard()`        | GET `/compliance/dashboard` — 60-s poll.                        |
| `useLeaveTypes()`                 | GET `/leave-types` — 5-min stale time.                          |
| `useMyLeaveBalances()`            | GET `/leave/me/balances`.                                       |
| `useLeaveRequests(args)`          | GET `/leave-requests` with `?status=`/`?employeeId=`.           |
| `useSubmitLeaveRequest()`         | POST `/leave-requests` — invalidates leave-requests + balances. |
| `useApproveLeaveRequest(id)`      | PATCH `/leave-requests/:id/approve`.                            |
| `useRejectLeaveRequest(id)`       | PATCH `/leave-requests/:id/reject`.                             |
| `useCancelLeaveRequest()`         | PATCH `/leave-requests/:id/cancel`.                             |
| `useVerifyCertification(id)`      | PATCH `/certifications/:id/verify`.                             |

Every query accepts an `enabled` boolean so non-admin personas don't fire 403 calls — `apps/web/src/app/(app)/staff/[id]/page.tsx` uses this to gate the Certifications / Compliance / Documents fetches behind the `canSeeFullProfile` flag.

### Tile and sidebar wiring

`apps/web/src/components/shell/apps.tsx::getAppsForUser` gained a new branch:

```ts
if (hasAnyPermission(user, ['hr-001:read'])) {
  apps.push({
    key: 'staff',
    label: 'Staff',
    description: 'Employee directory and profiles',
    href: '/staff',
    icon: PeopleIcon,
  });
}
```

Per the project's UI Design Principles, the launchpad and the sidebar both render from this list, so adding the Staff app required exactly one edit. The tile shows up for every persona that holds the code: principal@ (sch-001:admin → all codes), teacher@ (HR-001:read added in Step 5), vp@ + counsellor@ (Staff role same), Platform Admin (everyFunction). Parents and students don't hold the code, so the tile is hidden cleanly.

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/web build       # next build → exits 0
pnpm --filter @campusos/api build       # nest build still clean (no type drift)
```

Bundle sizes:

| Route                | First Load JS |
| -------------------- | ------------: |
| `/staff`             | 6.18 kB        |
| `/staff/[id]`        | 6.49 kB        |
| `/staff/me`          | 2.34 kB        |

The bundle sizes match the comparable Cycle 3 `/announcements` / `/announcements/[id]` routes — the page-level data fetching is React Query plus the existing `apiFetch`, so no new shared chunks are pulled in.

### Out-of-scope decisions for Step 8

- **No upload flow on the Documents tab.** The tab renders the list and the empty state; the actual upload UI (signed-URL fetch + PUT to S3 + POST to `/employees/:id/documents`) lands in Step 9 alongside the leave + compliance pages. The existing `EmployeeDocumentService.create` endpoint accepts a pre-uploaded `s3Key`, so the UI scaffolding doesn't need to change when the upload arrives.
- **No edit-profile path on the Info tab.** The plan reserves admin-only employee CRUD for the admin-side flows; an `Edit` button + form will land alongside the leave + compliance UI in Step 9. The Step 6 `PATCH /employees/:id` endpoint is in place; the form just isn't built yet.
- **No emergency-contact section on the Info tab.** Schema landed in Step 1 but no API surface exists yet (deferred from Step 6). When Cycle 5 or Phase 2 hardens the HR module, an emergency-contact card will slot in next to Position history.
- **No CPD / work-authorisation tabs.** Both schemas exist; no API surface; no UI. Reserved for a later iteration.
- **`/staff/me` redirects rather than rendering inline.** This keeps a single source-of-truth for the profile UI (`[id]/page.tsx`) and makes the deep-link surface stable — sharing a profile URL by ID always works, but `/staff/me` is the personalised entry point. The redirect runs in `useEffect` so the API call has time to land before Next router replaces.
- **`useLeaveRequests({ employeeId })` is admin-only at the API.** The Step 7 `LeaveService.list` short-circuits non-admins to their own employee_id, so passing a different employeeId from the UI just returns the caller's own list. The Leave tab uses this intentionally — admins viewing someone else's profile get the right rows; non-admins viewing their own get the right rows; non-admins viewing someone else don't see this tab in the first place.
- **No new icons.** Reused the existing `PeopleIcon` for the Staff tile to avoid bloating `icons.tsx`. If a more specific icon helps Phase 2 design, it's a one-file addition.
- **Bundle deltas tracked but not optimized further.** The 6 kB / 6 kB / 2 kB route bundles are in line with Cycle 3's announcement pages. No code-splitting beyond the route boundary.
- **CAT integration deferred to Step 10.** The Step 10 vertical-slice script will exercise these pages against `tenant_demo` end-to-end alongside the Step 9 leave + compliance flows.

Plan reference: Step 8 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 9 — Leave Management & Compliance Dashboard UI

**Done.** Four new routes plus two new launchpad tiles, all reusing the Step 8 `use-hr.ts` hook layer. No new types, no new API surface — the work is purely additive on the web side.

### Files added

```
apps/web/src/
├── components/shell/apps.tsx                 — appended Leave + Compliance tiles
└── app/(app)/
    ├── leave/page.tsx                        — My Leave (employee view)
    ├── leave/new/page.tsx                    — Request leave form
    ├── leave/approvals/page.tsx              — Admin approval queue with Modal
    └── compliance/page.tsx                   — Admin school-wide dashboard
```

### Tiles and persona behaviour

| Tile        | Permission gate                       | Visible to                                                              |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------- |
| Leave       | `hr-003:read`                         | Teacher, Staff, School Admin, Platform Admin (anyone with HR-003 read). |
| Compliance  | `sch-001:admin` OR `hr-004:admin`     | School Admin and Platform Admin only.                                    |

Parents and students hold neither code, so both tiles are hidden cleanly.

### Routes

| Route                | Visible to                          | Behaviour                                                                                                                                                                                                          |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/leave`             | anyone with `hr-003:read`           | Balance cards (per type, two-tone progress bar — campus-blue for `used`, amber for `pending`, headline `available` count) + request history list with status pills. Per-row Cancel button on PENDING / APPROVED rows behind a `window.confirm` guard, wired to `useCancelLeaveRequest`. Header `New request` button → `/leave/new`. |
| `/leave/new`         | anyone with `hr-003:read`           | Form: leave-type dropdown defaulted to the first active type, `<input type="date">` pickers for start/end, `daysRequested` auto-calc from the date range with manual half-day override, optional reason textarea (≤500 chars). Live balance preview for the selected type; amber warning when `daysRequested > available`. Submit through `useSubmitLeaveRequest` → success toast → `router.push('/leave')`. |
| `/leave/approvals`   | `sch-001:admin`                     | List of PENDING requests via `useLeaveRequests({status:'PENDING'})`. Per-row Approve / Reject buttons open a Modal with optional review-notes textarea. Approve uses primary CTA; Reject uses red CTA. Mutations: `useApproveLeaveRequest(id)` / `useRejectLeaveRequest(id)`. Empty state when queue is clear. Non-admins see an "Admin access required" empty state — the API gate is the actual access control. |
| `/compliance`        | `sch-001:admin` OR `hr-004:admin`   | 3-stat header (Active employees / With gaps / Compliant %); 3 filter chips (All / Has gaps / Fully compliant); per-employee row with `compliantCount / amberCount / redCount` summary pills + "View profile" link to `/staff/:id` + Details toggle expanding the per-requirement rows with green/amber/red urgency pills. Empty state per filter mode. |

### Hook reuse from Step 8

Step 9 adds zero new hooks. Every interaction goes through the Step 8 `use-hr.ts` surface:

- `useMyEmployee`, `useMyLeaveBalances`, `useLeaveRequests`, `useCancelLeaveRequest` — `/leave`.
- `useMyEmployee`, `useLeaveTypes`, `useMyLeaveBalances`, `useSubmitLeaveRequest` — `/leave/new`.
- `useLeaveRequests`, `useApproveLeaveRequest`, `useRejectLeaveRequest` — `/leave/approvals`.
- `useComplianceDashboard` — `/compliance`.

Each mutation invalidates the affected query keys, so the UI re-renders without manual refetches.

### Authorisation contract

| Persona              | /leave (own) | /leave/new | /leave/approvals | /compliance |
| -------------------- | ------------ | ---------- | ---------------- | ----------- |
| Platform Admin       | n/a (no employee row — empty state) | n/a | yes | yes |
| School Admin         | yes (own balances)                  | yes | yes | yes |
| Teacher              | yes                                  | yes | empty state (admin-only) | hidden tile |
| Staff (VP / Counsellor / Admin Asst) | yes                  | yes | empty state | hidden tile |
| Parent / Student     | hidden tile + 403 if URL guessed     | hidden tile + 403 | hidden tile + 403 | hidden tile + 403 |

The tiles are hidden when the user lacks the gate code. Direct URL guesses still hit the global `PermissionGuard` at the API and return 403.

### UX details

- **Balance cards** (`/leave`) — two-tone progress bar visualises `used` (campus-blue) and `pending` (amber) as a percentage of `accrued`. The bar stops at 100 % even if running totals exceed (defensive — shouldn't happen given the migration-012 CHECKs). Headline shows `available = accrued - used - pending`.
- **`/leave/new` auto-calc** — `daysRequested` defaults to whole-day diff between start and end dates. Users can override (e.g. `0.5` for half-day; the API accepts `>= 0.5`). When `daysRequested > balanceForType.available`, an amber inline warning appears under the field but the form still submits — the admin can still approve, and Unpaid Leave has no `available` budget anyway.
- **Cancel guard** — `/leave` uses `window.confirm` rather than a modal because cancel is a single-step action. The mutation is idempotent (a second cancel returns 400 from `LeaveService.cancel`'s status guard) so an accidental double-click is harmless.
- **Approval Modal** — re-uses the existing `Modal` primitive. Shared `ReviewModal` component swaps the action target via the `mode: 'approve' | 'reject'` prop. Both buttons disable during the mutation; toast surfaces success or the API error message.
- **Compliance Details toggle** — the page tracks one expanded employee at a time via local state. Expanding another collapses the previous one. This keeps the dashboard scannable and avoids long pages on schools with dozens of staff.

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/web build       # next build → exits 0
```

Bundle sizes:

| Route                | First Load JS |
| -------------------- | ------------: |
| `/leave`             | 5.66 kB        |
| `/leave/new`         | 5.74 kB        |
| `/leave/approvals`   | 6.06 kB        |
| `/compliance`        | 5.65 kB        |

In line with the Cycle 3 / Step 8 ranges.

### Out-of-scope decisions for Step 9

- **No /leave/[id] detail page.** The list rows on `/leave` and `/leave/approvals` show enough metadata (type, dates, reason, status, optional review notes) that a per-request detail page didn't earn its keep this cycle. If a future workflow needs deeper drill-down (e.g. attachments, audit trail), it lands as `/leave/[id]/page.tsx` reusing `useLeaveRequest`.
- **No bulk approval.** The approval modal is per-row. Bulk actions would require multi-select state + a server-side batch endpoint; not in plan.
- **No date-picker library.** Native `<input type="date">` is used for start / end. It's accessible, has built-in validation, and ships zero new bundle weight. If a future cycle wants a richer calendar picker, it can swap in.
- **No drag-and-drop reorder on the approval queue.** Sort order comes from the API (`submitted_at DESC`); admins work top-down.
- **Compliance dashboard filter is client-side.** With ~4–10 employees per school the data set is tiny; server-side filtering would just add a round-trip. If schools grow into the hundreds, the API can grow `?gapsOnly=true` and the chip can wire it.
- **Department / position filters not implemented.** Plan called for "Filter by department, position, compliance status." Status filter is in. Department + position filters are deferred — `hr_positions.department_id` is a soft FK to `sis_departments(id)` and the API doesn't currently surface a department label on each employee. When `EmployeeService` joins it through, the filter is a one-line addition.
- **No CSV export.** Out of scope for the CAT. If admins need to share the dashboard, they screenshot or copy-paste; a dedicated export ships with Phase 2 hardening.
- **Approval queue Modal doesn't preview balance impact.** The admin sees days requested but not "if I approve, this drops Rivera's Sick balance to N". Adding a balance preview is a one-line `useMyLeaveBalances` extension scoped to the target employee — but there's no `/leave/balances?employeeId=` endpoint yet (`/leave/me/balances` is calling-employee-only). Reserved for a Phase 2 polish pass.

Plan reference: Step 9 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 10 — Vertical Slice Integration Test

_Not started._ `docs/cycle4-cat-script.md` lands the reproducible 9-scenario CAT walkthrough:

1. Admin creates employee.
2. Employee views profile (Info, Certifications amber for Teaching Licence, Leave balances).
3. Employee submits leave; balance shows `pending` incremented, request appears as PENDING.
4. Kafka `hr.leave.requested` event verified on the wire.
5. Admin approves; status flips to APPROVED.
6. Balance updates (`used` incremented, `pending` decremented), Kafka `hr.leave.approved` event verified.
7. Employee receives in-app notification of approval.
8. Compliance dashboard shows Rivera amber for Teaching Licence (60 days to expiry).
9. Permission denials: teacher cannot access Leave Approvals or edit another employee's record; parent / student cannot access Staff at all.

Plus the bridge-verification queries from Step 0 (Scenarios 1–4 of the Verification table above) re-run as a smoke before Scenario 1.

Plan reference: Step 10 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Quick reference — running the stack from a fresh clone

```bash
pnpm install
docker compose up -d
pnpm --filter @campusos/database migrate
pnpm --filter @campusos/database seed
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database seed:classroom
pnpm --filter @campusos/database seed:messaging
pnpm --filter @campusos/database seed:hr                      # Cycle 4 Step 0 / Step 5 addition — bridge UPDATEs + 7 idempotent data layers (positions, leave, certs, training, docs, onboarding)
pnpm --filter @campusos/database exec tsx src/build-cache.ts  # Cycle 4 Step 5 — 7 account-scope pairs after vp@ and counsellor@ were added
pnpm --filter @campusos/api dev
```

`seed:hr` is the Cycle 4 addition; everything else is unchanged from Cycle 3. Seeds are idempotent and safe to re-run.

---

## Open items / known gaps (will be filled in as steps land)

- **Step 0 service-side wire-up.** `ActorContextService` lookup, the 4 controller / service substitutions, and the `class.service.ts` rename land alongside the seed in this step. CLAUDE.md "Temporary HR-Employee Identity Mapping" bullet retired in the same commit.
- **Steps 1–4 schema migrations.** Five new tenant SQL files (`011`–`014`) covering 16 tables on top of `hr_employees`. Total tenant base table count after Step 4: ~75 (was 57).
- **Step 5 seed + permission updates.** HR-001/003/004 read/write/admin codes added to Teacher / Staff / Parent / Student / School Admin / Platform Admin per the matrix in the plan.
- **Steps 6–7 NestJS module.** ~22 endpoints (10 employee/positions + 12 leave/certifications) + 5 Kafka events + 1 new consumer (LeaveNotificationConsumer).
- **Steps 8–9 UI.** Three launchpad tiles ("Staff", "Leave", "Compliance") added through the single-source `getAppsForUser` catalogue. Six pages.
- **Step 10 CAT.** 9-scenario reproducible script at `docs/cycle4-cat-script.md`.
- **Out of scope this cycle (deferred to Cycle 4b or later):** Recruitment (HR-002 — `hr_job_postings`, `hr_applications`, `hr_interview_schedules`, `hr_offer_letters`); payroll (`hr_pay_periods`, `hr_payroll_records`, `hr_salary_components`, `hr_deductions`, `hr_tax_information`); benefits (`hr_benefit_enrolment_periods`, `hr_benefit_plans`, `hr_benefit_elections`); appraisals + observations (HR-005 — `hr_appraisals`, `hr_appraisal_responses`, `hr_classroom_observations`); employee relations (`hr_grievances`, `hr_grievance_actions`, `hr_disciplinary_actions`); workers' comp (`hr_workers_comp_claims`, `hr_return_to_work_plans`).
- **Phase 2 carry-overs from Cycle 3 (not Cycle 4 scope):** DLQ-row dashboard / alert wiring on `platform.platform_dlq_messages` (REVIEW-CYCLE3 reviewer's carry-over). Persona walkthroughs and UI design guide creation. These remain on the Phase 2 punch list and are not blocked by Cycle 4.

---

## Cycle 4 exit criteria (from the plan)

1. HR-Employee identity migration complete. All four soft FKs resolved from `iam_person.id` to `hr_employees.id`.
2. Tenant schema: ~18 new HR tables. Total tenant tables: ~75.
3. Employee API: ~10 endpoints with row-level auth (own profile vs admin).
4. Leave API: ~6 endpoints with approval workflow. Kafka events for leave lifecycle.
5. Certification API: ~4 endpoints. Expiry alert events.
6. Compliance dashboard with school-wide training status.
7. Staff Directory UI: searchable employee list, tabbed profile.
8. Leave UI: request form, balance view, admin approval queue.
9. Vertical slice test: all 9 steps pass.
10. HANDOFF-CYCLE4.md and CLAUDE.md updated. CI green.

---

## Post-cycle architecture review

_Pending._ After Step 10 lands, the Cycle 4 review request goes to the architecture-review pipeline (same flow as Cycles 1–3 — `REVIEW-CYCLE4-CHATGPT.md` / `REVIEW-CYCLE4-CLAUDE.md`). The expected verdict trail mirrors Cycle 3:

| Round | SHA | Verdict |
| ----: | --- | ------- |
| 1     | tbd | tbd     |
| 2     | tbd | tbd     |

Carry-overs from prior reviews relevant to the Cycle 4 closeout:

- **REVIEW-CYCLE3 — DLQ dashboard / alert (operational).** Not Cycle 4 scope; tracked in the Phase 2 punch list.
- **REVIEW-CYCLE2 DEVIATION 4 — Temporary HR-Employee Identity Mapping.** Resolved by Cycle 4 Step 0. Closeout commit will reference this deviation explicitly so the post-cycle reviewer can confirm.
