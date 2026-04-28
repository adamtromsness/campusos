# Cycle 5 Handoff — Scheduling & Calendar

**Status:** Cycle 5 **IN PROGRESS — Step 1 done; Steps 2–10 pending.** Step 1 lands `015_sch_bell_schedules_and_rooms.sql` with 3 base tables (sch_bell_schedules, sch_periods, sch_rooms) for the foundation of the M22 Academic Scheduling module. Cycle 5 is the second cycle of Phase 3 (Expand). It connects Cycle 1's classes to a real timetable, Cycle 4's leave events to a substitute-coverage workflow, and ships a school calendar that every persona can read. Cycles 0–4 are COMPLETE; see `HANDOFF-CYCLE1.md`, `HANDOFF-CYCLE2.md`, `HANDOFF-CYCLE3.md`, and `HANDOFF-CYCLE4.md` for the foundation this cycle builds on.
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle5-implementation-plan.html`
**Vertical-slice deliverable:** Admin configures a bell schedule with 8 periods → assigns timetable slots (Rivera teaches Algebra in Room 101, Period 1) → Rivera's Cycle 1 class now has a room + time → Rivera submits a sick leave request (Cycle 4) → admin approves → `hr.leave.coverage_needed` fires → CoverageConsumer creates coverage-needed records for Rivera's classes on the leave dates → admin assigns a substitute → `sch.coverage.assigned` fires → substitute notification fires through the Cycle 3 notification pipeline → school calendar reflects the coverage for that day.

This document tracks the Cycle 5 build — the M22 Academic Scheduling module (core subset, 10 of the 27 ERD tables) — at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE4.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---: | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | Scheduling Schema — Bell Schedules & Rooms             | **Done** — `015_sch_bell_schedules_and_rooms.sql` lands 3 base tables (`sch_bell_schedules` with 5-value `schedule_type` CHECK + `is_default` flag + UNIQUE(school_id, name); `sch_periods` with FK to bell_schedule ON DELETE CASCADE + nullable `day_of_week` SMALLINT (rotation-friendly) + 5-value `period_type` CHECK + start<end CHECK + UNIQUE(bell_schedule_id, COALESCE(day_of_week,-1), start_time); `sch_rooms` with 7-value `room_type` CHECK + soft `fac_space_id` ref + UNIQUE(school_id, name)). 1 intra-tenant FK (sch_periods → sch_bell_schedules CASCADE), 0 cross-schema FKs. Tenant base table count: 77 (was 74). Live verification on `tenant_demo`: every CHECK fires (schedule_type, period_type, room_type, period start≥end), UNIQUE on (school_id, name) for both bell schedules and rooms rejects duplicates, UNIQUE on (bell_schedule_id, COALESCE(day_of_week,-1), start_time) rejects duplicate period slots, FK rejection clean, happy-path multi-insert across all 3 tables succeeds, ON DELETE CASCADE drops periods when the parent bell schedule is deleted. |
|    2 | Scheduling Schema — Timetable & Bookings               | TBD — `016_sch_timetable_and_bookings.sql` lands `sch_timetable_slots` (with btree_gist EXCLUSION constraints for teacher and room double-booking against overlapping `daterange(effective_from, COALESCE(effective_to,'infinity'),'[)')`), `sch_room_bookings`, `sch_room_change_requests`. Requires `CREATE EXTENSION IF NOT EXISTS btree_gist`.                                                                                                                                                                                  |
|    3 | Scheduling Schema — Calendar & Coverage                | TBD — `017_sch_calendar_and_coverage.sql` lands `sch_calendar_events`, `sch_calendar_day_overrides`, `sch_coverage_requests`, `sch_substitution_timetable`. Total scheduling tables: 10. Total tenant base tables: ~84.                                                                                                                                                                                                                                                                                                              |
|    4 | Seed Data — Schedules, Rooms, Timetable                | TBD — Seed bell schedule with 8 periods + Early Dismissal variant; 10 rooms (101–106 + Lab + Gym + Library + Hall); timetable slots for Rivera's 6 classes Periods 1–6 M-F; 5 calendar events (Spring Break, PD day, parent-teacher conf, end-of-year assembly, prom); 1 day override (snow day); 1 coverage request linked to Rivera's seeded sick leave with Park as substitute; 1 room booking. Adds SCH-001/003/004/005 read codes to Teacher/Staff per the plan; SCH-003 read also to Parent/Student. Rebuild access cache.    |
|    5 | Scheduling NestJS Module — Timetable & Rooms           | TBD — `apps/api/src/scheduling/` BellScheduleService, TimetableService, RoomService, RoomBookingService, RoomChangeRequestService. ~18 endpoints. EXCLUSION constraint violation (SQLSTATE 23P01) translated to 409 Conflict with the conflicting actor name in the message. Emits `sch.timetable.updated`.                                                                                                                                                                                                                          |
|    6 | Scheduling NestJS Module — Calendar & Coverage         | TBD — CalendarService, DayOverrideService, CoverageService, SubstitutionService + the **CoverageConsumer** (group `coverage-consumer`, subscribes to `hr.leave.coverage_needed` from Cycle 4). Reuses `unwrapEnvelope` + `processWithIdempotency` (Cycle 3 pattern). Emits `sch.coverage.needed` and `sch.coverage.assigned`. ~12 endpoints + 1 Kafka consumer + 3 event types.                                                                                                                                                       |
|    7 | Schedule & Timetable UI                                | TBD — Schedule app tile + bell schedule editor (`/schedule/bell-schedules`), timetable grid (`/schedule/timetable`), room management (`/schedule/rooms`), room bookings (`/schedule/room-bookings`).                                                                                                                                                                                                                                                                                                                                 |
|    8 | Calendar & Coverage UI                                 | TBD — Calendar app tile + school calendar (`/calendar`), daily coverage board (`/schedule/coverage`), coverage history (`/schedule/coverage/history`).                                                                                                                                                                                                                                                                                                                                                                               |
|    9 | Teacher & Parent Schedule Views                        | TBD — Teacher "My Schedule" tab on `/classes`, parent "Schedule" link per child card, student "My Schedule" tab on `/classes`, room availability checker widget.                                                                                                                                                                                                                                                                                                                                                                     |
|   10 | Vertical Slice Integration Test                        | TBD — `docs/cycle5-cat-script.md`. End-to-end: timetable verification → teacher/parent schedule views → 409 double-booking prevention → seeded coverage request → live leave→coverage flow → assign substitute → calendar reflects → room booking + conflict prevention → permission denials.                                                                                                                                                                                                                                       |

The Cycle 5 exit deliverable is the end-to-end vertical slice from the plan's Step 10. `docs/cycle5-cat-script.md` will be the reproducible CAT script.

---

## What this cycle adds on top of Cycles 0–4

Cycle 4 closed the first cycle of Phase 3 (Expand) with the M80 HR/Workforce module — every staff member is now a first-class `hr_employees` row with positions, certifications, leave balances, and a compliance posture. The leave-approval workflow republishes `hr.leave.coverage_needed` for every approved leave with the affected class ids inline, but Cycle 4 has no consumer for that topic — the event is publish-only until Cycle 5 arrives. Cycle 5 lands the M22 Academic Scheduling module (core subset, 10 of the 27 ERD tables) and finally connects the leave system to a substitute-coverage workflow. After Cycle 5, the teacher-absence → coverage-needed → substitute-assigned loop is fully automated, the school's daily timetable lives in the database, and every persona can see the schedule that affects them.

**Key dependencies inherited from Cycles 0–4:**

- **`hr_employees` is the canonical staff identity** (ADR-055, resolved by Cycle 4 Step 0). `sch_timetable_slots.teacher_id` and `sch_substitution_timetable.substitute_id` are soft FKs to `hr_employees(id)`. `sch_coverage_requests.absent_teacher_id` and `sch_coverage_requests.assigned_substitute_id` follow the same pattern. The `actor.employeeId` populated by `ActorContextService.resolveActor(...)` (Cycle 4 Step 0) is what timetable / coverage row-scope checks compare against.
- **`sis_classes` is the canonical class identity** (Cycle 1). Every `sch_timetable_slots` row references a class id; the timetable read paths join through `sis_class_teachers`, `sis_courses`, and `sis_classes` to surface section codes and course names. Cycle 4's `LeaveNotificationConsumer.emitCoverageNeeded` already uses this exact join shape, so Cycle 5's CoverageConsumer reuses the result.
- **Tenant isolation discipline** — `executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a `$transaction` that runs `SET LOCAL search_path` (REVIEW-CYCLE1 fix). Every scheduling service uses these helpers; the CoverageConsumer reuses the `runWithTenantContextAsync` + envelope-extracted `TenantInfo` pattern from `LeaveNotificationConsumer`.
- **ADR-057 event envelope** — every Cycle 5 emit goes through `KafkaProducerService.emit(EmitOptions)` with `sourceModule: 'scheduling'`. The deterministic `eventId` field added in REVIEW-CYCLE4 MAJOR 3 (`bda8a16`) is exactly the mechanism the CoverageConsumer needs — a redelivery of `hr.leave.coverage_needed` produces the same event_id, so `IdempotencyService.claim` against `platform_event_consumer_idempotency` catches the duplicate before the consumer creates a duplicate coverage request row.
- **Notification pipeline (Cycle 3 Step 5)** — when a substitute is assigned to a coverage request, `sch.coverage.assigned` flows through the existing `NotificationQueueService` and `NotificationDeliveryWorker`. The substitute receives an IN_APP notification through the same Redis ZADD path as every other notification.
- **Row-level authorization pattern** from REVIEW-CYCLE1 — every scheduling endpoint uses `ActorContextService.resolveActor(...)` and applies a per-personType visibility predicate. Self-only reads for "my schedule"; admin-only writes for timetable / coverage assignment; class-scoped row checks for room change requests.
- **Schedule / Calendar app tiles + sidebar entries** — wired through `apps/web/src/components/shell/apps.tsx::getAppsForUser(user)` per the UI Design Principles in `CLAUDE.md`. The Schedule tile gates on `sch-001:read`; the Calendar tile gates on `sch-003:read` (every persona since Step 4 grants the read code to Parent/Student/Staff/Teacher).

