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

## Round 1 Verdict — TBD

Awaiting reviewer verdict. The cycle ships clean from the build side:

- 25-assertion live smoke green on tenant_demo.
- All 26 P2-17b routes registered on boot.
- 783/783 tests passing.
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
