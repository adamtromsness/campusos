# HANDOFF — Phase 2 Cycle 17 (Scheduling Advanced)

**Status:** REVIEW-P2C17 Round 1 fixes applied at the closeout commit
(2026-05-12). Round 1 reviewer flagged 6 BLOCKING + 4 MAJOR against
`0406694` + `c4d13f1`; the closeout commit lands all 6 BLOCKINGs + 1
MAJOR (raw STAFF bypass replaced with explicit `sch-001:admin` perm
via `PermissionCheckService`) plus 27 new pinned regression tests so
the contracts cannot regress. 3 MAJORs carried as recommendation-class
Phase 2 follow-ups. CI parity green at 810/810 tests across 38 spec
files. Wave C (Operational Depth) closes here. Awaiting Round 2
verdict before tagging `p2c17-complete`.

## Round 1 fix log (REVIEW-P2C17, 2026-05-12)

All 6 BLOCKINGs landed with regression tests:

- **BLOCKING 1 — Event durability.** `sch.generation.completed` +
  `sch.timetable.updated` moved to `OutboxService.enqueueInTx` INSIDE
  the triggering transaction. Deterministic event IDs via new
  `apps/api/src/scheduling/event-ids.ts` helpers
  (`deterministicGenerationCompletedEventId(requestId)` +
  `deterministicTimetableUpdatedEventId(activationLogId)`). The
  `ScheduleGenerationService` constructor swaps `KafkaProducerService`
  for `OutboxService`. A broker outage now leaves the outbox row in
  place and `OutboxPublisherWorker` drains on recovery.
- **BLOCKING 2 — Candidate/activation school-scoping.** Every
  candidate / candidate_slot / activation read + write path joins
  through `sch_scheduling_requests r` and filters
  `r.school_id = $tenant.schoolId`. The activation INSERT into
  `sch_timetable_slots` validates `class_id` / `period_id` / `room_id`
  / `teacher_id` belong to the current school via inline EXISTS
  clauses BEFORE the INSERT — foreign-school references skip with
  WARN + bump `slots_skipped`.
- **BLOCKING 3 — Co-teaching school-scoping.** Every CoTeachingService
  read/write joins through `sch_timetable_slots s ON s.id =
ca.timetable_slot_id` filtered on `s.school_id`. `create()`
  validates slot + both teachers (`hr_employees.school_id`) BEFORE
  insert. `patch()`/`remove()` call `getById()` first so foreign-school
  arrangements 404 don't-leak-existence. `hasActiveCoTeachingFor`
  carries the same school-scope guard.
- **BLOCKING 4 — Exam children validate ownership.** 3 new private
  helpers `assertRoomBelongsToSchool` / `assertStudentBelongsToSchool`
  / `assertEmployeeBelongsToSchool` called before INSERT in
  `addRoom`, `assignSeat`, `assignInvigilator`. Accommodation lookup
  now school-scopes through `sis_student_active_accommodations.school_id`.
  `findRoomConflicts` session lookup adds school predicate. Every
  child reload joins through `sch_exam_sessions` for the parent
  session school scope.
- **BLOCKING 5 — Pull-out scoping.** `create()` validates studentId
  - regularSlotId + interventionProvider against current school
    via inline EXISTS clauses BEFORE INSERT. `premarkAttendance` joins
    intervention + slot on shared `school_id`. Attendance UPDATE adds
    a JOIN against `sis_students stu` filtered on `stu.school_id` for
    defence-in-depth. `patch()` UPDATE carries `school_id` predicate.
- **BLOCKING 6 — Cover arrangement children scoping.** `create()`
  validates absent + covering teachers + sub_assignment (joined
  through `sub_job_postings.school_id`) BEFORE insert. `addClass()`
  validates affected class + slot + destination room + supervising
  teacher. `addSplitStudents()` batch-validates students + optional
  destination rooms + supervising teachers via
  `ANY(string_to_array(...)::uuid[])`. Child reloads join through
  `sch_cover_arrangements a` so foreign-school rows can never
  surface.
