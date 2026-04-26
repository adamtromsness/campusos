# Cycle 1 Handoff — SIS Core + Attendance

**Status:** Steps 1–5 of 11 complete. Steps 6–11 remain.
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle1-implementation-plan.html`

This document was updated after the Cycle 1 architecture review. The original commits (`5cccc43`, `57ec312`) introduced 5 architecture deviations; review found 3 valid blockers, all now fixed in-place. The "deviations" section below tracks only the items that remain.

---

## Step status

| Step | Title | Status |
|---:|---|---|
| 1 | Academic Structure Schema | Done |
| 2 | Student & Family Schema | Done |
| 3 | Attendance Schema | Done (partitioned per ADR-007) |
| 4 | Seed Data — A Living School | Done |
| 4b | Role-permission mappings (gap fix) | Done |
| 5 | SIS NestJS Module | Done |
| 6 | Attendance NestJS Module | Not started |
| 7 | UI Shell & Design System | Not started |
| 8 | Teacher Dashboard | Not started |
| 9 | Attendance Taking UI | Not started |
| 10 | Parent Dashboard & Attendance View | Not started |
| 11 | Vertical Slice Integration Test | Not started |

The vertical-slice exit deliverable (teacher marks Maya tardy → parent sees notification) is not yet wired. Steps 6–11 build it.

---

## Schema changes — three tenant migrations

All migrations live in `packages/database/prisma/tenant/migrations/`. They are applied by `pnpm --filter @campusos/database provision --subdomain=<name>`. Tenant table count: **5 (Cycle 0 foundation) + 18 (SIS) = 23 base tables, plus 4 partition parents + 32 leaf partitions for `sis_attendance_records`**.

### `002_sis_academic_structure.sql` — 7 tables

| Table | Purpose | Key columns |
|---|---|---|
| `sis_academic_years` | One row per school year | `school_id`, `name`, `start_date`, `end_date`, `is_current` |
| `sis_terms` | Subdivisions of a year | `academic_year_id`, `term_type` ∈ {SEMESTER, QUARTER, TRIMESTER, FULL_YEAR} |
| `sis_departments` | Math, ELA, Science, etc. | `school_id`, `name`, `head_employee_id` (soft) |
| `sis_courses` | Course catalogue | `department_id`, `code`, `name`, `credit_hours`, `grade_level` |
| `sis_classes` | A specific section | `course_id`, `academic_year_id`, `term_id`, `section_code`, `room`, `max_enrollment` |
| `sis_class_teachers` | Teacher↔class link | `class_id`, `teacher_employee_id` (soft), `is_primary_teacher` |
| `sis_enrollments` | Student↔class link | `student_id`, `class_id`, `status` ∈ {ACTIVE, DROPPED, TRANSFERRED}, `enrolled_at` |

**Notable indexes:**
- `sis_academic_years_one_current_uq` — partial unique `WHERE is_current = true` (one current year per school)
- `sis_enrollments_active_uq` — partial unique `(student_id, class_id) WHERE status = 'ACTIVE'`

### `003_sis_students_and_families.sql` — 8 tables + forward-fix

| Table | Purpose | Key columns |
|---|---|---|
| `sis_families` | Household unit | `family_name`, `created_by` (soft → platform_users), `platform_family_id` (soft), `organisation_id` (soft) |
| `sis_students` | School-scoped student | `platform_student_id` (UNIQUE NOT NULL, soft → platform_students), `school_id`, `student_number`, `grade_level`, `homeroom_class_id → sis_classes`, `enrollment_status` ∈ {ENROLLED, TRANSFERRED, GRADUATED, WITHDRAWN} |
| `sis_staff` | School-scoped staff | `person_id` (UNIQUE NOT NULL, soft → iam_person), `account_id` (UNIQUE NOT NULL, soft → platform_users), `staff_type` ∈ {TEACHER, ADMINISTRATOR, SUPPORT, COUNSELLOR} |
| `sis_guardians` | School-scoped guardian | `person_id` (soft → iam_person), `account_id` (UNIQUE soft → platform_users, nullable for non-portal), `family_id`, `relationship`, `preferred_contact_method` |
| `sis_student_guardians` | Link triggering IAM access derivation | `student_id`, `guardian_id`, `has_custody`, `is_emergency_contact`, `receives_reports`, `portal_access`, `portal_access_scope` |
| `sis_family_members` | Everyone in the household | `family_id`, `person_id` (soft → iam_person), `person_type`, `relationship_to_family`, `is_primary_contact` |
| `sis_emergency_contacts` | Authorised pickup contacts | `student_id`, `name`, `phone`, `is_authorised_pickup` |
| `sis_student_notes` | Pastoral observations | `student_id`, `author_id` (soft), `note_type`, `note_text`, `is_parent_visible`, `is_confidential` |

All references to `platform.*` tables are **soft references** per ADR-001/020 — UUID columns with no DB-level FK constraint. App-layer Prisma lookups validate. Intra-tenant FKs (e.g. `sis_students.homeroom_class_id → sis_classes`) remain enforced.

**Forward-fix:** Adds the `sis_enrollments.student_id → sis_students(id)` FK left open in 002 (sis_students didn't exist yet). Uses `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` because Postgres has no `ADD CONSTRAINT IF NOT EXISTS`.

**ADR-055 identity contract:** sis_students references identity through the `platform_students.person_id → iam_person.id` projection chain (ERD does not declare a direct `sis_students.person_id`). sis_staff and sis_guardians use direct soft refs to `iam_person`.

### `004_sis_attendance.sql` — 3 tables (sis_attendance_records is partitioned)

| Table | Purpose | Key columns |
|---|---|---|
| `sis_absence_requests` | Parent-submitted absence notifications | `student_id`, `submitted_by` (soft), `absence_date_from/to`, `request_type`, `reason_category`, `status`, `reviewed_by` (soft) |
| `sis_attendance_records` | Main attendance fact table — **partitioned per ADR-007** | `school_year` (RANGE partition key), `class_id` (HASH partition key), `student_id`, `date`, `period`, `status`, `confirmation_status`, `evidence_source`, `marked_by` (soft), `parent_explanation`, `absence_request_id` |
| `sis_attendance_evidence` | Bus/door scans, photos, notes | `record_id` (soft ref to records — FK can't enforce against partitioned parent), `record_school_year`, `record_class_id`, `evidence_type`, `source_ref_id`, `note_text` |

**Partitioning structure (ADR-007):**
```
sis_attendance_records  PARTITION BY RANGE (school_year)
├── _2024_25            FOR VALUES FROM ('2024-08-01') TO ('2025-08-01')
│   └── _h0 .. _h7      PARTITION BY HASH (class_id) MODULUS 8
├── _2025_26            FOR VALUES FROM ('2025-08-01') TO ('2026-08-01')
│   └── _h0 .. _h7
├── _2026_27            FOR VALUES FROM ('2026-08-01') TO ('2027-08-01')
│   └── _h0 .. _h7
└── _2027_28            FOR VALUES FROM ('2027-08-01') TO ('2028-08-01')
    └── _h0 .. _h7