**Cycle-5-specific carry-overs from prior cycles:**

- **REVIEW-CYCLE4 reviewer's carry-over: `hr.leave.coverage_needed` consumer wiring.** This is exactly what Step 6's CoverageConsumer ships. The deterministic event_id pattern from REVIEW-CYCLE4 MAJOR 3 means the consumer's `IdempotencyService.claim` will catch any redelivery cleanly without any further work.
- **REVIEW-CYCLE3 reviewer's carry-over: DLQ-row dashboard / alert** for `platform.platform_dlq_messages`. Tracked in the Phase 2 punch list, not in Cycle 5 scope.

---

## Step 1 — Scheduling Schema — Bell Schedules & Rooms

**Done.** `packages/database/prisma/tenant/migrations/015_sch_bell_schedules_and_rooms.sql` lands 3 base tables. Idempotent CREATE-IF-NOT-EXISTS pattern. Snake_case columns, `TEXT + CHECK` for the schedule_type / period_type / room_type enums (no PG `ENUM` types per the codebase rule). One intra-tenant DB-enforced FK (sch_periods → sch_bell_schedules ON DELETE CASCADE). All cross-schema refs are soft per ADR-001/020 (school_id and the optional `fac_space_id` on rooms).

### Tables (3)

| Table                | Purpose                                                                                         | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `sch_bell_schedules` | Per-school catalogue of named bell schedules (e.g. "Standard Day", "Early Dismissal", "Exam").  | `id`, `school_id`, `name`, `schedule_type` CHECK (STANDARD / EARLY_DISMISSAL / ASSEMBLY / EXAM / CUSTOM), `is_default BOOLEAN DEFAULT false`. UNIQUE(school_id, name). Partial UNIQUE INDEX(school_id) WHERE `is_default = true` so each school has at most one default schedule. INDEX(school_id).                                                                                                                                                                                                                                                                                                          |
| `sch_periods`        | Periods within a bell schedule. Each row is one (day, start, end) slot (e.g. "Mon Period 1").   | `id`, `bell_schedule_id` (FK to `sch_bell_schedules ON DELETE CASCADE`), `name`, `day_of_week SMALLINT` nullable (0=Mon..6=Sun, NULL means rotation-driven), `start_time TIME NOT NULL`, `end_time TIME NOT NULL`, `period_type` CHECK (LESSON / BREAK / LUNCH / REGISTRATION / ASSEMBLY), `sort_order INT NOT NULL DEFAULT 0`. CHECK `start_time < end_time`. CHECK `day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)`. UNIQUE(bell_schedule_id, COALESCE(day_of_week,-1), start_time) so no overlap of identical start times within a (schedule, day). INDEX(bell_schedule_id, sort_order). |
| `sch_rooms`          | Per-school room catalogue. Used as the schedulable target for timetable slots and bookings.     | `id`, `school_id`, `name`, `capacity INT`, `room_type` CHECK (CLASSROOM / LAB / GYM / HALL / LIBRARY / OFFICE / OUTDOOR), `has_projector BOOLEAN DEFAULT false`, `has_av BOOLEAN DEFAULT false`, `floor TEXT`, `building TEXT`, `is_active BOOLEAN DEFAULT true`, `fac_space_id UUID` (DISPLAY-ONLY soft ref to a future `fac_spaces` table). UNIQUE(school_id, name). CHECK `capacity IS NULL OR capacity >= 0`. Partial INDEX(school_id) WHERE `is_active = true`. INDEX(room_type) for the "list all labs / gyms" lookups.                                                                              |