- **BLOCKING 7 (was MAJOR) — Subject choice STAFF bypass +
  cross-school leak.** `SubjectChoiceService` constructor injects
  `PermissionCheckService`. New `hasSchedulingAdminScope(actor)`
  helper replaces `personType === 'STAFF'` everywhere — admin is
  explicit `sch-001:admin` via
  `permissionCheck.hasAnyPermissionInTenant`. `SELECT_CHOICE_BASE`
  JOINs `sis_students stu` so every list query filters
  `stu.school_id`. `resolveOwnStudentId` +
  `resolveGuardianStudentIds` school-scope through
  `sis_students.school_id`. `submit()` validates body.studentId
  against current school. `demand()` joins through students for
  school-scope + requires sch-001:admin.

**MAJORs carried to Phase 2 follow-up list** (recommendation-class):

1. Cover coordinator dedicated role split (joins the Wave-2 Phase 2
   role-split chain). Today the service gates writes on
   `actor.isSchoolAdmin`, mirroring Cycle 5 CoverageService.
2. `POST /scheduling/pull-outs/:id/repremark` for cadence-change
   repremarking — operators currently DELETE + re-create.
3. Auto-call findRoomConflicts on `POST /scheduling/exams/:id/rooms`
   so the safe-by-default workflow surfaces conflicts immediately.

**Test coverage:** vitest 783 → **810 passing across 38 spec files**
(+27 pinned regression tests in `scheduling-p2c17-review.spec.ts`
across 7 REVIEW-P2C17 describe blocks). See `P2C17-REVIEW-NOTES.md`
for the per-fix verification trail.

---

**Original status (pre-Round-1):** COMPLETE pending peer review. Wave C
(Operational Depth) closes here.

Cycle 17 ships the **M22 Scheduling Advanced surface — 20 new tenant
`sch_*` base tables across 2 migrations (`149` + `150`) + 1 ALTER on
`sch_periods` (rotation_day column) + 1 ALTER on `sis_attendance_records`
(PULL_OUT status). The cycle is the most algorithmically complex module
in CampusOS — the second migration adds 5 multi-column lockstep CHECK
constraints + 1 person-level EXCLUSION (the cross-school keystone) on
top of the Cycle 5 timetable EXCLUSIONs.**

Plan: `docs/campusos-p2c17-scheduling-advanced.html`.
Review scaffold: `P2C17-REVIEW-NOTES.md`.

## Sub-Cycle Structure

The plan splits the 20 tables along the ADR-053 expansion boundary:

- **P2-17a — Rotation + Schedule Generation + Subject Choices** (10
  tables, `149_sch_rotation_generation.sql`). Schedule generation
  engine — how the master timetable is created. Rotation cycles +
  rotation calendar + constraint profiles + student subject choices +
  scheduling requests + candidates + candidate slots + activation log +
  subject-choice windows. Plus the ALTER on `sch_periods` to add
  `rotation_day`. Shipped at `0406694`.

- **P2-17b — Exams + Co-Teaching + Pull-Out + Cross-School + Cover**
  (10 tables, `150_sch_exams_coteach_cover.sql`). Daily operations
  layer — how the schedule handles exams, co-teaching, pull-outs,
  visiting staff, and complex cover on any given day. Plus the ALTER
  on `sis_attendance_records_status_chk` to accept PULL_OUT. Shipped
  in this commit.

## Cumulative P2-17 Totals

- **20 tenant base tables** across 2 migrations (10 + 10).
- **~46 endpoints** across the existing scheduling module:
  - P2-17a: ~24 endpoints (RotationController + SubjectChoiceController +
    SchedulingConstraintsController + SchedulingRequestController +
    SchedulingGenerateController + SchedulingCandidateController +
    SubjectChoiceWindowController).
  - P2-17b: **26 endpoints** (ExamSchedulingController 7 +
    CoTeachingController 5 + PullOutController 4 +
    CrossSchoolStaffController 4 + CoverArrangementController 6).
- **2 workers**: SchedulingWorker + SchedulingActivationWorker
  (P2-17a). P2-17b is request-path only.
- **2 Kafka emit topics**: `sch.generation.completed` (P2-17a) +
  `sch.timetable.updated` (P2-17a; existing from Cycle 5). P2-17b is
  pure request-path with attendance pre-marking but no new emits.

## P2-17b — Schema (migration 150)

10 new tables.