```

- Composite PRIMARY KEY: `(id, school_year, class_id)` — declarative partitioning requires partition keys in unique constraints.
- Natural-key unique: `(school_year, class_id, student_id, date, period)`.
- BRIN index on `date` per ADR-007 (declared on parent, propagates to leaves).
- Btree indexes propagate from parent: `(class_id, date)`, `(student_id, date)`, `(school_id, date)`, partial `(absence_request_id) WHERE absence_request_id IS NOT NULL`, partial `(class_id, date) WHERE confirmation_status='PRE_POPULATED'`.

**Verified:** seed inserts 41 records that route to 5 of the 8 hash buckets in the 2025–26 year partition.

**Future maintenance:** When a new academic year starts, add a new year partition + 8 hash sub-partitions. Otherwise a school with `school_year = 2028-08-01` will fail to insert. A scheduled job or manual migration is the path forward (M0 Platform module concern, out of scope for Cycle 1).

---

## Seed data — `seed-sis.ts`

Idempotent. Uses lookup-or-create on platform identities (so a tenant rebuild can replay without manual cleanup). Skips entirely if `sis_students` already populated. Invoked via `pnpm --filter @campusos/database seed:sis`.

| Entity | Count | Detail |
|---|---:|---|
| Academic year | 1 | 2025–2026 (`is_current=true`), runs Aug 15 → Jun 15 |
| Terms | 2 | Fall 2025, Spring 2026 (both SEMESTER) |
| Departments | 4 | Mathematics, English Language Arts, Science, Social Studies |
| Courses | 6 | MATH-101 Algebra 1, MATH-201 Geometry, ELA-101 English 9, SCI-101 Biology, SCI-201 Chemistry, SS-101 World History |
| Classes | 6 | Period 1–6, all assigned to James Rivera, Spring 2026 term |
| sis_staff | 1 | James Rivera (TEACHER) |
| sis_class_teachers | 6 | All to James, all `is_primary_teacher=true` |
| iam_person + platform_students + sis_students | 15 | Maya Chen (existing) + 14 new across grades 9–10 |
| iam_person + platform_users + sis_guardians | 10 | David Chen (existing) + 9 new, all with portal access |
| sis_families | 8 | 5 of them have ≥2 sibling students |
| sis_family_members | ~33 | Students + guardians per family |
| sis_student_guardians | 20 | Each student linked to every guardian in their family |
| sis_enrollments | 41 | Each class 5–8 students; grade 9 in P1–P4, grade 10 in P5–P6 |
| sis_attendance_records | 41 | Today's date, all PRESENT/PRE_POPULATED, routed across 5 hash partitions |

**Test users** (login via `POST /api/v1/auth/dev-login` with `X-Tenant-Subdomain: demo`):

| Email | iam_person | Role | sis_* role |
|---|---|---|---|
| `admin@demo.campusos.dev` | Platform Admin | Platform Admin (PLATFORM scope) | — |
| `principal@demo.campusos.dev` | Sarah Mitchell | School Admin (SCHOOL scope) | — |
| `teacher@demo.campusos.dev` | James Rivera | Teacher (SCHOOL scope) | `sis_staff` (TEACHER) |
| `student@demo.campusos.dev` | Maya Chen | Student (SCHOOL scope) | `sis_students` (S-1001, grade 9) |
| `parent@demo.campusos.dev` | David Chen | Parent (SCHOOL scope) | `sis_guardians` (linked to Maya) |

---

## Permission catalogue — Step 4b

Cycle 0 only assigned permissions to Platform Admin. Cycle 1 added baseline mappings for the other 5 roles. The catalogue source-of-truth is `packages/database/data/permissions.json` (148 functions × 3 tiers = **444 codes**, aligned with function library v11). The role-permission spec lives in `packages/database/src/seed-iam.ts` (the `rolePermsSpec` block). Cache rebuild via `tsx src/build-cache.ts`.

The seed reconciler in `seed-iam.ts` handles add/remove of catalogue codes — when `permissions.json` changes, stale codes (and their `role_permissions` rows) are deleted, new codes are inserted.

| Role | # codes | Permission codes |
|---|---:|---|
| Platform Admin | 444 | All 148 functions × 3 tiers (read, write, admin) |
| School Admin | 444 | Same as Platform Admin, but at SCHOOL scope |
| Teacher | 25 | `att-001:read/write`, `att-002:write`, `att-003:write`, `att-004:read`, `att-005:read/write`, `stu-001:read`, `tch-001:read/write`, `tch-002:read/write`, `tch-003:read/write`, `tch-006:read/write`, `com-001:read/write`, `com-002:read/write`, `sch-001:read`, `sch-003:read`, `beh-001:read/write`, `cou-002:write` |
| Parent | 10 | `att-001:read`, `att-004:read/write`, `stu-001:read`, `tch-003:read`, `tch-004:read`, `com-001:read/write`, `com-002:read`, `sch-003:read` |
| Student | 13 | `att-001:read`, `stu-001:read`, `tch-001:read`, `tch-002:read/write`, `tch-003:read`, `tch-006:read/write`, `tch-007:read/write`, `com-001:read/write`, `sch-003:read` |
| Staff | 5 | `stu-001:read`, `att-001:read`, `com-001:read/write`, `sch-003:read` |

Cache state after `tsx src/build-cache.ts`: admin 444, principal 444, teacher 25, student 13, parent 10.

These are intentionally **conservative defaults** for Cycle 1. Real schools will need richer per-tenant role policy in later cycles.

---

## API endpoints — Step 5

New module: `apps/api/src/sis/`. All routes are tenant-scoped (require `X-Tenant-Subdomain` header in dev) and `@RequirePermission`-protected.

| Verb | Path | Permission(s) | Notes |
|---|---|---|---|
| GET | `/api/v1/students` | `stu-001:read` | filters: `classId`, `gradeLevel`, `enrollmentStatus` |
| GET | `/api/v1/students/:id` | `stu-001:read` | |
| GET | `/api/v1/students/:id/guardians` | `stu-001:read` | per-link booleans (custody, emergency, portal scope) |
| GET | `/api/v1/students/my-children` | `stu-001:read` | resolves via `req.user.personId` → `sis_guardians.person_id` |
| POST | `/api/v1/students` | `stu-001:write` | creates `iam_person` + `platform_students` + `sis_students` per ADR-055 |
| PATCH | `/api/v1/students/:id` | `stu-001:write` | only school-scoped fields (identity is immutable here) |
| GET | `/api/v1/classes` | `stu-001:read` | filters: `termId`, `courseId`, `academicYearId`, `gradeLevel` |
| GET | `/api/v1/classes/:id` | `stu-001:read` | |
| GET | `/api/v1/classes/my` | `stu-001:read` OR `att-001:read` | teacher's classes, resolved via `req.user.personId` |
| GET | `/api/v1/classes/:id/roster` | `stu-001:read` OR `att-001:read` | active enrollments, the key endpoint for the attendance UI |

**Module structure:**
```
apps/api/src/sis/
├── sis.module.ts            (registered in AppModule)
├── student.service.ts       (StudentService)
├── class.service.ts         (ClassService)
├── family.service.ts        (FamilyService)
├── student.controller.ts    (6 endpoints)
├── class.controller.ts      (4 endpoints)
└── dto/
    ├── student.dto.ts       (CreateStudentDto, UpdateStudentDto, StudentResponseDto, ListStudentsQueryDto)
    ├── class.dto.ts         (ClassResponseDto, RosterEntryDto, ListClassesQueryDto)
    └── guardian.dto.ts      (GuardianResponseDto, StudentGuardianDto)
