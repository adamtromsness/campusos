# Cycle 5 Architecture Review — Handoff for ChatGPT

**Reviewer:** ChatGPT (adversarial)
**Author of this brief:** Claude (CampusOS implementer)
**Cycle under review:** Cycle 5 — Scheduling & Calendar (M22 Academic Scheduling, core subset)
**Branch:** `main`
**State at handoff:** Cycle 5 COMPLETE (Steps 1–10), Cycles 0–4 COMPLETE + reviewed + post-review fixes landed (Cycle 4 APPROVED at `76ddf03`)
**Verdict format requested:** same as Cycles 1–4 — `N PASS · N DEVIATION · N VIOLATION` with each item separately classified, plus a fix-priority order table.

You are doing a hostile architecture review of Cycle 5 the same way you did for Cycles 1–4. The Cycle 1 review caught 6 violations including a critical tenant-isolation race; the Cycle 2 review caught 2 BLOCKING issues (gradebook leak + at-most-once consumer); the Cycle 3 review caught 3 issues (consumer error swallowing, delivery worker SENT-as-in-flight, overly-broad `isManager()` scope); the Cycle 4 review caught 1 BLOCKING (leave-lifecycle concurrency) + 3 MAJOR (ON_LEAVE actor.employeeId, compliance dashboard auth split, deterministic event_id for republish). We expect the same standard here. Be specific — name the file, line, ADR, and minimum fix.

---

## Scope of this review

**In scope** — anything added or changed in the 10 commits of Cycle 5 (chronological, all on `main`):

```
d3cf61a  cycle5-step1   scheduling foundation — bell schedules, periods, rooms
ae4208d  cycle5-step2   timetable + bookings — btree_gist EXCLUSION on teacher/room
76e7ea7  cycle5-step3   calendar + coverage — events, day overrides, coverage requests, substitution timetable
6b9849f  cycle5-step4   seed scheduling + extend SCH grants to teacher/staff
9790ce7  cycle5-step5   scheduling NestJS — bell schedules, timetable, rooms, bookings, change requests
e0dada3  cycle5-step6   calendar + coverage NestJS — events, day overrides, CoverageConsumer
3f9af62  cycle5-step7   schedule UI — bell schedules, timetable, rooms, bookings
901d42a  cycle5-step8   calendar + coverage UI — month grid, day-of board, history
8db987f  cycle5-step9   teacher/parent/student schedule views
bf59fc8  cycle5-step10  vertical slice CAT — leave→coverage→sub→envelope verified live
```

Concretely:

- 3 new tenant migrations adding 10 base scheduling tables: `015_sch_bell_schedules_and_rooms.sql` (3 tables), `016_sch_timetable_and_bookings.sql` (3 tables + the `btree_gist` extension + 2 EXCLUSION constraints), `017_sch_calendar_and_coverage.sql` (4 tables). Tenant base table count after Cycle 5: **84** (was 74 after Cycle 4). 18 intra-tenant FKs on `sch_*` tables; 0 cross-schema FKs.
- 1 new module under `apps/api/src/scheduling/` — 9 services (`BellSchedule`, `Timetable`, `Room`, `RoomBooking`, `RoomChangeRequest`, `Calendar`, `DayOverride`, `Coverage`, `Substitution`), 1 Kafka consumer (`CoverageConsumer`), 8 controllers, 7 DTO files, **39 endpoints** (22 from Step 5 + 16 from Step 6 + 1 from Step 9), 3 Kafka emits (`sch.timetable.updated`, `sch.coverage.needed`, `sch.coverage.assigned`).
- 1 new platform-data dependency: `SchedulingModule` imports `SisModule` (Step 9) so `TimetableService.listForStudent` can call `StudentService.assertCanViewStudent`.
- 1 new seed: `seed-scheduling.ts` — 2 bell schedules + 19 periods + 10 rooms + 6 timetable slots + 5 calendar events + 1 day override + 1 ASSIGNED coverage row + 1 substitution row + 1 room booking. Idempotent, gated on `sch_bell_schedules` row count.
- IAM extensions in Step 4: Teacher gains `SCH-001:read` + `SCH-003:read` + `SCH-004:read` + `SCH-005:read+write` (27 → 34 perms); Staff gains the same plus `SCH-001:read` (10 → 14); Parent + Student keep `SCH-003:read` only.
- Web surface: 9 new routes under `apps/web/src/app/(app)/{schedule,calendar,my-schedule,children/[id]/schedule}/`, 1 new hooks file `apps/web/src/hooks/use-scheduling.ts` (**31 hooks**), 2 new shared components (`TimetableWeekView`, `RoomAvailabilityChecker`), 1 new helpers module `apps/web/src/lib/scheduling-format.ts`, 2 new launchpad tiles (`Schedule` + `Calendar`) in `apps/web/src/components/shell/apps.tsx`, the full Cycle 5 DTO surface in `apps/web/src/lib/types.ts`.
- One Sidebar contract addition: `AppDef.routePrefix` (Step 9) so `/schedule/coverage` etc. keep the Schedule tile lit. The Sidebar match logic now resolves to `routePrefix ?? href`.
- CAT script: `docs/cycle5-cat-script.md` — 10 plan scenarios + 4-check schema preamble verified live on `tenant_demo` 2026-04-28.

**Out of scope** (do not flag):

- Anything in Cycles 0–4 — already reviewed (Cycle 4 APPROVED at `76ddf03`). If you spot regressions to prior contracts caused by Cycle 5 changes, that **is** in scope; if you find a pre-existing issue in untouched code, please call it out separately and tag as "carry-over from Cycle N."
- The two Phase-2 carry-overs from Cycle 3's review: DLQ-row dashboard / alert wiring on `platform.platform_dlq_messages`, and persona walkthroughs / UI design guide. Both are explicitly Phase 2 work.
- The 17 ERD scheduling tables Cycle 5 deliberately deferred (`sch_rotation_cycles`, `sch_rotation_calendar`, `sch_scheduling_requests`, `sch_scheduling_candidates`, `sch_scheduling_candidate_slots`, `sch_exam_sessions` × 4, `sch_coteaching_arrangements`, `sch_pull_out_interventions`, `sch_cross_school_staff_assignments`, `sch_cover_arrangements` × 3) — only the 10 core tables in scope.
- SCH-002 (Course Selection) — depends on enrollment module; out of scope for this cycle.
- `sch.coverage.assigned → IN_APP notification` consumer — explicitly deferred to Phase 2 (Step 10 CAT documents this gap; see "Known scope decisions" 4 below).
- Browser-driver e2e — Cycles 1–4 also deferred this; Cycle 5 ships a manual CAT (`docs/cycle5-cat-script.md`).
- Year-ahead bell-schedule rotation cycles (A/B days) — ADR-053 is honoured by `sch_periods.day_of_week NULL = rotation-driven` placeholder; the rotation tables ship in a future Cycle 5b.
- The Step 7 `sch_periods` overlap rule — schema allows two periods to overlap on the same `day_of_week` + bell_schedule; the bell-schedule-editor UI should catch it but the schema doesn't enforce. Documented in Step 1's HANDOFF.