1. **sch_exam_sessions** — Exam scheduling root. One row per
   `(school exam_date exam_name)` instance. `window_chk` ensures
   `end_time > start_time`. `duration_chk` ensures `duration_minutes > 0`.
   `extra_time_minutes` carries the venue-level extension applied to
   every student.
2. **sch_exam_session_rooms** — Junction `(session room)` replacing a
   legacy room_ids ARRAY shape. Per-room capacity. UNIQUE(session_id,
   room_id) + CHECK(capacity > 0). is_main_room=true marks the primary
   venue.
3. **sch_exam_seatings** — Per-student seat allocation. UNIQUE(session,
   student) caps at one seating per (session, student). Four
   accommodation columns (`extra_time_minutes`, `separate_room`,
   `reader_required`, `scribe_required`) auto-populated by
   `ExamSchedulingService.assignSeat()` from
   `sis_student_active_accommodations` matching accommodation_type
   strings (EXTENDED_TIME, SEPARATE_LOCATION, READ_ALOUD, SCRIBE).
4. **sch_exam_invigilator_assignments** — UNIQUE(session, room,
   invigilator). is_lead flag (not unique per room — schools rotate
   lead during long exams).
5. **sch_coteaching_arrangements** — Per-(slot, secondary_teacher)
   co-teaching pairing. 5-value `teaching_model` CHECK (TEAM_TEACHING,
   ONE_TEACH_ONE_SUPPORT, STATION_ROTATION, PARALLEL_TEACHING,
   ALTERNATIVE_TEACHING). UNIQUE(timetable_slot_id, secondary_teacher_id).
   Distinct primary + secondary enforced via CHECK. The keystone —
   `sch_timetable_slots` carries an EXCLUSION on (teacher_id, period_id,
   daterange) that catches the primary teacher's double-booking. The
   secondary teacher recorded here is service-layer exempt from
   double-booking on the matching slot (CoTeachingService.hasActiveCoTeachingFor
   returns true for the secondary teacher, the existing TimetableService
   conflict checks can skip them).
6. **sch_pull_out_interventions** — Per-(student, regular_slot) pull-out
   scheduling. 4-value `frequency` CHECK (WEEKLY, FORTNIGHTLY, DAILY,
   CUSTOM). `days_of_week SMALLINT[]` carries weekdays for CUSTOM
   frequency. The keystone — PullOutService.create pre-marks
   sis_attendance_records.status = 'PULL_OUT' for every cadence-matching
   date inside [start_date, end_date]. Returns the count in
   `attendancePremarked`.
7. **sch_cross_school_staff_assignments** — Visiting staff between
   schools. Both `person_id` (iam_person — keystone for the
   person-level EXCLUSION) and `home_employee_id` (hr_employees in
   home school). The keystone — `EXCLUDE USING gist (person_id WITH =,
daterange(effective_from, COALESCE(effective_to, infinity), '[)')
WITH &&)` prevents the same iam_person from holding overlapping
   cross-school windows in this tenant. Sister-tenants have their own
   timetable EXCLUSIONs but cannot detect cross-tenant double-booking
   because tenants are schema-isolated. UNIQUE(visiting_school_id,
   person_id, effective_from).
8. **sch_cover_arrangements** — Higher-level per-(school, absent_teacher,
   cover_date) coordination row. Groups every class the absent teacher
   would have taught under a single arrangement with a chosen
   `cover_type`. 5-value `cover_type` CHECK (SUBSTITUTE_REPLACEMENT,
   INTERNAL_COVER, CLASS_MERGE, CLASS_SPLIT, SELF_STUDY). 3-value
   `status` CHECK (PLANNED, ACTIVE, COMPLETED) with multi-column
   `completed_chk` that COMPLETED requires `completed_at NOT NULL`.
   `sub_assignment_id` is a soft FK to P2-9 sub_assignments — set on
   SUBSTITUTE_REPLACEMENT when the marketplace assignment exists.
   Distinct from the Cycle 5 `sch_coverage_requests` table (which is
   per-(slot, date) granular and the CoverageConsumer write target).
9. **sch_cover_arrangement_classes** — Junction (arrangement, class,
   slot). 5-value `disposition` CHECK (COVERED_BY_SUB, MERGED_INTO,
   SPLIT_TO, SELF_STUDY, CANCELLED). UNIQUE(arrangement_id,
   affected_slot_id).
