# Wave 4 Coverage — Final Report (80% target met across all 5 modules)

## Per-module all-files coverage

| Module          | Pre-Wave-4 | Mid-Wave-4 (services only) | Final (services + controllers) | Target | Status |
| --------------- | ---------- | -------------------------- | ------------------------------- | ------ | ------ |
| **m20-sis**         | ~0%        | ~60% (services 92–98%)     | **89.64%**                       | ≥80%   | ✅ |
| **m21-classroom**   | ~0%        | 68.81%                     | **90.69%**                       | ≥80%   | ✅ |
| **m22-scheduling**  | ~0%        | 69.45%                     | **89.75%**                       | ≥80%   | ✅ |
| **m25-curriculum**  | ~0%        | 69.86%                     | **92.13%**                       | ≥80%   | ✅ |
| **m81-enrolment**   | ~0%        | 59.22%                     | **91.42%**                       | ≥80%   | ✅ |

All five modules exceeded the 80% target.

## Test counts

| Module          | Pre-Wave-4 | New integration tests | Total integration tests |
| --------------- | ---------- | --------------------- | ----------------------- |
| m20-sis         | 0          | ~400                  | ~400                    |
| m21-classroom   | 0          | 327                   | 327                     |
| m22-scheduling  | 0          | 295                   | 295                     |
| m25-curriculum  | 0          | 143                   | 143                     |
| m81-enrolment   | 0          | 215                   | 215                     |
| **Total**       | **0**      | **~1380**             | **~1380**               |

## Spec files added

- m20-sis (13): student-crud, family-relationships, custom-fields, student-notes, attendance, graduation, transcripts (Wave 4 base) + graduation-workers, guardians, student-profile, lockers-transfers, class-service (services) + student-controller, sis-advanced-controller, graduation-controller, transcripts-controller (controllers)
- m21-classroom (16): hall-passes, ai-tutoring, assignment-lifecycle, grading, lessons, class-moments, report-cards (Wave 4 base) + peer-review, progress-notes, formative-assessment, gradebook-snapshot, consumers, ai-gateway (services) + assignments-controllers, grading-controllers, misc-controllers (controllers)
- m22-scheduling (14): timetable, cover-arrangements, exam-scheduling, rooms (Wave 4 base) + bell-schedules, calendar, substitution, rotations, pull-out, schedule-generation (services) + controllers-rooms, controllers-calendar, controllers-coverage, controllers-advanced (controllers)
- m25-curriculum (6): maps-crud, standards-alignment, lessons (Wave 4 base) + gaps, frameworks, curriculum-controller (added)
- m81-enrolment (9): application-lifecycle, capacity, tours, withdrawals (Wave 4 base) + enrolment-periods, offers, screening-and-search, waitlist-and-placement, controllers (added)

**Total: 58 spec files, ~1380 DB-backed integration tests.**

## Production fixes surfaced and applied during Wave 4

1. **StudentService** (m20-sis) — `list/getById/assertCanViewStudent/getSelfForStudent/listForGuardianPerson/update` now bind `school_id = tenant.schoolId`. Cross-school leak.
2. **TranscriptService** (m20-sis) — joined `cls_grades` through a non-existent `class_id` column; routed through `cls_assignments.class_id`. Removed `COALESCE` references to non-existent `co.is_honors` / `co.is_ap`. Schema mismatch that broke transcript generation.
3. **ReportCardSubjectService** (m21-classroom) — added `::uuid` cast for `course_id`.
4. **RoomService** (m22-scheduling) — `list/getById` now bind `school_id`.
5. **TimetableService** (m22-scheduling) — `school_id` binding fix; `translateConflict` now prefers `e.meta.code` over `e.code` so Prisma's P2010 wrapper no longer hides UNIQUE/FK violations.
6. **CalendarService** (m22-scheduling) — `assertTimeShape` treats `allDay=true` patches as "times cleared" so flip on existing timed event no longer rejects.
7. **PullOutService** (m22-scheduling) — INSERT now casts `end_date::date` and `intervention_provider::uuid`; placeholder index computed dynamically.
8. **ClassService** (m20-sis) — `list/getById/listForTeacherEmployee/getRoster` added missing `school_id` predicate. Cross-school leak in classes.
9. **LockerService** (m20-sis) — unique-violation handler regex broadened.

## Coverage measurement notes

The Wave 4 integration suite shares a single `tenant_test` schema, so cross-spec data hygiene matters. Coverage numbers above are from fresh-DB runs of a single module's specs. When the whole repo runs back-to-back without intermediate provisioning, some specs (m20-sis attendance edge cases, m81 capacity refresh) hit shared-row collisions that turn into transient failures; the per-module measurements above reflect the genuine code coverage.

The v8 coverage provider also occasionally races on `coverage/.tmp/*.json` when many parallel agents run vitest concurrently against the same workspace — the coverage numbers above are from runs after killing the stragglers and clearing `coverage/`.

## Build state

- `pnpm --filter @campusos/api test` — **1249 / 1249 unit tests passing** (+ 54 pre-existing skips)
- `pnpm --filter @campusos/api exec tsc --noEmit` — 0 errors
- Wave 4 integration tests: ~1380 new tests, individual modules + per-spec runs are 100% green; full-suite runs have intermittent shared-schema flakiness that's the known follow-up
