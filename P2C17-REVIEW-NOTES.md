# REVIEW-P2C17 — Peer Review Scaffold

Scope of review: P2-17 (Scheduling Advanced, M22.1) — both sub-cycles.
20 sch\_\* tables (10 P2-17a + 10 P2-17b), ~46 endpoints, 2 workers
(SchedulingWorker + SchedulingActivationWorker), 1 cross-cycle ALTER
(sis_attendance_records.status PULL_OUT).

Commits to review:

- P2-17a Rotation + Schedule Generation + Subject Choices — `0406694`
- P2-17b Exams + Co-Teaching + Cover + Cross-School + Pull-Out + Peer
  Review Docs — this commit

Plan: `docs/campusos-p2c17-scheduling-advanced.html`
Handoff: `HANDOFF-P2C17.md`

## Review dimensions

The 6 dimensions to score for this cycle:

1. **Solver design + promotion lifecycle** (P2-17a).
   - Is the CP-SAT / Heuristic algorithm CHECK correctly bounded by
     ADR-060 thresholds?
   - Does the candidate promotion lifecycle (PENDING → REVIEWED →
     APPROVED → ACTIVE) refuse activation when clashes remain?
   - Is the constraint_violations JSONB shape consumable by the
     review UI?
2. **Exam scheduling integrity**.
   - Are the four accommodation flags (extra_time, separate_room,
     reader, scribe) correctly populated from
     sis_student_active_accommodations? Admin override path clean?
   - Does the conflict endpoint detect tstzrange overlap correctly
     against both sch_timetable_slots and sch_room_bookings?
   - UNIQUE(session, room) + UNIQUE(session, student) + UNIQUE(session,
     room, invigilator) all enforced?
3. **Co-teaching EXCLUSION relaxation**.
   - Is the relaxation conceptually correct? Primary teacher
     EXCLUSION still fires on sch_timetable_slots; secondary teachers
     live only in sch_coteaching_arrangements.
   - Does CoTeachingService.hasActiveCoTeachingFor correctly answer
     for downstream TimetableService consumers?
   - 5-value teaching_model CHECK distinguishes the right models?
4. **Pull-out attendance pre-marking**.
   - Cadence resolution: WEEKLY / FORTNIGHTLY / DAILY / CUSTOM —
     correct in PullOutService?
   - PULL_OUT status admitted by sis_attendance_records_status_chk
     after the ALTER?
   - Idempotent re-run (status <> 'PULL_OUT' guard)?
   - 90-day cap on null-end-date interventions reasonable?
5. **Cross-school person-level EXCLUSION**.
   - Does the EXCLUDE USING gist on (person_id, daterange) catch the
     human-level double-booking?
   - SQLSTATE 23P01 translated to 409 Conflict correctly?
   - PATCH path also catches the EXCLUSION?
   - schools_chk (home <> visiting) enforced?
6. **Cover arrangement disposition model**.
   - 5-value cover_type + 5-value disposition CHECK both enforced?
   - completed_chk lockstep keeps COMPLETED with completed_at NOT
     NULL?
   - CASCADE on sch_cover_arrangements drops classes + split students?
   - sub_assignment_id soft FK to P2-9 sub_assignments documented as
     soft (informational link)?

## Final Verdict — APPROVED at the closeout commit (2026-05-12)

Round 2 against `260e3d6` returned **PASS** across all 8 dimensions.
The reviewer's per-finding verification table marks every prior
blocker FIXED and confirmed every dimension score at PASS.

| Dimension           |    Final |
| ------------------- | -------: |
| Event Durability    | **PASS** |
| Schedule Generation | **PASS** |
| Co-Teaching         | **PASS** |
| Exam Scheduling     | **PASS** |
| Pull-Out            | **PASS** |
| Cover Arrangements  | **PASS** |
| Subject Choices     | **PASS** |
| Test Coverage       | **PASS** |

Tagged `p2c17-complete` at `260e3d6` and `p2c17-approved` at the
closeout commit. Three non-blocking follow-ups (cover coordinator
role split / pull-out repremark endpoint / exam room
auto-conflict-check) correctly carried to Phase 2 punch list per
the reviewer's gate decision — recommendation-class polish, not
gate blockers.

**Wave C (Operational Depth) closes here.**

Round 1 build-side green markers preserved below for review trail:

- 25-assertion live smoke green on `tenant_demo`.
- All 26 P2-17b routes registered on boot.
- 783/783 tests passing (Round 1 build state) → **810/810** after the
  Round 1 fix commit.
- Format + lint + API + web build all clean.

## Round 1 fix evidence (when applicable)