10. **sch_cover_split_students** — Junction (arrangement_class, student)
    for SPLIT_TO dispositions. `destination_class_label` is a free-text
    marker so the cover coordinator can label split groups without
    pre-defining them. UNIQUE(arrangement_class_id, student_id).

### Cross-cycle integration

- `sch_exam_sessions.subject_id` → soft FK `sis_courses` per ADR-001/020.
- `sch_exam_session_rooms.room_id` → DB FK `sch_rooms` (Cycle 5 — same
  tenant).
- `sch_exam_seatings.student_id` → DB FK `sis_students` (Cycle 1 — same
  tenant).
- `sch_exam_seatings.room_id` → DB FK `sch_rooms`.
- `sch_exam_invigilator_assignments.invigilator_id` → DB FK
  `hr_employees` (Cycle 4 — same tenant).
- `sch_coteaching_arrangements.timetable_slot_id` → DB FK
  `sch_timetable_slots` CASCADE.
- `sch_coteaching_arrangements.{primary,secondary}_teacher_id` → DB FK
  `hr_employees`.
- `sch_pull_out_interventions.student_id` → DB FK `sis_students` CASCADE.
- `sch_pull_out_interventions.regular_slot_id` → DB FK
  `sch_timetable_slots`.
- `sch_pull_out_interventions.intervention_provider` → DB FK
  `hr_employees`.
- `sch_cross_school_staff_assignments.person_id` → soft FK
  `platform.iam_person` per ADR-001/020.
- `sch_cross_school_staff_assignments.home_employee_id` → DB FK
  `hr_employees`.
- `sch_cross_school_staff_assignments.{home_school_id,visiting_school_id}`
  → soft FKs `platform.schools` per ADR-001/020.
- `sch_cover_arrangements.absent_teacher_id` → DB FK `hr_employees`.
- `sch_cover_arrangements.sub_assignment_id` → soft FK `sub_assignments`
  (P2-9) per ADR-001/020 — kept soft because cover arrangements can
  be planned ahead of any marketplace assignment.
- `sch_cover_arrangement_classes.affected_class_id` → DB FK
  `sis_classes`.
- `sch_cover_arrangement_classes.affected_slot_id` → DB FK
  `sch_timetable_slots`.
- `sch_cover_split_students.student_id` → DB FK `sis_students` CASCADE.

### Tenant base table count

Cycle 17 (P2-17a + P2-17b combined): adds 20 base tables. From the
pre-cycle baseline:

```
702 base tables in tenant_demo (P2-17b end)
```

The earlier P2-17a closeout commit captured 692 base tables; P2-17b
adds 10 more. The CLAUDE.md count drifts vs the live count because
some seed tables landed mid-cycle without bumping the CLAUDE.md narrative
— the live count is authoritative.

## P2-17b — Services + Endpoints

### ExamSchedulingService (7 endpoints, sch-001:read/admin)

- `GET /scheduling/exams` — list sessions.
- `GET /scheduling/exams/:id` — session detail with inlined rooms + seatings + invigilators.
- `POST /scheduling/exams` — create session (admin).
- `POST /scheduling/exams/:id/rooms` — assign a room with capacity (admin).
- `GET /scheduling/exams/:id/conflicts` — detect room conflicts via
  tstzrange overlap against active `sch_timetable_slots` and CONFIRMED
  `sch_room_bookings`. Service-layer check; no schema EXCLUSION because
  exams cross the daily-schedule grain.
- `POST /scheduling/exams/:id/seat` — **accommodation auto-populate
  keystone**. Reads `sis_student_active_accommodations` for the student
  filtered by `effective_from <= exam_date <= effective_to` and
  `applies_to IN ('ALL_ASSESSMENTS','SPECIFIC')`. Maps accommodation_type
  strings to the 4 seating flags:
  - `EXTENDED_TIME` / `EXTRA_TIME` → `extra_time_minutes = ceil(duration * 0.25)`
  - `SEPARATE_LOCATION` / `SEPARATE_ROOM` → `separate_room = true`
  - `READ_ALOUD` / `READER` → `reader_required = true`
  - `SCRIBE` → `scribe_required = true`
  - Admin can override every field via explicit body input.
