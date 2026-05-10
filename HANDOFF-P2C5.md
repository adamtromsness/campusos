# HANDOFF — Phase 2 Cycle 5 (P2-5) Enrolment Advanced

**Status:** Build complete pending peer review.
**Plan:** `docs/campusos-p2c5-enrolment-advanced.html`
**Module key:** `M81 .1` (deferred Cycle 16 tables)
**Wave:** Wave B opens here.

---

## What shipped

7 new tenant tables across 3 migrations, ~22 new endpoints, 2 Kafka emit topics, full UI surface, 41 unit tests.

### Migrations

| File                                    | Tables added                                                                                                                | Notes                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `119_enr_tours.sql`                     | `enr_tour_slots`, `enr_tour_bookings`, `enr_tour_booking_guests`                                                            | Plan called for slot 106 (taken since Cycle 6); used 119. Splitter clean on first audit. Smoke 18/18 assertions.                                                                                            |
| `120_enr_withdrawal_reenrol.sql`        | `enr_withdrawal_requests`, `enr_withdrawal_exit_tasks`, `enr_reenrollment_confirmations`, `enr_mid_year_admission_requests` | Plan 107 (taken); used 120. Splitter clean. Smoke 25/25.                                                                                                                                                    |
| `121_enr_withdrawal_task_templates.sql` | `enr_withdrawal_task_templates`                                                                                             | Step 8 — plan called for `platform_tenant_configs` storage but that table does not exist in the platform schema. Decision: ship as a tenant table (rationale documented inline). Lazy-seeded on first read. |

**Tenant base table count:** 474 → **481**.

### Schema keystones

- **`enr_tour_slots`** — `current_chk` is the schema-side capacity gate (`current_bookings <= max_bookings`). The TourBookingService already enforces capacity inside a locked tx; the CHECK is belt-and-braces.
- **`enr_tour_bookings.cancelled_chk`** — multi-column lockstep keeping `(status, cancelled_at, cancellation_reason)` consistent. CANCELLED requires non-empty `cancellation_reason`.
- **`enr_withdrawal_requests.completed_chk`** — multi-column lockstep on COMPLETED + completed_at + completed_by.
- **`enr_withdrawal_requests.hold_chk`** — `re_enrollment_hold_placed=true` requires non-empty `re_enrollment_hold_reason`. Admin who blocks a student must justify.
- **`enr_withdrawal_exit_tasks.completed_chk`** — COMPLETED/WAIVED require both `completed_by` + `completed_at`; PENDING/NOT_APPLICABLE require both NULL.
- **`enr_reenrollment_confirmations.reason_chk`** — `confirmed_continuing=false` requires non-empty `withdrawal_reason`. The auto-initiated withdrawal carries the family's narrative.
- **`enr_reenrollment_confirmations` UNIQUE(student_id, academic_year_id)** — one confirmation per student per year.
- **`enr_mid_year_admission_requests.capacity_chk`** — `(capacity_available, capacity_checked_at, capacity_checked_by)` either all-set or all-null.

### NestJS module — `apps/api/src/enrolment-advanced/`