---

## What to read (in order)

These four documents are the source of truth and should answer 90 % of "is X really designed this way?" questions:

1. **`CLAUDE.md`** — top-level project rules + project status. The Cycle 5 paragraph chain at the top documents every step with a one-line outcome, including the splitter `;`-in-string trap re-experienced on Step 1, the calendar-events `$N::time` cast bug fix in Step 4, the `c.title` → `co.name` consumer-SQL bug found and fixed in Step 8 (carry-over from Cycle 3, surfaced by the CAT), and the stale-API-instance trap caught during Step 9 + 10 smoke. The "Conventions" + "Key Design Contracts" sections are the durable rules; if Cycle 5 violates one of them, that's a clear violation.
2. **`HANDOFF-CYCLE5.md`** — the running technical handoff. Step status table at the top; per-step sections (Steps 1 through 10) describe migration shape, FKs, services, endpoints, row-level auth pattern, deviations, and known caveats. Mirrors the Cycle 4 handoff structure.
3. **`docs/cycle5-cat-script.md`** — the live-verified end-to-end walkthrough. 4-check schema preamble + 10 plan scenarios. Captures real `curl` outputs, the `sch.coverage.assigned` Kafka envelope on the wire, the 6 OPEN coverage rows landed in 3s after a leave approval, and 6 permission denial paths.
4. **`docs/campusos-cycle5-implementation-plan.html`** — the upstream plan you'd compare deviations against.

Authoritative ADR/ERD references the cycle is bound to:

- `docs/campusos-erd-v11.html` — schema source of truth (M22 Academic Scheduling, 27 tables; 10 in scope).
- `docs/campusos-architecture-review-v10.html` — sections 13 (modular monolith), 11 (events), and 9 (multi-tenancy) are the most relevant; section 27 covers ADR-053 for rotation schedules (deferred).
- `docs/campusos-function-library-v11.html` — SCH-001, SCH-003, SCH-004, SCH-005 codes + their access tiers.

---

## Design contracts to verify (these are the hard rules)

These are the contracts Cycle 5 commits to. If any is broken anywhere in the cycle's surface, that's a violation. Cite the ADR and the file.

### 1. ADR-001 / ADR-020 / ADR-028 — soft cross-schema refs

Tenant tables MUST NOT have DB-enforced FK constraints to `platform.*`. UUID columns + app-layer Prisma validation only.

```sql
SELECT count(*) FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_namespace rn ON rn.oid = r.relnamespace
WHERE c.contype='f' AND tn.nspname='tenant_demo' AND rn.nspname <> 'tenant_demo';
-- expected: 0
```

Cycle 5 declares 18 intra-tenant FKs across migrations 015 + 016 + 017 and zero cross-schema FKs — verify both numbers. The teacher / sub references on `sch_timetable_slots`, `sch_coverage_requests`, `sch_substitution_timetable` are intra-tenant FKs to `hr_employees(id)` (not soft) since both sides are in the tenant schema; this is the same pattern Cycle 4 established for `sis_class_teachers.teacher_employee_id`.

### 2. ADR-001 (REVIEW-CYCLE1 fix) — `SET LOCAL search_path` inside an interactive transaction

`TenantPrismaService.executeInTenantContext` and `executeInTenantTransaction` both wrap their callback in a Prisma `$transaction` and run `SET LOCAL search_path TO "tenant_X", platform, public`. SET LOCAL is mandatory; a session-level SET on a pooled client can leak between concurrent requests.

**Verify:** every scheduling service uses `executeInTenantContext` / `executeInTenantTransaction`. No raw `client.$queryRaw` / `client.$executeRaw` outside these helpers, and no manual `SET search_path` anywhere. The `CoverageConsumer` runs OUTSIDE a request, like Cycle 4's `LeaveNotificationConsumer` — verify it reconstructs tenant context via `runWithTenantContextAsync` (delegated through `processWithIdempotency` from `notification-consumer-base.ts`) and that the per-event INSERT loop runs inside a single tenant context.

### 3. EXCLUSION constraints + 23P01 → 409 translation

The two `btree_gist` EXCLUSION constraints on `sch_timetable_slots` (`sch_timetable_slots_teacher_no_overlap` and `sch_timetable_slots_room_no_overlap`) are the load-bearing schema-level guarantee that the timetable grid can never display overlaps. The Step 5 `TimetableService.translateConflict` decodes SQLSTATE 23P01 + the constraint name into a friendly 409 with the conflicting actor's name (looked up at translation time via separate `sch_rooms` / `sch_periods` / `hr_employees` reads).

**Verify:**

- `CREATE EXTENSION IF NOT EXISTS btree_gist` ships at the top of `016_sch_timetable_and_bookings.sql` (database-scope, idempotent across re-provisions).
- The two EXCLUSION constraints are shaped `(actor WITH =, period_id WITH =, daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&)`. The half-open `[)` daterange means a slot ending on a date and another slot starting on the same date do **not** overlap (rotation pattern).
- `teacher_id` is nullable and the `=` operator class treats `NULL <> NULL`, so two TBD-teacher slots on the same period and overlapping range do **not** conflict — the room EXCLUSION still catches the room collision. CAT scenario 4 verifies this.
- `translateConflict` looks up the conflicting actor's name correctly. The room name lookup uses `sch_rooms`, the period name uses `sch_periods`, the teacher name joins `hr_employees → platform.iam_person`. The 23P01 path includes the failure-side reads (acceptable since they only fire on the conflict path; they're not on the happy path).