- `POST /scheduling/exams/:id/invigilators` — assign invigilator
  (admin). UNIQUE(session, room, invigilator).

### CoTeachingService (5 endpoints, sch-001:read/admin)

- `GET /scheduling/co-teaching` — list arrangements. Optional
  `?slotId=` filters to a single timetable slot.
- `GET /scheduling/co-teaching/:id` — detail.
- `POST /scheduling/co-teaching` — create arrangement (admin).
  CHECK distinct primary + secondary; CHECK teaching_model in the
  5-value enum.
- `PATCH /scheduling/co-teaching/:id` — update arrangement (admin).
- `DELETE /scheduling/co-teaching/:id` — remove arrangement (admin).

**EXCLUSION relaxation contract**: `hasActiveCoTeachingFor(slotId,
teacherId)` returns true when the teacher is recorded as secondary on
the slot. The existing sch_timetable_slots EXCLUSION on `(teacher_id,
period_id, daterange)` catches the primary teacher's double-booking.
The secondary teacher is NOT on the slot's teacher_id column — they
live in this junction table — so the schema-side EXCLUSION cannot
fire against them anyway. The service-layer hook here is the canonical
place to record the pairing and answer "is this teacher's double-booking
relaxed for this slot?" for future call sites.

### PullOutService (4 endpoints, sch-001:read/admin)

- `GET /scheduling/pull-outs` — list interventions. Optional
  `?studentId=` filters.
- `GET /scheduling/pull-outs/:id` — detail.
- `POST /scheduling/pull-outs` — **attendance pre-marking keystone**.
  Service flow:
  1. Validate frequency + days_of_week shape (CUSTOM requires
     non-empty days_of_week).
  2. INSERT the intervention row.
  3. Compute cadence-matching dates inside [start_date, end_date]
     (capped at 90 days when end_date is null):
     - WEEKLY: each weekday in days_of_week (defaults to the regular
       slot's weekday when days_of_week is empty).
     - FORTNIGHTLY: each weekday in days_of_week, every other week.
     - DAILY: every weekday Mon..Fri.
     - CUSTOM: every weekday in days_of_week.
  4. Look up the regular_slot's class_id.
  5. `UPDATE sis_attendance_records SET status='PULL_OUT',
evidence_source='SYSTEM_INFERRED', marked_at = now()
WHERE class_id = $1::uuid AND student_id = $2::uuid AND
date = ANY(...) AND status <> 'PULL_OUT'`. Returns the row count
     as `attendancePremarked`. Idempotent — re-running over already-PULL_OUT
     rows is a no-op.

- `PATCH /scheduling/pull-outs/:id` — update window or cadence (admin).
  Does NOT re-run pre-marking — operators re-trigger via a fresh
  POST when needed.

### CrossSchoolStaffService (4 endpoints, sch-001:read/admin)

- `GET /scheduling/cross-school-staff` — list (home or visiting).
- `GET /scheduling/cross-school-staff/:id` — detail.
- `POST /scheduling/cross-school-staff` — create (admin). Validates
  visiting_school_id differs from home. SQLSTATE 23P01 from the
  person-level EXCLUSION constraint is translated to 409 Conflict.
- `PATCH /scheduling/cross-school-staff/:id` — update window
  extensions (admin). Same EXCLUSION translation on update.

**Person-level EXCLUSION**: the schema declares
`EXCLUDE USING gist (person_id WITH =, daterange WITH &&)`. Two
assignments for the same iam_person.id with overlapping date windows
will trip this constraint regardless of which visiting_school_id is on
each row. This is the only schema-level guard against the same human
being double-booked across schools in this tenant. Sister tenants
cannot be queried from a single SQL statement (schema-per-tenant), so
this is a per-tenant invariant, not a cross-tenant one. Phase 3 ops
adds a cross-tenant validator on the platform schema if real schools
need it.

### CoverArrangementService (6 endpoints, sch-004:read/write)

- `GET /scheduling/cover/:date/board` — daily cover board (cover
  coordinator view).
- `GET /scheduling/cover/:id` — arrangement detail with nested classes
  - split students.
- `POST /scheduling/cover` — create arrangement (admin).
- `PATCH /scheduling/cover/:id/status` — flip PLANNED ↔ ACTIVE ↔
  COMPLETED. The transaction takes `SELECT … FOR UPDATE` on the row,
  refuses COMPLETED → PLANNED/ACTIVE (COMPLETED is terminal), and
  stamps `completed_at = now()` on the COMPLETED transition so the
  multi-column `completed_chk` invariant is satisfied atomically.
- `POST /scheduling/cover/:id/classes` — add an affected class with
  per-class disposition.
- `POST /scheduling/cover/classes/:id/split-students` — assign
  students to split groups (one body request can land multiple). Each
  insert catches UNIQUE(arrangement_class_id, student_id) into a
  friendly 409 carrying the offending student id.

## Seed (`seed-scheduling-advanced-b.ts`)

Idempotent, gated on whether `sch_exam_sessions` already has a row for
the demo school. Seeds:

- **A) 2 exam sessions** — Math Final 2026 (2026-06-15 09:00..11:00,
  120m, 0 extra) + English Final 2026 (2026-06-17 09:00..11:30, 150m).
