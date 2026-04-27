# CampusOS

Cloud-native, multi-tenant School Operating System. Replaces 8–15 disconnected school software systems with one platform.

## Project Status

Cycle 0 (Platform Foundation) is COMPLETE. **Cycle 1 (SIS Core + Attendance) is COMPLETE — all 11 steps done. Post-cycle architecture review fixes (REVIEW-CYCLE1) landed.** Schema, seed, SIS API, Attendance API + Kafka emits, web UI shell, Teacher Dashboard, Attendance Taking UI with confirm modal + batch submit, Parent Dashboard + child attendance calendar + absence-request form, AdminDashboard (school-wide overview + pending-absence queue), and a verified end-to-end vertical slice (`docs/cycle1-cat-script.md`). The post-cycle review tightened tenant isolation (`SET LOCAL search_path` inside an interactive tx), added row-level authorization to student reads, gated attendance writes by `sis_class_teachers` membership, and replaced cross-scope admin checks with a tenant-scope-chain check.

**Cycle 2 (Classroom + Assignments + Grading) is COMPLETE — all 10 steps done. Post-cycle architecture review fixes (REVIEW-CYCLE2-CHATGPT) landed.** The post-cycle review tightened `GET /classes/:classId/gradebook` to manager-only (permission gate switched from `tch-003:read` → `tch-003:write` and row-scope from `assertCanReadClass` → `assertCanWriteClass`, closing a latent grade-data leak to students/parents who held `tch-003:read`); rewrote the GradebookSnapshotWorker idempotency from at-most-once to at-least-once (read-only `IdempotencyService.isClaimed` on arrival, debounce-entry tracks contributing event-ids, `claim()` only fires AFTER a successful recompute, transient DB failures retry on the next event); and documented the temporary HR-employee identity mapping that columns named `*_employee_id` / `cls_grades.teacher_id` / `cls_lessons.teacher_id` / `cls_student_progress_notes.author_id` currently hold `iam_person.id` directly until the HR module ships — annotated in the migration SQL via `COMMENT ON COLUMN`. The ADR-057 event envelope is deferred to Cycle 3 (Communications) where multiple producers and consumers will arrive together; the grade-emit headers (`event-id`, `tenant-id`, `tenant-subdomain`) already carry the three fields the worker reads, so the migration is additive. Migrations `005_cls_lessons_and_assignments.sql` (7 tables) and `006_cls_submissions_and_grading.sql` (8 tables) add the full M21 Classroom schema — 15 tenant tables total. ADR-010 (gradebook snapshots are async-only) is enforced at the schema layout level: `cls_grades` and `cls_gradebook_snapshots` are physically separate tables with no FK or trigger linking them; the Step 5 grade write path was end-to-end-verified to never touch the snapshot table. AI / human boundary: `cls_ai_grading_jobs` and `cls_submission_question_grades.ai_*` columns store AI suggestions; `cls_grades` has zero `ai_*` columns and is written only by teacher action. 28 intra-tenant FKs across the two migrations; zero cross-schema FKs. Step 3 (`seed-classroom.ts`) seeds 1 grading scale, 5 assignment types, 18 per-class categories (Homework 30 / Assessments 50 / Participation 20), 12 assignments, 80 submissions, 62 grades (53 published), 41 gradebook snapshots, and 1 progress note for Maya — and adds TCH-002:read (Parent), TCH-004:read (Student), TCH-004:read+write (Teacher) to the role-permission map. Step 4 lands AssignmentService + CategoryService + their controllers — 7 endpoints under `tch-002:read/write` with the same row-level auth pattern as Cycle 1 (admin → all; teacher → assigned classes via `sis_class_teachers`; student → enrolled classes; parent → linked-child classes). Step 5 lands SubmissionService + GradeService + GradebookService + ProgressNoteService + 4 controllers — 12 new endpoints (3 `tch-002:*` + 9 `tch-003:*`). Submissions are idempotent upserts by `(assignment, student)`; resubmitting flips status back to `SUBMITTED`. Grade writes (single + batch + publish + unpublish + publish-all) emit `cls.grade.published` / `cls.grade.unpublished` via `KafkaProducerService` and never write to `cls_gradebook_snapshots`. Draft grades are filtered out of student / parent payloads (`rowToDto(row, includeDraftGrade)` flag — manager teacher / admin sees them; everyone else does not). Gradebook reads (`/classes/:id/gradebook`, `/students/:id/gradebook`) join roster ↔ snapshot per resolved term (default = current term). Progress notes upsert by `(class, student, term)` with persona-scoped reads (admins all; teachers their classes; students/parents only `is_*_visible=true` AND `published_at IS NOT NULL`). **Step 6 lands the first Kafka consumer in the system — `GradebookSnapshotWorker` (in `apps/api/src/classroom/`) — backed by `KafkaConsumerService` and `IdempotencyService` (in `apps/api/src/kafka/`). The worker subscribes to `cls.grade.published` and `cls.grade.unpublished` under consumer group `gradebook-snapshot-worker`, debounces 30 seconds per `(schoolId, classId, studentId)`, and recomputes `cls_gradebook_snapshots` using the exact weighted-average algorithm from `seed-classroom.ts` (per-category mean, weighted by category, renormalised over participating categories only). Idempotency is via `platform.platform_event_consumer_idempotency` keyed on `(consumer_group, event_id)`; redelivered events fail the `INSERT` (SQLSTATE 23505) and are dropped before they can reset the debounce. Tenant context is reconstructed at flush time from Kafka headers (`event-id`, `tenant-id`, `tenant-subdomain`) using `runWithTenantContextAsync`, so the worker reuses the same `TenantPrismaService` helpers as the request path. The grade emit (`grade.service.ts::tenantHeaders`) injects these three headers from `getCurrentTenant()` plus a fresh UUIDv7 — forward-compatible with the ADR-057 envelope that lands in Cycle 3.** **Step 7 lands the teacher Assignments UI: a `ClassTabs` shell at `/classes/:id/{attendance,assignments}` (Gradebook tab hidden until Step 8), an assignments list page with type filter / draft visibility for managers / soft-delete confirm, shared `AssignmentForm` for create + edit, and `CategoryWeightModal` that mirrors the API's PUT-by-name semantics with a live "weights must sum to 100" check. New `GET /assignment-types` endpoint exposes the school's type catalogue. Pre-existing lint / Suspense issues in the Cycle 1 dashboards + `/login` were fixed so the web app builds clean — these were transitive (only surfaced once Step 7 needed `next build` to succeed).** **Step 8 lands the teacher Grading UI: a spreadsheet-style gradebook grid at `/classes/:id/gradebook` with color-coded cells × inline editor × per-cell publish toggle × per-assignment "Publish all", a submissions queue at `/assignments/:id/submissions` sorted by grading priority (SUBMITTED first), a single-submission detail page at `/submissions/:id` with grade entry + feedback + publish controls, and a per-student `ProgressNoteModal` launched from the gradebook (auto-loads existing note for the (class, term) pair, upserts on save). The Gradebook tab is now visible across all `/classes/:id/*` routes. **Side fix: `grade.service.ts` now emits `cls.grade.published` on updates to already-published grades** (Step 5 emit gap — only draft↔published transitions were emitting before, so a re-grade of a published row left the snapshot stale). Both `upsertGrade` (single) and `batchGrade` paths now flag rows for emit if they end up published, regardless of prior state. The snapshot worker is idempotent so the redundant emit is harmless.** **Step 9 lands the student & parent grade views: a new student `StudentDashboard` (upcoming-assignment list + per-class average cards), a student `/assignments` inbox across all enrolled classes (filter by class / overdue / next-14-days), `/assignments/:id` student detail + submit form (idempotent resubmit, published-grade reveal), `/grades` per-class average list, `/grades/:classId` per-assignment breakdown, and the parent equivalents — a Grades section on each child card on `ParentDashboard`, `/children/:id/grades` per-child average list, and `/children/:id/grades/:classId` per-class breakdown (incl. parent-visible progress notes). Two new backend endpoints back this: `GET /students/me` (bootstrap the calling student's `studentId` without scanning the list) and `GET /students/:studentId/classes/:classId/grades` (per-(student, class) breakdown — assignments + own submission + own grade, only published rows for non-managers). Sidebar surfaces `Assignments` and `Grades` for STUDENT persona.** **Step 10 lands the Cycle 2 CAT at `docs/cycle2-cat-script.md` — a 9-step reproducible end-to-end walkthrough verified live against `tenant_demo`: teacher creates an assignment → student bootstraps via `/students/me` and submits → teacher grades draft → draft is hidden from the student → teacher publish-all emits `cls.grade.published` → 30-second debounce + idempotent recompute updates `cls_gradebook_snapshots` (worker log captured) → student sees grade via the new per-class endpoint → parent sees the same data through `sis_student_guardians` → 3 permission denials (student grading, parent submitting, teacher writing to a class they don't teach) plus a draft-after-unpublish bonus assertion. All assertions pass; demo state restored at end of run.**