| Service                   | Endpoints             | Auth                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TourSlotService`         | 4                     | `stu-003:read`, `stu-003:admin`        | Public list filters published + future + non-cancelled + non-full. Admin CRUD with UNIQUE catch into 400.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TourBookingService`      | 5 incl. 1 `@Public()` | `stu-003:read`/`write`/`admin`+ public | **The `@Public()` `bookPublic` keystone** — locks slot row inside `executeInTenantTransaction`, validates published + non-cancelled + capacity remaining, resolves `iam_person` per ADR-055 (lookup-or-create), inserts booking + guests, bumps `current_bookings`, enqueues `enr.tour.booked` via `OutboxService.enqueueInTx` so a Kafka outage cannot roll back the user's booking. CancellationReason required when status flips to CANCELLED; cancel decrements `current_bookings` in same locked tx.                                                                                                                                      |
| `WithdrawalService`       | 5                     | `stu-004:read`/`write`/`admin`         | `create` validates guardian-of-student via `sis_student_guardians` for non-admin guardians + reads the per-school exit task template (`ExitTaskTemplateService.listActive`, lazy-seeds DEFAULT) + auto-creates one `enr_withdrawal_exit_tasks` row per template task in the same tx. **The `complete` keystone** runs an in-tx COUNT of PENDING tasks and rejects with a friendly 400 listing the count; on success flips `sis_students.enrollment_status='WITHDRAWN'` and emits `enr.student.withdrawn` via outbox. `cancel` is admin-or-original-requester only. `placeReenrolHold` enforces non-empty reason matching the schema invariant. |
| `ExitTaskService`         | 2                     | `stu-004:read`/`write`                 | Per-department staff close their tasks. Locks the row inside the parent withdrawal's tx via `FOR UPDATE OF t`; refuses transitions on COMPLETED/CANCELLED parent withdrawals. Maps `status='COMPLETED'`/`WAIVED` to also stamp `completed_by` + `completed_at` atomically (satisfying `completed_chk`). On first PENDING → non-PENDING transition flips parent withdrawal `REQUESTED → IN_PROGRESS`.                                                                                                                                                                                                                                           |
| `ReenrolmentService`      | 4                     | `stu-004:read`/`write`/`admin`         | Validates `confirmed_continuing` vs `withdrawal_reason` shape (matching `reason_chk`); refuses submission for students with active re-enrolment hold; **`confirmed_continuing=false` auto-calls `WithdrawalService.createInternal`** in the same logical flow (FAMILY initiated, OTHER reason category, current date as last_attendance_date) and stamps the new `linked_withdrawal_id` on the confirmation. Admin-only `summary` returns per-grade continuing vs departing vs outstanding counts.                                                                                                                                             |
| `MidYearAdmissionService` | 4                     | `stu-004:read`/`write`/`admin`         | Parent or EO submits; admin patches with `capacityAvailable` (auto-stamps `capacity_checked_at` + `capacity_checked_by` to satisfy `capacity_chk`); `linkedApplicationId` validated against `enr_applications` in this school before write.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ExitTaskTemplateService` | 2                     | `stu-004:read`/`stu-004:admin`         | Step 8 — admin reads + replaces the per-school template. Lazy-seeds 7-task DEFAULT baseline on first call. Upsert marks every existing row inactive then UPSERTs by `(school, template, task_name)`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Total endpoints:** 22 + 1 hidden test endpoint (`bookAuthenticated` is exposed via `bookPublic` only this cycle) = **23 routes mapped** on boot.

### Kafka emit topics

Both via `OutboxService.enqueueInTx` for durable at-least-once delivery:

| Topic                   | When                                             | Payload                                                                                     |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `enr.tour.booked`       | After every public or authenticated tour booking | `{ bookingId, slotId, schoolId, bookedBy, familyName, contactEmail, tourDate, guestCount }` |
| `enr.student.withdrawn` | After WithdrawalService.complete commits         | `{ withdrawalId, studentId, schoolId, completedBy, completedAt }`                           |

`source_module='enrolment-advanced'` on both. `OutboxPublisherWorker` picks up + publishes to Kafka; the deterministic event_id pattern ensures redelivery idempotency on the consumer side.

### Web UI — `apps/web/src/app/`

6 routes:

| Path                               | Layout                 | Notes                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/enrolment/tours`                 | (app) authenticated    | Admin slot calendar, bookings table, create-slot Modal. Per-row Publish/Cancel/Complete/No-show/Cancel actions. Window.confirm guards on destructive ops + cancellationReason prompt.                                                                                                                             |
| `/enrolment/tours/public`          | **app root** (no auth) | Prospective family browse + book. Slot picker grid → booking form with first/last name + email + phone + per-guest manifest (ADULT/CHILD/PROSPECTIVE_STUDENT) + notes. Confirmation screen on success.                                                                                                            |
| `/enrolment/withdrawals`           | (app)                  | Filterable status queue with detail Modal showing inlined exit tasks. Per-task status dropdown for staff. Admin-only Complete button (disabled when any task PENDING with tooltip showing the count). Place/Lift hold action. Cancel-with-reason prompt. Initiate-withdrawal Modal with reason category dropdown. |
| `/enrolment/withdrawals/templates` | (app) admin-only       | Editable task list with order, name, department, required toggle, remove + add. Save replaces template via UPSERT.                                                                                                                                                                                                |
| `/enrolment/reenrolment`           | (app)                  | Year picker + admin per-grade summary panel + confirmations table. Guardian-only "Confirm next year" Modal with continuing/departing radio + required reason on departing.                                                                                                                                        |
| `/enrolment/mid-year`              | (app)                  | Request queue with per-row Mark available/Mark full/Link application admin actions. Submit-request Modal.                                                                                                                                                                                                         |

**2 launchpad tiles** added in `apps/web/src/components/shell/apps.tsx`:

- `Tours` (key `enrolment-tours`) — gated on `stu-003:read/write/admin`. Description copy switches based on persona.
- `Withdrawal & Re-enrolment` (key `enrolment-withdrawals`, parent label switches to `Withdrawals` for staff) — gated on `stu-004:read/write/admin`.