```

**Tenant query pattern** (all SIS services follow this):

```typescript
return this.tenantPrisma.executeInTenantContext(async (client) => {
  return client.$queryRawUnsafe<RowType[]>(
    'SELECT s.id, ... FROM sis_students s ' +
    'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
    'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
    'WHERE s.id = $1::uuid',
    studentId,
  );
});
```

Cross-schema **joins** (read paths) remain — the search_path makes them ergonomic, and read-side platform integration is allowed by ADR-001. What's prohibited is DB-enforced **FK constraints** from tenant tables to platform tables; we have none.

Tenant tables aren't in the Prisma schema (they're SQL-migrated), so all SIS table access uses `$queryRawUnsafe` / `$executeRawUnsafe` with explicit `::uuid` and `::date` casts.

---

## Security fixes — `PermissionGuard`

Two pre-existing bugs surfaced during Step 5 smoke tests. Both would have blocked Step 6+ silently.

### Bug 1 — fail-open when `request.user` not yet populated

**Symptom:** Parent (no `stu-001:write`) could `POST /api/v1/students` and got HTTP 201.

**Root cause:** `AuthGuard` was registered as `APP_GUARD` in `AuthModule`; `TenantGuard` and `PermissionGuard` in `AppModule`. NestJS's actual resolution order put `PermissionGuard` first. The guard had a fallback `if (!user) return true; // defer to AuthGuard` — i.e. fail-open whenever Auth hadn't run yet.