See `docs/campusos-cycle1-implementation-plan.html` and `docs/campusos-cycle2-implementation-plan.html` for step-by-step plans; `HANDOFF-CYCLE1.md` and `HANDOFF-CYCLE2.md` for current build state and known gaps; `REVIEW-CYCLE1-CHATGPT.md` / `REVIEW-CYCLE1-CLAUDE.md` / `REVIEW-CYCLE1-FIXES.md` for the Cycle 1 architecture review record; `REVIEW-CYCLE2-CHATGPT.md` for the Cycle 2 review + the fixes-applied log.

## Delivery Plan (Revised)

**Phase 1: Build the Core (current)**

- Cycle 0: Platform Foundation — COMPLETE
- Cycle 1: SIS Core + Attendance — COMPLETE (reviewed, fixes applied)
- Cycle 2: Classroom + Assignments + Grading — COMPLETE
- Cycle 3: Communications — next (messaging, notifications, Kafka consumers)

**Phase 2: Test and Refine (after Cycle 3)**

- Walk through every workflow as each persona (teacher, parent, student, admin)
- Refine UI design, navigation, and interaction patterns
- Create UI design guide (`docs/ui-design-guide.md`) for future cycles
- Test edge cases and identify missing features within existing modules
- Fix issues and polish before expanding