### Hooks + format helpers

- `apps/web/src/hooks/use-enrolment-advanced.ts` — 22 React Query hooks covering every endpoint with proper invalidation chains.
- `apps/web/src/lib/enrolment-advanced-format.ts` — label maps, pill class maps, format helpers (date, time, student name).
- `apps/web/src/lib/types.ts` — appended ~30 P2-5 DTOs + payloads. **Renamed**: `TaskCategory` → `ExitTaskCategory`, `TaskStatus` → `ExitTaskStatus` to dodge collision with the Cycle 7 `TaskCategory` (`ACADEMIC|PERSONAL|ADMINISTRATIVE|ACKNOWLEDGEMENT`) and `TaskStatus` (`TODO|IN_PROGRESS|DONE|CANCELLED`).

### Seed data — `seed-enrolment-advanced.ts` (idempotent, gated on `enr_tour_slots`)

| Section | Rows                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A       | 3 published tour slots — 1 GENERAL_OPEN_DAY (max 10, 1 booking), 2 INDIVIDUAL_FAMILY_TOUR (1 with current=1, 1 with current=0) |
| B       | 2 tour bookings + 3 guests (1 CONFIRMED upcoming + 1 COMPLETED with `linked_application_id`); 1 fresh prospective `iam_person` |
| C       | 1 COMPLETED withdrawal — Maya Chen, 7 exit tasks all COMPLETED, `destination_school_name='Madison Country Day'`, records sent  |
| D       | 1 IN_PROGRESS withdrawal — Aiden Park, 4 COMPLETED + 3 PENDING tasks                                                           |
| E       | 5 re-enrolment confirmations — 4 continuing + 1 departing with linked auto-initiated REQUESTED withdrawal                      |
| F       | 2 mid-year admission requests — 1 ENROLLED with linked application + 1 RECEIVED awaiting capacity check                        |

**Important:** the COMPLETED withdrawal in section C **does NOT** flip `sis_students.enrollment_status` to WITHDRAWN at seed time. Documented in the seed comment — runtime `WithdrawalService.complete()` is the canonical writer; the seed leaves Maya as ENROLLED so downstream seeds (counselling caseloads, library checkouts, etc. that reference Maya as ACTIVE) continue to work. The CAT exercises a fresh withdrawal end-to-end against a dedicated test student so the flip is observable.

### IAM grants

Catalogue stays at 513 (STU-003 + STU-004 already in `permissions.json` from prior waves). New role-permission rows:

- **Parent**: `STU-004:read+write` added (47 → 49 perms cached). Parents submit own withdrawals + re-enrolment confirmations + mid-year requests for their own children.
- **Staff**: `STU-004:read+write` added (covers EO + per-department staff). Generic Staff scope today; pre-pilot role-split is on the punch list.
- **Vice Principal**: `STU-004:read+write+admin` added.
- **Enrolment Officer**: `STU-004:read+write+admin` added (joins existing STU-003 admin tier).
- **School Admin / Platform Admin**: pick up `STU-004:admin` via `everyFunction`.

---

## Test coverage

`apps/api/src/enrolment-advanced/enrolment-advanced.spec.ts` — **41 unit tests across 7 services + 5 controllers + the metadata-gate suite**:

- **TourSlotService** — list filter SQL shape, admin gate, endTime > startTime validation, 23505 → 400 translation.
- **TourBookingService** — locked slot read + bumps current_bookings + outbox emit (full payload assertion); ConflictException on full slot; NotFoundException on missing; refuses unpublished + cancelled slots; **ADR-055 reuses `iam_person` when contact email matches** (verifies findFirst + no duplicate INSERT); rejects malformed email; CANCELLED requires non-empty cancellationReason + decrements slot via locked tx; linkApplication validates application is in this school.
- **WithdrawalService** — parent row scope on list (sis_student_guardians clause); admin sees all; create rejects when parent is not guardian; create rejects on empty template; **complete rejects when any task PENDING (counts in friendly 400)**; complete flips sis_students.enrollment_status + emits enr.student.withdrawn; rejects already-COMPLETED; placeReenrolHold requires reason matching hold_chk; non-admin cannot complete.
- **ReenrolmentService** — rejects continuing=true with reason payload; rejects continuing=false without reason; rejects when student has active hold; summary admin-only.
- **MidYearAdmissionService** — list filters parent to own; patch admin-only; linkedApplicationId validated; submit by parent with stu-004:write writes the row.
- **ExitTaskService** — patch COMPLETED stamps completed_by + completed_at; refuses on COMPLETED parent; flips parent REQUESTED → IN_PROGRESS on first transition; refuses without write scope.
- **ExitTaskTemplateService** — `listActive` lazy-seeds 7-task baseline on empty; upsert refuses non-admin.
- **Controller permission metadata** — every controller method's `@RequirePermission` decorator value asserted via `Reflect.getMetadata(PERMISSIONS_KEY, ...)` for TourController + WithdrawalController + ReenrolmentController + MidYearAdmissionController + ExitTaskTemplateController. Catches accidental gate downgrades.