- **B) 3 exam session rooms** — Main hall + accommodation room on
  Math, main hall on English.
- **C) 8 exam seatings** — 4 per session. Math: student 1 with
  extra_time_minutes=30 (EXTENDED_TIME demo); student 2 with
  separate_room=true (SEPARATE_LOCATION demo); students 3 + 4
  standard. English: students 1..4 standard.
- **D) 3 invigilator assignments** — lead + floating second on Math
  main hall, lead on English.
- **E) 2 co-teaching arrangements** — TEAM_TEACHING on slot 1,
  STATION_ROTATION on slot 2.
- **F) 2 pull-out interventions** — Reading Recovery WEEKLY (Tuesday)
  for student 1; Speech Therapy FORTNIGHTLY (Thursday) for student 2.
- **G) 1 cross-school staff assignment** — visiting Music Teacher,
  effective Jan-Jun 2026, max 4 periods/week.
- **H) 2 cover arrangements** — SUBSTITUTE_REPLACEMENT linked to a
  P2-9 sub_assignment when one exists in the seed (graceful null
  otherwise) + CLASS_SPLIT.
- **I) 3 cover arrangement classes** — 1 COVERED_BY_SUB on the
  SUBSTITUTE_REPLACEMENT arrangement, 1 SPLIT_TO + 1 SELF_STUDY on the
  CLASS_SPLIT arrangement.
- **J) 5 cover split students** — 3 to Group A, 2 to Group B,
  destination rooms + supervising teacher pre-populated.

Wired as `seed:scheduling-advanced-b` and into `seed-all.ts` after
`seed-scheduling-advanced` (P2-17a).

Idempotent re-run: skips with "P2-17b already seeded for demo school
— skipping." Verified live on `tenant_demo` 2026-05-12.

## Live verification

25-assertion schema smoke (single BEGIN…ROLLBACK with savepoints)
verified on `tenant_demo` 2026-05-12 — all green:

- T1 window_chk rejects end<=start.
- T2 happy-path exam session + 2 rooms inserted.
- T3 UNIQUE(session, room) rejects duplicate.
- T4 2 seatings with accommodation columns.
- T5 UNIQUE(session, student) rejects duplicate.
- T6 UNIQUE(session, room, invigilator) rejects duplicate.
- T7 tstzrange overlap correctly detects exam<->slot conflict (the
  service-layer pattern the conflict endpoint uses).
- T8 co-teaching TEAM_TEACHING inserted.
- T9 distinct_chk rejects primary = secondary.
- T10 model_chk rejects bogus teaching_model.
- T11 pull-out intervention inserted.
- T12 frequency_chk rejects bogus.
- T13 **PULL_OUT accepted as attendance status** (the extended CHECK).
- T14 status_chk still rejects BOGUS values.
- T15 cross-school staff inserted.
- T16 **person-level EXCLUSION catches overlap (SQLSTATE 23P01)** —
  the keystone.