**Phase 3: Expand (after Phase 2 sign-off)**

- Cycles 4–8: HR, Enrollment, Tasks, Calendar, Helpdesk
- Each cycle follows validated patterns from Phase 1
- UI matches the design guide established in Phase 2

## Architecture

- **840 tables** across 38 modules, governed by 76 ADRs (Architecture Decision Records)
- Schema-per-tenant multi-tenancy (PostgreSQL `search_path` switching)
- Modular monolith (NestJS) with planned extraction of 6 services
- Event-driven via Kafka
- Phased delivery plan (see "Delivery Plan (Revised)" above): build core (Cycles 0–3) → test & refine → expand (Cycles 4–8)

## Tech Stack

- **Backend:** NestJS 10 (TypeScript strict), Node.js 22 (CI + production image)
- **Frontend:** Next.js 14 (App Router, Tailwind CSS, React Query, Zustand)
- **Database:** PostgreSQL 16 (Prisma ORM, schema-per-tenant)
- **Cache:** Redis 7 (ioredis)
- **Events:** Apache Kafka (KafkaJS)
- **Auth:** External IdP via OIDC (Keycloak for dev). CampusOS never stores passwords.
- **Monorepo:** pnpm + Turborepo

## Project Structure

```
apps/api/                → NestJS backend (modular monolith)
apps/api/src/auth/       → AuthGuard (JWT), PermissionGuard, @Public, @RequirePermission
apps/api/src/tenant/     → TenantResolverMiddleware, TenantGuard, TenantPrismaService, AsyncLocalStorage
apps/api/src/iam/        → Roles, permissions, assignments, effective access cache, ActorContextService (resolves caller persona + isSchoolAdmin per tenant)
apps/api/src/platform/   → M0 Platform Core
apps/api/src/sis/        → M20 SIS Core (Cycle 1 Step 5): students, classes, families, guardians; /classes/my includes todayAttendance summary (Step 8); /students/me added in Cycle 2 Step 9 to bootstrap a STUDENT persona's own studentId
apps/api/src/attendance/ → ATT-001..005 (Cycle 1 Step 6): attendance + absence requests + Kafka emits
apps/api/src/classroom/  → M21 Classroom (Cycle 2): assignment + category CRUD (Step 4) + submissions, grading (single/batch/publish), gradebook reads, and progress notes (Step 5) + GradebookSnapshotWorker (Step 6 — first Kafka consumer; subscribes to cls.grade.{published,unpublished} under group `gradebook-snapshot-worker`, debounces 30s per (class,student), recomputes cls_gradebook_snapshots). Step 9 adds GET /students/:studentId/classes/:classId/grades (per-(student, class) assignment breakdown — published-only for non-managers; reuses GradebookService.assertCanViewStudent + AssignmentService.assertCanReadClass for row scope). 4 services + 1 worker + 6 controllers; emits cls.submission.submitted, cls.grade.published, cls.grade.unpublished, cls.progress_note.published.
apps/api/src/kafka/      → KafkaProducerService (best-effort emit) + KafkaConsumerService (best-effort consumer registry, Step 6) + IdempotencyService (claim against platform.platform_event_consumer_idempotency)
apps/web/                → Next.js 14 frontend (App Router, Tailwind, React Query, Zustand)
apps/web/src/lib/        → api-client (Bearer + X-Tenant-Subdomain, single-flight 401→refresh), auth-store (Zustand), auth-context, query-client, shared TS types
apps/web/src/components/ui/        → Avatar, StatusBadge, LoadingSpinner, EmptyState, PageHeader, Modal, Toast (provider+useToast), DataTable, cn helper
apps/web/src/components/shell/     → AppLayout (responsive drawer), Sidebar (persona + permission-driven), TopBar (avatar menu, sign-out), inline SVG icons
apps/web/src/components/dashboard/ → TeacherDashboard (Step 8), ParentDashboard (Cycle 1 Step 10; Cycle 2 Step 9 adds the per-child Grades section + "View grades" button), AdminDashboard (Step 11), StudentDashboard (Cycle 2 Step 9 — upcoming-assignment list + per-class average cards)
apps/web/src/components/classroom/ → ClassTabs (shared header for /classes/:id/* routes), AssignmentForm (create + edit), CategoryWeightModal (Step 7), GradeCellEditor (gradebook inline editor — Step 8), ProgressNoteModal (per-student upsert by class+term — Step 8), StudentClassGradesView (Step 9 — shared per-class breakdown UI used by both student and parent routes)
apps/web/src/hooks/      → React Query hooks. Cycle 1: useMyClasses, useClasses, useClass, useClassAttendance, useBatchSubmitAttendance, useAbsenceRequests, useMyChildren, useStudent, useStudentAttendance, useSubmitAbsenceRequest. Cycle 2 Step 7 (use-classroom.ts): useAssignmentTypes, useAssignments, useAssignment, useCreateAssignment, useUpdateAssignment, useDeleteAssignment, useCategories, useUpsertCategories. Step 8 (same file): useClassGradebook, useStudentGradebook, useSubmissionsForAssignment, useSubmission, useGradeSubmission, useBatchGrade, usePublishGrade, useUnpublishGrade, usePublishAllGrades, useStudentProgressNotes, useUpsertProgressNote. Step 9 (same file): useMyStudent (GET /students/me), useStudentClassGrades (GET /students/:studentId/classes/:classId/grades), useMySubmission (GET /assignments/:id/submissions/mine), useSubmitAssignment (POST /assignments/:id/submit).
apps/web/src/app/        → Next.js routes: /login, /(app)/dashboard (persona-aware: sch-001:admin→Admin, STAFF→Teacher, GUARDIAN→Parent, STUDENT→Student), /(app)/classes/[id]/attendance, /(app)/classes/[id]/assignments + /new + /[assignmentId]/edit (Step 7), /(app)/classes/[id]/gradebook (Step 8 — spreadsheet grid + ProgressNoteModal), /(app)/assignments (Step 9 — student inbox across all enrolled classes), /(app)/assignments/[assignmentId] (Step 9 — student detail + submit form), /(app)/assignments/[assignmentId]/submissions (Step 8 — teacher grading queue), /(app)/submissions/[id] (Step 8 — single-submission detail with grade entry), /(app)/grades + /(app)/grades/[classId] (Step 9 — student gradebook + per-class breakdown), /(app)/children/[id]/attendance, /(app)/children/[id]/absence-request, /(app)/children/[id]/grades + /(app)/children/[id]/grades/[classId] (Step 9 — parent per-child gradebook + per-class breakdown w/ progress notes)
packages/database/       → Prisma schema, tenant SQL migrations, provisioning, seed scripts. `build` script chains `prisma generate` before tsc so CI/Docker builds are self-sufficient.
packages/shared/         → Shared TypeScript types and constants
```