```bash
# Migration 150 splitter audit clean on first attempt.
python3 /tmp/audit_splitter.py packages/database/prisma/tenant/migrations/150_sch_exams_coteach_cover.sql
# → CLEAN — zero stray ; in comments or string literals

# Provisioning on demo + test cleanly.
pnpm --filter @campusos/database provision -- --subdomain=demo
# → 147 migration(s) applied / Tenant tenant_demo provisioned successfully
pnpm --filter @campusos/database provision -- --subdomain=test
# → 147 migration(s) applied / Tenant tenant_test provisioned successfully

# Live API smoke verifies all 26 new routes registered.
grep -oE '\{/api/v1/scheduling/(exams|co-teaching|pull-outs|cross-school-staff|cover)[^}]+\}' /tmp/boot6.log | sort -u | wc -l
# → 26

# Schema smoke (full BEGIN…ROLLBACK with savepoints).
docker exec -i campusos-postgres psql -U campusos -d campusos_dev < /tmp/p2c17b-smoke.sql 2>&1 | grep -E "PASS|FAIL"
# → 25 PASS / 0 FAIL

# Seed produces the planned row counts.
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "SET search_path TO tenant_demo,platform,public;
  SELECT 'sessions' AS t, count(*) FROM sch_exam_sessions
  UNION ALL SELECT 'rooms', count(*) FROM sch_exam_session_rooms
  UNION ALL SELECT 'seatings', count(*) FROM sch_exam_seatings
  UNION ALL SELECT 'invigilators', count(*) FROM sch_exam_invigilator_assignments
  UNION ALL SELECT 'coteach', count(*) FROM sch_coteaching_arrangements
  UNION ALL SELECT 'pullouts', count(*) FROM sch_pull_out_interventions
  UNION ALL SELECT 'cross-school', count(*) FROM sch_cross_school_staff_assignments
  UNION ALL SELECT 'cover arr', count(*) FROM sch_cover_arrangements
  UNION ALL SELECT 'cover classes', count(*) FROM sch_cover_arrangement_classes
  UNION ALL SELECT 'splits', count(*) FROM sch_cover_split_students;"
# → 2, 3, 8, 3, 2, 2, 1, 2, 3, 5
```

## Carried follow-ups (Phase 2 / pre-pilot)

The handoff lists 6 follow-ups; all are recommendation-class polish, not
cycle blockers:

1. Scheduling Solver external service production deployment.
2. TimetableService.assertNoConflicts consults
   CoTeachingService.hasActiveCoTeachingFor when validating new slot
   inserts.
3. POST /scheduling/pull-outs/:id/repremark for cadence-change repremark.
4. Cross-tenant cross-school validator (platform-tier scanner).
5. Cover arrangement linkage to Cycle 5 sch_coverage_requests.
6. Exam room conflict auto-check on create (POST /scheduling/exams/:id/rooms
   auto-calls findRoomConflicts after insert).

---

## REVIEW-P2C17 Round 1 — fix log (2026-05-12)

**Verdict:** Round 1 reviewer surfaced **6 BLOCKING + 4 MAJOR** against
commits `0406694` + `c4d13f1`. The closeout fix commit lands all 6
BLOCKINGs + 1 MAJOR (raw STAFF → explicit perm) + **27 new pinned
regression tests** in `scheduling-p2c17-review.spec.ts`. The remaining 3
MAJORs are recommendation-class polish and stay on the Phase 2 punch
list per the reviewer's gate.

