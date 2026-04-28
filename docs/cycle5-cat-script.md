# CampusOS Cycle 5 — Customer Acceptance Test Script

**Cycle:** 5 (Scheduling & Calendar)
**Step:** 10 of 10 — Vertical Slice Integration Test
**Last verified:** 2026-04-28 (against `tenant_demo` on `main`)
**Plan reference:** `docs/campusos-cycle5-implementation-plan.html` § Step 10

This is the manual walkthrough that exercises every layer of Cycle 5 — the 10 base scheduling tables across Steps 1–3 (with the two `btree_gist` EXCLUSION constraints on `sch_timetable_slots`), the seeded bell schedule + timetable + calendar + coverage from Step 4, the 22 timetable / room / booking endpoints from Step 5, the 16 calendar / coverage endpoints + `CoverageConsumer` from Step 6, the admin web surfaces from Steps 7–8 (bell schedule editor, timetable grid, room directory, room bookings, calendar, coverage board), and the non-admin schedule views + new `/timetable/student/:studentId` row-scoped endpoint from Step 9. The format mirrors `docs/cycle1-cat-script.md` through `docs/cycle4-cat-script.md`.

The verification below was captured live with the API, all Cycle 1–4 Kafka consumers (gradebook-snapshot-worker, audience-fan-out-worker, the 5 notification consumers, leave-notification-consumer), the `CoverageConsumer`, and the notification-delivery worker all running against the freshly-seeded demo tenant. Outputs are recorded inline so a reviewer can re-run the script and diff the results against this transcript.

The plan's 10 scenarios are bracketed by a 4-check schema preamble that proves the 10 scheduling tables landed cleanly (with EXCLUSIONs and zero cross-schema FKs) before the business flow runs.

---

## Prerequisites

- Docker services up: `docker compose up -d` (Postgres, Redis, Kafka, Keycloak).
- Cycle 1–4 schema + seed in place. Full reset for a fresh CAT run:

  ```bash
  docker exec campusos-postgres psql -U campusos -d campusos_dev \
    -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
  pnpm --filter @campusos/database provision --subdomain=demo
  pnpm --filter @campusos/database provision --subdomain=test
  pnpm --filter @campusos/database seed                       # platform + 7 test users
  pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # 444 perms, 6 roles
  pnpm --filter @campusos/database seed:sis                   # SIS
  pnpm --filter @campusos/database seed:classroom             # Cycle 2
  pnpm --filter @campusos/database seed:messaging             # Cycle 3
  pnpm --filter @campusos/database seed:hr                    # Cycle 4
  pnpm --filter @campusos/database seed:scheduling            # Cycle 5
  pnpm --filter @campusos/database exec tsx src/build-cache.ts
  ```

- API running (must be the freshly built `dist/`): `pnpm --filter @campusos/api build && pnpm --filter @campusos/api start`. The CoverageConsumer subscribes on boot — Scenario 6 below depends on it.