## Key Design Contracts

- **Identity (ADR-055):** `iam_person` is the canonical FK for human identity. `platform_users` is ONLY for auth/audit columns. Domain projections (`sis_staff`, `sis_guardians`) carry direct `person_id` refs to `iam_person`. `sis_students` is a transitive projection — its identity path is `sis_students → platform_students.person_id → iam_person.id` (`platform_students` exists for cross-school student portability).
- **Soft cross-schema refs (ADR-001/020/028):** Tenant tables MUST NOT have DB-enforced FK constraints to `platform.*` tables. UUID columns + app-layer Prisma validation only. Cross-schema joins on the read path are fine; FK constraints are not. Health monitoring of soft refs is a future concern (`platform_reference_health`).
- **Permissions:** 444 permission codes (148 functions × 3 tiers: read/write/admin). Check codes, never role names. Use `@RequirePermission('att-001:write')`. Catalogue is reconciled from `packages/database/data/permissions.json` by `seed-iam.ts` — adds new codes, removes stale ones.
- **Tenancy (ADR-001):** Every tenant query uses `search_path = tenant_<id>, platform, public`. Platform tables are shared. Tenant tables are isolated. Schema-per-tenant — never store tenant_id columns on tenant-scoped tables.
- **UUIDs (ADR-002):** All PKs are UUIDv7, generated in the application layer via `generateId()` from `@campusos/database`.
- **Attendance partitioning (ADR-007):** `sis_attendance_records` is composite-partitioned `RANGE(school_year) → HASH(class_id) MODULUS 8`. Composite PK `(id, school_year, class_id)`. Queries should include `class_id` and `date` (or `school_year`) in the predicate to enable partition pruning. Year partitions cover 2024-08 through 2028-08; rotation is a future M0 job.
- **Frozen state (ADR-031):** `is_frozen=true` blocks all writes. Reads still work.
- **Guard order (Auth → Tenant → Permission):** All three guards are registered as `APP_GUARD` in `AppModule` to make order deterministic. `PermissionGuard` fails closed if `request.user` is missing.
- **Scope inheritance (ADR-036, partial):** `PermissionCheckService.resolveScopeChain` checks SCHOOL scope first, then PLATFORM scope. Used by both `PermissionGuard` (endpoint gates) and `hasAnyPermissionInTenant` (admin-status checks). Lets Platform Admins act against any tenant without per-school role assignments. Full district/department/class traversal is future work.
- **Tenant isolation under pooling:** `executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a Prisma `$transaction` that runs `SET LOCAL search_path TO "tenant_X", platform, public`. SET LOCAL is mandatory — a session-level SET on a pooled client can leak between concurrent requests and serve another tenant's data.
- **Row-level authorization:** Endpoint permission gates (`@RequirePermission`) are necessary but not sufficient. Multi-persona reads (e.g. `stu-001:read` is held by parents, students, teachers, and admins) MUST also apply a row filter via `ActorContextService.resolveActor(...)` + a per-personType visibility predicate. Pattern lives in `apps/api/src/sis/student.service.ts::visibilityClause`. Writes that are bound to a class (e.g. attendance) MUST verify caller membership in the relevant link table (`sis_class_teachers`) before mutating; admins bypass.
- **Admin checks are tenant-scoped, not cross-scope.** Use `permissionCheckService.hasAnyPermissionInTenant(accountId, schoolId, codes)` or read `actor.isSchoolAdmin` from `ActorContextService.resolveActor(...)`. NEVER scan `iam_effective_access_cache` across all scopes — that leaks admin status from school A into a request scoped to school B.
- **No implicit access:** Guardian access derived from `iam_relationship_access_rule`, never assumed.
- **Manager-only roster reads:** Endpoints that return roster-wide grade or assessment data (e.g. `GET /classes/:classId/gradebook`) MUST gate on a *manager* permission tier (`tch-003:write`, not `tch-003:read`) AND a row-scope manager check (`assertCanWriteClass` — admin OR `sis_class_teachers` membership). `*:read` codes are typically held by students and parents, so they cannot be the gate for cross-roster views. Per-student endpoints (`/students/:id/...`) stay on `*:read` because they are already row-scoped to the linked person. (REVIEW-CYCLE2 BLOCKING 1.)
- **Kafka consumer idempotency must be claim-after-success.** Workers MUST NOT claim `platform_event_consumer_idempotency` on message arrival, because a recompute failure after the claim is at-most-once and silently drops the work. The pattern is: read-only `IdempotencyService.isClaimed(group, eventId)` on arrival → process → on success, `claim(group, eventId)` for every event-id that contributed to the flush. Recompute paths must be idempotent (UPSERT) so duplicate redelivery after an unclaimed failure is harmless. Pattern lives in `apps/api/src/classroom/gradebook-snapshot-worker.service.ts`. (REVIEW-CYCLE2 BLOCKING 2.)
- **Temporary HR-Employee identity mapping (REVIEW-CYCLE2 DEVIATION 4):** Until the M16 HR module ships, columns documented in the ERD as soft references to `hr_employees.id` actually hold `iam_person.id` directly. Applies to `sis_class_teachers.teacher_employee_id`, `cls_grades.teacher_id`, `cls_lessons.teacher_id`, and `cls_student_progress_notes.author_id`. Services compare these against `ActorContextService.resolveActor(...).personId`. The constraint is annotated on the columns themselves via `COMMENT ON COLUMN`, so it is discoverable from the live schema. When HR lands, the bridge migration is additive — no service code needs to flip on day one.

## Guard Chain (every request)

TenantResolverMiddleware → AuthGuard (JWT) → TenantGuard (frozen check) → PermissionGuard (@RequirePermission)

## Commands

```bash
# Start local services
docker compose up -d

