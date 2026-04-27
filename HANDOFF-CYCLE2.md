# Cycle 2 Handoff — Classroom, Assignments & Grading

**Status:** Cycle 2 IN PROGRESS — Step 1 done. (Cycle 1 is COMPLETE; see `HANDOFF-CYCLE1.md` for the SIS + Attendance foundation this cycle builds on.)
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle2-implementation-plan.html`
**Vertical-slice deliverable:** Teacher creates an assignment for Period 1 Algebra → student Maya submits work → teacher grades and publishes → gradebook snapshot recomputes asynchronously → parent David sees Maya's updated average.

This document tracks the Cycle 2 build — the M21 Classroom module — at the same level of detail as `HANDOFF-CYCLE1.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                           | Status                                                              |
| ---: | ----------------------------------------------- | ------------------------------------------------------------------- |
|    1 | Classroom Schema — Lessons & Assignments        | Done — `005_cls_lessons_and_assignments.sql` applied to demo + test |
|    2 | Classroom Schema — Submissions & Grading        | Pending                                                             |
|    3 | Seed Data — Assignments & Grades                | Pending                                                             |
|    4 | Classroom NestJS Module — Assignments           | Pending                                                             |
|    5 | Classroom NestJS Module — Submissions & Grading | Pending                                                             |
|    6 | Kafka Events & Gradebook Snapshot Worker        | Pending                                                             |
|    7 | Teacher Assignments UI                          | Pending                                                             |
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

## Schema changes — two tenant migrations (planned)

All Cycle 2 migrations live in `packages/database/prisma/tenant/migrations/`. They follow the same idempotent pattern as the Cycle 1 migrations: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` for FK changes, `TEXT + CHECK IN (…)` for enum-like columns (the SQL splitter can't handle `CREATE TYPE` idempotently). Soft UUID references to `platform.*` tables — never DB-level FK constraints (ADR-001/020).

**After Cycle 2 the tenant schema will hold ~38 tables:** 5 (Cycle 0) + 18 (Cycle 1 SIS + Attendance) + 15 (Cycle 2 Classroom) = 38, plus the 36 partition objects under `sis_attendance_records`.

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

### `006_cls_submissions_and_grading.sql` — 8 tables (Step 2, planned)

Will land in Step 2: `cls_submissions`, `cls_submission_question_grades`, `cls_ai_grading_jobs`, `cls_grades`, `cls_gradebook_snapshots`, `cls_report_cards`, `cls_report_card_entries`, `cls_student_progress_notes`. **Total Classroom tables after Step 2: 15.** ADR-010 (gradebook snapshots are async-only) is enforced by the schema itself: nothing in `cls_grades` writes to `cls_gradebook_snapshots` directly.

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

Cycle 2 surfaces the TCH function group from the Function Library v11. Codes already exist in `packages/database/data/permissions.json` (the Cycle 1 reconciliation pulled the full 148/444 catalogue, including TCH). Step 3 (seed) wires them into roles:

| Code        | Function     | Roles (after Step 3)                                                    |
| ----------- | ------------ | ----------------------------------------------------------------------- |
| `tch-002:*` | Assignments  | Teacher: read/write. Student/Parent: read.                              |
| `tch-003:*` | Grade Book   | Teacher: read/write. Student/Parent: read (limited to own/linked rows). |
| `tch-004:*` | Report Cards | Teacher: read/write. Student/Parent: read.                              |

Step 3 will also rebuild the effective access cache via `pnpm --filter @campusos/database exec tsx src/build-cache.ts` after the role-permission mapping update.

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

## Step 2 — Classroom schema, submissions & grading (planned)

Will land `006_cls_submissions_and_grading.sql` with the 8 grading-pipeline tables. ADR-010 is enforced by the schema layout: `cls_grades` and `cls_gradebook_snapshots` are physically separate tables, written by separate code paths.

---

## Step 3 — Seed data (planned)

Extends `seed-sis.ts` (or a new `seed-classroom.ts`) with: 5 assignment types, 3 categories per class (Homework 30 / Assessments 50 / Participation 20), 12 assignments across 6 classes, ~80 submissions, ~50 grades, gradebook snapshots, and one progress note for Maya. Follows the same lookup-or-create idempotency pattern as `seed-sis.ts`.

Also wires TCH-002/003/004 codes onto roles (Teacher: read/write; Student/Parent: read) and rebuilds the effective access cache.

---

## Step 4 — Classroom NestJS module — assignments (planned)

`apps/api/src/classroom/` with `AssignmentService`, `AssignmentController`, `CategoryController`, DTOs. Reuses `ActorContextService` for row-level auth (teachers see only their assigned classes; students see only their enrolled classes; parents see only their linked children's classes; admins see all). Multi-table transactional creates (assignment + questions + answer key) use `executeInTenantTransaction`.

---

## Step 5 — Classroom NestJS module — submissions & grading (planned)

`SubmissionService`, `GradeService`, `GradebookService`, `ProgressNoteService`. Grade write path emits `cls.grade.published` via `KafkaProducerService` — never updates the snapshot inline (ADR-010). Batch grading endpoint is a single transaction across many `cls_grades` rows; one event emission per published grade.

---

## Step 6 — Kafka events & gradebook snapshot worker (planned)

First consumer in the system. New `KafkaConsumerService` in `apps/api/src/kafka/`. The worker is a NestJS provider with `OnModuleInit` that subscribes to `cls.grade.published` / `cls.grade.unpublished`. 30s debounce per (class_id, student_id) via an in-process queue. Idempotency via `platform_event_consumer_idempotency` so a redelivered event doesn't double-recompute.

---

## Step 7 — Teacher Assignments UI (planned)

Extends the existing class detail page with tabs: **Attendance | Assignments | Gradebook**. Assignments tab lists `cls_assignments` with sort/filter; create/edit form posts to the Step 4 API. Category weight management modal validates weights sum to 100.

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
pnpm --filter @campusos/database exec tsx src/build-cache.ts  # rebuild iam_effective_access_cache
# (Cycle 2 seed lands in Step 3)

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
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

---

## Open items / known gaps (will be filled in as steps land)

- **Cycle 2 seed pipeline.** Lands in Step 3. Until then, fresh tenants have empty `cls_*` tables.
- **`cls_lessons` API.** Minimal in Cycle 2 (table exists but no full CRUD endpoints). Full lesson planning is a later cycle.
- **AI grading service.** `cls_ai_grading_jobs` table is created for forward compatibility but no AI worker is wired this cycle. The contract (AI never writes to `cls_grades`) is documented and will be enforced at the service layer when the AI service lands.
- **ADR-057 envelope on Kafka events.** Cycle 2 emits raw payloads; Cycle 3 lands the canonical envelope (event_id, event_version, tenant_id, correlation_id) when the first consumer outside the gradebook worker reads from these topics. See `KafkaProducerService` TODO.

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
