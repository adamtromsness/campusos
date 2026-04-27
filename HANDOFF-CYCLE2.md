# Cycle 2 Handoff — Classroom, Assignments & Grading

**Status:** Cycle 2 IN PROGRESS — Steps 1–7 done (full classroom schema, demo data, TCH role-permission map, the Assignments + Categories module, the Submissions + Grading + Gradebook + Progress Notes module, the first Kafka consumer in the system — GradebookSnapshotWorker — that recomputes gradebook snapshots asynchronously per ADR-010, and the teacher Assignments UI: list / create / edit / delete + category-weight modal under a new ClassTabs shell at `/classes/:id/{attendance,assignments}`). (Cycle 1 is COMPLETE; see `HANDOFF-CYCLE1.md` for the SIS + Attendance foundation this cycle builds on.)
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle2-implementation-plan.html`
**Vertical-slice deliverable:** Teacher creates an assignment for Period 1 Algebra → student Maya submits work → teacher grades and publishes → gradebook snapshot recomputes asynchronously → parent David sees Maya's updated average.

This document tracks the Cycle 2 build — the M21 Classroom module — at the same level of detail as `HANDOFF-CYCLE1.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                           | Status                                                              |
| ---: | ----------------------------------------------- | ------------------------------------------------------------------- |
|    1 | Classroom Schema — Lessons & Assignments        | Done — `005_cls_lessons_and_assignments.sql` applied to demo + test |
|    2 | Classroom Schema — Submissions & Grading        | Done — `006_cls_submissions_and_grading.sql` applied to demo + test |
|    3 | Seed Data — Assignments & Grades                | Done — `seed-classroom.ts` lands 12 assignments + 80 submissions + 62 grades + 41 snapshots; TCH role-permission map updated |
|    4 | Classroom NestJS Module — Assignments           | Done — `apps/api/src/classroom/` ships AssignmentService, CategoryService, controllers; 7 endpoints under `tch-002:read/write` with row-level auth |
|    5 | Classroom NestJS Module — Submissions & Grading | Done — SubmissionService + GradeService + GradebookService + ProgressNoteService; 12 endpoints; per-class write gate; draft-grade visibility hidden from students/parents; Kafka emits for `cls.submission.submitted`, `cls.grade.published`, `cls.grade.unpublished`, `cls.progress_note.published` |
|    6 | Kafka Events & Gradebook Snapshot Worker        | Done — `KafkaConsumerService`, `IdempotencyService`, `GradebookSnapshotWorker`; subscribes to `cls.grade.{published,unpublished}` (group `gradebook-snapshot-worker`); 30s debounce per `(schoolId, classId, studentId)`; idempotent via `platform_event_consumer_idempotency`; reuses the seed's weighted-average algorithm verbatim |
|    7 | Teacher Assignments UI                          | Done — `ClassTabs` shell + `/classes/:id/assignments` list (filter, delete) + `/new` + `/[assignmentId]/edit` + `CategoryWeightModal`; new `GET /assignment-types` endpoint exposes the school's type catalogue to the create form |
|    8 | Teacher Grading UI                              | Pending                                                             |
|    9 | Student & Parent Grade Views                    | Pending                                                             |
|   10 | Vertical Slice Integration Test                 | Pending                                                             |

The Cycle 2 exit deliverable is the end-to-end vertical slice: assignment creation → submission → grading → publish → snapshot debounced recomputation → parent sees updated average. The reproducible CAT script will land at `docs/cycle2-cat-script.md` as the Step 10 deliverable.

---

## What this cycle adds on top of Cycle 1

Cycle 1 delivered SIS Core (academic structure, students/families, attendance) and a working teacher/parent/admin UI shell. Cycle 2 adds the M21 Classroom module on top — 15 new tenant tables across two migrations, plus the first Kafka **consumer** in the system (gradebook snapshot worker).

**Key dependencies inherited from Cycle 1:**

- `sis_classes`, `sis_class_teachers`, `sis_enrollments` — every assignment is scoped to a class, every submission to a (student, assignment) pair, every gradebook entry to (student, class, term).
- `sis_terms` (and `sis_academic_years`) — gradebook snapshots and report cards are term-scoped.
- `grading_scales` (Cycle 0 foundation) — assignments reference a grading scale for letter-grade derivation.
- Row-level authorization pattern from REVIEW-CYCLE1: parents see only linked children, students see only self, teachers see only their assigned classes, admins see all. **Reused verbatim** in every Classroom service.
- `KafkaProducerService` (Cycle 1) — Cycle 2 adds the matching consumer side.
- Tenant isolation discipline: `executeInTenantContext` and `executeInTenantTransaction` both run inside `$transaction` with `SET LOCAL search_path` (REVIEW-CYCLE1 fix). Every Classroom service uses these helpers.

---

## Schema changes — two tenant migrations

All Cycle 2 migrations live in `packages/database/prisma/tenant/migrations/`. They follow the same idempotent pattern as the Cycle 1 migrations: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` for FK changes, `TEXT + CHECK IN (…)` for enum-like columns (the SQL splitter can't handle `CREATE TYPE` idempotently). Soft UUID references to `platform.*` tables — never DB-level FK constraints (ADR-001/020).

**After Steps 1–2 the tenant schema holds 38 base tables:** 5 (Cycle 0) + 18 (Cycle 1 SIS + Attendance) + 15 (Cycle 2 Classroom) = 38, plus 36 partition objects under `sis_attendance_records`.

### `005_cls_lessons_and_assignments.sql` — 7 tables (Step 1)

| Table                       | Purpose                                                               | Key columns                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cls_lesson_types`          | Configurable lesson types per school                                  | `school_id`, `name`, `icon`, `is_active`. UNIQUE(school_id, name).                                                                                                                                                                                                             |
| `cls_lessons`               | Lesson plan (template or scheduled). Table created; minimal API only. | `class_id` FK nullable (NULL → template), `teacher_id` (soft → hr_employees), `lesson_type_id` FK, `title`, `date` nullable, `duration_minutes`, `learning_objectives TEXT[]`, `status` ∈ {DRAFT, PUBLISHED, ARCHIVED, TEMPLATE}, `is_template`, `bank_lesson_id` (provenance) |
| `cls_assignment_types`      | School-wide assignment types                                          | `school_id`, `name`, `weight_in_category NUMERIC(5,2)`, `category` ∈ {HOMEWORK, QUIZ, TEST, PROJECT, CLASSWORK}. UNIQUE(school_id, name).                                                                                                                                      |
| `cls_assignment_categories` | Per-class category weights for weighted grading                       | `class_id` FK, `name`, `weight NUMERIC(5,2)`. App-layer validation: weights sum to 100 per class.                                                                                                                                                                              |
| `cls_assignments`           | An assignment within a class                                          | `class_id` FK, `lesson_id` FK nullable, `assignment_type_id` FK, `title`, `instructions`, `due_date TIMESTAMPTZ`, `max_points NUMERIC(6,2)`, `grading_scale_id` FK (tenant-local `grading_scales`), `is_ai_grading_enabled`, `is_extra_credit`. INDEX(class_id, due_date).     |
| `cls_assignment_questions`  | Optional questions inside an assignment (quizzes, file uploads)       | `assignment_id` FK, `question_text`, `question_type` ∈ {MULTIPLE_CHOICE, SHORT_ANSWER, ESSAY, TRUE_FALSE, FILE_UPLOAD}, `points NUMERIC(5,2)`, `sort_order`. INDEX(assignment_id, sort_order).                                                                                 |
| `cls_answer_key_entries`    | Answer key for a question (per option for MC; or canonical answer)    | `question_id` FK, `option_index`, `correct_answer`, `explanation`, `is_correct`. UNIQUE(question_id, option_index).                                                                                                                                                            |

**Soft references** (UUID, no DB FK constraint, validated at the app layer):

- `cls_lessons.teacher_id` → `hr_employees.id` (HR module not yet built; column kept for forward compatibility per the ERD)
- `cls_lessons.bank_lesson_id` → external lesson bank (module not in scope this cycle)

**Intra-tenant FKs** (DB-enforced, all within the tenant schema):

- `cls_lessons.class_id → sis_classes(id)` (nullable; templates have no class)
- `cls_lessons.lesson_type_id → cls_lesson_types(id)`
- `cls_assignment_categories.class_id → sis_classes(id) ON DELETE CASCADE`
- `cls_assignments.class_id → sis_classes(id) ON DELETE CASCADE`
- `cls_assignments.lesson_id → cls_lessons(id)` (nullable)
- `cls_assignments.assignment_type_id → cls_assignment_types(id)`
- `cls_assignments.grading_scale_id → grading_scales(id)` (tenant-local Cycle 0 table)
- `cls_assignment_questions.assignment_id → cls_assignments(id) ON DELETE CASCADE`
- `cls_answer_key_entries.question_id → cls_assignment_questions(id) ON DELETE CASCADE`

### `006_cls_submissions_and_grading.sql` — 8 tables (Step 2)