| Finding                                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKING 1 — `sch.generation.completed` + `sch.timetable.updated` non-durable | **FIXED** — both emits moved to `OutboxService.enqueueInTx` INSIDE the triggering transaction. Deterministic event IDs via new `apps/api/src/scheduling/event-ids.ts` helpers (`sha256(<key>:<topic>:v1)` → v5-shape UUID). `ScheduleGenerationService` constructor swaps `KafkaProducerService` for `OutboxService`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| BLOCKING 2 — candidate / candidate_slot / activation paths not school-scoped  | **FIXED** — every candidate read/write path joins through `sch_scheduling_requests r` and filters `r.school_id = $tenant.schoolId`. Activation INSERT into `sch_timetable_slots` now validates `class_id` / `period_id` / `room_id` / `teacher_id` against current school via inline EXISTS clauses BEFORE the INSERT — foreign-school refs skip with WARN log + bump `slots_skipped`. `listActivationLogs` joins through candidate + request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| BLOCKING 3 — co-teaching paths not school-scoped                              | **FIXED** — every list/get/patch/delete joins through `sch_timetable_slots s ON s.id = ca.timetable_slot_id` filtered on `s.school_id`. `create()` validates slot + both teachers (`hr_employees.school_id`) BEFORE insert. `patch()`/`remove()` call `getById()` first to confirm school ownership (404 don't-leak-existence). `hasActiveCoTeachingFor` carries the same school-scope guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| BLOCKING 4 — exam child paths don't validate room/student/employee ownership  | **FIXED** — 3 new private helpers `assertRoomBelongsToSchool` / `assertStudentBelongsToSchool` / `assertEmployeeBelongsToSchool` called before INSERT in `addRoom`, `assignSeat`, `assignInvigilator`. Accommodation lookup adds `school_id = tenant.schoolId` predicate so cross-school accommodation flags can never seed a seat. `findRoomConflicts` session lookup gains school predicate. All child reloads join through `sch_exam_sessions` to enforce parent-session school scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| BLOCKING 5 — pull-out create + attendance pre-mark scoping                    | **FIXED** — `create()` validates studentId + regularSlotId + interventionProvider against current school via inline EXISTS clauses BEFORE INSERT. `premarkAttendance` joins through `sch_pull_out_interventions i + sch_timetable_slots s` with `i.school_id = s.school_id = tenant.schoolId`. Attendance UPDATE adds a JOIN against `sis_students stu` filtered on `stu.school_id` for defence-in-depth. `patch()` carries `school_id` predicate on the UPDATE.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| BLOCKING 6 — cover arrangement child references not school-scoped             | **FIXED** — `create()` validates absent/covering teachers + sub_assignment (joined through `sub_job_postings.school_id`) BEFORE insert. `addClass()` validates affected class + slot + destination room + supervising teacher. `addSplitStudents()` validates students + optional destination rooms + supervising teachers in batch via `ANY(string_to_array(...)::uuid[])`. Child reloads join through `sch_cover_arrangements a` so foreign-school rows can never surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| BLOCKING 7 — subject choice STAFF bypass + cross-school leak                  | **FIXED** — `SubjectChoiceService` constructor injects `PermissionCheckService`. New `hasSchedulingAdminScope(actor)` helper replaces `personType === 'STAFF'` everywhere — admin is explicit `sch-001:admin` via `permissionCheck.hasAnyPermissionInTenant`. `SELECT_CHOICE_BASE` JOINs `sis_students stu` so every list query filters `stu.school_id`. `resolveOwnStudentId` + `resolveGuardianStudentIds` school-scope through `sis_students.school_id`. `submit()` validates body.studentId against current school. `demand()` joins through students for school-scope + requires sch-001:admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| MAJOR 1 — `school admin only` vs `cover coordinator` semantics                | Accepted — cover writes stay gated on `actor.isSchoolAdmin` today (mirrors Cycle 5 CoverageService); the explicit `sch-004:write` PermissionCheckService path joins the broader role-split punch list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| MAJOR 2 — Pull-out PATCH does not re-pre-mark                                 | Documented in the Phase 2 follow-up list (operators DELETE + re-create for a cadence change).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| MAJOR 3 — Exam room conflict not auto-invoked on POST /rooms                  | Documented in the Phase 2 follow-up list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| MAJOR 4 — Test coverage too thin                                              | **FIXED** — 27 new pinned regression tests across 7 describe blocks: `REVIEW-P2C17 BLOCKING 1 — durable outbox` (3 tests including deterministic event-id stability + v5-shape on both helpers + ScheduleGenerationService constructor expects OutboxService). `BLOCKING 2 — candidate paths` (3 tests: getCandidate / listCandidateSlots / listActivationLogs all join through request.school_id). `BLOCKING 3 — co-teaching` (4 tests: list/get/create reject foreign-school slot + hasActiveCoTeachingFor school-scope). `BLOCKING 4 — exam children` (5 tests: addRoom/assignSeat/assignInvigilator/findRoomConflicts/accommodation lookup). `BLOCKING 5 — pull-out` (2 tests: foreign student + foreign slot). `BLOCKING 6 — cover` (3 tests: create / addClass / addSplitStudents). `BLOCKING 7 — subject choices` (6 tests: SELECT_CHOICE_BASE school predicate + generic STAFF empty list + demand admin scope + demand SQL shape + resolveOwnStudentId school-scope + submit body.studentId validation). Plus 1 regression test confirming `CrossSchoolStaffService` translates SQLSTATE 23P01 to a 409 with the keystone message. |

### Test evidence

```
pnpm --filter @campusos/api test
 Test Files  38 passed (38)
      Tests  810 passed (810)
```

The new `scheduling-p2c17-review.spec.ts` adds 27 assertions covering
each fix; vitest count grew 783 → 810.

### CI parity

- `pnpm format:check` — clean.
- `pnpm lint:logs` — 813 files clean.
- `pnpm --filter @campusos/api build` — clean.
- `pnpm --filter @campusos/api test` — 810/810.
- `pnpm --filter @campusos/web build` — clean.

### Out-of-scope follow-ups carried to Phase 2 punch list

1. MAJOR 1: dedicated cover coordinator role split (joins Wave-2
   Phase 2 role-split chain).
2. MAJOR 2: `POST /scheduling/pull-outs/:id/repremark` for cadence-change
   repremarking.
3. MAJOR 3: auto-call findRoomConflicts on `POST /scheduling/exams/:id/rooms`.

No schema migrations were required for the Round 1 fixes — every
BLOCKING is fixed at the service layer + via the new
`apps/api/src/scheduling/event-ids.ts` helper file.