### FKs (intra-tenant) and soft references

| Constraint                                                | Type                  | Notes                                                                                                                                                                                            |
| --------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sch_periods.bell_schedule_id → sch_bell_schedules(id)`   | DB-enforced (CASCADE) | Both unpartitioned. Cascade because a period without its parent schedule is meaningless — verified live with a temp-schedule delete that dropped all 3 child periods cleanly.                    |
| `sch_bell_schedules.school_id`, `sch_rooms.school_id`     | Soft (cross-schema)   | UUID refs to `platform.schools(id)` per ADR-001/020.                                                                                                                                             |
| `sch_rooms.fac_space_id`                                  | Soft (forward-compat) | DISPLAY-ONLY UUID ref to a future `fac_spaces` table. The plan calls this out — rooms today are scheduled directly; later, facilities-management can layer a richer space hierarchy underneath without touching `sch_rooms`. Unenforced; nullable. |

### CHECK constraints

| Constraint                            | Predicate                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `sch_bell_schedules_type_chk`         | `schedule_type IN ('STANDARD','EARLY_DISMISSAL','ASSEMBLY','EXAM','CUSTOM')`       |
| `sch_periods_type_chk`                | `period_type IN ('LESSON','BREAK','LUNCH','REGISTRATION','ASSEMBLY')`              |
| `sch_periods_times_chk`               | `start_time < end_time`                                                            |
| `sch_periods_dow_chk`                 | `day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)`                   |
| `sch_rooms_type_chk`                  | `room_type IN ('CLASSROOM','LAB','GYM','HALL','LIBRARY','OFFICE','OUTDOOR')`       |
| `sch_rooms_capacity_chk`              | `capacity IS NULL OR capacity >= 0`                                                |

### UNIQUE constraints

| Constraint                                  | Columns                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sch_bell_schedules_school_name_uq`         | `(school_id, name)`                                                                                  |
| `sch_bell_schedules_one_default_uq`         | partial UNIQUE INDEX `(school_id) WHERE is_default = true` — at most one default schedule per school |
| `sch_periods_schedule_dow_start_uq`         | `(bell_schedule_id, COALESCE(day_of_week, -1), start_time)` — no two periods share a start time      |
| `sch_rooms_school_name_uq`                  | `(school_id, name)`                                                                                  |