| Table                            | Purpose                                                                        | Key columns                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cls_submissions`                | One row per (assignment, student). Tracks status from NOT_STARTED to RETURNED. | `assignment_id` FK, `student_id` FK, `status` ∈ {NOT_STARTED, IN_PROGRESS, SUBMITTED, GRADED, RETURNED}, `submission_text`, `attachments JSONB`, `submitted_at`, `returned_at`, `return_reason`. UNIQUE(assignment_id, student_id). Partial index `(assignment_id, submitted_at DESC) WHERE status='SUBMITTED'`. |
| `cls_submission_question_grades` | Per-question grade (and AI suggestion) within a submission.                    | `submission_id` FK, `question_id` FK, `student_response`, `ai_suggested_points NUMERIC(5,2)`, `ai_confidence NUMERIC(3,2)` (0–1), `teacher_awarded_points`, `feedback`. UNIQUE(submission_id, question_id). CHECK on `ai_confidence`.                                                                            |
| `cls_ai_grading_jobs`            | Async AI grading job tracking. AI never writes to `cls_grades`.                | `submission_id` FK, `status` ∈ {PENDING, RUNNING, COMPLETE, FAILED}, `ai_suggested_grade`, `ai_confidence`, `ai_reasoning`, `model_version`, `started_at`, `completed_at`, `error_message`. Partial index `(status) WHERE status IN ('PENDING','RUNNING')` for the worker queue.                                 |
| `cls_grades`                     | The teacher-confirmed grade for an (assignment, student). Source of truth.     | `assignment_id` FK, `student_id` FK, `submission_id` FK nullable, `teacher_id` (soft → hr_employees), `grade_value NUMERIC(6,2)`, `letter_grade`, `feedback`, `is_published`, `graded_at`, `published_at`. UNIQUE(assignment_id, student_id). CHECK `grade_value >= 0`.                                          |
| `cls_gradebook_snapshots`        | Per-(class, student, term) running average. **Async-only writes (ADR-010).**   | `class_id` FK, `student_id` FK, `term_id` FK, `current_average NUMERIC(5,2)`, `letter_grade`, `assignments_graded`, `assignments_total`, `last_grade_event_at`, `last_updated_at`. UNIQUE(class_id, student_id, term_id).                                                                                        |
| `cls_report_cards`               | A finalised report-card record per (student, class, term).                     | `student_id` FK, `class_id` FK, `term_id` FK, `status` ∈ {DRAFT, PUBLISHED}, `published_at`, `finalized_by` (soft). UNIQUE(student_id, class_id, term_id). Partial index for published cards.                                                                                                                    |
| `cls_report_card_entries`        | One row per subject on a report card. Subject is intentional free text.        | `report_card_id` FK ON DELETE CASCADE, `subject TEXT`, `final_grade`, `grade_value NUMERIC(5,2)`, `teacher_comments`, `effort_grade`, `sort_order`. UNIQUE(report_card_id, subject).                                                                                                                             |
| `cls_student_progress_notes`     | One mid-term narrative per (class, student, term). Author is a soft ref.       | `class_id` FK, `student_id` FK, `term_id` FK, `author_id` (soft → hr_employees), `note_text`, `overall_effort_rating` ∈ {EXCELLENT, GOOD, SATISFACTORY, NEEDS_IMPROVEMENT, UNSATISFACTORY}, `is_parent_visible`, `is_student_visible`, `published_at`. UNIQUE(class_id, student_id, term_id).                    |

**Soft references** (UUID, no DB FK constraint, app-layer validation):

- `cls_grades.teacher_id` → `hr_employees.id`
- `cls_report_cards.finalized_by` → `hr_employees.id`
- `cls_student_progress_notes.author_id` → `hr_employees.id`

**Intra-tenant FKs** (DB-enforced; 18 total in this migration — see "Step 2 verification" section for the full list):

- `cls_submissions.{assignment_id, student_id}` → `cls_assignments(id)` (CASCADE) / `sis_students(id)`
- `cls_submission_question_grades.{submission_id, question_id}` → CASCADE on both parents
- `cls_ai_grading_jobs.submission_id` → `cls_submissions(id)` (CASCADE)
- `cls_grades.{assignment_id, student_id, submission_id}` → `cls_assignments`, `sis_students`, `cls_submissions` (no CASCADE — grades survive submission tweaks; assignment deletion is RESTRICT-by-default since the plan says assignments soft-delete)
- `cls_gradebook_snapshots.{class_id, student_id, term_id}` → `sis_classes` (CASCADE) / `sis_students` / `sis_terms`
- `cls_report_cards.{student_id, class_id, term_id}` → `sis_students` / `sis_classes` / `sis_terms`
- `cls_report_card_entries.report_card_id` → `cls_report_cards(id)` (CASCADE)
- `cls_student_progress_notes.{class_id, student_id, term_id}` → `sis_classes` (CASCADE) / `sis_students` / `sis_terms`

**ADR-010 enforcement at the schema level.** `cls_grades` and `cls_gradebook_snapshots` are physically separate tables with no FK from one to the other. There are no triggers on `cls_grades` that touch `cls_gradebook_snapshots`. Any future violation of "snapshots are async-only" would require a deliberate change here — making the rule auditable from the migration alone.

**AI / human boundary at the schema level.** `cls_ai_grading_jobs` and `cls_submission_question_grades.ai_suggested_*` columns are physically separate from `cls_grades`. `cls_grades` has no `ai_*` columns, and `cls_ai_grading_jobs` has no path to write to `cls_grades`. The contract — AI surfaces suggestions; only teacher action persists a grade — is enforced at the service layer (Step 5) and made obvious by the schema layout.

---

## Key design contracts (Cycle 2)

- **AI / human boundary (M21).** `cls_ai_grading_jobs` and `cls_submission_question_grades` store AI suggestions. `cls_grades` stores only teacher-confirmed grades. AI services MUST NOT write to `cls_grades` — the UI surfaces AI suggestions next to teacher input but only a teacher action persists a grade. Enforced at the service layer (no AI service is wired in this cycle; the table is created for forward compatibility and the contract is documented here).
- **ADR-010 (gradebook snapshots async-only).** `cls_gradebook_snapshots` is NEVER updated inside the same transaction that writes a grade. Grade writes emit `cls.grade.published` (or `.unpublished`); a Kafka consumer with a 30-second debounce per (class_id, student_id) recomputes `current_average` and upserts the snapshot. This is the first Kafka consumer in the system — it establishes the consumer pattern (KafkaConsumerService, topic subscription, idempotency via `platform_event_consumer_idempotency`) that Cycle 3 (Communications) will reuse.
- **Row-level authorization (inherited from REVIEW-CYCLE1).** Every Classroom service uses `ActorContextService.resolveActor(...)` and applies a per-personType visibility predicate. Teachers can only manage assignments / grades for classes where they appear in `sis_class_teachers`. Students can only submit for their own enrolled classes. Parents see only their linked children's data. Admins see school-wide. Endpoint `@RequirePermission` is the floor; row-level filter is the actual access boundary for shared permission codes (TCH-002:read is held by teachers, students, and parents).
- **Weighted grading.** `cls_assignment_categories` defines per-class category weights summing to 100 (validated at the app layer). Current average = Σ (category_weight × category_grade) / 100. Extra-credit assignments (`is_extra_credit=true`) are excluded from the denominator.
- **Tenant isolation discipline.** Every classroom service uses `TenantPrismaService.executeInTenantContext` (single-statement) or `executeInTenantTransaction` (multi-statement atomic). Both helpers run inside a Prisma `$transaction` with `SET LOCAL search_path` so search_path stays pinned to a single connection (REVIEW-CYCLE1 Fix #1). A session-level SET on a pooled client could leak across requests under concurrent load — never use it.
- **Frozen-tenant gate (ADR-031, Cycle 0).** Every write through this module passes the existing TenantGuard frozen check. Reads continue to work even on a frozen tenant.

---

## Permission catalogue updates

Cycle 2 surfaces the TCH function group from the Function Library v11. Codes already exist in `packages/database/data/permissions.json` (the Cycle 1 reconciliation pulled the full 148/444 catalogue, including TCH). Step 3 (seed) wired them into roles via `seed-iam.ts`:

| Code        | Function     | Roles (after Step 3)                                                                                  |
| ----------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `tch-002:*` | Assignments  | Teacher: read/write. Student: read/write (so the submit endpoint can pass). Parent: read.            |
| `tch-003:*` | Grade Book   | Teacher: read/write. Student/Parent: read (row-scoped to own/linked rows by `ActorContextService`).   |
| `tch-004:*` | Report Cards | Teacher: read/write. Student/Parent: read.                                                            |

Student keeps `tch-002:write` rather than just `read` because submitting an assignment is a write under the same function code (no separate "submit-own-work" code exists). Row-level scoping in the Step 5 service will enforce that students can only insert/update submissions where `student_id = self`.

Step 3 also rebuilt the effective access cache (`pnpm --filter @campusos/database exec tsx src/build-cache.ts`) after the role-permission mapping update. Cached counts: Platform Admin 444, School Admin 444, Teacher 27, Student 14, Parent 11.

---

## API endpoints (planned)

Step 4 (Assignments) and Step 5 (Submissions & Grading) deliver ~20 endpoints under the new `/classroom` domain. All `@RequirePermission` and row-scoped via `ActorContextService`:

```
# Assignments (Step 4)
GET   /classes/:id/assignments
GET   /assignments/:id
POST  /classes/:id/assignments
PATCH /assignments/:id
DELETE /assignments/:id            # soft delete
GET   /classes/:id/categories
PUT   /classes/:id/categories      # bulk upsert, weights must sum to 100

# Submissions & Grading (Step 5)
POST  /assignments/:id/submit
GET   /assignments/:id/submissions          # teacher view
GET   /assignments/:id/submissions/mine     # student view
POST  /submissions/:id/grade
POST  /classes/:id/grades/batch
POST  /grades/:id/publish
POST  /classes/:id/grades/publish-all
GET   /classes/:id/gradebook                # teacher view
GET   /students/:id/gradebook               # student/parent view
POST  /classes/:id/progress-notes
GET   /students/:id/progress-notes
```

---

## Kafka events & consumer (Step 6, planned)

**Emitted (best-effort produce, untouched envelope until ADR-057 is implemented in Cycle 3 — see `KafkaProducerService` TODO):**

- `cls.grade.published` — `{ studentId, classId, assignmentId, gradeValue, maxPoints, isExtraCredit, termId }`
- `cls.grade.unpublished` — same payload
- `cls.submission.submitted` — `{ studentId, assignmentId, submittedAt }`
- `cls.progress_note.published` — `{ studentId, classId, termId }`

**Consumed (first consumer in the system):**

- `GradebookSnapshotWorker` consumes `cls.grade.published` and `cls.grade.unpublished`. Debounces 30s per `(class_id, student_id)`. Recomputes weighted average from published grades and category weights, upserts `cls_gradebook_snapshots`. Idempotent via `platform_event_consumer_idempotency` (Cycle 0).

This worker establishes the consumer pattern (KafkaConsumerService, topic subscription, idempotency table check, debounce queue) that Cycle 3 (Communications) will reuse for notification delivery.

---

## Step 1 — Classroom schema, lessons & assignments

### Migration file

`packages/database/prisma/tenant/migrations/005_cls_lessons_and_assignments.sql`. 7 tables. Idempotent CREATE-IF-NOT-EXISTS pattern matching Cycle 1 migrations. Snake_case columns, TEXT+CHECK enums, soft FKs to `platform.*` and to not-yet-built modules (`hr_employees`, lesson bank).

### Detailed tables — see "Schema changes" section above.

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/database provision --subdomain=demo
# → Applying: 001..005, 5 migration(s) applied. Idempotent re-run is a no-op.
pnpm --filter @campusos/database provision --subdomain=test
# → same.
```

7 new `cls_*` tables in `tenant_demo` (verified):

```
cls_answer_key_entries
cls_assignment_categories
cls_assignment_questions
cls_assignment_types
cls_assignments
cls_lesson_types
cls_lessons
```