### 4. ADR-055 — `iam_person` is the canonical FK for human identity (Cycle 4 Step 0 contract)

`hr_employees.id` is the canonical staff identity per the Cycle 4 Step 0 bridge. Cycle 5 schedule slots reference it directly:

- `sch_timetable_slots.teacher_id` → `hr_employees(id)` nullable for TBD slots
- `sch_substitution_timetable.substitute_id` → `hr_employees(id)`
- `sch_coverage_requests.absent_teacher_id` → `hr_employees(id)`
- `sch_coverage_requests.assigned_substitute_id` → `hr_employees(id)`

**Verify:**

- Every `actor.employeeId` comparison in scheduling services uses the Cycle 4 resolution (`actor.employeeId` from `ActorContextService.resolveActor`), not `actor.personId`. Specifically:
  - `RoomChangeRequestService` row-scope (`requested_by = actor.employeeId`).
  - `RoomBookingService.cancel` ownership check.
  - `CoverageService` row-scope reads (admin OR absent OR assigned).
- `CoverageConsumer.processWithIdempotency` body: when it joins through `sch_timetable_slots → sch_periods` for each `affectedClasses[].classId`, it uses the inbound envelope's `tenantId` to pin context — verify it doesn't accidentally trust an attacker-supplied tenant id.

### 5. Row-level authorisation — endpoint permission gates are the floor, not the ceiling

`@RequirePermission` is necessary but not sufficient. Scheduling endpoints follow the same pattern as Cycles 1–4. The matrix:

| Surface                                                         | Gate            | Row-scope inside service                                                                                                                                                                                        |
| --------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /bell-schedules` + `GET /bell-schedules/:id`               | `sch-001:read`  | None (schedule catalogue).                                                                                                                                                                                      |
| `POST /bell-schedules` + `PATCH /bell-schedules/:id`            | `sch-001:admin` | Service-layer `actor.isSchoolAdmin` admin check.                                                                                                                                                                |
| `POST /bell-schedules/:id/periods`                              | `sch-001:admin` | Same; the upsert is a DELETE-all + INSERT-each in one tx.                                                                                                                                                       |
| `POST /bell-schedules/:id/set-default`                          | `sch-001:admin` | Same; atomically clears any other default in the same tx so the partial UNIQUE INDEX(school_id) WHERE is_default never rejects the flip.                                                                        |
| `GET /timetable` + `GET /timetable/:id`                         | `sch-001:read`  | None (school timetable).                                                                                                                                                                                        |
| `GET /timetable/teacher/:employeeId` + `class/:id` + `room/:id` | `sch-001:read`  | None — these are filter shortcuts on the same `list()` shape.                                                                                                                                                   |
| `GET /timetable/student/:studentId` (Step 9)                    | `stu-001:read`  | **Service-layer `StudentService.assertCanViewStudent`** — admin / parent of / assigned-class teacher / the student themself. The gate is `stu-001:read` because parents and students don't hold `sch-001:read`. |
| `POST /timetable/slots` + `PATCH/DELETE /:id`                   | `sch-001:admin` | Service-layer admin check + EXCLUSION-aware translateConflict for 409s.                                                                                                                                         |
| `GET /rooms` + `GET /rooms/:id`                                 | `sch-005:read`  | None.                                                                                                                                                                                                           |
| `POST /rooms` + `PATCH /rooms/:id`                              | `sch-005:admin` | Service-layer admin check.                                                                                                                                                                                      |
| `GET /room-bookings` + `GET /:id`                               | `sch-005:read`  | None — every persona with the read code sees the school-wide list.                                                                                                                                              |
| `POST /room-bookings`                                           | `sch-005:write` | App-layer `assertNoConflicts` checks both existing CONFIRMED bookings AND active timetable slots whose period clock-time overlaps the booking window (the schema does NOT enforce booking-vs-slot conflict).    |
| `PATCH /room-bookings/:id/cancel`                               | `sch-005:write` | Service-layer **owner OR admin** — `actor.employeeId === booking.bookedById OR actor.isSchoolAdmin`.                                                                                                            |
| `GET /room-change-requests`                                     | `sch-005:write` | Non-admins see only own rows via `requested_by = actor.employeeId`.                                                                                                                                             |
| `POST /room-change-requests`                                    | `sch-005:write` | Refuses if the slot's `teacher_id` is set and not the actor (admins bypass). Reads `current_room_id` from the slot rather than trusting the client.                                                             |
| `PATCH /room-change-requests/:id/{approve,reject}`              | `sch-005:write` | Service-layer admin check.                                                                                                                                                                                      |
| `GET /calendar` + `GET /:id`                                    | `sch-003:read`  | Non-admins only ever see published events; admins with `includeDrafts=true` see drafts too. Service-layer double-check on `getById` (drafts hidden from non-admins via 404).                                    |
| `POST /calendar` + `PATCH/DELETE /:id`                          | `sch-003:write` | Service-layer admin check (per the plan: write is admin-only).                                                                                                                                                  |
| `GET /calendar/day/:date`                                       | `sch-003:read`  | None (resolution endpoint; same gate as the read).                                                                                                                                                              |
| `GET /calendar/overrides`                                       | `sch-003:read`  | None.                                                                                                                                                                                                           |
| `POST /calendar/overrides` + `DELETE`                           | `sch-003:admin` | Service-layer admin check; UNIQUE(school_id, override_date) handled at the service layer with a friendly 409.                                                                                                   |
| `GET /coverage` + `GET /:id`                                    | `sch-004:read`  | **Non-admin staff see only rows where they are the absent OR assigned employee.**                                                                                                                               |
| `PATCH /coverage/:id/{assign,cancel}`                           | `sch-004:write` | Service-layer admin check.                                                                                                                                                                                      |
| `GET /substitutions` + `GET /teacher/:employeeId`               | `sch-004:read`  | Read-only; substitution rows are written exclusively by `CoverageService.assign`.                                                                                                                               |

Verify each endpoint applies its row-scope. The places to scrutinise hardest:

- `CoverageService.list` row-scope — non-admin staff filter is `WHERE absent_teacher_id = $actor.employeeId OR assigned_substitute_id = $actor.employeeId`. Verify it doesn't accidentally widen to `OR true` for any persona, and that it doesn't leak to a teacher who isn't either party.
- `RoomBookingService.assertNoConflicts` — the booking-vs-timetable gate matches by ISO weekday on the booking's `startAt` against `sch_periods.day_of_week`. NULL `day_of_week` (rotation-driven, every weekday) is the seed pattern; verify the gate handles both the typed-day case and the NULL case correctly. CAT scenario 9c covers the NULL case.
- `RoomChangeRequestService.create` — refuses if `slot.teacher_id IS NOT NULL AND slot.teacher_id <> actor.employeeId` (non-admin teacher submitting on behalf of another teacher). Admins bypass. Verify the `slot.teacher_id IS NULL` branch (TBD-teacher slot) — should it allow any teacher to submit? Current implementation: yes, anyone with `sch-005:write` can submit a change request on a TBD-teacher slot.
- `TimetableService.listForStudent` (Step 9) — the row-scope helper is `StudentService.assertCanViewStudent` from Cycle 1. Verify the visibility predicate matches the seeded `David Chen → Maya` link via `sis_student_guardians`. CAT scenarios 3 + 10e cover the legitimate access + the row-scope rejection.

### 6. Admin status is tenant-scope-chain, not cross-scope

Use `actor.isSchoolAdmin` from `ActorContextService.resolveActor` or `permissionCheckService.hasAnyPermissionInTenant`. NEVER scan `iam_effective_access_cache` across all scopes. The previous `hasAnyPermissionAcrossScopes` helper was removed in REVIEW-CYCLE1.

**Verify** every scheduling admin-tier check uses one of the two correct paths:

- `actor.isSchoolAdmin` is read directly in 13 service methods (BellSchedule.create / .update / .upsertPeriods / .setDefault; Timetable.create / .update / .delete; Room.create / .update; Calendar.create / .update / .delete; DayOverride.create / .delete; Coverage.assign / .cancel; RoomChangeRequest.approve / .reject).
- The only consumer-side admin read is `CoverageConsumer` — but the consumer doesn't do admin checks; it republishes coverage_needed by walking active timetable slots via the schema relation directly. No cache scan there.

### 7. Frozen-tenant gate (ADR-031)

Every write through this module passes the existing `TenantGuard` frozen check. Reads continue to work even on a frozen tenant. The frozen gate is registered in `AppModule` as `APP_GUARD` and runs after Auth and before Permission. New controllers in this cycle inherit it automatically. Verify no controller bypasses the global guard chain.

### 8. UUIDv7 for all PKs (ADR-002)

`generateId()` from `@campusos/database` only. No `gen_random_uuid()` or `uuidv4()` in service code. The seed and CAT cleanup queries use `gen_random_uuid()` — fine outside the request path.

### 9. ADR-057 envelope on every emit + deterministic event_id from REVIEW-CYCLE4 MAJOR 3

Every scheduling emit goes through `KafkaProducerService.emit(EmitOptions)` with `sourceModule: 'scheduling'`. Topics: `sch.timetable.updated` (every `TimetableService.create / update / delete`); `sch.coverage.needed` (`CoverageConsumer` after creating OPEN rows); `sch.coverage.assigned` (`CoverageService.assign` after the OPEN→ASSIGNED transition + matching substitution row, emitted OUTSIDE the tx so a transient broker outage doesn't roll back the DB write). All on the env-prefixed wire (`dev.sch.*`).

The Cycle 5 `CoverageConsumer` is the FIRST consumer of the deterministic-event-id pattern from REVIEW-CYCLE4 MAJOR 3 (`bda8a16`). The `LeaveNotificationConsumer.emitCoverageNeeded` republish derives a UUID v5-shaped event_id from `sha1(inbound_event_id + ':hr.leave.coverage_needed.v1')`. A Kafka redelivery republish carries the exact same event_id, so `CoverageConsumer.processWithIdempotency` catches the dup before doing the work twice.

**Verify:**

- Every `KafkaProducerService.emit` call in scheduling sets `sourceModule: 'scheduling'`.
- The CAT scenario 7 captures `sch.coverage.assigned` on the wire with the full join shape inline (coverageRequestId, timetableSlotId, coverageDate, substituteId, substituteName, absentTeacherId, absentTeacherName, classSectionCode, courseName, periodName, roomId, roomName, assignedAt). The shape is intentionally read-deep so a future downstream consumer doesn't need DB lookups.
- `CoverageConsumer` reads `event_id` + `tenant_id` off the envelope (via `unwrapEnvelope`), not the legacy transport headers.
- The `UNIQUE(timetable_slot_id, coverage_date)` on `sch_coverage_requests` is the schema-side belt-and-braces dedup — Kafka redelivery raises 23505 and the consumer swallows it. Verify the swallow is bounded (only on this specific UNIQUE; not a generic `catch (e) { /* ignore */ }`).

### 10. Schema-layer state-machine CHECKs

Cycle 5 leans hard on multi-column CHECK constraints to keep state in sync:

- `sch_timetable_slots_dates_chk` — `effective_to IS NULL OR effective_to >= effective_from`.
- `sch_timetable_slots_teacher_no_overlap` + `sch_timetable_slots_room_no_overlap` — the two btree_gist EXCLUSIONs.
- `sch_room_bookings_window_chk` — `end_at > start_at`.
- `sch_room_bookings_cancelled_chk` — multi-column lifecycle: `(status, cancelled_at, cancelled_reason)` consistent.
- `sch_room_change_requests_reviewed_chk` — `PENDING ⇔ reviewed_at IS NULL`.
- `sch_calendar_events_time_consistency_chk` — `(all_day, start_time, end_time)` 2-branch check; `all_day=true` requires both NULL, `all_day=false` requires both NOT NULL with `start_time < end_time`.
- `sch_calendar_events_dates_chk` — `end_date >= start_date`.
- `sch_coverage_requests_assignment_chk` — 3-branch: OPEN ⇔ both NULL; ASSIGNED/COVERED ⇒ both NOT NULL; CANCELLED unconstrained.

The Step 6 `CalendarService.update` is the load-bearing one: when `allDay` toggles to `true`, the UPDATE clears `start_time` + `end_time` in the **same statement** so the time-consistency CHECK never fires mid-flight. Verify this is actually one statement (a separate UPDATE-then-UPDATE would briefly violate the CHECK and rollback).

### 11. Permission catalogue is reconciled

Step 4 added `SCH-001:read` to Staff (Teacher already had it from elsewhere — verify), `SCH-004:read` + `SCH-005:read+write` to Teacher and Staff, and Parent + Student kept `SCH-003:read` from Cycle 1. Cached counts after Step 4: Teacher 34, Staff 14, Student 15, Parent 11 (Step 4 paragraph in CLAUDE.md).

**Verify:**

- `seed-iam.ts` Teacher block includes `'SCH-001': ['read']`, `'SCH-003': ['read']`, `'SCH-004': ['read']`, `'SCH-005': ['read', 'write']`.
- Staff block has the same 4 codes with the same access tiers.
- Parent block has only `'SCH-003': ['read']`.
- Student block has only `'SCH-003': ['read']`.
- The student endpoint `GET /timetable/student/:studentId` correctly gates on `stu-001:read` (every persona has it from Cycle 1) — NOT on `sch-001:read` (which parents and students don't hold). The row-scope check inside `StudentService.assertCanViewStudent` is the actual access gate.

### 12. Idempotent migrations + `seed-scheduling.ts`

`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …`. Re-running provision on an already-migrated tenant must be a no-op. The btree_gist extension creation uses `CREATE EXTENSION IF NOT EXISTS btree_gist` so it's safe across re-provisions and across multiple tenants on the same database.

`seed-scheduling.ts` has 9 idempotent layers each gated on its own row count (or on `sch_bell_schedules` count for the single overall gate). Re-running after a successful seed produces 0 inserts.

### 13. Splitter `;`-in-string trap (carry-over from Cycles 1–4)

`provision-tenant.ts` splits SQL files on `;` regardless of quoting context — block comments, string literals, defaults. CHECK predicates and `COMMENT ON COLUMN` strings cannot contain `;`. Step 1 of Cycle 5 tripped this **again** — the first re-provision failed because `sch_periods.day_of_week` COMMENT contained a literal `;`. The migration was rewritten with em-dashes and applied cleanly on the second pass. **Verify** no `;` anywhere in any string literal across migrations 015–017.

---

## Known scope decisions / accepted deviations — do not flag these

These are deliberate. If you think any of them is wrong, please call it out as a "deviation" not a "violation," and explain why you'd push back.

1. **`sch.coverage.assigned → IN_APP notification` consumer is deferred.** The Step 7 emit fires correctly with full join shape inline; the substitute does NOT yet receive a bell notification when assigned. The Step 6 handoff explicitly documented this as a future patch. The CAT confirms the emit lands cleanly so the wiring is a small downstream consumer addition rather than a re-architecture. Phase 2 punch list, not Cycle 5 scope.
2. **`seed-scheduling.ts` plants the 1 ASSIGNED coverage row directly via SQL, bypassing the `CoverageConsumer`.** The seed runs once per tenant before the API is up, so the consumer can't fire. The CAT scenario 6 (live leave→coverage) exercises the consumer chain end-to-end with a fresh leave at runtime; scenario 5 just verifies the seeded baseline read.
3. **`CalendarService` PATCH doesn't allow un-publishing.** Once `isPublished=true`, flipping it back to `false` returns 400. Drafts are one-way; the audience-fan-out has no analogue here so we keep the contract simple.
4. **Day overrides are managed via the API only, no UI Modal yet.** The hooks (`useDayOverrides` / `useCreateDayOverride` / `useDeleteDayOverride`) are wired and the calendar grid renders existing override rows as a "Closed" pill, but a dedicated admin Modal to add a new override is deferred. The seed plants the demo's only override (2026-02-07 Winter storm closure), which is enough to demonstrate the resolution chain.
5. **`/calendar` is month-view only.** The plan mentioned "month/week view"; Step 8 ships month-only because the seeded events all fit comfortably in the month grid and a separate week shell would duplicate the cell logic. Week view can drop in alongside in a future patch — the data fetcher already supports an arbitrary date range.
6. **No `affects_attendance` integration with Cycle 1's attendance pre-population yet.** The flag is stored, surfaced as a pill in the event detail modal, and its purpose documented; the actual Cycle 1 attendance pre-population path doesn't yet read it. That integration is a future cross-cycle hardening task, not Cycle 5 scope.
7. **No EXCLUSION on substitute double-booking.** A substitute could in theory be assigned to two overlapping `sch_substitution_timetable` rows on the same date in different periods. Modelling this as an EXCLUSION would require materialising period clock-times on the substitution row, which is out of scope. The Step 8 coverage board UI is the human gate; the Assign Modal could in a follow-up surface a warning when an admin tries to assign a substitute who's already covering another period that day.
8. **`sch_periods` overlap is enforced at the application layer, not the schema.** The UNIQUE on `(bell_schedule_id, COALESCE(day_of_week, -1), start_time)` rejects two periods that start at the same minute, but two periods that overlap (e.g. 09:00–10:00 and 09:30–10:30) are allowed at the schema layer. The bell-schedule editor (Step 7) validates `start < end` per row at submit time but doesn't yet validate non-overlap across rows; per the plan, EXCLUSION constraints are reserved for `sch_timetable_slots` where the conflict semantics are dramatically more important.
9. **Rotation cycles are deferred.** `sch_rotation_cycles` + `sch_rotation_calendar` (A/B day schedules per ADR-053) are placeholders. `sch_periods.day_of_week IS NULL` semantically means "rotation-driven" but no rotation tables exist yet; Cycle 5b will add them.
10. **`sch_rooms.fac_space_id`** is a soft, display-only ref to a future `fac_spaces` table (M52 Facilities). Unenforced, nullable, forward-compat. ADR-001/020 holds.
11. **No CSV export on the coverage history.** Out of scope for the CAT.
12. **`/my-schedule` is anchored on today's week; no week-nav.** A small week-nav (prev / next / Today) is a follow-up — the substitution-coverage list below the grid already shows the next 14 days so the user has a window into upcoming weeks.
13. **`SchedulingModule` imports `SisModule` (Step 9) for `StudentService.assertCanViewStudent`.** Cross-module dependency from M22 → M20. The alternative was to copy the visibility predicate into `TimetableService.listForStudent` itself, which would drift over time. Importing the existing helper is the single source of truth.
14. **Booking-vs-timetable conflict is enforced at the app layer (`assertNoConflicts`), not the schema.** Modelling this as an EXCLUSION would require either materialising bookings as date+period rows or moving timetable slots to a date+time shape — both invasive. The app-layer gate is the documented contract per Step 2's out-of-scope decision.
15. **`AppDef.routePrefix` cleanup applies to the Schedule tile only.** The Calendar tile keeps the default behaviour (href = `/calendar`, no prefix) since its routes are nested under that single prefix already. Adding a routePrefix to every tile is unnecessary; only tiles whose href is under their own URL space need the override.
16. **The CAT script does NOT test the bell-schedule editor's `upsertPeriods` path under partial failure.** The Step 5 service uses DELETE-all + INSERT-each in one tx so a UNIQUE / CHECK violation aborts the whole replacement. The CAT verifies the happy path only; a failure-injection smoke would require either a malformed payload or a DB outage mid-insert.
17. **Open-ended `sch_timetable_slots` (effective_to IS NULL) coalesce to `'infinity'::date` in the EXCLUSION constraint.** The `[)` half-open daterange means an open-ended slot blocks every future date. Closing a slot requires PATCHing `effective_to` to a date before opening a replacement — the seed's `effective_from='2025-08-15'` is open-ended for all 6 Rivera slots and that's intentional.
18. **The Step 5 `RoomBookingService.cancel` allows the booking owner OR an admin.** The seed's 1 booking is owned by Mitchell (Principal); other personas trying to cancel her booking should get 403. CAT scenario 10b's parent/student denial is gate-tier, not row-scope; the row-scope owner check would only fire for a non-admin teacher trying to cancel another teacher's booking — not exercised in the CAT.
19. **`/calendar/day/:date` is gated on `sch-003:read` (every persona), not `@Public`.** Schedule data is school-confidential; even non-admin students reading the resolved bell schedule for a date stays inside the gate. The student / parent persona reads through the same endpoint as admins; only the gate level differs.
20. **The `CoverageConsumer` enumerates Mon–Fri only.** Saturday / Sunday slots (`day_of_week IN (5, 6)`) are not enumerated. Schools that operate weekends would need a Phase-2 extension to handle weekend coverage.
21. **`sch_timetable_slots.teacher_id` is nullable for TBD slots.** The Step 5 conflict translator handles the `teacher_id IS NULL` case correctly — two TBD slots on the same period and overlapping range do not conflict per the `=` operator class's NULL-vs-NULL behaviour. The room EXCLUSION still catches the room collision in that case.

---

## Specific paths worth poking at

These are the spots most likely to harbour a real bug. Look at them first.

| File                                                                               | Why it's load-bearing                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/scheduling/timetable.service.ts::translateConflict`                  | Decodes SQLSTATE 23P01 + the EXCLUSION constraint name into a friendly 409. The lookups on the failure path (sch_rooms / sch_periods / hr_employees) are extra reads — verify they don't accidentally widen the response error message to leak names from a different tenant. (Tenant context is pinned to the request, so this should be fine, but worth eyeballing.)                                                            |
| `apps/api/src/scheduling/timetable.service.ts::listForStudent` (Step 9)            | The new row-scoped student endpoint. `StudentService.assertCanViewStudent` is the gate. The query joins `sis_enrollments → sch_timetable_slots`. Verify the predicate uses `sis_enrollments.status='ACTIVE'` and that the join doesn't accidentally surface a slot from a class the student dropped.                                                                                                                              |
| `apps/api/src/scheduling/coverage.service.ts::assign`                              | Locks the row with `FOR UPDATE`, flips OPEN→ASSIGNED, INSERTs the matching `sch_substitution_timetable` row in the same transaction, then emits `sch.coverage.assigned` OUTSIDE the tx. Verify the FOR UPDATE is the right strategy for this hot path (vs. a status-conditional UPDATE). Verify the emit happens only after the tx commits — a roll-back-then-emit would publish a phantom event.                                 |
| `apps/api/src/scheduling/coverage.service.ts::cancel`                              | Drops any matching `sch_substitution_timetable` row in the same tx then flips status=CANCELLED. Verify the schema's `sch_coverage_requests_assignment_chk` (3-branch) accepts CANCELLED unconstrained — i.e. CANCELLED with both NULL OR both NOT NULL must both be valid (cancelled-before-assigned vs cancelled-after-assigned).                                                                                                |
| `apps/api/src/scheduling/coverage.consumer.ts::handle`                             | Reuses `unwrapEnvelope` + `processWithIdempotency` from Cycle 3. Per inbound event, enumerates weekdays Mon–Fri in `[startDate, endDate]`, joins through `sch_timetable_slots → sch_periods` for each `affectedClasses[].classId`, INSERTs `sch_coverage_requests` with status=OPEN. The `UNIQUE(timetable_slot_id, coverage_date)` is the schema-side dedup — verify the `23505` swallow is bounded to that specific constraint. |
| `apps/api/src/scheduling/coverage.consumer.ts::loadActiveSlots`                    | The query that finds Rivera's classes for a given date. Filters on slot date range AND on period `day_of_week` (NULL or matches the date's ISO weekday). Verify the ISO weekday calculation handles the 0=Mon convention correctly (Postgres `EXTRACT(DOW FROM date)` returns 0=Sun by default; 1=Mon if you `ISODOW`).                                                                                                           |
| `apps/api/src/scheduling/calendar.service.ts::resolveDay`                          | The `/calendar/day/:date` endpoint. Resolution order: override → published-event-with-bell_schedule_id → school's `is_default=true` schedule → none. Verify the order is exactly that — a snow day with an attached bell schedule override should resolve as OVERRIDE with `isSchoolDay=false`, NOT as EVENT.                                                                                                                     |
| `apps/api/src/scheduling/calendar.service.ts::update`                              | When `allDay` toggles to `true`, the UPDATE clears `start_time` + `end_time` in the same statement so the schema's time-consistency CHECK never fires mid-flight. Verify this is one SQL statement (a 2-statement update would briefly violate the CHECK).                                                                                                                                                                        |
| `apps/api/src/scheduling/room-booking.service.ts::assertNoConflicts`               | Booking-vs-booking AND booking-vs-timetable. The booking-vs-timetable gate matches by ISO weekday + clock-time on `sch_periods.start_time/end_time` against the booking window. NULL `day_of_week` (rotation-driven, every weekday) is the seed pattern; verify both branches of the OR work.                                                                                                                                     |
| `apps/api/src/scheduling/room-change-request.service.ts::create`                   | Refuses if the slot's `teacher_id` is set and not the actor (admins bypass). Reads `current_room_id` from the slot rather than trusting the client. Verify: what if `slot.teacher_id IS NULL` (TBD slot)? Current behaviour: anyone with `sch-005:write` can submit. Is that the right contract?                                                                                                                                  |
| `apps/api/src/scheduling/room-change-request.service.ts::approve`                  | Requires `approvedRoomId` if the original request had `requestedRoomId=null` ("any available"). Verify the validation: empty string vs absent vs explicit null in the JSON.                                                                                                                                                                                                                                                       |
| `apps/api/src/scheduling/bell-schedule.service.ts::setDefault`                     | Atomically clears any other default for the same school in the same tx so the partial UNIQUE INDEX(school_id) WHERE is_default never rejects the flip. Verify the SQL: `UPDATE … SET is_default=false WHERE school_id=$1 AND is_default=true; UPDATE … SET is_default=true WHERE id=$2;` — both statements inside one tx.                                                                                                         |
| `apps/api/src/scheduling/bell-schedule.service.ts::upsertPeriods`                  | DELETE-all + INSERT-each in one tx so a UNIQUE / CHECK violation aborts the whole replacement. Verify the DELETE is correctly scoped to the single bell_schedule_id (the FK ON DELETE CASCADE on `sch_periods` would catch a rogue DELETE FROM `sch_periods` without a WHERE, but worth checking the parameterised SQL).                                                                                                          |
| `packages/database/prisma/tenant/migrations/015_*.sql` + `016_*.sql` + `017_*.sql` | 10 new tables; 18 intra-tenant FKs. Verify CASCADE rules: `sch_bell_schedules → sch_periods` CASCADE; `sch_coverage_requests → sch_substitution_timetable` CASCADE. The FK from `sch_substitution_timetable.coverage_request_id → sch_coverage_requests` is CASCADE — a substitution row without its parent coverage request is meaningless.                                                                                      |
| `packages/database/src/seed-scheduling.ts`                                         | The 9 idempotent layers. Each layer must gate on its own row count so re-running is a no-op. The Step 4 fix (calendar events INSERT explicitly casting `$N::time` and the coverage request `$5::uuid` cast for `leave_request_id`) must be in place. Verify on a fresh re-provision.                                                                                                                                              |
| `apps/web/src/components/scheduling/TimetableWeekView.tsx`                         | The substitution-highlight pass uses a Map keyed `${slotId}::${YYYY-MM-DD}`. Verify the lookup correctly handles the case where `dayOfWeek=null` (slot renders in every weekday column) — the key needs to be per-render-date, not per-slot. The current implementation iterates `[0..4]` for the column index; verify the date is computed per-column.                                                                           |
| `apps/web/src/app/(app)/calendar/page.tsx::buildMonthGrid`                         | Mon-leading 7×6 grid (42 days). The fetch range covers ±6 weeks around the visible month so leading / trailing days from adjacent months render their badges. Verify the range computation handles year boundaries (December → January, January → December) correctly.                                                                                                                                                            |
| `apps/web/src/components/shell/Sidebar.tsx`                                        | The Step 9 active-state fix: `pathname === matchAgainst OR pathname.startsWith(matchAgainst + '/')` where `matchAgainst = app.routePrefix ?? app.href`. Verify the empty-pathname case (Next.js can briefly null on first render) doesn't crash.                                                                                                                                                                                  |