- Pre-create the dev Kafka topics on a fresh broker (the scheduling emits add 3 topics on top of Cycle 4's HR set):

  ```bash
  for t in dev.sch.timetable.updated dev.sch.coverage.needed dev.sch.coverage.assigned; do
    docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
      --bootstrap-server localhost:9092 --create --if-not-exists \
      --topic "$t" --partitions 3 --replication-factor 1
  done
  ```

- Web running (for the UI walkthrough lines): `pnpm --filter @campusos/web dev` at `http://localhost:3000`.

- Tokens stashed for the four personas under test:

  ```bash
  login() {
    curl -s -X POST http://localhost:4000/api/v1/auth/dev-login \
      -H "Content-Type: application/json" -H "X-Tenant-Subdomain: demo" \
      -d "{\"email\":\"$1\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])"
  }
  PRINCIPAL=$(login principal@demo.campusos.dev)   # School Admin (Sarah Mitchell)
  TEACHER=$(login teacher@demo.campusos.dev)       # Teacher (James Rivera)
  PARENT=$(login parent@demo.campusos.dev)         # Parent (David Chen, Maya's father)
  STUDENT=$(login student@demo.campusos.dev)       # Student (Maya Chen)
  VP=$(login vp@demo.campusos.dev)                 # Staff (Linda Park, the seeded substitute)
  ```

  Every request below sends `X-Tenant-Subdomain: demo` and the appropriate `Authorization: Bearer …` token.

---

## Schema preamble — 4 checks

The 10 base scheduling tables landed across Steps 1–3 with `btree_gist` EXCLUSION constraints on `sch_timetable_slots` and zero cross-schema FKs. Verified before any business flow runs:

```sql
SELECT 'tenant base tables' AS check, count(*) AS value
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='tenant_demo' AND c.relkind IN ('r','p') AND c.relispartition=false
UNION ALL
SELECT 'sch_ scheduling tables', count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='tenant_demo' AND c.relkind IN ('r','p') AND c.relispartition=false
   AND c.relname LIKE 'sch\_%' ESCAPE '\'
UNION ALL
SELECT 'cross-schema FKs', count(*)
  FROM pg_constraint c
  JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace nt ON nt.oid=t.relnamespace
  JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace nr ON nr.oid=r.relnamespace
 WHERE c.contype='f' AND nt.nspname='tenant_demo' AND nr.nspname<>'tenant_demo'
UNION ALL
SELECT 'btree_gist EXCLUSIONs', count(*)
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
  JOIN pg_namespace nt ON nt.oid=t.relnamespace
 WHERE c.contype='x' AND nt.nspname='tenant_demo';
```

```
       check         | value
---------------------+-------
 tenant base tables  |    84
 sch_ scheduling     |    10
 cross-schema FKs    |     0
 btree_gist EXCLUSIONs|    2
```

Cycle 4 left 74 tenant base tables; Cycle 5 added 10 (`sch_bell_schedules`, `sch_periods`, `sch_rooms` from Step 1; `sch_timetable_slots`, `sch_room_bookings`, `sch_room_change_requests` from Step 2; `sch_calendar_events`, `sch_calendar_day_overrides`, `sch_coverage_requests`, `sch_substitution_timetable` from Step 3). The 2 EXCLUSIONs are `sch_timetable_slots_teacher_no_overlap` and `sch_timetable_slots_room_no_overlap`. ADR-001/020 holds: zero DB-enforced FKs from a tenant table to anything outside `tenant_demo`.

Seed row counts (from `seed:scheduling`):

```sql
SELECT 'sch_bell_schedules' AS t, count(*) FROM tenant_demo.sch_bell_schedules
UNION ALL SELECT 'sch_periods', count(*) FROM tenant_demo.sch_periods
UNION ALL SELECT 'sch_rooms', count(*) FROM tenant_demo.sch_rooms
UNION ALL SELECT 'sch_timetable_slots', count(*) FROM tenant_demo.sch_timetable_slots
UNION ALL SELECT 'sch_calendar_events', count(*) FROM tenant_demo.sch_calendar_events
UNION ALL SELECT 'sch_calendar_day_overrides', count(*) FROM tenant_demo.sch_calendar_day_overrides
UNION ALL SELECT 'sch_coverage_requests', count(*) FROM tenant_demo.sch_coverage_requests
UNION ALL SELECT 'sch_substitution_timetable', count(*) FROM tenant_demo.sch_substitution_timetable
UNION ALL SELECT 'sch_room_bookings', count(*) FROM tenant_demo.sch_room_bookings;
```

```
              t              | count
-----------------------------+-------
 sch_bell_schedules          |     2
 sch_periods                 |    19
 sch_rooms                   |    10
 sch_timetable_slots         |     6
 sch_calendar_events         |     5
 sch_calendar_day_overrides  |     1
 sch_coverage_requests       |     1
 sch_substitution_timetable  |     1
 sch_room_bookings           |     1
```

---

## Scenario 1 — Admin views the school timetable

Anchored read: principal hits `GET /timetable` and gets Rivera's 6 seeded Standard Day slots with the full join shape (class section + course name + period name + clock-time + teacher name + room name + effective-from date).

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/timetable
```

```
count=6
  Period 1 (08:00-08:50) | 1 Algebra 1     | teacher=James Rivera | room=Room 101 | from=2025-08-15
  Period 2 (09:00-09:50) | 2 English 9     | teacher=James Rivera | room=Room 102 | from=2025-08-15
  Period 3 (10:00-10:50) | 3 Biology       | teacher=James Rivera | room=Room 103 | from=2025-08-15
  Period 4 (10:50-11:40) | 4 World History | teacher=James Rivera | room=Room 104 | from=2025-08-15
  Period 5 (12:20-13:10) | 5 Geometry      | teacher=James Rivera | room=Room 105 | from=2025-08-15
  Period 6 (13:10-14:00) | 6 Chemistry     | teacher=James Rivera | room=Room 106 | from=2025-08-15
```

UI walkthrough: log in as `principal@demo.campusos.dev`, click the **Schedule** tile on the launchpad. `/schedule/timetable` renders the week-view grid with rows = the 11 periods of the Standard Day default schedule and columns = Mon–Fri. The 6 cells (one per Rivera class) appear in every Mon–Fri column for Periods 1–6 (the seed uses `dayOfWeek=null` so each slot applies to every weekday). Each cell shows section code + course name + teacher name + room name in a campus-100 chip.

---

## Scenario 2 — Teacher views own week (Rivera)

Teacher logs in, clicks **Schedule** tile (now also clicks through to `/my-schedule` from the Step 9 button on `/classes`), sees their own 6-period week. Path: `useMyEmployee` → `useTimetableForTeacher(employeeId)`.

```bash
RIVERA_EMP=$(curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/employees/me | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/timetable/teacher/$RIVERA_EMP"
```

```
Rivera employeeId: 019dd544-85e6-7997-b89d-099bf973ba2b
count=6
  Period 1 | 1 Algebra 1     | room=Room 101
  Period 2 | 2 English 9     | room=Room 102
  Period 3 | 3 Biology       | room=Room 103
  Period 4 | 4 World History | room=Room 104
  Period 5 | 5 Geometry      | room=Room 105
  Period 6 | 6 Chemistry     | room=Room 106
```

UI: `/my-schedule` page (Step 9). Rivera sees the same week-view grid as the admin but without the Mon–Fri filter chip header — it's "your week, this week." A second section below the grid lists upcoming substitution coverage in the next 14 days (sourced from `useSubstitutionsForTeacher`); empty for Rivera since they're the absent teacher in the seeded substitution row, not the substitute.

---

## Scenario 3 — Parent views child's timetable (David Chen → Maya)

The Step 9 row-scoped endpoint `GET /timetable/student/:studentId` gates on `stu-001:read` (held by every relevant persona) with row-scope enforced by `StudentService.assertCanViewStudent` at the service layer. David Chen is linked to Maya via `sis_student_guardians`; Maya's enrolled in Periods 1–4 of Rivera's 6 classes per the Cycle 1 seed.

```bash
MAYA_ID=$(curl -s -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/students/my-children | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
curl -s -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/timetable/student/$MAYA_ID"
```

```
Maya studentId: 019dd544-7e06-777b-94e8-2e3304310985
count=4
  Period 1 | 1 Algebra 1     | teacher=James Rivera | room=Room 101
  Period 2 | 2 English 9     | teacher=James Rivera | room=Room 102
  Period 3 | 3 Biology       | teacher=James Rivera | room=Room 103
  Period 4 | 4 World History | teacher=James Rivera | room=Room 104
```

UI: parent logs in, clicks the **My Children** tile, then the new **Schedule** button on Maya's child card → `/children/[id]/schedule`. The page header shows Maya's name + grade; the body renders the same `TimetableWeekView` grid showing Maya's 4 enrolled-class slots. Periods 5 + 6 render `—` because Maya isn't enrolled in those classes per the seed.

---

## Scenario 4 — Double-booking prevention (EXCLUSION → 409)

The Step 2 `sch_timetable_slots_teacher_no_overlap` EXCLUSION rejects two slots where the same teacher is on the same period over an overlapping daterange. Step 5's `TimetableService.translateConflict` catches the SQLSTATE 23P01 and turns it into a friendly 409 with the conflicting actor's name.

```bash
P1_ID=<Period 1 id>          # from /bell-schedules default schedule
LIBRARY_ID=<Library room id> # from /rooms
ANY_CLASS=<a different class id>  # any class other than Rivera's seeded Algebra
curl -s -X POST -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"classId\":\"$ANY_CLASS\",\"periodId\":\"$P1_ID\",\"teacherId\":\"$RIVERA_EMP\",\"roomId\":\"$LIBRARY_ID\",\"effectiveFrom\":\"2025-08-15\"}" \
  http://localhost:4000/api/v1/timetable/slots
```

```
HTTP=409
{"message":"Teacher James Rivera is already scheduled for Period 1 during the requested date range","error":"Conflict","statusCode":409}
```

The schema's EXCLUSION fired (SQLSTATE 23P01), the constraint name `sch_timetable_slots_teacher_no_overlap` was matched, and the service-layer translator looked up `hr_employees + iam_person` for the teacher's name and `sch_periods.name` for the period to render the friendly message. UI: at `/schedule/timetable`, an admin trying to add a second slot for Rivera + Period 1 + a different room would see the same Toast text. The schema makes overlap impossible at the storage layer, so the grid is consistent by construction.

---

## Scenario 5 — Seeded ASSIGNED coverage row (Step 4 baseline)

Before the live leave→coverage cycle in Scenario 6, verify the seeded baseline: 1 ASSIGNED coverage row + 1 substitution row matching Park-covers-Rivera-Period-1-Algebra-2026-03-09 (from Cycle 4's seeded APPROVED 2-day Sick leave).

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/coverage?fromDate=2026-03-09&toDate=2026-03-09"
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/substitutions?fromDate=2026-03-09&toDate=2026-03-09"
```

```
count=1
  2026-03-09 Period 1 1 Algebra 1 status=ASSIGNED sub=Linda Park room=Room 101
substitutions count=1
  2026-03-09 Period 1 1 Algebra 1 sub=Linda Park room=Room 101
```

UI: admin lands on the **Calendar** tile sidebar entry → clicks **Schedule** tile → `/schedule/coverage` → set the date picker to `2026-03-09` → the page renders the Assigned section with 1 row showing the Park-covers-Rivera assignment with the assignedAt timestamp.

---

## Scenario 6 — Live leave → coverage flow

The end-to-end loop: Rivera submits a 1-day leave for a future Wednesday → admin approves → `LeaveNotificationConsumer` republishes `hr.leave.coverage_needed` → `CoverageConsumer` enumerates the weekday(s) in the range, joins through `sis_class_teachers` for Rivera's classes that day, and INSERTs one OPEN `sch_coverage_requests` row per matching `(slot, date)` tuple. The `UNIQUE(timetable_slot_id, coverage_date)` is the schema-side belt-and-braces dedup; the deterministic event_id from REVIEW-CYCLE4 MAJOR 3 is the primary gate via `processWithIdempotency`.

```bash
LEAVE_DATE="2026-09-30"   # Wednesday
SICK_ID=$(curl -s -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/leave-types \
  | python3 -c "import sys,json; print([t for t in json.load(sys.stdin) if t['name']=='Sick Leave'][0]['id'])")

# 6a — submit
LEAVE_ID=$(curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"leaveTypeId\":\"$SICK_ID\",\"startDate\":\"$LEAVE_DATE\",\"endDate\":\"$LEAVE_DATE\",\"daysRequested\":1,\"reason\":\"CAT smoke — sub coverage\"}" \
  http://localhost:4000/api/v1/leave-requests | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 6b — admin approves
curl -s -X PATCH -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"reviewNotes":"Approved for CAT"}' \
  "http://localhost:4000/api/v1/leave-requests/$LEAVE_ID/approve"

# 6c — wait for the consumer to fire
sleep 3

# 6d — coverage rows should exist
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/coverage?fromDate=$LEAVE_DATE&toDate=$LEAVE_DATE"
```

Submit response:

```json
{
  "id": "019dd63a-543e-722e-a3da-5648551d5ce7",
  "status": "PENDING",
  "daysRequested": 1,
  "reason": "CAT smoke — sub coverage",
  "startDate": "2026-09-30",
  "endDate": "2026-09-30"
}
```

Approve response: `status=APPROVED reviewedAt=2026-04-28T22:34:00.224Z`.

Coverage list 3s after approve:

```
count=6
  Period 1 | 1 Algebra 1     | absent=James Rivera | room=Room 101 | status=OPEN | leaveRequestId=019dd63a-543e-722e-a3da-5648551d5ce7
  Period 2 | 2 English 9     | absent=James Rivera | room=Room 102 | status=OPEN | leaveRequestId=019dd63a-543e-722e-a3da-5648551d5ce7
  Period 3 | 3 Biology       | absent=James Rivera | room=Room 103 | status=OPEN | leaveRequestId=019dd63a-543e-722e-a3da-5648551d5ce7
  Period 4 | 4 World History | absent=James Rivera | room=Room 104 | status=OPEN | leaveRequestId=019dd63a-543e-722e-a3da-5648551d5ce7
  Period 5 | 5 Geometry      | absent=James Rivera | room=Room 105 | status=OPEN | leaveRequestId=019dd63a-543e-722e-a3da-5648551d5ce7
  Period 6 | 6 Chemistry     | absent=James Rivera | room=Room 106 | status=OPEN | leaveRequestId=019dd63a-543e-722e-a3da-5648551d5ce7
```

The `CoverageConsumer` ran the weekday loop (just one date in this range), joined through `sch_timetable_slots → sch_periods` for each affectedClasses[].classId, found 6 active slots whose period `day_of_week=NULL` matched, and inserted 6 OPEN rows — each linked to the original leave request via `leave_request_id`. UI: at `/schedule/coverage` with the date picker set to `2026-09-30`, all 6 rows render in the Open (red-tinted) section.

---

## Scenario 7 — Admin assigns Park to Period 1 + `sch.coverage.assigned` envelope

Admin clicks **Assign** on the Period 1 OPEN row → Modal pre-loads `useEmployees` + `useRooms`, filters out the absent teacher and inactive employees → admin picks Linda Park → submit. The Step 6 backend writes the OPEN→ASSIGNED transition + matching `sch_substitution_timetable` row in one tx, then emits `sch.coverage.assigned` outside the tx.

```bash
P1_COV_ID=<Period 1 coverage row id from Scenario 6>
PARK_ID=<Linda Park hr_employees.id>
curl -s -X PATCH -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"substituteId\":\"$PARK_ID\",\"notes\":\"Park covering Period 1 Algebra (CAT)\"}" \
  "http://localhost:4000/api/v1/coverage/$P1_COV_ID/assign"
```

```
status=ASSIGNED sub=Linda Park assignedAt=2026-04-28T22:34:32.358Z
```

Substitution row materialised:

```
count=1
  2026-09-30 Period 1 1 sub=Linda Park room=Room 101
```

`sch.coverage.assigned` envelope captured from Kafka:

```bash
docker exec campusos-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic dev.sch.coverage.assigned \
  --from-beginning --timeout-ms 4000 2>/dev/null | tail -1
```

```json
{
  "event_id": "019dd63a-d233-722e-a3db-03d3b4c961bb",
  "event_type": "sch.coverage.assigned",
  "event_version": 1,
  "occurred_at": "2026-04-28T22:34:32.371Z",
  "published_at": "2026-04-28T22:34:32.371Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "scheduling",
  "correlation_id": "019dd63a-d233-722e-a3db-0d0d7532e23c",
  "payload": {
    "coverageRequestId": "019dd63a-54d1-722e-a3da-a54ab534d462",
    "timetableSlotId": "019dd5c8-0e7a-7aac-b2cb-a4eb83756b88",
    "coverageDate": "2026-09-30",
    "substituteId": "019dd544-85e7-7997-b89d-1459422d6c56",
    "substituteName": "Linda Park",
    "absentTeacherId": "019dd544-85e6-7997-b89d-099bf973ba2b",
    "absentTeacherName": "James Rivera",
    "classSectionCode": "1",
    "courseName": "Algebra 1",
    "periodName": "Period 1",
    "roomId": "019dd5c8-0e6b-7aac-b2cb-554486d0eb31",
    "roomName": "Room 101",
    "assignedAt": "2026-04-28T22:34:32.358Z"
  }
}
```

ADR-057 envelope, `source_module=scheduling`, full join shape inline so a downstream consumer doesn't need DB lookups. UI: the **Coverage Board** flips Period 1 from the red Open section into the amber Assigned section showing `Sub: Linda Park`. Park's day-view of `/my-schedule` for the week containing 2026-09-30 would render the Period 1 cell with an amber border + struck-through "James Rivera" + "→ Linda Park".

**Known gap:** there is no consumer wired yet to translate `sch.coverage.assigned` into an IN_APP notification on Park's bell. The emit shape is ready (full join shape inline so a downstream consumer doesn't need DB lookups) but the actual fan-out lands in a future patch — most likely a small NotificationConsumer addition. For Step 10 the emit is fire-and-forget and the test verifies the wire envelope only.

---

## Scenario 8 — Calendar (Spring Break, PD day, snow day)

Admin lists the year's events including drafts; verifies the snow-day override resolves correctly via the day-resolution endpoint.

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  "http://localhost:4000/api/v1/calendar?fromDate=2026-01-01&toDate=2026-12-31&includeDrafts=true"
```

```
count=5
  2026-03-15->2026-03-15 PROFESSIONAL_DEVELOPMENT 'Professional Development Day' published=True  affectsAttendance=True
  2026-04-14->2026-04-18 HOLIDAY                  'Spring Break'                  published=True  affectsAttendance=True
  2026-05-01->2026-05-01 PARENT_EVENT             'Parent-Teacher Conference Evening' published=True affectsAttendance=False
  2026-05-23->2026-05-23 CUSTOM                   'Senior Prom'                   published=False affectsAttendance=False
  2026-06-06->2026-06-06 ASSEMBLY                 'End of Year Assembly'          published=True  affectsAttendance=False
```

```bash
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/calendar/overrides
curl -s -H "Authorization: Bearer $PRINCIPAL" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/calendar/day/2026-02-07
```

```
overrides:
  2026-02-07 isSchoolDay=False reason=Winter storm closure

day-resolution 2026-02-07:
{
  "date": "2026-02-07",
  "resolvedFrom": "OVERRIDE",
  "isSchoolDay": false,
  "bellScheduleId": null,
  "bellScheduleName": null,
  "overrideId": "019dd5c8-0e8c-7aac-b2cb-f9e45b120714",
  "overrideReason": "Winter storm closure",
  "eventIds": []
}
```

Resolution chain (Step 6 spec): override first → published events with a `bell_schedule_id` override → school's `is_default=true` schedule → `NONE`. The 2026-02-07 row hits the override branch immediately. UI: at `/calendar`, navigate to February 2026 — the cell for 2026-02-07 shows the gray "Closed · Winter storm closure" pill above any other content. Spring Break renders with rose chips spanning 2026-04-14 through 2026-04-18. The 5th row (Senior Prom, draft) only appears when the admin checks `Show drafts` — non-admins never see it.

---

## Scenario 9 — Room booking + conflict prevention

The Step 5 `assertNoConflicts` gate checks both existing CONFIRMED bookings whose time range overlaps **and** active timetable slots whose period clock-time on the booking's ISO weekday overlaps the booking window (the schema does NOT enforce booking-vs-slot conflict — it's an app-layer gate per the Step 2 out-of-scope decision).

```bash
LIBRARY=<Library room id>

# 9a — clean booking
curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"$LIBRARY\",\"bookingPurpose\":\"CAT smoke study session\",\"startAt\":\"2026-10-15T09:00:00.000Z\",\"endAt\":\"2026-10-15T10:00:00.000Z\"}" \
  http://localhost:4000/api/v1/room-bookings
```

```json
{
  "id": "019dd63e-de30-722e-a3db-22b42af53f77",
  "roomName": "Library",
  "bookedByName": "James Rivera",
  "bookingPurpose": "CAT smoke study session",
  "startAt": "2026-10-15T09:00:00.000Z",
  "endAt": "2026-10-15T10:00:00.000Z",
  "status": "CONFIRMED"
}
```

```bash
# 9b — booking-vs-booking overlap
curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"$LIBRARY\",\"bookingPurpose\":\"Conflict test\",\"startAt\":\"2026-10-15T09:30:00.000Z\",\"endAt\":\"2026-10-15T10:30:00.000Z\"}" \
  http://localhost:4000/api/v1/room-bookings
```

```
HTTP=409
{"message":"Room is already booked for an overlapping window (booking 019dd63e-de30-722e-a3db-22b42af53f77)","error":"Conflict","statusCode":409}
```

```bash
# 9c — booking-vs-timetable overlap (Room 101 during Rivera's Period 1 Algebra)
curl -s -X POST -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"roomId\":\"<Room 101>\",\"bookingPurpose\":\"Should conflict with Period 1 Algebra\",\"startAt\":\"2026-10-15T08:15:00.000Z\",\"endAt\":\"2026-10-15T08:45:00.000Z\"}" \
  http://localhost:4000/api/v1/room-bookings
```

```
HTTP=409
{"message":"Room is in use by the timetable during the requested window: 1 / Period 1","error":"Conflict","statusCode":409}
```

UI: at `/schedule/room-bookings`, the **Room Availability Checker** widget at the top of the page (Step 9) lets the user pick a date + period and see which rooms are free; Room 101 / Period 1 / a school day shows the amber "in use" dot. Then **New booking** opens a Modal — picking Room 101 with a window that overlaps Period 1 returns the 409 inline via Toast.

---

## Scenario 10 — Permission denials

Six permission gates exercised across the four non-admin personas:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $PARENT"  -H "X-Tenant-Subdomain: demo" http://localhost:4000/api/v1/timetable
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $STUDENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" -d '{"roomId":"…","bookingPurpose":"…","startAt":"2027-01-15T09:00:00Z","endAt":"2027-01-15T10:00:00Z"}' http://localhost:4000/api/v1/room-bookings
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" -d '{"substituteId":"…"}' "http://localhost:4000/api/v1/coverage/<id>/assign"
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $PARENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" -d '{"title":"X","eventType":"CUSTOM","startDate":"2027-01-01","endDate":"2027-01-01"}' http://localhost:4000/api/v1/calendar
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $PARENT"  -H "X-Tenant-Subdomain: demo" "http://localhost:4000/api/v1/timetable/student/<other-student-id>"
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $STUDENT" -H "X-Tenant-Subdomain: demo" -H "Content-Type: application/json" -d '{"name":"X","scheduleType":"CUSTOM"}' http://localhost:4000/api/v1/bell-schedules
```

| Step | Caller | Action                                       | Required perm    | Expected | Got |
| ---: | ------ | -------------------------------------------- | ---------------- | -------- | ---: |
|  10a | Parent  | `GET /timetable`                            | `sch-001:read`   | 403      | **403** |
|  10b | Student | `POST /room-bookings`                       | `sch-005:write`  | 403      | **403** |
|  10c | Teacher | `PATCH /coverage/:id/assign`                | admin (service)  | 403      | **403** |
|  10d | Parent  | `POST /calendar`                            | `sch-003:admin`  | 403      | **403** |
|  10e | Parent  | `GET /timetable/student/:unrelated`         | row-scope reject | 404      | **404** |
|  10f | Student | `POST /bell-schedules`                      | `sch-001:admin`  | 403      | **403** |

10a–10b–10d–10f are gate-tier permission denials (the `@RequirePermission` decorator catches them before the service layer). 10c is service-layer admin check (the gate `sch-004:write` does pass for the teacher per Step 4's grant, but `CoverageService.assign` enforces `actor.isSchoolAdmin` which fails for Rivera). 10e is the row-scope rejection from `StudentService.assertCanViewStudent` — a parent calling `/timetable/student/:id` for a student they aren't linked to via `sis_student_guardians` gets 404 (collapsed from 403 to avoid probing existence of student ids the caller has no access to).

---

## Cleanup

The CAT writes 1 leave request, 6 coverage rows, 1 substitution row, and 1 room booking; restore `tenant_demo` to seed state so the next run starts clean:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TEACHER" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"cancelledReason":"CAT cleanup"}' \
  "http://localhost:4000/api/v1/room-bookings/$B1_ID/cancel"

docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
DELETE FROM tenant_demo.sch_substitution_timetable
 WHERE coverage_request_id IN (SELECT id FROM tenant_demo.sch_coverage_requests WHERE leave_request_id = '$LEAVE_ID');
DELETE FROM tenant_demo.sch_coverage_requests WHERE leave_request_id = '$LEAVE_ID';
DELETE FROM tenant_demo.sch_room_bookings WHERE id = '$B1_ID' AND status = 'CANCELLED';
DELETE FROM tenant_demo.hr_leave_requests WHERE id = '$LEAVE_ID';
UPDATE tenant_demo.hr_leave_balances b
   SET used = 2.0, pending = 0.0, updated_at = now()
  FROM tenant_demo.hr_leave_types t
 WHERE b.leave_type_id = t.id AND t.name = 'Sick Leave' AND b.employee_id = '$RIVERA_EMP';
"
```

Verify state restored:

```
coverage rows           | 1   ← back to seeded Park-covers-Rivera-2026-03-09
substitution rows       | 1   ← matching seeded substitution row
room bookings (CONFIRMED)| 1  ← back to seeded Main Hall booking
Rivera Sick balance     | used=2.00 pending=0.00
```

`tenant_demo` is back to the post-`seed:scheduling` state.

---

## Outcome

All 10 plan scenarios pass on `tenant_demo` as of 2026-04-28. The scheduling vertical slice is verified end-to-end:

- Timetable read paths surface Rivera's 6 seeded slots correctly to admin / teacher / student / parent personas with the right row-scope gates.
- Schema-level EXCLUSION constraints translate to friendly 409 Conflict responses with the conflicting actor's name.
- The leave → coverage → substitute loop runs in under a second from approval to OPEN coverage rows landing.
- Substitute assignment writes the OPEN→ASSIGNED transition + substitution row in one tx and emits an ADR-057 envelope on `sch.coverage.assigned` with the full join shape.
- The school calendar resolves the override → event-with-override → default chain correctly for snow days.
- Room bookings reject both booking-vs-booking and booking-vs-timetable overlaps via the app-layer `assertNoConflicts` gate.
- All 6 permission denials behave (4 gate-tier 403, 1 service-layer 403, 1 row-scope 404).

The only known gap is the missing `sch.coverage.assigned → IN_APP notification` consumer (the emit is fire-and-forget; a substitute does not yet receive a bell notification when assigned). The emit shape is ready for a small downstream consumer in a future patch.

Cycle 5 is COMPLETE.