- T17 non-overlapping cross-school window accepted for same person.
- T18 schools_chk rejects home=visiting.
- T19 cover arrangement CLASS_SPLIT PLANNED inserted.
- T20 cover_type CHECK rejects bogus.
- T21 completed_chk rejects COMPLETED with NULL completed_at.
- T22 UNIQUE(arrangement, affected_slot) rejects duplicate.
- T23 UNIQUE(arrangement_class, student) rejects duplicate.
- T24 CASCADE on arrangements drops classes + split students.
- T25 CASCADE on exam_sessions drops rooms + seatings + invigilators.

## Live API verification

All 26 P2-17b routes registered live on boot:

```
{/api/v1/scheduling/co-teaching, GET}
{/api/v1/scheduling/co-teaching, POST}
{/api/v1/scheduling/co-teaching/:id, DELETE}
{/api/v1/scheduling/co-teaching/:id, GET}
{/api/v1/scheduling/co-teaching/:id, PATCH}
{/api/v1/scheduling/cover, POST}
{/api/v1/scheduling/cover/:date/board, GET}
{/api/v1/scheduling/cover/:id, GET}
{/api/v1/scheduling/cover/:id/classes, POST}
{/api/v1/scheduling/cover/:id/status, PATCH}
{/api/v1/scheduling/cover/classes/:id/split-students, POST}
{/api/v1/scheduling/cross-school-staff, GET}
{/api/v1/scheduling/cross-school-staff, POST}
{/api/v1/scheduling/cross-school-staff/:id, GET}
{/api/v1/scheduling/cross-school-staff/:id, PATCH}
{/api/v1/scheduling/exams, GET}
{/api/v1/scheduling/exams, POST}
{/api/v1/scheduling/exams/:id, GET}
{/api/v1/scheduling/exams/:id/conflicts, GET}
{/api/v1/scheduling/exams/:id/invigilators, POST}
{/api/v1/scheduling/exams/:id/rooms, POST}
{/api/v1/scheduling/exams/:id/seat, POST}
{/api/v1/scheduling/pull-outs, GET}
{/api/v1/scheduling/pull-outs, POST}
{/api/v1/scheduling/pull-outs/:id, GET}
{/api/v1/scheduling/pull-outs/:id, PATCH}
```

## CI parity

- `pnpm format:check` — clean.
- `pnpm lint:logs` — 811 files clean.
- `pnpm --filter @campusos/api build` — clean.
- `pnpm --filter @campusos/api test` — 783/783 passing across 37 spec
  files.
- `pnpm --filter @campusos/web build` — clean.

## Structural keystones

The P2-17 cycle introduces **6 structural keystones**:

1. **CP-SAT vs Heuristic solver selection** (P2-17a) — ADR-060
   threshold drives `sch_scheduling_requests.solver_algorithm`. CP-SAT
   for ≤300 sections (exact, fully constraint-satisfied) or HEURISTIC
   for >300 (approximate, faster). The Scheduling Solver external
   service is stubbed today — service-layer stub fallback produces
   candidates synchronously for the demo.

2. **Promotion lifecycle with clash blocking** (P2-17a) —
   PENDING → REVIEWED → APPROVED → ACTIVE. The
   SchedulingActivationWorker refuses to promote any candidate that
   carries `total_clashes > 0` or any
   `sch_scheduling_candidate_slots.has_clash = true` row. Admin must
   resolve clashes (dismiss or edit the slot) before activation.

3. **Exam accommodation auto-population** (P2-17b) —
   `ExamSchedulingService.assignSeat` reads
   `sis_student_active_accommodations` and maps accommodation_type
   strings to the four `sch_exam_seatings` flags. Admin can override
   each field. Documented mapping:
   - EXTENDED_TIME / EXTRA_TIME → ceil(duration \* 0.25) minutes
   - SEPARATE_LOCATION / SEPARATE_ROOM → separate_room=true
   - READ_ALOUD / READER → reader_required=true
   - SCRIBE → scribe_required=true

4. **Co-teaching EXCLUSION relaxation** (P2-17b) — the
   sch_timetable_slots EXCLUSION on (teacher_id, period_id, daterange)
   catches the **primary** teacher's double-booking. Secondary
   teachers recorded in sch_coteaching_arrangements are referenced
   only via this junction — they don't appear on the slot's
   teacher_id column, so the schema-side EXCLUSION cannot fire
   against them. CoTeachingService.hasActiveCoTeachingFor is the
   service hook that answers "is this teacher's double-booking
   relaxed for this slot?" for future TimetableService call sites.