---

## What we'd love you to actively try to break

In Cycle 1 you found a real cross-tenant data leak. Cycle 2 you found a class-grade leak. Cycle 3 you found a notification-consumer error swallow + delivery worker SENT-as-in-flight + overly-broad `isManager()`. Cycle 4 you found a leave-lifecycle concurrency race + ON_LEAVE access regression + compliance dashboard auth split + non-deterministic event_id for republish. Some equivalents to try here:

1. **Cross-tenant `hr.leave.coverage_needed` consumption.** The `CoverageConsumer.handle` reconstructs tenant context from the inbound envelope's `tenant_id`. If an attacker emits a forged `hr.leave.coverage_needed` to `dev.hr.leave.coverage_needed` with `tenant_id=other-school` but a `payload.affectedClasses[].classId` that exists only in `tenant_demo`, what happens? The `runWithTenantContextAsync` should pin to whatever `tenant_id` the envelope says — verify it doesn't accidentally find a same-id `sch_timetable_slots` row from `tenant_demo` while pinned to `other-school`.
2. **Timetable EXCLUSION race under concurrent inserts.** Two admins simultaneously POST `/timetable/slots` — both targeting Rivera + Period 1 + non-overlapping rooms but overlapping date ranges. The teacher EXCLUSION should serialise them; verify the second POST gets a clean 409, not a partial-write that lands the slot but fails the response.
3. **Coverage assign race.** Two admins simultaneously click "Assign" on the same OPEN coverage row, picking different substitutes. The Step 6 service uses `SELECT … FOR UPDATE` — verify the second admin's request re-reads `status='ASSIGNED'` and 400s ("Coverage row is in status ASSIGNED; only OPEN can be assigned"). If the lock is not actually applied, the second assign would overwrite the first substitute with a fresh substitution row and emit a stale `sch.coverage.assigned` event.
4. **Permission scoping on `sch-005:write`.** Teacher gets `sch-005:read+write` per Step 4. What if a teacher hits `POST /room-bookings` for an absurdly-future date range (e.g. 2099-01-01)? No upper bound on the booking date is enforced. Reasonable behaviour, but worth flagging if you think it's exploitable.
5. **Bell-schedule editor partial save under concurrent admin edits.** Two admins edit the same bell schedule's periods at the same time; both POST the full upsert payload with different period sets. The `upsertPeriods` is DELETE-all + INSERT-each in one tx. Whichever commits second wins — the first admin's edits are silently lost. Verify this is the intended contract or whether optimistic-concurrency tokens are needed.
6. **Calendar event `bell_schedule_id` resolution under a deleted bell schedule.** A calendar event has `bell_schedule_id=X` (override). An admin then deletes bell schedule X. What happens? The schema's FK from `sch_calendar_events.bell_schedule_id → sch_bell_schedules` is CASCADE? or RESTRICT? Verify the foreign key behaviour and the resolution endpoint's response when the bell_schedule_id no longer exists.
7. **Coverage_needed for an employee that's not actually a teacher.** Cycle 4's `LeaveNotificationConsumer.emitCoverageNeeded` queries `sis_class_teachers` for the absent employee's classes. If a non-teaching staff (Park, Hayes — VP, Counsellor) submits a leave that gets approved, the query returns 0 classes and the consumer doesn't emit. Verify Cycle 5's `CoverageConsumer.handle` handles the empty `affectedClasses` array correctly (should be a no-op, not a crash).
8. **Half-open daterange edge case.** The EXCLUSION uses `daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)')`. A slot ending on 2026-08-31 and another slot starting on 2026-08-31 do not overlap (half-open `[)` interval semantics). Verify this is the intended behaviour — a teacher's contract running through 2026-08-31 followed by a new contract from 2026-08-31 should NOT trigger a 409 conflict.
9. **`/coverage` row-scope with mixed admin + non-admin.** A non-admin staff (Counsellor) views `/coverage` — they should see only rows where they are the absent OR assigned employee. Try with a Counsellor who is the assigned substitute on one row but the absent teacher on another. Verify both rows surface; not just one.
10. **Substitution row orphan.** An admin assigns a substitute via `/coverage/:id/assign` — the substitution row is INSERTed with `coverage_request_id` pointing back. The CASCADE FK on `coverage_request_id → sch_coverage_requests` ON DELETE CASCADE means deleting the coverage request drops the substitution row cleanly. But if the API is not the deleter (someone runs a SQL DELETE directly), the substitution row gets orphaned via the FK. Verify the production deployment's permission model doesn't expose direct table writes.
11. **Calendar event with `affects_attendance=true` not yet read by Cycle 1.** The Cycle 1 attendance pre-population path doesn't consult `sch_calendar_events.affects_attendance` — so a teacher hitting `/attendance/by-class` on Spring Break would still pre-populate students. This is a documented future-cycle integration gap; flag if you think it should have been wired in Cycle 5.
12. **Bell-schedule editor `period_type` validation.** The 5-value CHECK accepts LESSON / BREAK / LUNCH / REGISTRATION / ASSEMBLY. The web Modal lets the admin pick from the same enum. What if an attacker sends a custom `period_type` directly to the API? The DTO uses `class-validator` `IsIn(PERIOD_TYPES)` — verify this is enforced at the validation layer before the SQL INSERT.
13. **Hot path on `sch_room_bookings` partial index.** The Step 2 partial INDEX `(room_id, start_at, end_at) WHERE status='CONFIRMED'` is the conflict-check hot path. Verify the index is actually selected by the planner for the `assertNoConflicts` query (a simple `EXPLAIN` on the conflict-check query against a populated tenant would confirm).
14. **Sidebar tile active-state on URL with query string.** With Step 9's `routePrefix='/schedule'`, navigating to `/schedule/timetable?roomId=X` should still light up the Schedule tile. The Sidebar match is `pathname.startsWith(matchAgainst + '/')` — Next.js `usePathname` strips query strings, so this should work. Verify by attempting the URL in the dev server.
15. **Rivera viewing the seeded Park-covers-Rivera substitution row on his own `/my-schedule`.** Step 9's TimetableWeekView highlights cells where a substitution exists. Rivera's own week is rendered for the next 5 weekdays (today-anchored). The seeded substitution is for 2026-03-09 (in the past relative to 2026-04-28). So the highlight should NOT fire; the cell should render as a normal Period 1 Algebra. Verify the `weekDates` calculation correctly anchors on today and doesn't accidentally include past dates.