# Start API (dev mode, port 4000, watch)
pnpm --filter @campusos/api dev

# Start web (dev mode, port 3000)
pnpm --filter @campusos/web dev

# Run tests
pnpm test

# Database migrations (platform schema, Prisma)
pnpm --filter @campusos/database migrate

# Tenant schema migrations
# Add SQL file to packages/database/prisma/tenant/migrations/ (numbered: 005_*.sql, 006_*.sql, ...)
# Then re-provision:
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test

# Seed pipeline (run in order)
pnpm --filter @campusos/database seed                       # platform: org, school, 5 test users, Chen family, provisions tenant_demo
pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 permissions, 6 roles, role-permission mappings, role assignments
pnpm --filter @campusos/database seed:sis                   # 15 students, 10 guardians, 8 families, 41 enrollments + attendance
pnpm --filter @campusos/database seed:classroom             # 12 assignments, 80 submissions, 62 grades, 41 gradebook snapshots, 1 progress note
pnpm --filter @campusos/database exec tsx src/build-cache.ts  # rebuild iam_effective_access_cache (run after any role/permission change)

# Rebuild from corrupted state (drops and re-provisions tenant schemas)
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:sis        # idempotent: lookup-or-create on platform identities
pnpm --filter @campusos/database seed:classroom  # idempotent: skips if cls_assignments already populated
pnpm --filter @campusos/database exec tsx src/build-cache.ts