5. **PULL_OUT attendance pre-marking** (P2-17b) —
   PullOutService.create computes cadence-matching dates from the
   intervention's frequency + days_of_week + window and
   UPDATEs sis_attendance_records for the (student, class, date)
   tuples to status='PULL_OUT'. Idempotent UPDATE — re-running over
   already-PULL_OUT rows is a no-op. The migration extends the
   sis_attendance_records_status_chk via splitter-safe DROP + ADD to
   include PULL_OUT.

6. **Cross-school person-level EXCLUSION** (P2-17b) — the
   sch_cross_school_staff_assignments EXCLUSION on (person_id,
   daterange) prevents the same iam_person from holding overlapping
   cross-school assignments in this tenant. SQLSTATE 23P01 translated
   to 409 Conflict. Sister tenants are schema-isolated so this is the
   per-tenant invariant — Phase 3 ops adds a cross-tenant validator
   on platform if real schools need it.

## Wave C closure

Cycle 17 closes Wave C (Operational Depth). The Operational Depth
wave covered the modules schools rely on every day:

- Cycle 11 (Transportation Advanced — M61.1, 22 tables)
- Cycle 12 (Events & Ticketing — M101, 9 tables)
- Cycle 13 (SIS Advanced — M20.1, 24 tables)
- Cycle 14 (Behaviour Advanced — M20.1, 5 tables)
- Cycle 15 (Analytics Read Models — M110.1, 18 tables)
- Cycle 16 (bundled into P2-4 — Cycle 4 HR continuation)
- Cycle 17 (Scheduling Advanced — M22.1, 20 tables)

Wave C total: ~98 new tenant tables across the 6 cycles.

## Outstanding Phase 2 / pre-pilot follow-ups

Carried from the P2-17 plan and review prompts:

1. **Scheduling Solver external service** — production deployment of
   the CP-SAT / Heuristic solver. The service-layer stub ships today
   and produces valid candidates synchronously; production replaces
   it with the deployed solver and an async queue worker pattern.

2. **Co-teaching skip in TimetableService.assertNoConflicts** — the
   CoTeachingService.hasActiveCoTeachingFor hook is in place; the
   TimetableService should consult it when validating new slot
   inserts so the schema EXCLUSION never fires against a registered
   secondary teacher. Today the secondary teacher is just not on the
   slot row so the EXCLUSION can't fire against them anyway, but the
   explicit skip would let admins consciously assign a slot's
   teacher_id to the secondary teacher when needed.

3. **Pull-out re-pre-marking on cadence change** — PATCH of
   frequency or days_of_week does not currently re-run the
   attendance pre-mark. Operators re-trigger via DELETE + fresh POST
   when needed. Production should add a `POST /scheduling/pull-outs/:id/repremark`
   endpoint.

4. **Cross-school cross-tenant validator** — the per-tenant EXCLUSION
   is a strong guard but does not detect a person assigned to two
   visiting schools across separate tenants. Phase 3 ops adds a
   platform-tier scanner that crawls `platform.platform_tenant_routing`
   - each tenant's sch_cross_school_staff_assignments and surfaces
     cross-tenant double-bookings to the affected DPOs.

5. **Cover arrangement linkage to Cycle 5 sch_coverage_requests** —
   when a CLASS_SPLIT or SELF_STUDY arrangement lands, the
   per-(slot, date) sch_coverage_requests row should be auto-resolved
   to the arrangement so the day-level coverage board reconciles
   with the per-slot board.

6. **Exam room conflict auto-check on create** — `POST /scheduling/exams/:id/rooms`
   currently does NOT call findRoomConflicts after insert. Operators
   call the conflict endpoint explicitly. Production should auto-call
   on every room add and surface conflicts in the response body.

## Closing notes

P2-17b ships clean. The schema smoke is green, the seed shape matches
the plan exactly, all 26 endpoints register live, and the cycle is
ready for peer review under `REVIEW-P2C17-CHATGPT` against the closeout
commit.

Wave C closes here. Phase 2 continues with the remaining `.1` cycles
for cross-cutting concerns once pilot feedback arrives.