**Fix:**
- Removed `APP_GUARD AuthGuard` registration from `AuthModule`.
- Declared all 3 APP_GUARDs in `AppModule` in explicit Auth → Tenant → Permission order.
- Changed `PermissionGuard` to throw `ForbiddenException('Authentication context missing')` when `request.user` is absent.

### Bug 2 — Platform Admins denied on tenant-scoped requests

**Symptom:** `admin@` (assigned at PLATFORM scope) got 403 on every tenant endpoint.

**Root cause:** `resolveScopeId(schoolId)` returned only the SCHOOL scope when one existed, so the cache lookup `(admin.account_id, schoolScope.id)` always missed.

**Fix:** Replaced with `resolveScopeChain(schoolId)` returning `[schoolScope, platformScope]` (most-specific first). The guard probes each scope in order and admits on the first match. Minimum-viable scope inheritance per the spirit of ADR-036; full parent-scope traversal can come later.

### Verification matrix (after rebuild)

| Caller | Endpoint | Required | Expected | Actual |
|---|---|---|---|---|
| no token | `/guard-test/admin-only` | `sys-001:admin` | 401 | 401 |
| parent | `/guard-test/admin-only` | `sys-001:admin` | 403 | 403 |
| parent | `/guard-test/grades` | `tch-003:write` | 403 | 403 |
| parent | `/guard-test/attendance` | `att-001:read` | 200 | 200 |
| teacher | `/guard-test/grades` | `tch-003:write` | 200 | 200 |
| admin | `/guard-test/admin-only` | `sys-001:admin` | 200 | 200 |
| admin | `/classes/my` | school-scoped | 200 | 200 |
| parent | `POST /students` | `stu-001:write` | 403 | 403 |
| admin | `POST /students` | `stu-001:write` | 201 | 201 |
| admin | `POST /students` (dup `studentNumber`) | — | 409 | 409 |