---

## Output we'd like

Same format as `REVIEW-CYCLE4-CHATGPT.md`:

1. **Verdict header** — `N PASS · N DEVIATION · N VIOLATION` and an overall accept / reject.
2. **Per violation** — title with priority, body explaining the issue, ADR violated, file path + line number, required fix, your own triage. Be specific enough that the fix can be implemented from the description alone.
3. **Per deviation** — a short "this is technically off-spec, but acceptable because X" entry. We'll consolidate and decide.
4. **Per pass** — one bullet each. Helps us know what NOT to second-guess in future cycles.
5. **Fix priority order table** — same shape as Cycle 4 (Priority / Violation / Risk / Effort).

When you submit, please save your output as `REVIEW-CYCLE5-CHATGPT.md` in the repo root. Cycle 4's review body was ~298 lines; Cycle 5 has comparable surface area (10 new tables + 39 endpoints + 1 consumer + 9 web routes + 31 hooks + 2 launchpad tiles + 2 shared components), so something in the 200–400-line range is probably right.

If you find nothing material, that's a fine outcome — say so. We'd rather you tell us "Cycle 5 is clean modulo deviations" than synthesise a violation to fill space.

The closeout SHA to anchor the review against is **`bf59fc8`** (Step 10 — vertical-slice CAT). Cycle 5's first commit is **`d3cf61a`** (Step 1 — scheduling foundation). The 10-commit chain is: `d3cf61a → ae4208d → 76e7ea7 → 6b9849f → 9790ce7 → e0dada3 → 3f9af62 → 901d42a → 8db987f → bf59fc8`.

Suggested entry points for the source walk:

```
git diff 76ddf03..bf59fc8 --stat                 # full Cycle 5 delta vs Cycle 4 closeout
git log 76ddf03..bf59fc8 --oneline               # commit chain
git show 9790ce7 -- apps/api/src/scheduling/     # Step 5 — biggest API surface
git show e0dada3 -- apps/api/src/scheduling/     # Step 6 — calendar + CoverageConsumer
git show ae4208d -- packages/database/prisma/    # Step 2 — EXCLUSION constraints
```