### Verification (recorded 2026-04-28)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 15 migrations applied
pnpm --filter @campusos/database provision --subdomain=demo   # idempotent re-run (CREATE IF NOT EXISTS no-ops)
pnpm --filter @campusos/database provision --subdomain=test   # 15 migrations applied
```

Counts in `tenant_demo` after Step 1:

| What                                    | Count |
| --------------------------------------- | ----: |
| Logical base tables (top-level, was 74) |    77 |
| `sch_*` tables                          |     3 |
| Intra-tenant FKs from Step 1 tables     |     1 |
| Cross-schema FKs from `tenant_demo`     |     0 |

CHECK + FK + UNIQUE + cascade smoke (live):

| Constraint / behaviour                                        | Test                                                                                                                  | Outcome  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| `sch_bell_schedules_type_chk`                                 | INSERT schedule_type='BOGUS'                                                                                          | ERROR ✅ |
| `sch_periods_type_chk`                                        | INSERT period_type='BOGUS'                                                                                            | ERROR ✅ |
| `sch_periods_times_chk`                                       | INSERT start_time='10:00', end_time='09:00'                                                                           | ERROR ✅ |
| `sch_periods_dow_chk`                                         | INSERT day_of_week=9                                                                                                  | ERROR ✅ |
| `sch_rooms_type_chk`                                          | INSERT room_type='BOGUS'                                                                                              | ERROR ✅ |
| `sch_rooms_capacity_chk`                                      | INSERT capacity=-1                                                                                                    | ERROR ✅ |
| `sch_bell_schedules_school_name_uq`                           | INSERT a duplicate (school_id, name)                                                                                  | ERROR ✅ |
| `sch_bell_schedules_one_default_uq`                           | INSERT a second `is_default=true` row for the same school                                                             | ERROR ✅ |
| `sch_periods_schedule_dow_start_uq`                           | INSERT a second period with the same (bell_schedule_id, day_of_week, start_time) tuple                                | ERROR ✅ |
| `sch_rooms_school_name_uq`                                    | INSERT a duplicate (school_id, name)                                                                                  | ERROR ✅ |
| `sch_periods_bell_schedule_id_fkey`                           | INSERT bell_schedule_id=<random uuid>                                                                                 | ERROR ✅ |
| Happy path: 1 bell schedule + 3 periods (Mon P1/P2/P3) + 2 rooms (Room 101 + Lab) | inserts succeed cleanly; period start times sort 08:00 / 09:00 / 10:00                                                | ✅       |
| ON DELETE CASCADE on `sch_bell_schedules`                     | Pre-delete: 3 periods. DELETE FROM sch_bell_schedules. Post-delete: 0 periods.                                        | ✅       |

### Out-of-scope decisions for Step 1

- **No `rotation_day` / `cycle_day` column on `sch_periods`.** The ERD includes columns for A/B day rotation schedules (ADR-053 advanced scheduling); the plan defers `sch_rotation_cycles` + `sch_rotation_calendar` to Cycle 5b. `day_of_week` is nullable so rotation-driven schedules can leave it blank, but the rotation linkage itself is not modelled this cycle.
- **`fac_space_id` on `sch_rooms` is DISPLAY-ONLY.** The future M52 Facilities module will own `fac_spaces`; Cycle 5 doesn't ship that table. Keeping a nullable UUID column on rooms now means later facilities work is purely additive — no DDL change to `sch_rooms` once `fac_spaces` exists.
- **No `is_default` enforcement that exactly-one bell schedule is default.** The partial UNIQUE INDEX rejects two simultaneous defaults, but a school with zero defaults is allowed (e.g. a freshly-provisioned tenant before the seed runs). Step 5's `BellScheduleService.setDefault` will own the "atomically flip default" pattern (clear all, then set the one).
- **No `EXCLUSION` constraints on `sch_periods` for time-range overlap.** The UNIQUE on `(bell_schedule_id, COALESCE(day_of_week,-1), start_time)` rejects two periods that start at the same minute, but two periods that overlap (e.g. 09:00–10:00 and 09:30–10:30) are allowed at the schema layer. The plan deliberately keeps periods overlap-free at the application layer (the bell schedule editor in Step 7 catches it) and reserves `EXCLUSION` constraints for `sch_timetable_slots` in Step 2 where the conflict semantics are dramatically more important.
- **`day_of_week` is `SMALLINT`, not `TEXT`.** The plan calls out 0=Monday..6=Sunday. Storing as integer is more compact and lets the period-listing query use a simple `ORDER BY day_of_week, start_time`. The COALESCE(-1) in the UNIQUE index handles the rotation case where `day_of_week IS NULL`.
- **`has_projector` and `has_av` are the only amenity flags.** The plan calls out these two; richer room metadata (smart board, accessibility, climate control) can ship as additive columns later without breaking anything. Schools that need richer metadata today can put it in `notes` (added in a future iteration) or model it through a separate `sch_room_amenities` join table.
- **No `building` / `floor` validation.** Both are free TEXT — schools' building taxonomies vary too much to constrain at the schema layer.
- **No partitioning.** Volume bounded by (schools × ~10 schedules × ~50 periods) and (schools × ~50 rooms). Far below the partitioning threshold even at multi-school scale.
- **No seed yet.** Step 4 owns the bell-schedule + rooms seed (8-period Standard Day + Early Dismissal variant + 10 rooms).
- **CHECK strings still cannot contain `;`.** Carries forward from every prior cycle. Spot-checked all CHECK predicates and `COMMENT ON COLUMN` strings in 015 — none contain `;`. The block-comment header was reviewed for the splitter trap.

Plan reference: Step 1 of `docs/campusos-cycle5-implementation-plan.html`.

---

## Quick reference — running the stack from a fresh clone

```bash
pnpm install
docker compose up -d
pnpm --filter @campusos/database migrate
pnpm --filter @campusos/database seed
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database seed:classroom
pnpm --filter @campusos/database seed:messaging
pnpm --filter @campusos/database seed:hr
pnpm --filter @campusos/database exec tsx src/build-cache.ts
pnpm --filter @campusos/api dev
```

Cycle 5's `seed:scheduling` lands in Step 4. Until then, the seed pipeline is unchanged from Cycle 4.

---

## Open items / known gaps (will be filled in as steps land)

- **Steps 2–3 schema migrations.** Two new SQL files (`016_sch_timetable_and_bookings.sql` requires `btree_gist` extension for the EXCLUSION constraints; `017_sch_calendar_and_coverage.sql`). 7 additional tenant tables. Total tenant base table count after Step 3: ~84.
- **Step 4 seed + permission updates.** SCH-001/003/004/005 codes added to Teacher / Staff / Parent / Student / School Admin / Platform Admin per the matrix in the plan.
- **Steps 5–6 NestJS module.** ~30 endpoints (~18 timetable/rooms + ~12 calendar/coverage) + 3 Kafka emits (`sch.timetable.updated`, `sch.coverage.needed`, `sch.coverage.assigned`) + 1 new consumer (CoverageConsumer subscribing to `hr.leave.coverage_needed`).
- **Steps 7–9 UI.** Two launchpad tiles ("Schedule" and "Calendar"), 7+ pages.
- **Step 10 CAT.** ~10-scenario reproducible script at `docs/cycle5-cat-script.md`.
- **Out of scope this cycle (deferred to Cycle 5b or later):** sch_rotation_cycles + sch_rotation_calendar (A/B day schedules — ADR-053). sch_scheduling_requests + sch_scheduling_candidates + sch_scheduling_candidate_slots (automated constraint solver). sch_exam_sessions + sch_exam_session_rooms + sch_exam_seatings + sch_exam_invigilator_assignments (exam scheduling). sch_coteaching_arrangements (co-teaching). sch_pull_out_interventions (specialist pull-outs). sch_cross_school_staff_assignments (district staff). sch_cover_arrangements + sch_cover_arrangement_classes + sch_cover_split_students (complex cover beyond simple substitution). SCH-002 (Course Selection) — depends on enrollment module.
- **Phase 2 carry-overs (not Cycle 5 scope):** DLQ-row dashboard / alert wiring on `platform.platform_dlq_messages` (REVIEW-CYCLE3 reviewer's carry-over). Persona walkthroughs and UI design guide creation.

---

## Cycle 5 exit criteria (from the plan)

1. ✅ Tenant schema: 3 new scheduling tables. Total tenant tables: 77. (Step 1.)
2. Tenant schema: 10 new scheduling tables with EXCLUSION constraints. Total tenant tables: ~84. (Steps 2–3.)
3. Bell schedule, periods, rooms, timetable slots seeded for the demo school. (Step 4.)
4. Timetable API: ~18 endpoints with conflict detection via EXCLUSION constraints. (Step 5.)
5. Calendar API: ~12 endpoints for events, day overrides, coverage, substitutions. (Step 6.)
6. CoverageConsumer: consumes `hr.leave.coverage_needed`, creates coverage requests automatically. (Step 6.)
7. Admin UI: bell schedule editor, timetable grid, room management, coverage board, calendar. (Steps 7–8.)
8. Teacher/parent/student: timetable views integrated into existing navigation. (Step 9.)
9. Vertical slice test: leave approved → coverage auto-created → sub assigned → calendar reflects. (Step 10.)
10. HANDOFF-CYCLE5.md and CLAUDE.md updated. CI green.