---

## Architecture review response — what changed

Initial peer review flagged 5 blockers; verification against the actual docs confirmed 3 valid, 2 incorrect. The 3 valid ones are now fixed:

| # | Reviewer claim | Verified? | Resolution |
|---:|---|---|---|
| 1 | Cross-schema FKs from tenant→platform violate ADR-001/020 | ✅ Valid | All 12 cross-schema FK constraints removed across 003 and 004. Columns kept as plain UUIDs. App-layer Prisma lookups validate. |
| 2 | `sis_students` missing direct `person_id` FK per ADR-055 | ❌ Incorrect | ERD does not declare `person_id` on `sis_students`. ADR-055 satisfied via the projection chain `sis_students → platform_students.person_id → iam_person.id`. **No change.** |
| 3 | `sis_attendance_records` not partitioned per ADR-007 | ✅ Valid | Implemented `RANGE(school_year) → HASH(class_id, 8 buckets)` per ERD. 4 year partitions × 8 hash buckets = 32 leaf partitions. Composite PK `(id, school_year, class_id)`. BRIN index on `date`. FK from `sis_attendance_evidence` removed (soft ref now). |
| 4 | `sis_absence_requests` ERD parity | ❌ Incorrect | Migration already had every cited field (`school_id NOT NULL`, `reason_text NOT NULL`, `supporting_document_s3_key`, `reviewer_notes`, partial pending index). **No change.** |
| 5 | Function catalogue 142 vs library v11's 148 | ✅ Valid | `permissions.json` now has 148 functions (444 codes). Removed 5 stale (PFL-001/002/003, SAF-005, FRM-003), added 11 new (ACH-001/002/003, ATH-007/008/009/010, CRM-006, PRC-005, PUB-004, IT-009). `seed-iam.ts` made reconciling so it handles future catalogue updates. |

---

## Remaining deviations / known gaps

| # | Area | ERD / plan says | What we built | Why |
|---:|---|---|---|---|
| 1 | Enum-like columns | ERD shows native PG `ENUM` types | `TEXT + CHECK IN (...)` | The tenant SQL splitter (statements separated on `;`, dropped if starting with `--`) can't run `CREATE TYPE` idempotently on re-provision. ENUM evolution requires `ALTER TYPE` ceremony that doesn't fit per-tenant migrations. CHECK gives the same domain enforcement. |
| 2 | DTO location | Plan: "Zod schemas in `packages/shared`" | class-validator DTOs in `apps/api/src/sis/dto/` | Existing API has class-validator wired globally (ValidationPipe in main.ts); `packages/shared` lists Zod as a dep but no DTOs yet. Matching the wired pattern. |
| 3 | Number of endpoints in Step 5 | Plan says ~15 | 9 delivered (10 with dual-permission ones) | Built only the endpoints that have a clear consumer in Cycle 1's vertical slice. Additional family/guardian list endpoints can land when Step 7+ UIs need them. |
| 4 | Soft FK targets | Plan: `FK(hr_employees …)` for `head_employee_id`, `teacher_employee_id`, `author_id` | Plain UUID columns | `hr_employees` table doesn't exist yet (HR module). Soft references for now. |
| 5 | `sis_students.withdrawal_id` | ERD soft-refs `enr_withdrawal_requests` | Plain UUID | Enrollment module not in scope. |
| 6 | Scope inheritance in `PermissionGuard` | ADR-036 implies full parent-scope traversal | Two-level `[school, platform]` chain | Minimum viable to unblock Platform Admins. Add full traversal (district, department, class) when those scope levels gain users. |