**Vitest suite: 230/230 passing across 18 spec files** (was 189 before P2-5; +41 = 230).

---

## Live verification

Smoke run on `tenant_demo` 2026-05-09 confirmed every keystone end-to-end:

- **Tour lifecycle** — public booking → 201 with `status=CONFIRMED`, slot `current_bookings` bumped from 0 → 1, outbox row written for `enr.tour.booked` with `source_module='enrolment-advanced'` + payload populated.
- **Capacity gate** — first booking against cap=1 slot returns 201; second returns `409 Conflict — "Tour slot is full (1/1)"`.
- **Re-enrolment auto-withdrawal** — parent submits `confirmed_continuing=false` with reason → returns confirmation with `linkedWithdrawalId` populated; new withdrawal row exists in REQUESTED status with 7 PENDING exit tasks auto-created from the lazy-seeded DEFAULT template.
- **Complete-gate** — admin attempts `PATCH /:id/complete` with 7 PENDING → `400 "Cannot complete withdrawal — 7 exit task(s) still PENDING. Mark each task COMPLETED, WAIVED, or NOT_APPLICABLE first."`
- **End-to-end completion** — admin marks all 7 tasks COMPLETED (one at a time via the per-task PATCH); admin completes withdrawal → status flips to COMPLETED, `sis_students.enrollment_status` flips to WITHDRAWN, `enr.student.withdrawn` outbox row written with the correct studentId.
- **Mid-year admissions** — admin reads 2 seeded rows including 1 ENROLLED with linkedApplicationId.
- **Visibility** — student GET `/enrolment/tours` 403; parent GET `/withdrawals` returns 1 (own children via guardian link) vs admin returns 3.

The full smoke transcript (with the OutboxService bug fix that was caught + resolved during smoke — see Known Issues below) lives in this file's git history.

---

## Cross-module dependencies

**Cycle 16 application pipeline** — three integration points:

1. `enr_tour_bookings.linked_application_id` soft FK → `enr_applications(id)` (SET NULL on application removal).
2. `enr_mid_year_admission_requests.linked_application_id` soft FK → `enr_applications(id)` (SET NULL).
3. `enr_capacity_summary` (Cycle 6) is the read source for the EO's mid-year capacity check (Phase 2 punch list — currently the admin manually inspects + flips `capacityAvailable` rather than reading it via the service).

**Cycle 1 SIS** — `sis_students.enrollment_status` is flipped to `'WITHDRAWN'` by `WithdrawalService.complete`. `sis_student_guardians` is the row-scope source for parent-initiated withdrawals + re-enrolment.

**ADR-055** — `TourBookingService.bookPublic` creates a fresh `iam_person` (`person_type='GUARDIAN'`) + `platform_users` row (`account_status='PENDING_VERIFICATION'`) for prospective families that don't yet have an account. Identical pattern to `seed-recruitment.ts`'s candidate creation path.

**Cycle 7 task system** — none. Future Phase 2 polish item: emit `tsk.task.requested` for each newly created exit task so the per-department staff member sees it on their personal task list.

**Cycle 4 HR** — `enr_tour_slots.led_by` soft FK → `hr_employees(id)` SET NULL (tour leader).

---

## Known Issues + Carry-overs

### Bug fix in this cycle

**`OutboxService.enqueueInTx` SQL had a missing `::uuid` cast on `tenant_id`** — caught during P2-5 live smoke. The INSERT into `platform.platform_outbox` passed `$5` for `tenant_id` (UUID column) but the SQL had no cast. Prisma's `$executeRawUnsafe` doesn't auto-cast text → uuid, so every emit for new modules failed with `42804: column "tenant_id" is of type uuid but expression is of type text`. This was a latent bug — existing services that called `enqueueInTx` (Step 6 P2-4c, governance breach service, emergency-alert service) likely never exercised the path live (or did so under conditions that converted the value differently). The fix added `::uuid` to the `$5` parameter on line 112 of `apps/api/src/kafka/outbox.service.ts`. Existing callers benefit immediately.

### Carry-overs to Phase 2 punch list