10 intra-tenant FKs resolved cleanly:

```
cls_answer_key_entries.question_id     → cls_assignment_questions(id)  ON DELETE CASCADE
cls_assignment_categories.class_id     → sis_classes(id)               ON DELETE CASCADE
cls_assignment_questions.assignment_id → cls_assignments(id)           ON DELETE CASCADE
cls_assignments.assignment_type_id     → cls_assignment_types(id)
cls_assignments.category_id            → cls_assignment_categories(id)
cls_assignments.class_id               → sis_classes(id)               ON DELETE CASCADE
cls_assignments.grading_scale_id       → grading_scales(id)            (Cycle 0 tenant table)
cls_assignments.lesson_id              → cls_lessons(id)
cls_lessons.class_id                   → sis_classes(id)               ON DELETE CASCADE
cls_lessons.lesson_type_id             → cls_lesson_types(id)
```

Zero cross-schema FKs from `tenant_demo` to anywhere else (ADR-001/020):

```sql
SELECT count(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class r ON r.oid = c.confrelid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
JOIN pg_namespace rn ON rn.oid = r.relnamespace
WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
-- result: 0
```

Tenant base table count: **30** (5 Cycle 0 + 18 Cycle 1 SIS + 7 Cycle 2 Step 1). Plus 36 partition objects under `sis_attendance_records`. Cycle 1 SIS seed (`pnpm --filter @campusos/database seed:sis`) re-runs cleanly against the new schema (idempotent, "SIS data already seeded — skipping").

### Out-of-scope decisions for Step 1

- **`cls_lessons` is created but the lesson API is minimal in this cycle.** Per the plan, full TCH-001 lesson planning lands in a later cycle. The table exists so assignments can reference it (`cls_assignments.lesson_id`) and so the schema is complete from the start.
- **`bank_lesson_id` column added without a referenced table.** Lesson bank is a future module; the column is nullable and unconstrained (soft ref).
- **No FKs into `platform.grading_scales`.** Per ADR-001/020 the cross-schema reference is soft. App layer (Step 4 onward) validates the lookup.

---

## Step 2 — Classroom schema, submissions & grading

### Migration file