### Other open items

- **Atomicity of `POST /students`.** Currently does `iam_person.create` → `platform_students.create` → raw `INSERT INTO sis_students`. If the SIS insert fails after the platform inserts succeed, we leak orphan rows. Mitigated by a pre-check for duplicate `student_number`; a real race could still bypass. Wrap in a Prisma `$transaction`.
- **`PATCH /students` cannot change `firstName`/`lastName`.** Per ADR-055, identity is immutable from sis_students. To rename a student, the API needs a separate mutation that updates `iam_person`. Not currently exposed.
- **No PII protection on student lookups.** Any user with `stu-001:read` sees all students at the school. Cycle 1 doesn't model "who can see whom" beyond role; future hardening per `iam_relationship_access_rule` derivations.
- **Bigint serialization.** `client.$queryRawUnsafe` returns Postgres `bigint` columns as JS bigint. We coerce inline with `(SELECT count(*)::int FROM …)`. Watch for this in future raw queries.
- **`build-cache.ts` is a manual step.** Not invoked by `pnpm seed`. Anyone editing role-permission mappings has to remember to rebuild. Worth wiring into `seed-iam.ts` as a final step.
- **`PermissionGuard.resolveScopeChain` queries Postgres on every request.** No caching on the scope lookup itself. Acceptable for now; reach for Redis when latency matters.
- **Partition rotation for `sis_attendance_records`.** Year partitions cover 2024-08 through 2028-08. After 2028-08-01, inserts will fail. A scheduled job or annual migration is needed (M0 Platform concern).
- **Soft-reference health monitoring.** ADR-020/028 prescribes a `platform_reference_health` background monitor for soft FKs. Not yet implemented; soft refs currently rely solely on app-layer validation.

---

## What Step 6 needs from Cycle 1's foundation

The Attendance module (Step 6) will:

- **Consume** `ClassService.getRoster(classId)` to know who to pre-populate.
- **Consume** `ClassService.listForTeacherPerson(personId)` for the teacher dashboard's "today's classes".
- **Consume** `StudentService.listForGuardianPerson(personId)` for the parent's child list.
- **Use** the existing Teacher permissions (`att-001:read/write`, `att-002:write`, `att-003:write`, `att-004:read`) — already in the cache.
- **Use** the existing Parent permissions (`att-001:read`, `att-004:read/write`) — already in the cache.
- **Insert into** the partitioned `sis_attendance_records`. Inserts must include `school_year`, `class_id`, and `id` (composite PK); pass `school_year = '2025-08-15'::date` for the current academic year.
- **Watch out for partition pruning.** Queries by `class_id` + `date` (or implicit `school_year`) will prune correctly. Queries by `id` alone won't and will scan all 32 leaves — pass `school_year` and `class_id` alongside `id` for efficient PATCH.
- **Emit** Kafka events `att.attendance.marked`, `att.attendance.confirmed`, `att.student.marked_tardy`, `att.student.marked_absent`. Kafka client wired in Cycle 0; consumers come in Cycle 3.

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
pnpm --filter @campusos/database seed:sis         # 15 students, 10 guardians, 8 families, today's attendance
pnpm --filter @campusos/database exec tsx src/build-cache.ts  # rebuild iam_effective_access_cache

# 4. Start the API
pnpm --filter @campusos/api dev
# → http://localhost:4000
# → http://localhost:4000/api/docs (Swagger)

# 5. Smoke-test
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"teacher@demo.campusos.dev"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])')
curl -s http://localhost:4000/api/v1/classes/my \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Subdomain: demo'
```

### Rebuilding from a corrupted state

```bash
# Drop tenants, clean platform-side identities, re-run the pipeline.
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
  DROP SCHEMA IF EXISTS tenant_demo CASCADE;
  DROP SCHEMA IF EXISTS tenant_test CASCADE;
"
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test
pnpm --filter @campusos/database seed:sis        # idempotent — lookup-or-create on platform identities
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```