# Prisma studio (visual DB browser, platform schema only)
pnpm --filter @campusos/database studio
```

## Database

- **Platform schema** (~27 tables): organisations, schools, iam_person, platform_users, platform_students, platform_families, roles, permissions (**444 codes**), iam_scope, iam_role_assignment, iam_effective_access_cache, and more. Managed by Prisma at `packages/database/prisma/platform/schema.prisma`.
- **Tenant schema** (38 base tables after Cycle 2 Steps 1–2): 5 from Cycle 0 foundation (school_config, school_feature_flags, grading_scales, custom_field_definitions, custom_field_values) + 18 SIS tables from Cycle 1 (sis_academic_years, sis_terms, sis_departments, sis_courses, sis_classes, sis_class_teachers, sis_enrollments, sis_families, sis_students, sis_staff, sis_guardians, sis_student_guardians, sis_family_members, sis_emergency_contacts, sis_student_notes, sis_absence_requests, sis_attendance_records, sis_attendance_evidence) + 15 Classroom tables from Cycle 2 (cls_lesson_types, cls_lessons, cls_assignment_types, cls_assignment_categories, cls_assignments, cls_assignment_questions, cls_answer_key_entries, cls_submissions, cls_submission_question_grades, cls_ai_grading_jobs, cls_grades, cls_gradebook_snapshots, cls_report_cards, cls_report_card_entries, cls_student_progress_notes). Plus 36 partition objects under sis_attendance_records (4 year partitions × 8 hash leaves + 4 year parents).
- Tenant migrations are SQL files in `packages/database/prisma/tenant/migrations/`, split by semicolons, each statement executed individually by `provision-tenant.ts`. **Caveat:** statements that start with `--` after trim are filtered out — keep header comments minimal or use `/* … */`.
- Tenant SQL must be idempotent: use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` for FK changes (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`).
- Enum-like columns use `TEXT + CHECK IN (…)` rather than PG `ENUM` types — `CREATE TYPE` isn't idempotent under the SQL splitter.

## Test Users (seeded, Keycloak)

| Email                       | Role                                 | Password   |
| --------------------------- | ------------------------------------ | ---------- |
| admin@demo.campusos.dev     | Platform Admin (all 444 permissions) | admin123   |
| principal@demo.campusos.dev | School Admin                         | admin123   |
| teacher@demo.campusos.dev   | Teacher (James Rivera)               | teacher123 |
| student@demo.campusos.dev   | Student (Maya Chen)                  | student123 |
| parent@demo.campusos.dev    | Parent (David Chen, Maya's father)   | parent123  |

Dev login: `POST /api/v1/auth/dev-login` with `{"email":"..."}` and `X-Tenant-Subdomain: demo` header.

## Design Documents (authoritative references)

Read these when you need table definitions, column details, ADR specifics, or permission descriptions:

- `docs/campusos-erd-v11.html` — Complete schema: all 840 tables with full column definitions, indexes, constraints, Kafka events, ADR cross-references
- `docs/campusos-architecture-review-v10.html` — 30 sections: system architecture, multi-tenancy, IAM, events, scalability, security
- `docs/campusos-function-library-v11.html` — 148 functions, 28 groups, 3 access tiers each
- `docs/campusos-dev-deployment-plan.html` — Build pipeline, environments, Wave 1 sequence
- `docs/campusos-business-strategy.html` — Pricing, team, GTM, community exchange
- `docs/campusos-cycle1-implementation-plan.html` — Cycle 1 plan: 11 steps for SIS + Attendance
- `docs/cycle1-cat-script.md` — Cycle 1 Customer Acceptance Test script (the Step 11 deliverable; reproducible end-to-end walkthrough)
- `docs/campusos-cycle2-implementation-plan.html` — Cycle 2 plan: 10 steps for Classroom + Assignments + Grading
- `docs/cycle2-cat-script.md` — Cycle 2 Customer Acceptance Test script (the Step 10 deliverable; live API + worker walkthrough)

## Conventions

- Tenant-scoped tables use SQL migrations in `packages/database/prisma/tenant/migrations/`
- Platform tables use Prisma schema in `packages/database/prisma/platform/schema.prisma`
- NestJS modules follow the pattern: module.ts, service.ts, controller.ts, dto/ in `apps/api/src/<domain>/`
- Every API endpoint needs `@RequirePermission()` unless marked `@Public()`. New global guards must be registered in `AppModule` (not in submodules) so guard ordering stays deterministic
- Use `TenantPrismaService.executeInTenantContext(fn)` for **single-statement** tenant queries (read or single-table write). Internally runs inside a `$transaction` with `SET LOCAL search_path` to keep tenant scope pinned to one connection — never use a session-level SET on a pooled client.
- Use `TenantPrismaService.executeInTenantTransaction(fn)` for **multi-statement** writes that must be atomic (e.g. cross-schema inserts that span platform + tenant tables, like `POST /students`)
- Multi-persona reads (any endpoint where multiple personType values hold the gating permission) MUST resolve the caller via `ActorContextService.resolveActor(...)` and apply a row-level filter. Don't trust `@RequirePermission` alone for row scope. Pattern: see `apps/api/src/sis/student.service.ts::visibilityClause` (parent → linked children, student → self, teacher → assigned-class enrollments, admin → no filter).
- Class-bound writes (attendance, grading) MUST gate on the link table (e.g. `sis_class_teachers`) before mutating; school admins bypass. The `att-001:write` code is held school-wide by every teacher, so the link-table check is the actual access gate.
- Admin status comes from the **current tenant's scope chain**, never across all cached scopes. Use `permissionCheckService.hasAnyPermissionInTenant(accountId, tenant.schoolId, codes)` or read `actor.isSchoolAdmin`. The previous `hasAnyPermissionAcrossScopes` helper has been removed for this reason.
- Tenant tables aren't in the Prisma schema — query via `client.$queryRawUnsafe<RowType[]>(sql, ...args)` / `client.$executeRawUnsafe(sql, ...args)`. Always cast UUID args explicitly: `$1::uuid`. Same for `$1::date`. Prisma sends raw query parameters as TEXT and Postgres won't auto-coerce
- Schema-qualify cross-schema reads (`platform.iam_person`) to be explicit
- DTOs use `class-validator` + `class-transformer` (global ValidationPipe in `main.ts`). The `packages/shared` Zod option is unused so far
- Kafka events follow `{domain}.{entity}.{verb}` naming (e.g. `att.student.marked_tardy`)
- No DROP TABLE, no DROP COLUMN in migrations. Additive only. (Pre-deployment edits to fix architectural errors are categorically different — re-provision the tenant.)
- Snake_case in SQL, camelCase in TypeScript. Map at the service layer with a `rowToDto` helper
- **Web auth gating uses `personType` + permission codes from `/auth/me`** for menu visibility and persona routing only. Backend `PermissionGuard` is the authoritative access check on every request.
- **Web fetch wrapper (`apps/web/src/lib/api-client.ts`)** sends `X-Tenant-Subdomain: demo` (override via `NEXT_PUBLIC_TENANT_SUBDOMAIN`) and Bearer token. On 401 it single-flights `/auth/refresh` and retries once; on terminal 401 it calls the registered `onUnauthenticated` handler which clears state and routes to `/login`.

## Claude Code Operating Rules

After completing each step and before each commit:

1. Update this CLAUDE.md to reflect current status, new conventions, new commands, and any schema changes. The "Project Status" section must always state exactly which steps are done and which remain.
2. Update the active HANDOFF document (currently HANDOFF-CYCLE1.md) with any new tables, endpoints, seed data changes, deviations from the ERD, bug fixes, or architecture decisions. Update the step status table. Document what was built in the same level of detail as the existing completed steps.
3. Include both files in every commit.

These two files are the source of truth that external architecture reviewers read. If they are stale, reviewers cannot do their job. A step is NOT complete until both files are current. Treat updating these files as part of the definition of done, not as a follow-up task.

When starting a new cycle, create the new HANDOFF-CYCLE{N}.md from the template structure used in HANDOFF-CYCLE1.md before beginning Step 1.