`packages/database/prisma/tenant/migrations/006_cls_submissions_and_grading.sql`. 8 tables. Idempotent CREATE-IF-NOT-EXISTS pattern. TEXT+CHECK enums (status enums, AI confidence range, grade-value floor, effort rating). 18 intra-tenant FKs; zero soft refs to `platform.*` (the only soft refs are `teacher_id`, `author_id`, `finalized_by` → `hr_employees` — a tenant module that doesn't exist yet, kept as plain UUIDs for forward compatibility per ADR-001/020).

Detailed tables — see `006_cls_submissions_and_grading.sql` schema-changes section above.

### Step 2 verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 6 migrations, idempotent
pnpm --filter @campusos/database provision --subdomain=test   # same
```

15 `cls_*` tables in `tenant_demo` (Steps 1+2 combined):

```
cls_ai_grading_jobs              (Step 2)
cls_answer_key_entries           (Step 1)
cls_assignment_categories        (Step 1)
cls_assignment_questions         (Step 1)
cls_assignment_types             (Step 1)
cls_assignments                  (Step 1)
cls_gradebook_snapshots          (Step 2)
cls_grades                       (Step 2)
cls_lesson_types                 (Step 1)
cls_lessons                      (Step 1)
cls_report_card_entries          (Step 2)
cls_report_cards                 (Step 2)
cls_student_progress_notes       (Step 2)
cls_submission_question_grades   (Step 2)
cls_submissions                  (Step 2)
```

18 intra-tenant FKs from the new Step 2 tables:

```
cls_ai_grading_jobs.submission_id              → cls_submissions(id)            ON DELETE CASCADE
cls_gradebook_snapshots.class_id               → sis_classes(id)                ON DELETE CASCADE
cls_gradebook_snapshots.student_id             → sis_students(id)
cls_gradebook_snapshots.term_id                → sis_terms(id)
cls_grades.assignment_id                       → cls_assignments(id)
cls_grades.student_id                          → sis_students(id)
cls_grades.submission_id                       → cls_submissions(id)
cls_report_card_entries.report_card_id         → cls_report_cards(id)           ON DELETE CASCADE
cls_report_cards.class_id                      → sis_classes(id)
cls_report_cards.student_id                    → sis_students(id)
cls_report_cards.term_id                       → sis_terms(id)
cls_student_progress_notes.class_id            → sis_classes(id)                ON DELETE CASCADE
cls_student_progress_notes.student_id          → sis_students(id)
cls_student_progress_notes.term_id             → sis_terms(id)
cls_submission_question_grades.question_id     → cls_assignment_questions(id)   ON DELETE CASCADE
cls_submission_question_grades.submission_id   → cls_submissions(id)            ON DELETE CASCADE
cls_submissions.assignment_id                  → cls_assignments(id)            ON DELETE CASCADE
cls_submissions.student_id                     → sis_students(id)
```

**Zero cross-schema FKs** (ADR-001/020) — verified via the same `pg_constraint` join used in REVIEW-CYCLE1:

```sql
SELECT count(*) FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class r ON r.oid = c.confrelid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
JOIN pg_namespace rn ON rn.oid = r.relnamespace
WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
-- result: 0
```

**CHECK constraints fire as expected** (smoke-tested 2026-04-27):

| Constraint                              | Test                                 | Outcome  |
| --------------------------------------- | ------------------------------------ | -------- |
| `cls_submissions_status_chk`            | INSERT status='BOGUS'                | ERROR ✅ |
| `cls_ai_grading_jobs_ai_conf_chk`       | INSERT ai_confidence=1.5             | ERROR ✅ |
| `cls_grades_value_chk`                  | INSERT grade_value=-5                | ERROR ✅ |
| `cls_student_progress_notes_effort_chk` | INSERT overall_effort_rating='BOGUS' | ERROR ✅ |

**Tenant base table count: 38** (5 Cycle 0 + 18 Cycle 1 + 15 Cycle 2 Steps 1–2). Re-running provision is a no-op (idempotency confirmed). Cycle 1 SIS seed re-runs cleanly.

### Out-of-scope decisions for Step 2

- **No partitioning on `cls_grades` or `cls_submissions`.** Volume in Cycle 2 is bounded (one row per (assignment, student); ~12 assignments × 15 students = 180 rows in the seed). Partitioning is appropriate for `sis_attendance_records` (one row per student × period × school day) but overkill here. Revisit in Wave 2 if the table grows past O(10⁷).
- **`cls_ai_grading_jobs` allows multiple jobs per submission.** Re-running the AI is plausible (model change, retry on FAILED), so no UNIQUE on `submission_id`. The partial index `(status) WHERE status IN ('PENDING','RUNNING')` keeps the worker queue scan cheap.
- **`cls_grades.submission_id` is nullable.** A teacher can record a grade for an assignment a student never submitted (e.g. zero-grade for missed work, or paper-based assignments). The submission FK is informational; the teacher-action grade stands alone.
- **`cls_report_card_entries.subject` is free text, not a FK to `sis_courses`.** Per the plan: report cards label subjects in ways that don't always map 1:1 to courses (e.g. "Mathematics" combining Algebra + Geometry rows). Deliberate design choice from the ERD.
- **No triggers.** ADR-010 (snapshots async-only) is enforced by the schema layout (no FK or trigger from `cls_grades` to `cls_gradebook_snapshots`) plus a service-layer rule, not by a `BEFORE INSERT` trigger that could be bypassed.

---

## Step 3 — Seed data — assignments & grades

### Files

- `packages/database/src/seed-classroom.ts` (new) — idempotent classroom seeder, mirrors the structure of `seed-sis.ts`.
- `packages/database/package.json` — added `seed:classroom` script (`tsx src/seed-classroom.ts`).
- `packages/database/src/seed-iam.ts` — added Teacher `TCH-004:read+write`, Parent `TCH-002:read`, Student `TCH-004:read`. (Student already had `TCH-002:read+write` from Cycle 1; intentionally left in place — see "Permission catalogue updates" above.)

### What gets seeded

| Table                        | Rows | Notes                                                                                                                                    |
| ---------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `grading_scales`             |    1 | "Standard A-F (Percentage)", `is_default=true`, JSON grade buckets A≥90 / B≥80 / C≥70 / D≥60 / F<60.                                     |
| `cls_assignment_types`       |    5 | Homework, Quiz, Test, Project, Classwork — one of each per school. Each `weight_in_category=100`.                                        |
| `cls_assignment_categories`  |   18 | 3 per class × 6 classes: Homework (30) / Assessments (50) / Participation (20). Weights sum to 100 per class (validated at app layer).   |
| `cls_assignments`            |   12 | 2 per class. All `is_published=true`. Mix of Quiz / Test / Project / Homework. Due dates spread Feb–Apr 2026.                            |
| `cls_submissions`            |   80 | One per (assignment, enrolled student) for fully-graded assignments (41); partial assignments drop one submission per period 1 / 5 (39). |
| `cls_grades`                 |   62 | All 41 fully-graded submissions get a published grade; 21 of the 39 partial submissions get graded, of which 12 are published.           |
|   ↳ `is_published=true`      |   53 | Used by snapshot computation.                                                                                                            |
|   ↳ `is_published=false`     |    9 | Draft grades on partial-graded assignments — exercises the publish/unpublish path that Step 5 will build.                                |
| `cls_gradebook_snapshots`    |   41 | One per (class, student, term=Spring 2026) where the student has at least one published grade. Weighted by category.                    |
| `cls_student_progress_notes` |    1 | Maya in P1 Algebra 1, term=Spring 2026, `overall_effort_rating='GOOD'`, `is_parent_visible=true`, `is_student_visible=true`.             |

### Weighted-average math (snapshot computation)

For each (class, student) with ≥1 published grade:

1. Group published grades by category. For each category, take the simple mean of `(grade_value / max_points × 100)`.
2. Weight each category by its declared `weight` and **renormalise** by the sum of weights for categories with at least one grade. Categories with zero published grades are excluded from both numerator and denominator (rather than counted as 0%).
3. Letter grade derived from the resulting average using the same A/B/C/D/F bucketing as the grading scale.

This is the same formula the Step 6 Kafka snapshot worker will implement; seed and worker MUST agree, so the algorithm is encoded in `seed-classroom.ts::seedClassroom` (the loop after the per-class grades query) and the Step 6 worker will port it verbatim.

### Determinism

Per-(student, assignment) percentages come from a hash on the SIS `student_number` + assignment index, mapped into the 70–98 range. Maya is overridden with a hand-picked 87–94 sequence so her parent-dashboard story shows a clean B+/A- across her four enrolled classes. Re-running on a clean tenant always produces identical numbers.

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/database seed:classroom
# →  1 grading_scale (Standard A-F)
# →  5 cls_assignment_types
# →  18 cls_assignment_categories (3 per class, weights 30/50/20)
# →  12 cls_assignments (12, 2 per class, all is_published=true)
# →  80 cls_submissions
# →  62 cls_grades (53 published, 9 draft)
# →  41 cls_gradebook_snapshots
# →  1 cls_student_progress_notes (Maya, P1 Algebra 1, parent + student visible)

pnpm --filter @campusos/database seed:classroom   # idempotent re-run
# → "Classroom data already seeded (12 cls_assignments rows) — skipping"
```

Maya's snapshots (verified end-to-end against the raw grade table):

| Period | Class            | Snapshot avg | Letter | Graded / Total |
| -----: | ---------------- | -----------: | :----: | -------------: |
|      1 | Algebra 1        |        90.50 | A      |          2 / 2 |
|      2 | English 9        |        92.00 | A      |          2 / 2 |
|      3 | Biology          |        89.75 | B      |          2 / 2 |
|      4 | World History    |        90.00 | A      |          2 / 2 |

Manual recomputation of P1 Algebra 1 from the raw grades:

```
Assessments (weight 50): 1 grade @ 92.00%  →  cat avg 92.00
Homework    (weight 30): 1 grade @ 88.00%  →  cat avg 88.00
weighted = (50 × 92 + 30 × 88) / (50 + 30) = (4600 + 2640) / 80 = 90.50  ✓ matches snapshot
```

Letter-grade distribution across the 41 snapshots: 11 A, 18 B, 12 C, 0 D, 0 F (no F because the deterministic generator floors at 70 %; D would require ≤ 69 %).

### Permission cache (rebuilt after Step 3)

```
admin@demo.campusos.dev     → 444 permissions
principal@demo.campusos.dev → 444 permissions
teacher@demo.campusos.dev   →  27 permissions   (was 25 before Step 3 — added tch-004:read, tch-004:write)
student@demo.campusos.dev   →  14 permissions   (was 13 — added tch-004:read)
parent@demo.campusos.dev    →  11 permissions   (was 10 — added tch-002:read)
```

### Out-of-scope decisions for Step 3

- **No lessons seeded.** `cls_lessons` table is created but the lesson API is minimal in this cycle (per Step 1 out-of-scope decision); seeding lesson rows would just be dead data. `cls_assignments.lesson_id` is left NULL.
- **No assignment questions / answer keys seeded.** Per the plan, questions / answer keys / AI-grading-jobs / per-question grades are exercised by the API tests in Step 5, not by the seed. Seeding them now would lock us into a UX choice (essay vs. MC vs. file upload) that the UI step (7) hasn't made yet.
- **Submissions hold plain `submission_text='Submitted via portal.'`** No real attachments. Step 7 may upgrade this when it ships the submit form.
- **No FAILED `cls_ai_grading_jobs` rows.** AI grading service is forward-compat-only this cycle; seeding the job table would be misleading.
- **No report cards seeded.** Report-card generation is a Wave 1 backlog item (the schema exists for forward compatibility, but neither Step 5 nor Step 6 build the API). The first published report cards will land in a later cycle.
- **No deterministic D / F grades.** The seed's percentage range floors at 70 to keep the demo cheerful; if a future review wants edge cases, lower the floor in `pickPercentage` to 50 and adjust Maya's overrides.

---

## Step 4 — Classroom NestJS module — assignments

### Files

- `apps/api/src/classroom/classroom.module.ts` — wires `AssignmentService`, `CategoryService`, `AssignmentController`, `CategoryController`. Imports `TenantModule` and `IamModule`.
- `apps/api/src/classroom/assignment.service.ts` — list / getById / create / update / softDelete; per-class read+write authorisation helpers (`assertCanReadClass`, `assertCanWriteClass`, `isClassManager`).
- `apps/api/src/classroom/category.service.ts` — list / atomic upsert (validate sum=100, replace by name, FK-restrict surfaces as 409).
- `apps/api/src/classroom/assignment.controller.ts` — 5 endpoints (`/classes/:id/assignments` GET+POST, `/assignments/:id` GET+PATCH+DELETE).
- `apps/api/src/classroom/category.controller.ts` — 2 endpoints (`/classes/:id/categories` GET+PUT).
- `apps/api/src/classroom/dto/assignment.dto.ts`, `dto/category.dto.ts` — DTOs (class-validator).
- `apps/api/src/app.module.ts` — `ClassroomModule` added to imports (in module order: SIS → Attendance → Classroom).

### Endpoints landed (7)

| Method | Path                                    | Permission         | Notes                                                                            |
| ------ | --------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| GET    | `/classes/:classId/assignments`         | `tch-002:read`     | Row-scoped. `?includeUnpublished=true` honoured only for managers (teacher/admin). |
| GET    | `/assignments/:id`                      | `tch-002:read`     | Row-scoped. Students/parents only see published, non-deleted rows.               |
| POST   | `/classes/:classId/assignments`         | `tch-002:write`    | Teacher-of-class or admin only. Validates `assignmentTypeId`, `categoryId`.       |
| PATCH  | `/assignments/:id`                      | `tch-002:write`    | Partial update. Teacher-of-class or admin.                                       |
| DELETE | `/assignments/:id`                      | `tch-002:write`    | Soft delete (`deleted_at = now()`). Returns 204.                                 |
| GET    | `/classes/:classId/categories`          | `tch-002:read`     | Row-scoped read of `cls_assignment_categories`.                                  |
| PUT    | `/classes/:classId/categories`          | `tch-002:write`    | Atomic replace by name. Weights MUST sum to 100. 409 if removed-but-still-referenced. |

### Authorisation semantics (Step 4)

- **Read row scope** (`assertCanReadClass` + `canReadClass`):
  - Admin → any class in school.
  - Teacher (STAFF) → must appear in `sis_class_teachers` for the class.
  - Student → must have an active `sis_enrollments` row for the class (joined through `platform_students.person_id`).
  - Guardian → at least one linked child must have an active enrollment in the class.
  - Other → 404.
- **Manager view** (`isClassManager`) — admins + teachers-of-class. Drives whether `?includeUnpublished=true` is honoured and whether draft (non-`is_published`) rows surface in list/get.
- **Write row scope** (`assertCanWriteClass`) — admin OR teacher-of-class only. The student `tch-002:write` permission (held so the Step 5 submit endpoint can pass) hits 403 here, exactly mirroring the Cycle 1 attendance pattern: endpoint permission is the floor, link-table membership is the actual gate.

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/api build       # nest build → exits 0
pnpm --filter @campusos/api start       # API boots, all 7 routes mapped
```

Smoke matrix (full curl trace in this commit's working notes — boiled down here):

| # | Scenario                                                                        | Expected | Got |
| - | ------------------------------------------------------------------------------- | -------- | --- |
| 1 | Teacher GET `/classes/:id/assignments` for assigned class                       | 2 rows   | ✅  |
| 2 | Teacher GET `/classes/:id/categories`                                           | 3 rows (30/50/20) | ✅ |
| 3 | Teacher POST draft assignment                                                   | 201, `isPublished=false`  | ✅ |
| 4 | Student GET draft by id                                                         | 404      | ✅  |
| 5 | Student GET `/classes/:id/assignments` (draft hidden)                           | 2 rows, no draft | ✅ |
| 6 | Teacher PATCH `{isPublished:true}`                                              | 200      | ✅  |
| 7 | Student GET after publish                                                       | 200      | ✅  |
| 8 | Parent GET after publish                                                        | 200      | ✅  |
| 9 | Teacher DELETE                                                                  | 204      | ✅  |
| 10 | Student GET deleted assignment                                                 | 404      | ✅  |
| 11 | Teacher list `?includeUnpublished=true` after delete                            | soft-deleted hidden | ✅ |
| 12 | Student POST assignment (has `tch-002:write` but no class membership)           | 403      | ✅  |
| 13 | Admin (principal) POST assignment in any class                                  | 201      | ✅  |
| 14 | Categories PUT with weights summing to 110                                      | 400      | ✅  |
| 15 | Categories PUT removing a category still referenced by an assignment            | 409      | ✅  |
| 16 | Categories PUT valid rebalance (25/55/20)                                       | 200, returns 3 rows | ✅ |

Test data was cleaned up afterwards; P1 weights restored to 30/50/20 to keep the seed snapshot math intact.

### Out-of-scope decisions for Step 4

- **No questions / answer-key endpoints in this step.** `cls_assignment_questions` and `cls_answer_key_entries` exist in the schema (Step 1) but aren't user-facing yet — Step 5 (Submissions & Grading) will need read access to questions, but write CRUD for them ships when the assignment-builder UI lands in Step 7.
- **No bulk assignment-type CRUD.** `cls_assignment_types` is school-wide config seeded once. The Cycle 2 plan doesn't require an admin endpoint for editing types; revisit if Phase 2 polish surfaces a need.
- **Soft delete is intentionally simple — no `restore` endpoint.** Once `deleted_at` is set, the only way to bring a row back is by hand (DB or a future admin tool). Listing already-deleted rows isn't supported either; if the teacher needs to "undelete" they should re-create. Keep this surface minimal until product asks for more.
- **`@Controller()` (no path) on `AssignmentController`.** Some endpoints sit under `/classes/:classId/assignments` and others under `/assignments/:id` — keeping both in one controller mirrors the attendance controller's mixed routing, but with a bare base path so the per-method `@Get/@Post/...` strings are explicit. CategoryController stays under `/classes` since both its routes share that prefix.
- **PUT-by-name semantics for categories.** The PUT body is the new full set; rows whose name disappears are deleted via FK RESTRICT (409 if still referenced). Alternative `PATCH` semantics (partial update) and bulk reassignment of orphaned assignments are left to a future admin tool.
- **`isClassManager` runs an extra DB query per call.** Could be folded into `ResolvedActor` if the Step 5 services repeat the pattern; keeping it local to AssignmentService for now to avoid premature abstraction.

---

## Step 5 — Classroom NestJS module — submissions & grading

### Files

- `apps/api/src/classroom/submission.service.ts` — submit / list-roster / list-mine / getById; resolves the calling student's `sis_students.id` via `platform_students.person_id`; idempotent upsert by `(assignment_id, student_id)`; per-class write gate.
- `apps/api/src/classroom/grade.service.ts` — single grade, batch grade, publish, unpublish, publish-all-for-assignment; ADR-010 enforced (no snapshot writes); emits `cls.grade.published` / `cls.grade.unpublished`; auto-bumps the linked submission to `GRADED`.
- `apps/api/src/classroom/gradebook.service.ts` — per-class teacher view + per-student row-scoped view; resolves a default term when none supplied.
- `apps/api/src/classroom/progress-note.service.ts` — upsert by `(class_id, student_id, term_id)`; persona-scoped read (students see only `is_student_visible=true` AND `published_at IS NOT NULL`; parents `is_parent_visible`; teachers see notes for their classes; admins see all).
- `apps/api/src/classroom/submission.controller.ts`, `grade.controller.ts`, `gradebook.controller.ts`, `progress-note.controller.ts` — 12 new endpoints; all `@RequirePermission`-gated; row-level auth in services.
- `apps/api/src/classroom/dto/submission.dto.ts`, `grade.dto.ts`, `gradebook.dto.ts`, `progress-note.dto.ts` — class-validator DTOs + response shapes.
- `apps/api/src/classroom/classroom.module.ts` — wires the four new services + four new controllers; imports `KafkaModule` so services can emit events.

### Endpoints landed (12)

| Method | Path                                          | Permission        | Notes                                                                                                                                                  |
| ------ | --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/assignments/:id/submit`                     | `tch-002:write`   | Student-only (403 for non-students). Idempotent upsert; resubmit overwrites text + flips status back to `SUBMITTED`. Emits `cls.submission.submitted`. |
| GET    | `/assignments/:id/submissions`                | `tch-002:read`    | Teacher / admin only — combines roster + submissions so `NOT_STARTED` rows surface as empty placeholders. Includes counters.                            |
| GET    | `/assignments/:id/submissions/mine`           | `tch-002:read`    | Student-only. Returns the calling student's submission for the assignment, or `null` if not submitted yet. Hides draft grades.                          |
| GET    | `/submissions/:id`                            | `tch-002:read`    | Single-row read. Visible to admins, teacher-of-class, owning student, linked guardian. Hides draft grade fields for non-managers.                       |
| POST   | `/submissions/:id/grade`                      | `tch-003:write`   | Teacher-of-class / admin only. Upserts `cls_grades` by `(assignment, student)`, flips submission to `GRADED`. `publish=true` → emits `cls.grade.published`. |
| POST   | `/classes/:id/grades/batch`                   | `tch-003:write`   | Single transaction across many entries. Validates each `studentId` is actively enrolled. Emits one event per published row (after commit).             |
| POST   | `/grades/:id/publish`                         | `tch-003:write`   | Idempotent. Emits `cls.grade.published` only on the draft → published transition.                                                                       |
| POST   | `/grades/:id/unpublish`                       | `tch-003:write`   | Sets `is_published=false`; keeps `published_at` for audit. Emits `cls.grade.unpublished`.                                                              |
| POST   | `/classes/:id/grades/publish-all`             | `tch-003:write`   | Body `{assignmentId}`. Bulk-publishes every draft on that assignment in a single tx. Emits one event per row that transitioned.                         |
| GET    | `/classes/:id/gradebook`                      | `tch-003:read`    | Teacher / admin view. Roster joined to `cls_gradebook_snapshots` for the resolved term (defaults to current term, then most-recent fallback).            |
| GET    | `/students/:id/gradebook`                     | `tch-003:read`    | Per-student view. Row-scope: admins; self-student; linked guardian; teacher-of-any-enrolled-class. Returns enrolled classes × snapshots.                |
| POST   | `/classes/:id/progress-notes`                 | `tch-003:write`   | Teacher-of-class / admin. Idempotent upsert by `(class_id, student_id, term_id)`. Always sets `published_at=now()`. Emits `cls.progress_note.published`. |
| GET    | `/students/:id/progress-notes`                | `tch-003:read`    | Persona-scoped: admins all rows, teachers their classes' rows, students/parents only published rows where the matching visibility flag is `true`.       |

(13 routes; `GET /submissions/:id` is the only one not on the original plan list — added because it's the natural sibling for the post-grade response payload and enforces the same row-scope as the assignment-level reads.)

### Authorisation semantics (Step 5)

- **Submit (`POST /assignments/:id/submit`)** — caller must be a `STUDENT` with a `sis_students` row in this tenant AND an `ACTIVE` `sis_enrollments` row in the assignment's class. Anything else throws 403. The `tch-002:write` permission is held by all four personas (teacher / parent / student / admin) but only students reach the upsert; non-student callers fail the personType check.
- **List-mine (`/submissions/mine`)** — same student check as submit. Returns `null` (200) when the student is enrolled but hasn't submitted.
- **Teacher list (`/assignments/:id/submissions`)** — uses `assignmentService.assertCanWriteClass(classId, actor)` so the matrix is admin OR teacher-of-class. Students/parents → 403 even though they hold `tch-002:read`.
- **Single-submission read (`/submissions/:id`)** — admins; teacher of the class; owning student (matched via `platform_students.person_id`); linked guardian via `sis_student_guardians`. Anything else returns 404 (deliberately collapsed with not-found so the API can't probe submission ids).
- **Draft-grade leak fix.** `cls_grades` rows with `is_published=false` are **never** rendered in the response when the actor is not a teacher-of-class / admin. The `rowToDto(row, includeDraftGrade)` flag is the single point of truth for this — student `mine` view always passes `false`, manager teacher view always passes `true`, single-row `getById` resolves the manager flag at request time.
- **Grade writes (`/submissions/:id/grade`, `/classes/:id/grades/batch`, `/grades/:id/publish`, etc.)** — gated on teacher-of-class / admin (same `assertCanWriteClass` pattern as the assignment writes from Step 4). The `cls_grades.teacher_id` column is filled with `actor.personId` (the calling teacher's `iam_person.id`); HR is a future module so this is a soft ref by design.
- **Gradebook (class)** — `assignmentService.assertCanReadClass(classId, actor)` — admin / teacher-of-class / enrolled student / linked guardian. Students and parents see the full class roster + averages; this is intentional and matches the parent-portal expectation that class context is visible.
- **Gradebook (student)** — admin / self-student / linked guardian / teacher-of-any-enrolled-class. Anything else returns 404 (mirrors `student.service.ts::assertCanViewStudent`).
- **Progress notes write** — teacher-of-class / admin. `body.studentId` must have an `ACTIVE` enrollment in the class.
- **Progress notes read** — persona-scoped at the SQL layer, not just the row layer: students/parents only get rows where the matching `is_*_visible=true` AND `published_at IS NOT NULL`.

### Kafka events emitted (Step 5)

| Topic                          | Key            | Payload (raw — ADR-057 envelope is Cycle 3)                                                                                                              |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cls.submission.submitted`     | `studentId`    | `{ submissionId, assignmentId, classId, studentId, submittedAt }`                                                                                        |
| `cls.grade.published`          | `studentId`    | `{ gradeId, assignmentId, classId, studentId, gradeValue, maxPoints, letterGrade, isExtraCredit, termId, publishedAt }`                                  |
| `cls.grade.unpublished`        | `studentId`    | `{ gradeId, assignmentId, classId, studentId, gradeValue, maxPoints, letterGrade, isExtraCredit, termId, unpublishedAt }`                                |
| `cls.progress_note.published`  | `studentId`    | `{ noteId, classId, studentId, termId, isParentVisible, isStudentVisible, authorId, publishedAt }`                                                       |

All emits are best-effort (`KafkaProducerService.emit` swallows broker errors). Step 6 wires the `cls.grade.{published,unpublished}` consumer (gradebook snapshot worker).

### ADR-010 enforcement

The grade write path (single + batch + publish + unpublish + publish-all) **never** reads or writes `cls_gradebook_snapshots`. This was verified end-to-end in the smoke matrix: after Test 11 (batch-graded all 8 P1 students with new values, all published), the snapshot table count was 41 and 0 rows had `last_updated_at` within the last 15 minutes. Snapshots stay in seed state until the Step 6 consumer recomputes them off the Kafka topic.

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/api build       # nest build → exits 0
pnpm --filter @campusos/api start:prod  # all 19 classroom routes mapped, Kafka connected
```

Smoke matrix (full curl trace stored in this commit's working notes — boiled down here):

| #  | Scenario                                                                                                  | Expected                            | Got |
| -- | --------------------------------------------------------------------------------------------------------- | ----------------------------------- | --- |
| 1  | Teacher GET `/assignments/:id/submissions` for a fully-graded assignment                                  | rosterSize=8 / submitted=8 / graded=8 / published=8 | ✅ |
| 2  | Student (Maya) GET `/assignments/:id/submissions/mine` for the same assignment                            | status=GRADED, gradeValue=92        | ✅  |
| 3  | Student GETs the teacher list (held `tch-002:read`)                                                       | 403                                 | ✅  |
| 4  | Teacher POSTs a new published assignment in P1                                                            | 201                                 | ✅  |
| 5  | Student submits to the new assignment                                                                     | 201, status=SUBMITTED               | ✅  |
| 6  | Student resubmits — same submission id, fresh `submittedAt`                                               | id matches                          | ✅  |
| 7  | Teacher posts a draft grade (`publish=false`)                                                             | percentage=90, isPublished=false    | ✅  |
| 8  | Student fetches own submission                                                                            | grade hidden (draft)                | ✅  |
| 8b | Teacher fetches teacher view                                                                              | grade visible (draft)               | ✅  |
| 9  | Teacher publishes the draft grade                                                                         | isPublished=true, emits `cls.grade.published` | ✅ |
| 10 | Student fetches own submission again                                                                      | grade visible (published)           | ✅  |
| 11 | Teacher batch-grades 8 P1 students with `publish=true`                                                    | inserted=4, updated=4, published=8  | ✅  |
| 12 | Teacher class gradebook                                                                                   | 8 rows joined to seed snapshots     | ✅  |
| 13 | Maya student gradebook                                                                                    | 4 enrolled classes, all snapshots populated | ✅ |
| 14 | Parent David Chen gets Maya's gradebook                                                                   | 200, 4 rows                         | ✅  |
| 15 | Stranger student / parent gradebook attempt                                                               | 404 (both)                          | ✅  |
| 16 | Teacher writes a progress note for Maya                                                                   | upsert ok, publishedAt set          | ✅  |
| 17 | Maya reads her own notes                                                                                  | count=1, visibility flags both true | ✅  |
| 18 | Parent David reads Maya's notes                                                                           | count=1                             | ✅  |
| 19 | Stranger student `GET /students/:id/progress-notes`                                                       | 404                                 | ✅  |
| 20 | Student → `POST /submissions/:id/grade`                                                                   | 403 (no `tch-003:write`)            | ✅  |
| 21 | Teacher grades > max_points on a non-extra-credit assignment                                              | 400                                 | ✅  |
| 22 | Batch-grade with assignment that doesn't belong to URL class                                              | 400                                 | ✅  |
| 23 | Student submits to an unpublished assignment                                                              | 404                                 | ✅  |
| 24 | Re-publish an already-published grade                                                                     | 200 idempotent (publishedAt unchanged) | ✅ |
| 25 | Unpublish a published grade                                                                               | 200, isPublished=false              | ✅  |

All 25 cases passed. Smoke artefacts were rolled back by re-provisioning + re-running `seed:sis` + `seed:classroom` so the seed snapshot count (41) and grade count (62 / 53 published) match the Step 3 baseline.

### Out-of-scope decisions for Step 5

- **No `IN_PROGRESS` save-as-draft for submissions.** Students go straight from `NOT_STARTED` → `SUBMITTED`. Auto-save is a Phase 2 polish item; the column exists in the schema but no endpoint writes it.
- **No `RETURNED` workflow.** Teachers can't formally return a submission for revision in this cycle. The status enum allows it for forward compatibility but no endpoint sets it. Add `POST /submissions/:id/return` when the UI step asks for it.
- **No question-level grading endpoints.** `cls_submission_question_grades` and `cls_ai_grading_jobs` exist (Step 2) but no endpoint reads or writes them. Per-question grading + AI suggestions land when the assignment-builder UI does (later cycle).
- **`cls_grades.teacher_id` is filled with `actor.personId`, not an HR employee id.** HR module isn't in this cycle; the column is a soft UUID per ADR-001/020 so this is fine. When HR lands, the assignment will become an `iam_person → hr_employees` lookup.
- **Snapshots not recomputed inline.** ADR-010. The seed's snapshot rows reflect the seed-time state. Until the Step 6 consumer is wired, batch-grading new rows leaves the snapshot stale (intentional). Tests 11–14 confirm this — Maya's snapshot stays at 90.5 even after the P1 batch grade.
- **No row-scope on `GET /grades/:id`.** That endpoint is **not** exposed — single-grade reads happen via the response payload of grade writes / publishes. Avoiding it sidesteps the question of how to gate a single-grade read across personas.
- **`canSeeSubmission` includes guardians via the seed-tested path.** Linked guardians can read their child's `/submissions/:id` even though the original plan only mentioned student/teacher views. This is consistent with how parents see attendance records (Cycle 1) and matches portal expectations.
- **Default-letter derivation lives in `grade.service.ts::deriveLetter`, not in `grading_scales`.** Reading the scale JSON would couple write-time grading to a tenant config row; for now we hard-code the same A/B/C/D/F bucketing the seed uses. When the scale becomes editable (Phase 2), replace this with a lookup against the assignment's `grading_scale_id`.
- **`PublishAllBodyDto` (in `grade.controller.ts`) is defined inline.** It only carries an `assignmentId` so it doesn't justify a dedicated DTO file. Promote to `dto/grade.dto.ts` if it grows fields.
- **Term resolution defaults to "current today, then most recent."** No tenant config flag for "use the academic year's last term." Phase 2 polish if the demo tenant ever has overlapping terms.
- **Snapshots, report cards, and AI grading remain forward-compat tables only.** Step 6 will start reading from the snapshot side; report cards + AI grading are post-Cycle-2.

---

## Step 6 — Kafka events & gradebook snapshot worker

First Kafka consumer in CampusOS. Establishes the consumer pattern (subscribe + idempotency-claim + handler) that Cycle 3 (Communications) will reuse for notification delivery.

### Files

- `apps/api/src/kafka/kafka-consumer.service.ts` (new) — `KafkaConsumerService`. Subscribe-by-group registry. `subscribe({ topics, groupId, handler, fromBeginning })` opens its own kafkajs `Consumer`, runs `eachMessage` against the supplied handler, and flattens `Buffer` headers into a `Record<string,string>` so handlers don't deal with binary plumbing. Best-effort connection: if the broker is unreachable on boot, the service logs a warning and silently no-ops; subsequent emits keep working in producer-only mode.
- `apps/api/src/kafka/idempotency.service.ts` (new) — `IdempotencyService`. Wraps `platform.platform_event_consumer_idempotency`. `claim(consumerGroup, eventId, topic)` returns `true` on first sight, `false` on re-delivery (catches `23505` unique violation against `(consumer_group, event_id)`). Uses the platform Prisma client directly — no tenant search_path required since this table is shared.
- `apps/api/src/kafka/kafka.module.ts` — now exports `KafkaProducerService`, `KafkaConsumerService`, `IdempotencyService`. Imports `TenantModule` so the idempotency service can reach the platform client.
- `apps/api/src/classroom/gradebook-snapshot-worker.service.ts` (new) — `GradebookSnapshotWorker`. NestJS provider; subscribes during `onModuleInit`. Owns the per-(schoolId, classId, studentId) debounce map. The recompute path matches `seed-classroom.ts` verbatim so the seed's snapshot baseline (90.50 for Maya in P1, etc.) is preserved across the first event. Includes a `flushAllForTest()` test seam so future integration tests can avoid a 30s wait.
- `apps/api/src/classroom/classroom.module.ts` — registers `GradebookSnapshotWorker` as a provider + export.
- `apps/api/src/classroom/grade.service.ts` — `emitPublished` / `emitUnpublished` now pass headers `{ event-id, tenant-id, tenant-subdomain }` via the shared `tenantHeaders()` helper. `event-id` is a fresh UUIDv7 per emit; `tenant-id` and `tenant-subdomain` come from `getCurrentTenant()`. These three headers are forward-compatible with the ADR-057 envelope (Cycle 3) — when the envelope lands, they migrate from raw transport headers to envelope fields with no payload reshape.

### Architecture

```
              ┌──────────────────┐    cls.grade.{published,unpublished}    ┌──────────────────────┐
  HTTP write  │  GradeService    │ ──────────────────────────────────────▶ │ KafkaProducerService │
  (tenant ctx)│  (publish/unpub) │   payload + headers (event-id,           │  (best-effort emit)  │
              └──────────────────┘   tenant-id, tenant-subdomain)            └──────────┬───────────┘
                                                                                         │
                                                                                         ▼ Kafka topic
                                                                            ┌────────────────────────┐
                                                                            │ KafkaConsumerService   │
                                                                            │  groupId = gradebook-  │
                                                                            │  snapshot-worker       │
                                                                            └──────────┬─────────────┘
                                                                                       │ ConsumedMessage
                                                                                       ▼
                                                                            ┌────────────────────────┐
                                                                            │ GradebookSnapshotWorker│
                                                                            │  1. claim eventId      │──▶ platform_event_consumer_idempotency
                                                                            │     (skip on duplicate)│       INSERT (id, group, event, topic)
                                                                            │  2. reset/start 30s    │        — 23505 → already processed
                                                                            │     debounce timer     │
                                                                            │  3. on flush:          │
                                                                            │     runWithTenantCtx   │
                                                                            │     → executeInTenantContext
                                                                            │     → recompute        │──▶ tenant_<sd>.cls_gradebook_snapshots
                                                                            │       weighted avg     │       UPSERT (class, student, term)
                                                                            └────────────────────────┘
```

### Debounce semantics

Key = `${schoolId}|${classId}|${studentId}`. On every event:

1. **Idempotency claim first.** `IdempotencyService.claim(group, eventId, topic)` runs synchronously before the debounce reset. A redelivered duplicate fails the claim and is dropped — it can never reset the timer or trigger another recompute.
2. **Reset (or create) the 30s timer.** Distinct events for the same key (e.g. publish-all flipping 8 students at once, or rapid unpublish/republish on the same row) collapse into a single recompute that fires 30 seconds after the *last* event in the burst.
3. **Flush at timer expiry.** The flush calls `runWithTenantContextAsync` with a `TenantInfo` reconstructed from headers (schemaName = `tenant_<subdomain>`, organisationId = null, isFrozen = false). The recompute then calls `tenantPrisma.executeInTenantContext` exactly like a request-scoped service.

The 30s window is deliberate: long enough that a teacher's batch publish doesn't fan out into 8 redundant recomputes, short enough that a parent refreshing the dashboard sees the new average within ~minute-scale latency. The `unref()` on the timer means a graceful shutdown won't be blocked by a pending flush.

### Idempotency model

- Each emit gets a fresh UUIDv7 in the `event-id` header (`grade.service.ts::tenantHeaders`).
- The unique constraint `platform_event_consumer_idempotency_consumer_group_event_id_key` makes `claim` race-safe across multiple consumer instances.
- Distinct events for the same `(class, student)` each get their own idempotency row — the recompute itself is what coalesces them, not the idempotency table.
- Redelivery within the same consumer process is dropped at claim time; redelivery after a redeploy (when the in-memory debounce map is gone) is also dropped, because the idempotency row survives the restart.
- ADR-057 envelope (Cycle 3) will migrate `event-id` from a raw transport header to an envelope field; no consumer change required — the `IdempotencyService` API stays the same.

### Tenant context for the worker

The worker runs outside any HTTP request, so AsyncLocalStorage is empty when an event arrives. The grade emit path attaches the necessary tenant info to the message header:

| Header              | Source                          | Used by worker as           |
| ------------------- | ------------------------------- | --------------------------- |
| `event-id`          | `generateId()` (UUIDv7)         | idempotency `event_id`      |
| `tenant-id`         | `getCurrentTenant().schoolId`   | `TenantInfo.schoolId`       |
| `tenant-subdomain`  | `getCurrentTenant().subdomain`  | `TenantInfo.subdomain` → schemaName=`tenant_<sd>` |

At flush time the worker calls `runWithTenantContextAsync({ tenant: synthesizedTenantInfo }, ...)` — `executeInTenantContext` then runs `SET LOCAL search_path TO "tenant_<subdomain>", platform, public` on the same pinned connection it uses for request-path queries. No new tenant-isolation surface area; the existing REVIEW-CYCLE1 `SET LOCAL`-inside-tx discipline carries over verbatim.

The synthesized `TenantInfo` sets `isFrozen=false` because the producer-side guard already ran during the request that emitted the event; once the event is in flight, gradebook recomputation is part of the asynchronous cleanup of an already-authorised write. (A later cycle can revisit if `isFrozen` should be re-checked at flush time — currently it is not, and that matches the ADR-031 read-still-works guarantee for frozen tenants.)

### Recompute algorithm

Mirrors `packages/database/src/seed-classroom.ts` exactly so the seed-time baseline doesn't drift the first time a real event fires:

1. Pull every `cls_grades` row for `(class_id, student_id)` with `is_published=true`, joined to `cls_assignments` and `cls_assignment_categories`.
2. Group by category. Per-category mean of `(grade_value / max_points * 100)`.
3. `currentAverage = Σ(category_mean × category_weight) / Σ(category_weight)` over **participating** categories only — i.e. categories that have at least one published grade contribute their full weight; categories with no published grades are excluded from numerator AND denominator (rather than counted as 0%).
4. Letter grade derived via the same A≥90 / B≥80 / C≥70 / D≥60 / F<60 bucketing the seed uses.
5. `assignments_total` = count of non-deleted, published `cls_assignments` rows for the class. `assignments_graded` = count of published grades that contributed to the average.
6. Term resolution (only used when `sis_classes.term_id` is null on the class — the grade emit's `termId` is informational): today's term first, then most-recent term as fallback. Matches `gradebook.service.ts::resolveTermId`.
7. Upsert via `INSERT ... ON CONFLICT (class_id, student_id, term_id) DO UPDATE` against the `cls_gradebook_snapshots_class_student_term_uq` constraint. New row → fresh UUIDv7; update path → bumps `current_average`, `letter_grade`, `assignments_graded`, `assignments_total`, `last_grade_event_at`, `last_updated_at`.
8. Edge case: if the recompute reads zero published grades (every grade has been unpublished), the snapshot row is **deleted** rather than left as a stale 0%. Matches the parent-portal expectation that "no published grades" surfaces as "no grade yet" rather than "F".

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/api build      # nest build → exits 0
pnpm --filter @campusos/api start:prod # api boots; KafkaConsumerService ready; subscribed: groupId=gradebook-snapshot-worker topics=cls.grade.published,cls.grade.unpublished
```

Smoke matrix (full curl trace stored in this commit's working notes — boiled down here):

| #  | Scenario                                                                     | Expected                                | Got |
| -- | ---------------------------------------------------------------------------- | --------------------------------------- | --- |
| 1  | Baseline: 41 seed snapshots, 0 idempotency rows                              | 41 / 0                                  | ✅  |
| 2  | Teacher unpublishes Maya's P1 homework grade (44/50, was contributing 88%)   | event emitted, snapshot stays 90.50 for ~30s, then drops to 92.00 (only Assessments left), graded=1/2 | ✅ |
| 3  | API log: one `Snapshot recomputed` line at +30s with `avg=92.00 letter=A graded=1/2` | one log line, debounce respected | ✅ |
| 4  | Idempotency: one row in `platform_event_consumer_idempotency`                | group=gradebook-snapshot-worker, topic=cls.grade.unpublished | ✅ |
| 5  | Other students' snapshots untouched (verified by `last_updated_at`)          | 40 rows still at seed-time `2026-04-27 14:44`           | ✅ |
| 6  | Teacher re-publishes the homework grade                                       | snapshot recomputes back to 90.50 graded=2/2 ~30s later | ✅ |
| 7  | Debounce coalescing: 4 events fired in <1s on same (Maya, P1) — 2 unpub + 2 pub | exactly **one** recompute logged at +30s; final snapshot 90.50 | ✅ |
| 8  | Idempotency table after Test 7: 3 published + 3 unpublished rows total       | 6 distinct event ids                    | ✅  |
| 9  | Total snapshot count after all tests                                          | still 41 — no spurious inserts          | ✅  |

The verification ran against the live demo tenant with Kafka up. Idempotency rows were cleared after the smoke run so the next reviewer starts clean (`DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group='gradebook-snapshot-worker'` — 6 rows removed).

### Out-of-scope decisions for Step 6

- **Worker runs in-process.** `GradebookSnapshotWorker` is a NestJS provider in the API. A separate worker process is operationally cleaner for production scaling but premature for Cycle 2; the in-process worker shares the producer's Kafka client model and the request-path's tenant connection pool. When Cycle 3 (Communications) lands a second consumer, revisit whether to split workers into a dedicated process.
- **Headers, not envelope.** Step 6 ships `event-id` / `tenant-id` / `tenant-subdomain` as raw Kafka transport headers, not as an ADR-057 envelope. Other emits (`cls.submission.submitted`, `cls.progress_note.published`, all `att.*`) still ship raw payloads with no headers, matching their Cycle 1/Cycle 2 producer-only state. Cycle 3 lifts everything to the canonical envelope at once.
- **Idempotency claim before debounce.** Alternative considered: claim only the latest event id at flush time (so distinct events sharing the same debounce window cost one row instead of N). Rejected — that design lets a redelivered duplicate "into" the debounce window where it can extend the timer, masking real backpressure. Claiming on arrival keeps each event's first-time semantics independent. The cost (one row per emit instead of one per flush) is negligible.
- **No retry / DLQ.** A handler that throws is logged at error and the consumer offset advances anyway (kafkajs default for `eachMessage`). Snapshots are eventually consistent — the next event for the same `(class, student)` re-runs the recompute. A more aggressive setup (retry with backoff, DLQ on N failures) is post-Cycle 2 hardening once we have real production traffic to size the retry window against.
- **`assignments_total` excludes soft-deleted assignments.** The seed counts every assignment because the seed has no soft-deletes. The worker excludes `deleted_at IS NOT NULL` so a teacher who soft-deletes a stale assignment after grading sees the denominator drop on the next recompute. Matches the gradebook UI's "graded N of T" intuition.
- **`isFrozen` is not re-checked at flush time.** Once the event is on the wire, the originating write was already authorised. ADR-031 says reads continue to work for frozen tenants; gradebook recompute is closer to a read than a new write from the user's perspective. Revisit if a frozen-tenant scenario surfaces a need.
- **No on-startup catch-up scan.** If the worker is down for a window and grade events pile up, the consumer group reads from its last committed offset on resume — no separate "scan all snapshots and re-derive" pass. Acceptable because the seed baseline plus the next event for any drifted `(class, student)` closes the gap. A reconciliation job is post-Cycle-2 ops work.
- **`KafkaConsumerService.subscribe` opens one Consumer per call.** Could share a Consumer across multiple subscriptions but at the cost of unifying group-id semantics; per-call Consumers map cleanly onto the standard Kafka model where each independent worker owns its own group.
- **No metrics yet.** Snapshot recompute count, debounce hit rate, idempotency dedupe rate — all great Prometheus targets and all explicitly out of scope for this step. The structured `Snapshot recomputed: …` log line is the only observability surface for now.

---

## Step 7 — Teacher Assignments UI

Lands the teacher-facing assignment management UI on top of the Step 4 API. Same Cycle 1 visual language (PageHeader, Modal, Toast, LoadingSpinner). The class detail page now has a tab bar — **Attendance | Assignments** — that the Step 8 grading UI will extend with **Gradebook**.

### Files

**API (one small expansion)**

- `apps/api/src/classroom/assignment.service.ts` — adds `listAssignmentTypes()` (school-scoped read of `cls_assignment_types`, ordered by name, only `is_active=true`).
- `apps/api/src/classroom/assignment.controller.ts` — adds `GET /assignment-types` (`tch-002:read`). Used by the create-assignment form to populate the type dropdown.

**Web (new components, hooks, routes)**

- `apps/web/src/lib/types.ts` — adds `AssignmentTypeCategory`, `AssignmentTypeDto`, `AssignmentCategoryDto`, `AssignmentDto`, `CreateAssignmentPayload`, `UpdateAssignmentPayload`, `UpsertCategoryEntry`.
- `apps/web/src/hooks/use-classroom.ts` (new) — React Query hooks: `useAssignmentTypes`, `useAssignments` (per class, with `includeUnpublished`), `useAssignment`, `useCreateAssignment`, `useUpdateAssignment`, `useDeleteAssignment`, `useCategories`, `useUpsertCategories`. Same single-flight + auto-invalidate pattern as `use-attendance.ts`.
- `apps/web/src/components/classroom/ClassTabs.tsx` (new) — tab bar shared by every `/classes/:id/*` route. Currently renders Attendance + Assignments; Gradebook tab exists in the type but is hidden via `hideGradebook` until Step 8 lands the gradebook UI.
- `apps/web/src/components/classroom/AssignmentForm.tsx` (new) — shared create + edit form. Title, instructions, type, category, due date, max points, extra-credit toggle, publish toggle. Local validation (title required; max points > 0); server-side errors surface inline.
- `apps/web/src/components/classroom/CategoryWeightModal.tsx` (new) — editable rows of `(name, weight)`. Live total with green/amber styling; Save disabled until total = 100, names non-empty, names unique. PUT semantics match the server: removed names are deleted (409 if still referenced).
- `apps/web/src/app/(app)/classes/[id]/assignments/page.tsx` (new) — list page. Manager view (teachers/admins) shows drafts; type filter pills; "Manage categories" button opens the modal; per-row Edit (links to `/edit`) + Delete (confirm modal, soft delete).
- `apps/web/src/app/(app)/classes/[id]/assignments/new/page.tsx` (new) — wraps `AssignmentForm` for create, navigates back to the list on success.
- `apps/web/src/app/(app)/classes/[id]/assignments/[assignmentId]/edit/page.tsx` (new) — wraps `AssignmentForm` for edit; loads via `useAssignment` then re-seeds the form on data arrival.
- `apps/web/src/app/(app)/classes/[id]/attendance/page.tsx` — adds `<ClassTabs active="attendance" hideGradebook />` between PageHeader and the existing roster.

**Side fixes (build hygiene)**

- `apps/web/src/components/dashboard/{Admin,Parent,Teacher}Dashboard.tsx` — escape `'` → `&rsquo;` so `next build` no longer fails on `react/no-unescaped-entities`. Pre-existing lint debt that surfaced once Step 7 needed a clean prod build.
- `apps/web/src/app/login/page.tsx` — wrap the inner page in `<Suspense fallback={null}>` so `useSearchParams()` no longer trips the prerender bail. Pre-existing issue, surfaced for the same reason.

### Routes added

```
/classes/:id/assignments                        (list — teachers/admins, manager view; students/parents see published-only via the shared API)
/classes/:id/assignments/new                    (create form)
/classes/:id/assignments/:assignmentId/edit     (edit form)
```

The existing `/classes/:id/attendance` route gains the same `ClassTabs` header so teachers can pivot between attendance and assignments without backing out to the dashboard.

### UX rules baked in

- **Manager-only list view.** The list page calls `useAssignments(classId, { includeUnpublished: true })`. The API hides drafts from non-managers automatically — so even a student who navigates to this URL by hand sees only published rows. The "Draft" badge on the list page is therefore a teacher/admin-only signal.
- **Type filter is client-side.** The 5 categories (Homework / Quiz / Test / Project / Classwork) are static; filtering in the browser saves a round-trip and keeps the row count tile responsive.
- **Edit links re-use the assignment row title.** Clicking the title takes the teacher straight to `/edit` — saves a wasted detail page that this cycle doesn't need (read-only view of an assignment is part of the Step 8 grading detail).
- **Category modal mirrors PUT semantics.** Local state holds the *full new set*. Removing a row marks it for deletion via the API — and the API returns 409 if the category is still referenced. The error message surfaces inline; the modal stays open so the teacher can fix the conflict (re-add the row, or first reassign the affected assignments via the edit page).
- **Date input is `datetime-local`.** Browser-native picker; the form serialises to ISO at submit time using the user's local clock. Fine for a single-tenant demo; a global rollout will need to re-anchor to the school's timezone.
- **Default extra-credit = false; default published = true.** Most teachers create a published, non-extra-credit assignment. Drafts and extra-credit are deliberate opt-ins.
- **All toasts on success and error paths.** Re-uses the existing `useToast()`; the form's `serverError` state surfaces 400/409 messages inline as well so the teacher doesn't have to scroll up.

### Authorisation behaviour (recap)

The list page is gated by `tch-002:read` (held by every persona) but the Step 4 API row-scopes results to the caller (admins all; teacher-of-class their classes; student/parent the published view). The create/edit/delete pages call the same API; non-managers hit 403 even though their token holds `tch-002:write` (student-write is for `POST /assignments/:id/submit`, not for managing assignments — handled by `assertCanWriteClass` server-side). The frontend doesn't try to hide write actions for non-teachers in this step — admins land on the same dashboard layout the principal already uses, and a teacher who is *not* assigned to the class never sees a card linking to it. A defensive role-aware UI hide is a Phase 2 polish item.

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/api build      # nest build → exits 0
pnpm --filter @campusos/web build      # next build → all routes compile, /login + /classes/[id]/assignments ƒ (dynamic)
pnpm --filter @campusos/api start:prod # GET /assignment-types returns 5 rows for tenant_demo
pnpm --filter @campusos/web dev        # /login HTTP 200; /classes/<id>/assignments HTTP 200
```

API smoke matrix (full curl trace stored in this commit's working notes — boiled down here):

| #  | Scenario                                                                          | Expected                                                                 | Got |
| -- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --- |
| 1  | Teacher GET `/api/v1/assignment-types` for demo tenant                            | 5 rows (Homework, Quiz, Test, Project, Classwork) ordered by name        | ✅  |
| 2  | Teacher POST draft assignment ("Step 7 smoke draft") in P1 with category=Homework | 201, `isPublished=false`, category nested under `category` field         | ✅  |
| 3  | Teacher GET `/classes/:id/assignments?includeUnpublished=true`                    | 3 rows; the draft surfaces alongside the seed's 2 published rows         | ✅  |
| 4  | Teacher PATCH `{title:"…updated", isPublished:true}`                              | 200 with new title + `isPublished=true`                                  | ✅  |
| 5  | Teacher DELETE the assignment                                                      | 204                                                                      | ✅  |
| 6  | Teacher PUT categories with weights 50/40/20 (sum=110)                            | 400 "Category weights must sum to 100; got 110.00"                       | ✅  |
| 7  | Web: `/login` route                                                                | 200 with rendered HTML (Suspense boundary fix)                           | ✅  |
| 8  | Web: `/classes/<P1>/assignments` route                                            | 200 (route compiles + serves)                                            | ✅  |
| 9  | Web: `/classes/<P1>/assignments/new` route                                        | 200                                                                      | ✅  |

The browser-side interactivity (button clicks, modal state, navigations) was validated structurally via Next.js's static analysis (build succeeds, all components type-check, hooks import correctly) and via the API smoke tests above. A full click-through with an actual browser is a Step 10 (vertical slice CAT) deliverable; if Phase 2 polish surfaces UI bugs they get fixed there.

### Out-of-scope decisions for Step 7

- **No question-builder UI.** `cls_assignment_questions` and `cls_answer_key_entries` exist but no form writes to them. Per the original Step 4 plan: question / MC / file-upload UX waits until a later cycle that has actual assessment workflows to design against.
- **No grading-scale picker.** The form omits `gradingScaleId`; the API defaults the value. The seed sets a single "Standard A-F" scale per tenant — until Phase 2 teaches teachers to author scales, surfacing the picker would just be visual noise.
- **No assignment list for students/parents.** Step 9 will land the student/parent grade views; the list page in this step is teacher-facing only. The API itself already row-scopes the list, so a future student page can reuse the exact same `useAssignments(classId)` hook with no API change.
- **Drag-to-reorder on categories deferred.** Sort order is preserved by the array index on submit, but the modal has no drag handles — manual `sortOrder` ordering is good enough for the Cycle 2 demo.
- **No assignment-type CRUD UI.** The 5 standard types are seeded; there's no admin form to create new ones. A school-admin "manage types" page is post-Cycle 2.
- **Soft-delete is one-way.** No restore button. Matches the API's deliberate Step 4 decision.
- **No empty-state CTA inside `CategoryWeightModal`.** The modal opens against the existing 18 seeded categories (3 per class). For brand-new classes with zero categories the seed dataflow won't apply; that path lands when an "add new class" admin flow ships.
- **`hideGradebook` is a UI-side toggle, not a permission check.** Once Step 8 lands the gradebook UI we'll flip the prop off across all class routes; until then the tab is simply hidden so a teacher can't navigate to a 404. No permission code change needed (gradebook reads use `tch-003:read` and the API gates that).
- **Pre-existing lint / Suspense fixes ride along.** The dashboard `'` escapes and the `/login` Suspense wrapping are not Step 7 features per se; they were necessary to make `pnpm build` pass for the web app, and they fix bugs that would have surfaced the first time anyone deployed Cycle 1's web. Treating them as part of Step 7 is honest — without them the Step 7 routes can't ship.
- **No frontend-side test coverage in this step.** Cycle 1 also didn't ship Jest/Playwright suites; that's a deliberate Phase 2 deliverable. Smoke tests are API-side curl + Next build/route probes only.

---

## Step 8 — Teacher Grading UI (planned)

The gradebook grid: students × assignments, color-coded cells, click-to-edit, batch publish per assignment. Submission detail page with grade entry + feedback. Progress notes editor.

---

## Step 9 — Student & Parent Grade Views (planned)

Student: `/assignments` (across all enrolled classes), `/assignments/:id` (instructions + submit form), `/grades` (per-class average + per-assignment list). Parent: gradebook card on the existing parent dashboard with per-class current averages from `cls_gradebook_snapshots`; click-through to per-assignment breakdown.

---

## Step 10 — Vertical Slice Integration Test (planned)

Reproducible CAT script at `docs/cycle2-cat-script.md`. The 9-step happy-path covers create → submit → grade → publish → debounced snapshot recomputation → student/parent visibility. Plus 3 permission-denial assertions.

---

## Quick reference — running the stack from a fresh clone

```bash
# 1. Install
pnpm install

# 2. Start local services
docker compose up -d

# 3. Run migrations + seed everything
pnpm --filter @campusos/database migrate          # platform schema (Prisma)
pnpm --filter @campusos/database seed             # 5 test users + Chen family + tenant_demo provisioned
pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 permissions, 6 roles, role-permission map, role assignments
pnpm --filter @campusos/database seed:sis         # Cycle 1 seed: students, guardians, families, today's attendance
pnpm --filter @campusos/database seed:classroom   # Cycle 2 Step 3 seed: assignments, submissions, grades, gradebook snapshots, progress note
pnpm --filter @campusos/database exec tsx src/build-cache.ts  # rebuild iam_effective_access_cache

# 4. Start the API
pnpm --filter @campusos/api dev
# → http://localhost:4000
# → http://localhost:4000/api/docs (Swagger)
```

### Rebuilding from a corrupted state

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  DROP SCHEMA IF EXISTS tenant_demo CASCADE;
  DROP SCHEMA IF EXISTS tenant_test CASCADE;
"
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:sis        # Cycle 1 SIS — idempotent
pnpm --filter @campusos/database seed:classroom  # Cycle 2 classroom — idempotent (skips when cls_assignments has rows)
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

---

## Open items / known gaps (will be filled in as steps land)

- **Cycle 2 seed pipeline.** Done in Step 3 — `pnpm seed:classroom` populates the demo tenant. `tenant_test` is intentionally left empty (test fixtures will set up their own data per test).
- **`cls_lessons` API.** Minimal in Cycle 2 (table exists but no full CRUD endpoints). Full lesson planning is a later cycle.
- **AI grading service.** `cls_ai_grading_jobs` table is created for forward compatibility but no AI worker is wired this cycle. The contract (AI never writes to `cls_grades`) is documented and will be enforced at the service layer when the AI service lands.
- **ADR-057 envelope on Kafka events.** The `cls.grade.*` topics now carry transport headers `event-id`, `tenant-id`, `tenant-subdomain` (Step 6 — needed by the snapshot worker for idempotency + tenant context). Other topics still emit raw. Cycle 3 lifts everything to the canonical envelope (event_id, event_version, tenant_id, correlation_id) at once. See `KafkaProducerService` TODO.

---

## Cycle 2 exit criteria (from the plan)

1. Tenant schema: 15 new Classroom tables migrated. Total tenant tables: ~38.
2. Seed data: 12 assignments, ~80 submissions, ~50 grades, gradebook snapshots, progress notes.
3. Assignment API: ~8 endpoints, all permission-protected with row-level auth.
4. Submission & Grading API: ~12 endpoints. Grade entry, batch grading, publish workflow.
5. Kafka: first consumer (gradebook snapshot worker). 30s debounce. Idempotent. 4 event types.
6. Teacher UI: assignment CRUD, gradebook grid, submission review, grade entry, publish.
7. Student UI: assignment list, submission form, grade view.
8. Parent UI: gradebook averages, per-assignment breakdown, progress notes.
9. Vertical slice test: all 9 steps pass.
10. HANDOFF-CYCLE2.md and CLAUDE.md updated. CI green.
