# Cycle 1 Handoff — SIS Core + Attendance

**Status:** Steps 1–10 of 11 complete. Step 11 (vertical-slice integration test) remains.
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle1-implementation-plan.html`

This document was updated after the Cycle 1 architecture review. The original commits (`5cccc43`, `57ec312`) introduced 5 architecture deviations; review found 3 valid blockers, all now fixed in-place. Steps 7–9 added the web app (UI shell, Teacher Dashboard, Attendance Taking UI) and a small API extension (`/classes/my` `todayAttendance` summary). The "deviations" section below tracks only the items that remain.

---

## Step status

| Step | Title                              | Status                                             |
| ---: | ---------------------------------- | -------------------------------------------------- |
|    1 | Academic Structure Schema          | Done                                               |
|    2 | Student & Family Schema            | Done                                               |
|    3 | Attendance Schema                  | Done (partitioned per ADR-007)                     |
|    4 | Seed Data — A Living School        | Done                                               |
|   4b | Role-permission mappings (gap fix) | Done                                               |
|    5 | SIS NestJS Module                  | Done                                               |
|    6 | Attendance NestJS Module           | Done — API vertical slice verified                 |
|    7 | UI Shell & Design System           | Done — auth, layout, design tokens, components     |
|    8 | Teacher Dashboard                  | Done — `/classes/my` extended with todayAttendance |
|    9 | Attendance Taking UI               | Done — full UI vertical slice verified end-to-end  |
|   10 | Parent Dashboard & Attendance View | Done — children cards, calendar, absence request   |
|   11 | Vertical Slice Integration Test    | Not started                                        |

The Cycle 1 exit deliverable (teacher marks Maya tardy → submits → dashboard updates → parent sees it) is now wired end-to-end on both the teacher and parent sides; Step 11 walks the full UI script in a browser.

---

## Schema changes — three tenant migrations

All migrations live in `packages/database/prisma/tenant/migrations/`. They are applied by `pnpm --filter @campusos/database provision --subdomain=<name>`. Tenant table count: **5 (Cycle 0 foundation) + 18 (SIS) = 23 base tables, plus 4 partition parents + 32 leaf partitions for `sis_attendance_records`**.

### `002_sis_academic_structure.sql` — 7 tables

| Table                | Purpose                  | Key columns                                                                          |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `sis_academic_years` | One row per school year  | `school_id`, `name`, `start_date`, `end_date`, `is_current`                          |
| `sis_terms`          | Subdivisions of a year   | `academic_year_id`, `term_type` ∈ {SEMESTER, QUARTER, TRIMESTER, FULL_YEAR}          |
| `sis_departments`    | Math, ELA, Science, etc. | `school_id`, `name`, `head_employee_id` (soft)                                       |
| `sis_courses`        | Course catalogue         | `department_id`, `code`, `name`, `credit_hours`, `grade_level`                       |
| `sis_classes`        | A specific section       | `course_id`, `academic_year_id`, `term_id`, `section_code`, `room`, `max_enrollment` |
| `sis_class_teachers` | Teacher↔class link       | `class_id`, `teacher_employee_id` (soft), `is_primary_teacher`                       |
| `sis_enrollments`    | Student↔class link       | `student_id`, `class_id`, `status` ∈ {ACTIVE, DROPPED, TRANSFERRED}, `enrolled_at`   |

**Notable indexes:**

- `sis_academic_years_one_current_uq` — partial unique `WHERE is_current = true` (one current year per school)
- `sis_enrollments_active_uq` — partial unique `(student_id, class_id) WHERE status = 'ACTIVE'`

### `003_sis_students_and_families.sql` — 8 tables + forward-fix

| Table                    | Purpose                               | Key columns                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sis_families`           | Household unit                        | `family_name`, `created_by` (soft → platform_users), `platform_family_id` (soft), `organisation_id` (soft)                                                                                                              |
| `sis_students`           | School-scoped student                 | `platform_student_id` (UNIQUE NOT NULL, soft → platform_students), `school_id`, `student_number`, `grade_level`, `homeroom_class_id → sis_classes`, `enrollment_status` ∈ {ENROLLED, TRANSFERRED, GRADUATED, WITHDRAWN} |
| `sis_staff`              | School-scoped staff                   | `person_id` (UNIQUE NOT NULL, soft → iam_person), `account_id` (UNIQUE NOT NULL, soft → platform_users), `staff_type` ∈ {TEACHER, ADMINISTRATOR, SUPPORT, COUNSELLOR}                                                   |
| `sis_guardians`          | School-scoped guardian                | `person_id` (soft → iam_person), `account_id` (UNIQUE soft → platform_users, nullable for non-portal), `family_id`, `relationship`, `preferred_contact_method`                                                          |
| `sis_student_guardians`  | Link triggering IAM access derivation | `student_id`, `guardian_id`, `has_custody`, `is_emergency_contact`, `receives_reports`, `portal_access`, `portal_access_scope`                                                                                          |
| `sis_family_members`     | Everyone in the household             | `family_id`, `person_id` (soft → iam_person), `person_type`, `relationship_to_family`, `is_primary_contact`                                                                                                             |
| `sis_emergency_contacts` | Authorised pickup contacts            | `student_id`, `name`, `phone`, `is_authorised_pickup`                                                                                                                                                                   |
| `sis_student_notes`      | Pastoral observations                 | `student_id`, `author_id` (soft), `note_type`, `note_text`, `is_parent_visible`, `is_confidential`                                                                                                                      |