1. **Cycle 7 exit-task-to-personal-task wiring** — the WithdrawalService creates `enr_withdrawal_exit_tasks` rows directly. Future polish: emit `tsk.task.requested` per task so per-department staff see them in their Tasks app alongside everything else.

2. **EO Capacity check via `enr_capacity_summary`** — the mid-year admission `capacityAvailable` flag is set manually by the admin today. Phase 2 polish: the EO admin patch should read the matching `enr_capacity_summary(school, period, grade)` row and surface the available count inline.

3. **`hr_employees`-keyed `completed_by` on exit tasks** — currently soft-typed to `platform.iam_person.id`. ADR-055 / ADR-001/020 conformant but a per-cycle reviewer may prefer DB-enforced FK to `hr_employees` for staff completers. Schema-only migration would suffice.

4. **Department-staff per-category routing on `ExitTaskService`** — service-side `hasWriteScope` is generic stu-004:write today. Plan called for per-department staff completing only their own category. Pre-pilot fix: introduce per-category function codes (LIB-001 → RECORDS, IT-002 → IT, etc.) and tighten the gate. Mentioned in `ExitTaskService` JSDoc.

5. **Generic Staff role still owns withdrawal admin** — joins items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 in the broader role-split chain. A dedicated EO role split (which the seed already creates as a specialist) needs to fully own STU-003 + STU-004 admin so generic Staff doesn't inherit them.

6. **Tour confirmation email** — `enr.tour.booked` envelope is emitted; future Cycle 3 NotificationConsumer fan-out wires the actual SES/SMTP send. Not in scope this cycle.

7. **Cycle 16 application creation from tour booking** — currently EO manually links via `POST /tour-bookings/:id/link-application`. Future polish: a "Create application from tour" button on the booking detail that pre-populates the application form with the booker's identity + linked guests.

8. **No tests / hooks for the parent-row-scoped `getById` on tour bookings** — the booking owner can read their own booking by id. Tested in service code; not yet a vitest scenario.

9. **Re-enrolment hold handling for new application submissions** — currently `ReenrolmentService.submit` checks holds, but `enr_applications` admission flow doesn't. A school admin who holds a withdrawn student should also see the new application bounce. Pre-pilot.

---

## File inventory

```
apps/api/src/enrolment-advanced/
├── dto/
│   ├── tour.dto.ts
│   └── withdrawal.dto.ts
├── tour-slot.service.ts
├── tour-booking.service.ts
├── tour.controller.ts
├── withdrawal.service.ts
├── withdrawal.controller.ts
├── exit-task.service.ts
├── reenrolment.service.ts
├── reenrolment.controller.ts
├── mid-year-admission.service.ts
├── mid-year-admission.controller.ts
├── exit-task-template.service.ts
├── exit-task-template.controller.ts
├── enrolment-advanced.module.ts
└── enrolment-advanced.spec.ts                     (41 tests)

apps/api/src/kafka/outbox.service.ts                (latent bug fix — 1 char)
apps/api/src/app.module.ts                          (+ EnrolmentAdvancedModule import)

packages/database/prisma/tenant/migrations/
├── 119_enr_tours.sql
├── 120_enr_withdrawal_reenrol.sql
└── 121_enr_withdrawal_task_templates.sql

packages/database/src/seed-enrolment-advanced.ts
packages/database/src/seed-all.ts                   (+ 1 SEED_STEPS entry)
packages/database/src/seed-iam.ts                   (+ STU-004 grants, 4 roles)
packages/database/package.json                      (+ seed:enrolment-advanced script)

apps/web/src/hooks/use-enrolment-advanced.ts        (22 React Query hooks)
apps/web/src/lib/enrolment-advanced-format.ts
apps/web/src/lib/types.ts                           (+ ~30 DTOs; renamed TaskCategory/TaskStatus)
apps/web/src/components/shell/apps.tsx              (+ 2 launchpad tiles + 2 AppKey entries)

apps/web/src/app/(app)/enrolment/
├── tours/page.tsx
├── withdrawals/page.tsx
├── withdrawals/templates/page.tsx
├── reenrolment/page.tsx
└── mid-year/page.tsx

apps/web/src/app/enrolment/tours/public/page.tsx    (public — outside (app) layout)
```

---

## Wave B opening

P2-5 is the first cycle of Wave B (Pilot Enhancement). Wave A (P2C1–P2C4 + P2-4a/b/c) closed clean with the M80 HR + finance integration loop fully operational. Wave B continues with the remaining `.1` cycles for cross-cutting concerns (analytics expansion, deeper governance, pre-pilot hardening).
