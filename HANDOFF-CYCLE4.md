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
|    3 | HR Schema — Certifications & Training                   | Not started — `013_hr_certifications_and_training.sql` will land 5 base tables (`hr_staff_certifications`, `hr_training_requirements`, `hr_training_compliance`, `hr_cpd_requirements`, `hr_work_authorisation`).                                                                                                                                |
|    4 | HR Schema — Onboarding                                  | Not started — `014_hr_onboarding.sql` will land 3 base tables (`hr_onboarding_templates`, `hr_onboarding_checklists`, `hr_onboarding_tasks`).                                                                                                                                                                                                   |
|    5 | Seed Data — Employees, Leave, Certifications            | Not started — `seed-hr.ts` will populate 5 employee records, 5 positions + assignments, 5 leave types + balances, 2 sample leave requests, certifications (incl. Rivera's Teaching Licence expiring in 60 days), training requirements + pre-computed compliance, document types, and a New Teacher Onboarding template. Adds HR-001/003/004 to roles. |
|    6 | HR NestJS Module — Employee Records & Directory         | Not started — `apps/api/src/hr/` will land EmployeeService, PositionService, EmployeeDocumentService, and extend `ActorContextService.resolveActor()` to populate `actor.employeeId` from `hr_employees.person_id`. ~10 endpoints under `hr-001:*`.                                                                                              |
|    7 | HR NestJS Module — Leave & Certifications               | Not started — LeaveService + CertificationService + TrainingComplianceService + LeaveNotificationConsumer (Kafka consumer on `hr.leave.approved` → resolves affected classes via `sis_class_teachers` and emits `hr.leave.coverage_needed` for Cycle 5 Scheduling). ~12 endpoints under `hr-003:*` / `hr-004:*` + 5 Kafka events.                |
|    8 | Staff Directory & Employee Profile UI                   | Not started — `/staff` directory + `/staff/:id` tabbed profile (Info / Certifications / Leave / Documents) + `/staff/me` shortcut. New "Staff" launchpad tile under `hr-001:read`.                                                                                                                                                              |
|    9 | Leave Management & Compliance Dashboard UI              | Not started — `/leave/new` request form, `/leave` employee history, `/leave/approvals` admin queue, `/compliance` admin dashboard. New "Leave" tile (all staff) and "Compliance" tile (admin-only).                                                                                                                                            |
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

_Not started._ Migration `013_hr_certifications_and_training.sql`. 5 base tables: `hr_staff_certifications`, `hr_training_requirements`, `hr_training_compliance`, `hr_cpd_requirements`, `hr_work_authorisation`. ADR-015 followed for DBS / background-check refs (store reference + status only, never the underlying record).

Plan reference: Step 3 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 4 — HR Schema — Onboarding

_Not started._ Migration `014_hr_onboarding.sql`. 3 base tables: `hr_onboarding_templates`, `hr_onboarding_checklists`, `hr_onboarding_tasks`.

Plan reference: Step 4 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 5 — Seed Data — Employees, Leave, Certifications

_Not started._ `packages/database/src/seed-hr.ts` lands the rest of the HR seed on top of Step 0's bridge:

- 5 employee records (already seeded in Step 0; this step is idempotent and won't re-insert).
- 5 positions (Teacher, Principal, Vice Principal, Administrative Assistant, Counsellor) + 5 employee-position assignments.
- 5 leave types (Sick Leave, Personal Leave, Bereavement, Professional Development, Unpaid Leave) + per-employee balances for the current academic year.
- 2 sample leave requests (one APPROVED, one PENDING).
- Certifications including James Rivera's Teaching Licence with a 60-day expiry — drives the compliance dashboard amber row in the CAT.
- 3 school-wide training requirements (Safeguarding, First Aid, Fire Safety) + 1 position-specific (Teaching Licence renewal).
- Pre-computed compliance rows.
- 4 document types (Contract, Background Check, Tax Form W-4, Teaching Licence Copy).
- "New Teacher Onboarding" template with 8 tasks.
- Permission updates: HR-001 (Employee Records) read for Teacher/Staff, HR-003 (Leave) read+write for Teacher/Staff, HR-004 (Certifications) read for Teacher/Staff, full HR access for School Admin and Platform Admin. Rebuild `iam_effective_access_cache`.

Plan reference: Step 5 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 6 — HR NestJS Module — Employee Records & Directory

_Not started._ `apps/api/src/hr/` lands EmployeeService, PositionService, EmployeeDocumentService. Extends `ActorContextService.resolveActor()` to populate `actor.employeeId` (deferred from Step 0 if Step 0 only seeds — this step finalises the wire-up). ~10 endpoints under `hr-001:read` / `hr-001:write` / `hr-001:admin`.

Row-level authorisation: employees view the staff directory (everyone with `hr-001:read`) and their own full profile; admins view + edit all employees; teachers cannot view other employees' documents or leave details.

Plan reference: Step 6 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 7 — HR NestJS Module — Leave & Certifications

_Not started._ LeaveService + CertificationService + TrainingComplianceService + LeaveNotificationConsumer. ~12 endpoints under `hr-003:*` and `hr-004:*` plus 5 Kafka events.

Kafka events: `hr.leave.requested`, `hr.leave.approved`, `hr.leave.rejected`, `hr.leave.cancelled`, `hr.certification.expiring`. The `LeaveNotificationConsumer` listens on `hr.leave.approved`, resolves affected classes via `sis_class_teachers` for the leave date range, and emits `hr.leave.coverage_needed` (consumed by Cycle 5 Scheduling). Notifications flow through the Cycle 3 `NotificationQueueService`.

Plan reference: Step 7 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 8 — Staff Directory & Employee Profile UI

_Not started._ Adds the "Staff" launchpad tile (`hr-001:read`-gated) and the corresponding sidebar entry via `apps/web/src/components/shell/apps.tsx::getAppsForUser(user)` (UI Design Principles in CLAUDE.md — single source of truth for tile + sidebar). Three pages:

- `/staff` — searchable directory.
- `/staff/:id` — tabbed profile (Info / Certifications / Leave / Documents). Own profile shows all tabs; others' profiles show only Info unless the viewer is an admin.
- `/staff/me` — redirects to `/staff/:myEmployeeId`.

Plan reference: Step 8 of `docs/campusos-cycle4-implementation-plan.html`.

---

## Step 9 — Leave Management & Compliance Dashboard UI

_Not started._ Two new launchpad tiles ("Leave" for all staff, "Compliance" for admins) plus four pages:

- `/leave/new` — request form with leave-type dropdown, date range picker, half-day support, balance preview.
- `/leave` — employee view of balances + request history with cancel buttons on PENDING.
- `/leave/approvals` — admin queue.
- `/compliance` — admin training-compliance dashboard, color-coded by urgency (green / amber / red), filters by department / position / status.

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
pnpm --filter @campusos/database seed:hr                      # Cycle 4 Step 0 / Step 5 addition
pnpm --filter @campusos/database exec tsx src/build-cache.ts
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