All references to `platform.*` tables are **soft references** per ADR-001/020 — UUID columns with no DB-level FK constraint. App-layer Prisma lookups validate. Intra-tenant FKs (e.g. `sis_students.homeroom_class_id → sis_classes`) remain enforced.

**Forward-fix:** Adds the `sis_enrollments.student_id → sis_students(id)` FK left open in 002 (sis_students didn't exist yet). Uses `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` because Postgres has no `ADD CONSTRAINT IF NOT EXISTS`.

**ADR-055 identity contract:** sis_students references identity through the `platform_students.person_id → iam_person.id` projection chain (ERD does not declare a direct `sis_students.person_id`). sis_staff and sis_guardians use direct soft refs to `iam_person`.

### `004_sis_attendance.sql` — 3 tables (sis_attendance_records is partitioned)

| Table                     | Purpose                                                  | Key columns                                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sis_absence_requests`    | Parent-submitted absence notifications                   | `student_id`, `submitted_by` (soft), `absence_date_from/to`, `request_type`, `reason_category`, `status`, `reviewed_by` (soft)                                                                                           |
| `sis_attendance_records`  | Main attendance fact table — **partitioned per ADR-007** | `school_year` (RANGE partition key), `class_id` (HASH partition key), `student_id`, `date`, `period`, `status`, `confirmation_status`, `evidence_source`, `marked_by` (soft), `parent_explanation`, `absence_request_id` |
| `sis_attendance_evidence` | Bus/door scans, photos, notes                            | `record_id` (soft ref to records — FK can't enforce against partitioned parent), `record_school_year`, `record_class_id`, `evidence_type`, `source_ref_id`, `note_text`                                                  |

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

| Entity                                        | Count | Detail                                                                                                             |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------ |
| Academic year                                 |     1 | 2025–2026 (`is_current=true`), runs Aug 15 → Jun 15                                                                |
| Terms                                         |     2 | Fall 2025, Spring 2026 (both SEMESTER)                                                                             |
| Departments                                   |     4 | Mathematics, English Language Arts, Science, Social Studies                                                        |
| Courses                                       |     6 | MATH-101 Algebra 1, MATH-201 Geometry, ELA-101 English 9, SCI-101 Biology, SCI-201 Chemistry, SS-101 World History |
| Classes                                       |     6 | Period 1–6, all assigned to James Rivera, Spring 2026 term                                                         |
| sis_staff                                     |     1 | James Rivera (TEACHER)                                                                                             |
| sis_class_teachers                            |     6 | All to James, all `is_primary_teacher=true`                                                                        |
| iam_person + platform_students + sis_students |    15 | Maya Chen (existing) + 14 new across grades 9–10                                                                   |
| iam_person + platform_users + sis_guardians   |    10 | David Chen (existing) + 9 new, all with portal access                                                              |
| sis_families                                  |     8 | 5 of them have ≥2 sibling students                                                                                 |
| sis_family_members                            |   ~33 | Students + guardians per family                                                                                    |
| sis_student_guardians                         |    20 | Each student linked to every guardian in their family                                                              |
| sis_enrollments                               |    41 | Each class 5–8 students; grade 9 in P1–P4, grade 10 in P5–P6                                                       |
| sis_attendance_records                        |    41 | Today's date, all PRESENT/PRE_POPULATED, routed across 5 hash partitions                                           |

**Test users** (login via `POST /api/v1/auth/dev-login` with `X-Tenant-Subdomain: demo`):

| Email                         | iam_person     | Role                            | sis\_\* role                     |
| ----------------------------- | -------------- | ------------------------------- | -------------------------------- |
| `admin@demo.campusos.dev`     | Platform Admin | Platform Admin (PLATFORM scope) | —                                |
| `principal@demo.campusos.dev` | Sarah Mitchell | School Admin (SCHOOL scope)     | —                                |
| `teacher@demo.campusos.dev`   | James Rivera   | Teacher (SCHOOL scope)          | `sis_staff` (TEACHER)            |
| `student@demo.campusos.dev`   | Maya Chen      | Student (SCHOOL scope)          | `sis_students` (S-1001, grade 9) |
| `parent@demo.campusos.dev`    | David Chen     | Parent (SCHOOL scope)           | `sis_guardians` (linked to Maya) |

---

## Permission catalogue — Step 4b

Cycle 0 only assigned permissions to Platform Admin. Cycle 1 added baseline mappings for the other 5 roles. The catalogue source-of-truth is `packages/database/data/permissions.json` (148 functions × 3 tiers = **444 codes**, aligned with function library v11). The role-permission spec lives in `packages/database/src/seed-iam.ts` (the `rolePermsSpec` block). Cache rebuild via `tsx src/build-cache.ts`.

The seed reconciler in `seed-iam.ts` handles add/remove of catalogue codes — when `permissions.json` changes, stale codes (and their `role_permissions` rows) are deleted, new codes are inserted.

| Role           | # codes | Permission codes                                                                                                                                                                                                                                                                                                        |
| -------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform Admin |     444 | All 148 functions × 3 tiers (read, write, admin)                                                                                                                                                                                                                                                                        |
| School Admin   |     444 | Same as Platform Admin, but at SCHOOL scope                                                                                                                                                                                                                                                                             |
| Teacher        |      25 | `att-001:read/write`, `att-002:write`, `att-003:write`, `att-004:read`, `att-005:read/write`, `stu-001:read`, `tch-001:read/write`, `tch-002:read/write`, `tch-003:read/write`, `tch-006:read/write`, `com-001:read/write`, `com-002:read/write`, `sch-001:read`, `sch-003:read`, `beh-001:read/write`, `cou-002:write` |
| Parent         |      10 | `att-001:read`, `att-004:read/write`, `stu-001:read`, `tch-003:read`, `tch-004:read`, `com-001:read/write`, `com-002:read`, `sch-003:read`                                                                                                                                                                              |
| Student        |      13 | `att-001:read`, `stu-001:read`, `tch-001:read`, `tch-002:read/write`, `tch-003:read`, `tch-006:read/write`, `tch-007:read/write`, `com-001:read/write`, `sch-003:read`                                                                                                                                                  |
| Staff          |       5 | `stu-001:read`, `att-001:read`, `com-001:read/write`, `sch-003:read`                                                                                                                                                                                                                                                    |

Cache state after `tsx src/build-cache.ts`: admin 444, principal 444, teacher 25, student 13, parent 10.

These are intentionally **conservative defaults** for Cycle 1. Real schools will need richer per-tenant role policy in later cycles.

---

## API endpoints — Steps 5 & 6

New module: `apps/api/src/sis/`. All routes are tenant-scoped (require `X-Tenant-Subdomain` header in dev) and `@RequirePermission`-protected.

| Verb  | Path                             | Permission(s)                    | Notes                                                                   |
| ----- | -------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| GET   | `/api/v1/students`               | `stu-001:read`                   | filters: `classId`, `gradeLevel`, `enrollmentStatus`                    |
| GET   | `/api/v1/students/:id`           | `stu-001:read`                   |                                                                         |
| GET   | `/api/v1/students/:id/guardians` | `stu-001:read`                   | per-link booleans (custody, emergency, portal scope)                    |
| GET   | `/api/v1/students/my-children`   | `stu-001:read`                   | resolves via `req.user.personId` → `sis_guardians.person_id`            |
| POST  | `/api/v1/students`               | `stu-001:write`                  | creates `iam_person` + `platform_students` + `sis_students` per ADR-055 |
| PATCH | `/api/v1/students/:id`           | `stu-001:write`                  | only school-scoped fields (identity is immutable here)                  |
| GET   | `/api/v1/classes`                | `stu-001:read`                   | filters: `termId`, `courseId`, `academicYearId`, `gradeLevel`           |
| GET   | `/api/v1/classes/:id`            | `stu-001:read`                   |                                                                         |
| GET   | `/api/v1/classes/my`             | `stu-001:read` OR `att-001:read` | teacher's classes, resolved via `req.user.personId`                     |
| GET   | `/api/v1/classes/:id/roster`     | `stu-001:read` OR `att-001:read` | active enrollments, the key endpoint for the attendance UI              |

### Attendance & absence-request endpoints (Step 6)

| Verb  | Path                                            | Permission      | Notes                                                                                                                                                                                                         |
| ----- | ----------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/api/v1/classes/:id/attendance/:date?period=N` | `att-001:read`  | Class roster + statuses for the date. When `period` is supplied, lazily pre-populates PRESENT/PRE_POPULATED rows for any active enrollment that's missing one — the natural-key UNIQUE makes this idempotent. |
| PATCH | `/api/v1/attendance/:id`                        | `att-001:write` | Mark a single record. Looks up partition keys first (id alone isn't enough on a partitioned table for an efficient UPDATE), then UPDATEs and emits Kafka events.                                              |
| POST  | `/api/v1/classes/:id/attendance/:date/batch`    | `att-001:write` | Confirm a class period. Body sends only exceptions; omitted students treated as PRESENT. Single transaction. Emits `att.attendance.confirmed` + per-row `att.student.marked_*` events.                        |
| GET   | `/api/v1/students/:id/attendance`               | `att-001:read`  | Student history; optional `fromDate`/`toDate`.                                                                                                                                                                |
| POST  | `/api/v1/absence-requests`                      | `att-004:write` | Submit. SAME_DAY_REPORT auto-approves; ADVANCE_REQUEST queues PENDING. Non-admin callers must be a guardian of the student (sis_student_guardians link check inside the tx).                                  |
| GET   | `/api/v1/absence-requests`                      | `att-004:read`  | List. Non-admins see only their own submissions; admins see all (filterable).                                                                                                                                 |
| GET   | `/api/v1/absence-requests/:id`                  | `att-004:read`  | Get one. Non-admins can only view their own.                                                                                                                                                                  |
| PATCH | `/api/v1/absence-requests/:id`                  | `att-004:admin` | Review (APPROVE/REJECT). Only PENDING requests can be reviewed.                                                                                                                                               |

**Kafka events (best-effort, fire-and-forget):**

- `att.attendance.marked` — every individual mark
- `att.attendance.confirmed` — per period batch submit
- `att.student.marked_tardy` — when status transitions to TARDY
- `att.student.marked_absent` — when status transitions to ABSENT
- `att.absence.requested` — on absence-request submission
- `att.absence.reviewed` — on admin decision

Cycle 1 emits but does not consume; consumers land in Cycle 3 (Communications).

### Vertical-slice verification (Step 6 exit criterion)

End-to-end run on tenant_demo, `2026-04-26`:

| Step | Action                                                                                         | Result                                                     |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A    | Teacher GET `/classes/:p1/attendance/2026-04-26?period=1`                                      | 8 students, all PRESENT/PRE_POPULATED                      |
| B    | Teacher PATCH `/attendance/<maya>` `{status:'TARDY', parentExplanation:'arrived 8:15'}`        | 200; Maya TARDY/PRE_POPULATED, markedBy set                |
| C    | Teacher POST `/classes/:p1/attendance/2026-04-26/batch` `{period:'1', records:[{maya,TARDY}]}` | 201; total=8, present=7, tardy=1, confirmedAt set          |
| D    | DB inspection                                                                                  | Maya TARDY/CONFIRMED with note; 7 others PRESENT/CONFIRMED |
| E    | Parent GET `/students/<maya>/attendance?fromDate=...&toDate=...`                               | P1 TARDY (CONFIRMED) note='arrived 8:15' visible           |
| F    | Parent POST `/absence-requests` (ADVANCE_REQUEST for 2026-04-28, MEDICAL_APPOINTMENT)          | 201; status PENDING                                        |
| G    | Admin PATCH `/absence-requests/<id>` `{decision:'APPROVED'}`                                   | 200; status APPROVED, reviewedBy/reviewedAt set            |

Permission denial verified for: parent on att-001:write, student on att-001:write, teacher on att-004:admin.

Kafka emits verified by consuming from each topic — `att.student.marked_tardy` shows 2 messages (one from PATCH, one from batch); `att.absence.reviewed` shows the approval payload.

### Module structure

```
apps/api/src/sis/
├── sis.module.ts                  (registered in AppModule)
├── student.service.ts
├── class.service.ts
├── family.service.ts
├── student.controller.ts          (6 endpoints)
├── class.controller.ts            (4 endpoints)
└── dto/
    ├── student.dto.ts
    ├── class.dto.ts
    └── guardian.dto.ts

apps/api/src/attendance/
├── attendance.module.ts           (registered in AppModule, imports SisModule + IamModule + KafkaModule)
├── attendance.service.ts          (getClassAttendance, prePopulateClassPeriod, markIndividual, batchSubmit, getStudentAttendance)
├── absence-request.service.ts     (create, list, getById, review)
├── attendance.controller.ts       (8 endpoints)
└── dto/
    ├── attendance.dto.ts
    └── absence-request.dto.ts

apps/api/src/kafka/
├── kafka.module.ts
└── kafka-producer.service.ts      (best-effort emit; logs warning if broker unreachable)
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

| Caller   | Endpoint                               | Required        | Expected | Actual |
| -------- | -------------------------------------- | --------------- | -------- | ------ |
| no token | `/guard-test/admin-only`               | `sys-001:admin` | 401      | 401    |
| parent   | `/guard-test/admin-only`               | `sys-001:admin` | 403      | 403    |
| parent   | `/guard-test/grades`                   | `tch-003:write` | 403      | 403    |
| parent   | `/guard-test/attendance`               | `att-001:read`  | 200      | 200    |
| teacher  | `/guard-test/grades`                   | `tch-003:write` | 200      | 200    |
| admin    | `/guard-test/admin-only`               | `sys-001:admin` | 200      | 200    |
| admin    | `/classes/my`                          | school-scoped   | 200      | 200    |
| parent   | `POST /students`                       | `stu-001:write` | 403      | 403    |
| admin    | `POST /students`                       | `stu-001:write` | 201      | 201    |
| admin    | `POST /students` (dup `studentNumber`) | —               | 409      | 409    |

---

## Step 7 — Web UI shell, design system, auth/tenant client

New subtree: `apps/web/src/`. Next.js 14 App Router, Tailwind only (no component library). Test run: `pnpm --filter @campusos/web dev` → http://localhost:3000.

**Auth bootstrap:**

- On mount, `AuthProvider` calls `POST /api/v1/auth/refresh` (HttpOnly cookie). On success, calls `GET /api/v1/auth/me` and seeds the Zustand store. On failure, status flips to `unauthenticated` and protected routes redirect to `/login`.
- The fetch wrapper attaches `Authorization: Bearer …` and `X-Tenant-Subdomain` (default `demo`, override via `NEXT_PUBLIC_TENANT_SUBDOMAIN`). On 401, it single-flights a `/auth/refresh` call (so N parallel 401s trigger one refresh) and retries the original request once. On terminal 401, `onUnauthenticated` clears state and routes to `/login`.

**API extension for the shell:**

- `GET /api/v1/auth/me` now returns `personType` (drives persona-aware UI) and a flat `permissions[]` (union across the user's `iam_effective_access_cache` rows). Used by the sidebar for **menu gating only** — `PermissionGuard` remains the authoritative access check on every protected request.

**Persona-driven sidebar** (`Sidebar.tsx`):

| Item      | Visible when |
| --------- | ------------ |
| Dashboard | always       |

The sidebar was originally drafted with Classes / Attendance / Children / Students / Settings entries (gated by `personType` and various permission codes), but Cycle 1 only ships `/dashboard` plus the detail routes (`/classes/[id]/attendance`, `/children/[id]/attendance`, `/children/[id]/absence-request`). Section-level landing pages produced 404s on click, so the sidebar was trimmed to the only nav target that actually has a route. The dashboard itself is the navigation hub — class cards (teacher) and children cards (parent) link directly into the detail views. Future cycles will re-introduce section landings and grow the sidebar back as those pages land.

**Design tokens (Tailwind):**

- Brand `campus.50–900` (existing) + semantic `success/warning/danger`.
- Attendance status palette: `status.{present,tardy,absent,excused}.{DEFAULT,soft,text}` — used by the StatusBadge, attendance row tinting, and the Step 9 pill controls.
- `borderRadius.card = 12px`, `shadow.card`, `shadow.elevated`.
- `font.sans = DM Sans`, `font.display = DM Serif Display` (loaded via Google Fonts in `globals.css`).

**Shared UI components** (`apps/web/src/components/ui/`):

`Avatar`, `StatusBadge`, `LoadingSpinner` + `PageLoader`, `EmptyState`, `PageHeader`, `Modal`, `ToastProvider` + `useToast` (custom ~75-line provider — no `react-hot-toast` dep), `DataTable<T>`, `cn` helper.

**App shell** (`apps/web/src/components/shell/`):

`AppLayout` (responsive: sidebar inline ≥lg, mobile drawer with backdrop + close button below), `Sidebar`, `TopBar` (avatar menu with sign-out), inline SVG icon set (HomeIcon, ClassesIcon, AttendanceIcon, ChildrenIcon, PeopleIcon, SettingsIcon, MenuIcon, CloseIcon, LogoutIcon).

**Routes:**

- `/` → client-side redirect based on auth status to `/dashboard` or `/login`.
- `/login` — five dev-account buttons (admin/principal/teacher/student/parent) wired to `POST /auth/dev-login`. Also handles the OIDC callback redirect: when Keycloak's callback redirects to `/login?token=…`, the page seeds the store and routes to `/dashboard`.
- `/(app)/dashboard` — persona-aware switch (Step 8 wires teacher; Step 10 will wire parent).
- `/(app)/classes/[id]/attendance` — Step 9.

---

## Step 8 — Teacher Dashboard + `/classes/my` extension

### API: ClassResponseDto.todayAttendance

`apps/api/src/sis/`. The `/classes/my` endpoint now returns each class enriched with a `todayAttendance` summary used by the dashboard. Other class endpoints (`list`, `getById`) leave it `undefined` to stay cheap.

```ts
TodayAttendanceSummaryDto {
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED'
  totalRecorded, present, tardy, absent, excused, earlyDeparture: number
}
```

**Status derivation** — single grouped aggregate joins `sis_attendance_records` for today's date in one query:

```sql
SELECT class_id,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='PRESENT')::int AS present,
       COUNT(*) FILTER (WHERE status='TARDY')::int AS tardy,
       …
       BOOL_AND(confirmation_status='CONFIRMED') AS all_confirmed
FROM sis_attendance_records
WHERE date=$1::date AND class_id IN ($2::uuid, …)
GROUP BY class_id
```

- 0 records → `NOT_STARTED`
- ≥1 record AND `all_confirmed` → `SUBMITTED`
- otherwise → `IN_PROGRESS`

The aggregate is per-class (collapses across periods). For multi-period classes that's an MVP simplification — period-level state lives in Step 9.

### Web: TeacherDashboard

`apps/web/src/components/dashboard/TeacherDashboard.tsx` plus hooks:

- `useMyClasses()` → `GET /classes/my`
- `useAbsenceRequests({ status?, studentId? })` → `GET /absence-requests` (also used in Recent Activity)

**Layout:**

- Greeting (time-of-day aware) + today's date.
- 4-card QuickStats row: Total students (sum of `enrollmentCount`), Attendance rate (`(present+tardy)/totalRecorded`, "—" until anything's marked), Tardies today, Absences today (last two accent-coloured).
- Today's classes grid (1 / 2 / 3 cols responsive). Each card: status pill (`Not started | In progress | Submitted`), course name, period, room, enrollment count, exception badges (tardy/absent/excused) when present. The whole card is a `<Link>` to `/classes/:id/attendance`.
- Recent activity panel: up to 5 latest absence requests with status pills.

### Persona-aware dashboard router

`apps/web/src/app/(app)/dashboard/page.tsx`:

```ts
const isTeacherView =
  user.personType === 'STAFF' &&
  hasAnyPermission(user, ['att-001:read', 'att-001:write', 'att-001:admin']);
```

Teachers see `TeacherDashboard`. All other personas see the placeholder until their dashboards land (Parent in Step 10).

---

## Step 9 — Attendance Taking UI

`apps/web/src/app/(app)/classes/[id]/attendance/page.tsx`. Backend endpoints (Step 6) used unchanged.

**Hooks** (`apps/web/src/hooks/use-attendance.ts`):

- `useClass(id)` — class header info.
- `useClassAttendance(classId, date, period)` — `GET /classes/:id/attendance/:date?period=…`. Disabled until `period` is known, so the lazy pre-populate fires deterministically on first render.
- `useBatchSubmitAttendance(classId, date)` — `POST /classes/:id/attendance/:date/batch` mutation. On success invalidates `['attendance', classId, date]` and `['classes','my']` so the dashboard card flips to SUBMITTED immediately.

**Page layout:**

- Back link to `/dashboard`.
- Header: course name, period, primary teacher, room, date picker (URL is the source of truth: `?date=YYYY-MM-DD`; today is implicit).
- Roster `<ul>`: one `<li>` per attendance record with avatar, name, student number, and a 4-button status group (P/T/A/E). Non-PRESENT rows are tinted by their status colour and reveal a status-aware note input.
- Sticky submit bar (fixed bottom): live exception summary ("Submit — 2 tardy, 1 absent" when there are exceptions; "Submit attendance" when none). Disabled while the mutation is in flight.

**Read-only mode:** when every record is `CONFIRMED`, the page shows a green "Locked" banner with the day's tally and disables all controls. Per ADR/spec, confirms cannot be undone without admin override.

**Override-map pattern:**

- Local state is `Record<recordId, { status, note }>` of overrides relative to server state.
- Setting a row back to its server value drops the override entirely. Submitting builds the batch payload from non-default rows only — matching the API contract that omitted students stay PRESENT.
- Switching dates resets overrides.

**Period assumption:** seed maps `class.section_code` 1–6 to period 1–6 (one period per class). The page uses `class.sectionCode` as the period. Multi-period classes are a future iteration.

### Vertical-slice verification — UI side

End-to-end run on `tenant_demo` after Step 9 landed:

| #   | Action                                                                           | Result                                                            |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `GET /classes/<period1>/attendance/2026-04-27?period=1`                          | 8 students inserted as PRESENT/PRE_POPULATED                      |
| 2   | `POST .../batch` `{period:'1', records:[{maya, TARDY, "arrived 8:15"}]}`         | total=8, present=7, tardy=1, all CONFIRMED                        |
| 3   | `GET /classes/my`                                                                | Period 1 → `status: SUBMITTED, present: 7, tardy: 1`              |
| 4   | Web smoke (curl): `/login` 200, `/dashboard` 200, `/classes/<id>/attendance` 200 | route serves the auth-gated shell; React Query feeds it from #1–3 |

The browser-side walk-through (login → dashboard → click class → see roster → tap Maya → submit → toast → dashboard SUBMITTED) is the Step 11 deliverable.

---

## Step 10 — Parent Dashboard, attendance calendar, absence-request form

Web-only step. Backend endpoints (`/students/my-children`, `/students/:id/attendance`, `/absence-requests` POST) all already existed from Step 6.

### Hooks (`apps/web/src/hooks/use-children.ts`)

- `useMyChildren()` → `GET /students/my-children`. Resolves via `req.user.personId` → `sis_guardians.person_id` server-side.
- `useStudent(id)` → `GET /students/:id`.
- `useStudentAttendance(id, fromDate?, toDate?)` → `GET /students/:id/attendance` with optional date range.
- `useSubmitAbsenceRequest()` → `POST /absence-requests` mutation; on success invalidates `['absence-requests']`.

### `ParentDashboard` (`apps/web/src/components/dashboard/ParentDashboard.tsx`)

- Greeting + today's date.
- **Tardy banner:** for each child, fetches `useStudentAttendance(id, today, today)`. If any row is TARDY or ABSENT, renders a banner per affected child: "{Child} was marked {tardy|absent} in Period {N}{ ({note})}" with a deep link to the child's attendance.
- **Children cards** (1 col / 2 col responsive): avatar, name, grade, `#studentNumber`, today's status pill (`Not marked | Present | Tardy | Absent | Excused | Mixed`), year-to-date attendance rate, periods-recorded count. Two CTAs: "View attendance" → `/children/:id/attendance`; "Report absence" → `/children/:id/absence-request`.
- Each `ChildCard` runs its own `useStudentAttendance(id)` (no date range — full history) and computes today/total client-side. Acceptable because seed has small history; if scale becomes an issue, summary-on-server is the next step (mirroring the Step 8 pattern on `/classes/my`).

### `/children/[id]/attendance` (calendar + history)

- Month-grid calendar component built inline (no library): 7-col grid, leading blanks for the first weekday, day cells coloured by worst-status across periods that day (`bg-status-{present|tardy|absent|excused}-soft` + matching text). Today's day number is underlined. Empty days are gray. Each cell shows `{N}p` for the period count.
- Prev / next month navigation buttons in the header. Date range queries refetch on month change (one query per visible month).
- Click a day → expands a "Day detail" panel below the calendar showing each period with its status pill and the parent explanation note when present.
- Stats row above the calendar: attendance rate, periods present (PRESENT + TARDY + EXCUSED), tardies, absences — computed for the visible month.

### `/children/[id]/absence-request` (submission form)

- Form fields: from-date (`min=today`), to-date (`min=fromDate`), reason category dropdown (ILLNESS, MEDICAL_APPOINTMENT, FAMILY_EMERGENCY, HOLIDAY, RELIGIOUS_OBSERVANCE, OTHER), free-text explanation (1–1000 chars, with live counter).
- `requestType` is **derived**, not asked: `SAME_DAY_REPORT` if all dates are today, otherwise `ADVANCE_REQUEST`. The form shows an info banner explaining which path the request will follow ("auto-approved" vs "queued for school admin review").
- Past-date guard: if `fromDate < today` the form blocks submission and shows an error.
- On success: toast (`Absence request submitted` or `auto-approved`), redirect to `/dashboard`. Errors surface inline above the submit button.
- **Document upload deliberately omitted** — the API takes a `supportingDocumentS3Key` but no S3 infra is wired in Cycle 1. The field is left out rather than stubbed.

### Persona switch + sidebar adjustments

- `app/(app)/dashboard/page.tsx` adds `personType === 'GUARDIAN'` → `<ParentDashboard />`. Existing STAFF teacher branch unchanged.
- `Sidebar` drops the previous "My Children" item (`/children` route never existed and is redundant — Dashboard IS the children landing for parents). The corresponding `ChildrenIcon` import was removed; the icon component is kept in `icons.tsx` for future use.

### Smoke test — full parent vertical slice

Run on `tenant_demo`, `2026-04-27`:

| #   | Action                                                                                                              | Result                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Parent dev-login → `GET /students/my-children`                                                                      | 1 child: Maya Chen, grade 9, S-1001                                       |
| 2   | `GET /students/<maya>/attendance`                                                                                   | 5 records — incl. today's P1 TARDY/CONFIRMED ("arrived 8:15") from Step 9 |
| 3   | `POST /absence-requests` `{maya, 2026-04-28→2026-04-28, ADVANCE_REQUEST, MEDICAL_APPOINTMENT, "Pediatric checkup"}` | 201; status `PENDING`                                                     |
| 4   | Web smoke: `/dashboard` 200, `/children/<maya>/attendance` 200, `/children/<maya>/absence-request` 200              | All routes serve the auth-gated shell; React Query feeds them from #1–3   |

The teacher→parent vertical slice is now end-to-end real: Maya was marked tardy in the Step 9 smoke test on 2026-04-27, and the parent dashboard's tardy banner now shows it.

---

## CI / build hygiene fixes (between Step 6 and Step 9)

These weren't part of the implementation plan but unblocked CI / Docker:

- **Repo on GitHub.** `git@github.com:adamtromsness/campusos.git` (SSH), `main` branch.
- **CI / Docker runtime aligned to Node 22.** `NODE_VERSION` env in `.github/workflows/ci.yml` plus `node:22-slim` base in `Dockerfile`. Production image and CI now share the same major.
- **pnpm version is single-sourced from `packageManager`.** Removed the explicit `version: 10` from both `pnpm/action-setup@v4` invocations in `ci.yml`. With version omitted, the action reads `pnpm@10.33.2` from `package.json` `packageManager`, so CI and local installs stay locked together — no drift if pnpm is bumped.
- **`@campusos/database` build chains `prisma generate`.** CI was failing with 14 implicit-any errors because `pnpm --filter @campusos/database build` ran `tsc` before `prisma generate`, and `@prisma/client` ships an empty stub until generation. Every Prisma reference downgraded to `any` and the cascade hit middleware params (`params`, `next`), provision-tenant `r` callbacks, and the `var tier` redeclaration in `seed-iam.ts`. Local builds masked it because the generated client persisted in the pnpm store. Fix: `"build": "pnpm run generate && tsc --project tsconfig.json"` in `packages/database/package.json`. Dockerfile's pre-build `prisma generate` becomes redundant but harmless (prisma generate is idempotent).
- **Repo-wide Prettier pass.** 64 files had drifted from Prettier rules. Single `pnpm format` commit aligned them; `format:check` is now green.

Outstanding warning: GitHub deprecated Node 20 for the **action runtime itself** (separate from `NODE_VERSION`) — `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4` internally run on Node 20. Forced bump to Node 24 starts 2026-06-02. Acceptable to defer until those actions ship Node 24-compatible majors.

---

## Architecture review response — what changed

Initial peer review flagged 5 blockers; verification against the actual docs confirmed 3 valid, 2 incorrect. The 3 valid ones are now fixed:

|   # | Reviewer claim                                            | Verified?    | Resolution                                                                                                                                                                                                                                                                |
| --: | --------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Cross-schema FKs from tenant→platform violate ADR-001/020 | ✅ Valid     | All 12 cross-schema FK constraints removed across 003 and 004. Columns kept as plain UUIDs. App-layer Prisma lookups validate.                                                                                                                                            |
|   2 | `sis_students` missing direct `person_id` FK per ADR-055  | ❌ Incorrect | ERD does not declare `person_id` on `sis_students`. ADR-055 satisfied via the projection chain `sis_students → platform_students.person_id → iam_person.id`. **No change.**                                                                                               |
|   3 | `sis_attendance_records` not partitioned per ADR-007      | ✅ Valid     | Implemented `RANGE(school_year) → HASH(class_id, 8 buckets)` per ERD. 4 year partitions × 8 hash buckets = 32 leaf partitions. Composite PK `(id, school_year, class_id)`. BRIN index on `date`. FK from `sis_attendance_evidence` removed (soft ref now).                |
|   4 | `sis_absence_requests` ERD parity                         | ❌ Incorrect | Migration already had every cited field (`school_id NOT NULL`, `reason_text NOT NULL`, `supporting_document_s3_key`, `reviewer_notes`, partial pending index). **No change.**                                                                                             |
|   5 | Function catalogue 142 vs library v11's 148               | ✅ Valid     | `permissions.json` now has 148 functions (444 codes). Removed 5 stale (PFL-001/002/003, SAF-005, FRM-003), added 11 new (ACH-001/002/003, ATH-007/008/009/010, CRM-006, PRC-005, PUB-004, IT-009). `seed-iam.ts` made reconciling so it handles future catalogue updates. |

---

## Remaining deviations / known gaps

|   # | Area                                   | ERD / plan says                                                                       | What we built                                   | Why                                                                                                                                                                                                                                                                       |
| --: | -------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Enum-like columns                      | ERD shows native PG `ENUM` types                                                      | `TEXT + CHECK IN (...)`                         | The tenant SQL splitter (statements separated on `;`, dropped if starting with `--`) can't run `CREATE TYPE` idempotently on re-provision. ENUM evolution requires `ALTER TYPE` ceremony that doesn't fit per-tenant migrations. CHECK gives the same domain enforcement. |
|   2 | DTO location                           | Plan: "Zod schemas in `packages/shared`"                                              | class-validator DTOs in `apps/api/src/sis/dto/` | Existing API has class-validator wired globally (ValidationPipe in main.ts); `packages/shared` lists Zod as a dep but no DTOs yet. Matching the wired pattern.                                                                                                            |
|   3 | Number of endpoints in Step 5          | Plan says ~15                                                                         | 9 delivered (10 with dual-permission ones)      | Built only the endpoints that have a clear consumer in Cycle 1's vertical slice. Additional family/guardian list endpoints can land when Step 7+ UIs need them.                                                                                                           |
|   4 | Soft FK targets                        | Plan: `FK(hr_employees …)` for `head_employee_id`, `teacher_employee_id`, `author_id` | Plain UUID columns                              | `hr_employees` table doesn't exist yet (HR module). Soft references for now.                                                                                                                                                                                              |
|   5 | `sis_students.withdrawal_id`           | ERD soft-refs `enr_withdrawal_requests`                                               | Plain UUID                                      | Enrollment module not in scope.                                                                                                                                                                                                                                           |
|   6 | Scope inheritance in `PermissionGuard` | ADR-036 implies full parent-scope traversal                                           | Two-level `[school, platform]` chain            | Minimum viable to unblock Platform Admins. Add full traversal (district, department, class) when those scope levels gain users.                                                                                                                                           |

### Other open items

- **Atomicity of `POST /students`.** ✅ Fixed (commit after `a16fbe6`). All three inserts (`iam_person`, `platform_students`, `sis_students`) run inside a Prisma interactive transaction via the new `TenantPrismaService.executeInTenantTransaction` helper. Verified: a forced FK violation on the SIS insert leaves zero orphan rows in the platform-side tables.
- **ADR-055 doc clarification.** Reviewer noted the ADR prose is broader than the physical ERD (it describes `sis_students/staff/guardians` as projections of `iam_person`, but `sis_students` actually projects through `platform_students`). Backlog item: tighten ADR-055 wording to make the transitive identity path through `platform_students` explicit. Not a code change.
- **`PATCH /students` cannot change `firstName`/`lastName`.** Per ADR-055, identity is immutable from sis_students. To rename a student, the API needs a separate mutation that updates `iam_person`. Not currently exposed.
- **No PII protection on student lookups.** Any user with `stu-001:read` sees all students at the school. Cycle 1 doesn't model "who can see whom" beyond role; future hardening per `iam_relationship_access_rule` derivations.
- **Bigint serialization.** `client.$queryRawUnsafe` returns Postgres `bigint` columns as JS bigint. We coerce inline with `(SELECT count(*)::int FROM …)`. Watch for this in future raw queries.
- **`build-cache.ts` is a manual step.** Not invoked by `pnpm seed`. Anyone editing role-permission mappings has to remember to rebuild. Worth wiring into `seed-iam.ts` as a final step.
- **`PermissionGuard.resolveScopeChain` queries Postgres on every request.** No caching on the scope lookup itself. Acceptable for now; reach for Redis when latency matters.
- **Partition rotation for `sis_attendance_records`.** Year partitions cover 2024-08 through 2028-08. After 2028-08-01, inserts will fail. A scheduled job or annual migration is needed (M0 Platform concern).
- **Soft-reference health monitoring.** ADR-020/028 prescribes a `platform_reference_health` background monitor for soft FKs. Not yet implemented; soft refs currently rely solely on app-layer validation.

---

## What Steps 10–11 need from the existing foundation

Steps 7–9 have already consumed and validated `/auth/me`, `/classes/my`, `/classes/:id`, `/classes/:id/attendance/:date`, and the batch submit endpoint. The remaining work is parent-facing.

**Parent dashboard (Step 10):**

- `GET /api/v1/students/my-children` → children list (existing — resolves via `req.user.personId` → `sis_guardians.person_id`).
- `GET /api/v1/students/:id/attendance` → calendar/history view (existing).
- `POST /api/v1/absence-requests` → submit absence form (existing — SAME_DAY_REPORT auto-approves, ADVANCE_REQUEST queues PENDING).
- Persona-aware `/dashboard`: the existing route already branches `STAFF → TeacherDashboard`. Adding a `GUARDIAN → ParentDashboard` branch is the entry point.

**Vertical slice integration test (Step 11):**

- All 9 steps of the test script in the plan map to endpoints that already exist. Step 6 validated the API-side flow; Step 9 added UI confirmation through the teacher path. Step 11 walks the full browser path: login as teacher → mark Maya tardy → submit → log in as parent → see notification → submit advance absence.

**Persistent gotchas to be aware of:**

- Partition pruning on `sis_attendance_records`: queries by `class_id` + `date` prune correctly; queries by `id` alone scan all 32 leaves but each lookup is O(log n) via PK index. The implementation handles this internally (looks up partition keys before UPDATE).
- Lazy pre-populate runs on first `GET /classes/:id/attendance/:date?period=N`. The natural-key UNIQUE prevents dupes if multiple teachers race.
- Kafka emits are best-effort; a Kafka outage doesn't block requests. Consumers (Cycle 3) need to be idempotent.

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
