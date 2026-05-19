# Wave 4 Coverage — Final Report

## Per-module all-files coverage (post Codex review)

| Module          | Statements | Branches | Functions | Lines  | Target | Status |
| --------------- | ---------- | -------- | --------- | ------ | ------ | ------ |
| **m20-sis**         | 89.64%     | 84.54%   | 96.38%    | 89.64% | ≥80%   | ✅ |
| **m21-classroom**   | 90.69%     | 81.20%   | 96.77%    | 90.69% | ≥80%   | ✅ |
| **m22-scheduling**  | 89.75%     | 85.60%   | 95.52%    | 89.75% | ≥80%   | ✅ |
| **m25-curriculum**  | 92.13%     | 86.74%   | 96.15%    | 92.13% | ≥80%   | ✅ |
| **m81-enrolment**   | 91.73%     | 83.81%   | 95.92%    | 91.73% | ≥80%   | ✅ |

All five modules exceed the Wave 4 ≥80% target.

## Build state

- `pnpm --filter @campusos/api test` — **1249 / 1249 unit tests passing** (+ 54 pre-existing skips)
- `pnpm --filter @campusos/api exec vitest run --config vitest.integration.config.ts` — **3808 / 3808 integration tests passing** (+ 9 pre-existing skips). 0 failures.

## Codex review fixes

### FIX 1 — m20-sis attendance test idempotency
Two sub-issues:
- `attendance.spec.ts`: the `student persona: getClassAttendance only sees own row` test inserted into `platform.platform_students` without conflict handling. `TEST_STUDENT_PERSON_ID` is a stable fixture id, so a sibling spec may have already created the row. Fixed: check for existing row, reuse its id; defensive DELETE of any stale `sis_students` row for that `platform_student_id`.
- `sis-helpers.ts cleanupSeededIds`: m84-payments specs leave `pay_financial_aid_applications` rows that FK-reference `sis_guardians.id` (no ON DELETE CASCADE). When attendance.spec's `beforeEach` ran cleanup for the parent-actor guardian id, the DELETE failed with 23503 and the entire `beforeEach` threw — turning two attendance tests into setup-side failures. Fixed: cleanup helper now DELETEs `pay_financial_aid_applications` rows referencing the tracked guardian ids before the `sis_guardians` DELETE.

### FIX 2 — ApplicationService school-scope (production bug)
`apps/api/src/modules/m81-enrolment/applications/application.service.ts`:
- `list()` now binds `a.school_id = tenant.schoolId` as `$1::uuid`. A multi-school org sharing one tenant schema (and the test harness's intentional `tenant_test` A+B share) no longer leaks School B applications into a School A actor's list.
- `getById()` now binds `a.id = $1::uuid AND a.school_id = $2::uuid`. Cross-school ids collapse to `NotFoundException`.

Tests flipped from documented BUG to expected behaviour: `application-lifecycle.spec.ts` cross-school describe block now asserts `.not.toContain` for School B rows and `NotFoundException` on cross-school `getById`.

### FIX 3 — EnrollmentPeriodService school-scope (production bug)
`apps/api/src/modules/m81-enrolment/applications/enrollment-period.service.ts`:
- `list()` now binds `WHERE p.school_id = $1::uuid`.
- `getById()` now binds `WHERE p.id = $1::uuid AND p.school_id = $2::uuid`.

Tests flipped: `enrolment-periods.spec.ts` cross-school describe block now asserts School A's list excludes School B periods and that a cross-school `getById` rejects with `NotFoundException`.

## Cumulative Wave 4 production fixes (12 total)

| # | File | Fix |
| -- | ---- | --- |
| 1 | m20-sis StudentService | `list/getById/assertCanViewStudent/getSelfForStudent/listForGuardianPerson/update` bind `school_id` |
| 2 | m20-sis TranscriptService | join `cls_grades → cls_assignments.class_id` (not non-existent `cls_grades.class_id`); drop `co.is_honors`/`co.is_ap` refs |
| 3 | m20-sis ClassService | `list/getById/listForTeacherEmployee/getRoster` bind `school_id` |
| 4 | m20-sis LockerService | unique-violation handler regex broadened |
| 5 | m21-classroom ReportCardSubjectService | `::uuid` cast for `course_id` |
| 6 | m22-scheduling RoomService | `list/getById` bind `school_id` |
| 7 | m22-scheduling TimetableService | `school_id` binding + `translateConflict` reads `e.meta.code` (Prisma P2010 unwrap) |
| 8 | m22-scheduling CalendarService | `assertTimeShape` treats `allDay=true` patches as "times cleared" |
| 9 | m22-scheduling PullOutService | `::date` / `::uuid` casts + dynamic placeholder index |
| 10 | **m81-enrolment ApplicationService** | **`list/getById` bind `school_id` (Codex FIX 2)** |
| 11 | **m81-enrolment EnrollmentPeriodService** | **`list/getById` bind `school_id` (Codex FIX 3)** |
| 12 | **test helper sis-helpers.cleanupSeededIds** | **wipe `pay_financial_aid_applications` before `sis_guardians` DELETE (Codex FIX 1 cleanup side)** |

## Test counts

- m20-sis: 402 tests
- m21-classroom: 327 tests
- m22-scheduling: 295 tests
- m25-curriculum: 143 tests
- m81-enrolment: 215 tests
- **Wave 4 total: 1382 new tests**
- Full integration suite: 3808 / 3808 passing
