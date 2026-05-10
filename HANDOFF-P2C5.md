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

---

## REVIEW-P2-5 ROUND 1 fix log (2026-05-09 → 2026-05-10)

Round 1 against `a5f3026` returned **FAIL** with 3 BLOCKING + 3 MAJOR. The closeout fix commit lands all 3 BLOCKING + actionable MAJORs 4 + 5 with live verification on `tenant_demo`. MAJOR 6 (per-department exit-task scoping) correctly carries to the Phase 2 punch list per the reviewer's gate decision.

### BLOCKING 1 — public booking creates platform identities before slot validation

**File:** `apps/api/src/enrolment-advanced/tour-booking.service.ts`

`bookPublic()` previously created `platform.iam_person` + `platform.platform_users` BEFORE locking + validating the tour slot. An attacker could spam the endpoint with random / unpublished / cancelled / full slot ids and leave orphan platform identity rows behind even though no valid booking lands.

**Fix:** Reordered the flow:

1. **Pre-flight unlocked slot validation** (existence + published + non-cancelled + capacity remaining) BEFORE any platform identity write. Catches the abuse path with zero side-effects.
2. **Identity creation** (only after pre-flight passes).
3. **Locked tx with re-validation** + booking insert + outbox enqueue (canonical race protection).

The schema-side `current_chk` (`current_bookings <= max_bookings`) remains the belt-and-braces against any direct-SQL bypass.

**Live verified on `tenant_demo` 2026-05-10:** 1 legit booking → +1 `iam_person`; 2 spam attempts (full slot 409, bogus UUID 404) → +0 `iam_person` rows. Zero `Spam*` rows landed in the platform schema.

### BLOCKING 2 — re-enrolment auto-withdrawal not atomic

**Files:** `apps/api/src/enrolment-advanced/withdrawal.service.ts` + `reenrolment.service.ts`

`ReenrolmentService.submit` previously called `WithdrawalService.createInternal()` (which opened its own tenant tx + committed) BEFORE inserting the confirmation row. If the confirmation INSERT hit the `UNIQUE(student_id, academic_year_id)` collision, the auto-withdrawal + its 7 exit tasks were already committed and the school ended up with an orphan REQUESTED withdrawal the family never knowingly submitted.

**Fix:**

1. New `TenantTx` interface + `WithdrawalService.createInTx(tx, input, actor)` helper that takes an open tenant tx instead of opening its own.
2. `WithdrawalService.create()` (the public controller path) now opens its own tx and delegates to `createInTx` — same behaviour, no API change.
3. `ReenrolmentService.submit` rewritten to wrap BOTH the confirmation INSERT AND the conditional auto-withdrawal call in a single `executeInTenantTransaction`. The auto-withdrawal call passes the SAME tx through so a UNIQUE collision on the confirmation rolls back the withdrawal + its exit tasks atomically.
4. The obsolete `WithdrawalService.createInternal` was removed (no other callers).

**Live verified on `tenant_demo` 2026-05-10:** first non-continuing submission → 1 REQUESTED withdrawal for Maya. Duplicate submission for the same (student, year) → 400 + REQUESTED count UNCHANGED at 1. Zero orphans.

### BLOCKING 3 — generic Staff has broad STU-004 + bypasses row scope

**Files:** `packages/database/src/seed-iam.ts` + `withdrawal.service.ts` + `reenrolment.service.ts` + `mid-year-admission.service.ts` + `exit-task.service.ts`

The `Staff` role spec granted `STU-004:read+write`. Multiple services then treated `actor.personType === 'STAFF'` as a row-scope bypass — a generic counsellor / librarian / VP could list every school-wide withdrawal / re-enrolment / mid-year request and initiate withdrawals for arbitrary students. The dedicated `Enrolment Officer` specialist role already carries STU-004:admin, so the broad Staff grant was unnecessary AND unsafe.

**Fix:**

1. **`Staff` role spec dropped `STU-004:read/write`.** Comment cross-references the broader role-split punch list.
2. **`seed-iam.ts` reconciliation extended** to also DELETE role_permissions rows that no longer match the spec (previously only INSERTed new rows, so removed grants stuck around). Live re-run reports `Staff: 4 stale removed`.
3. **New `hasOperatorScope(actor)` helper** in `WithdrawalService`, `ReenrolmentService`, `MidYearAdmissionService`. Returns true ONLY if `actor.isSchoolAdmin OR (personType=STAFF AND has STU-004:write|admin)`. Replaces every `personType === 'STAFF'` shortcut.
4. **`ExitTaskService.listPending`** dropped the `personType === 'STAFF'` bypass; now strictly `STU-004:write|admin OR school admin`.
5. Cache rebuild reports `vp 229 → 227 perms` and `counsellor 201 → 197 perms` after the cleanup landed.

**Live verified on `tenant_demo` 2026-05-10:** counsellor (generic Staff persona, no STU-004 grant) → 403 on POST `/enrolment/withdrawals` and gate-blocked on the list; principal (admin) → sees 3 school-wide withdrawals.

### MAJOR 4 — public booking attaches to existing iam_person by email

**File:** `apps/api/src/enrolment-advanced/tour-booking.service.ts`

`bookPublic()` previously did `platformUser.findFirst({where:{email}})` and reused the existing `iam_person.id` as `booked_by`. Anyone who knew an existing user's email could attach a booking to their account. The owner would later see a booking they did not create.

**Fix:** Removed the email-based lookup entirely. Public bookings now ALWAYS create a fresh `iam_person` row (no `platform_users` row at all — public bookings are "pending external contacts" with no auth identity, so the unique-email collision is dodged AND the row never pollutes the auth surface). The contact email stays in `enr_tour_bookings.contact_email`. EOs link to existing identities later via `POST /tour-bookings/:id/link-application` after verification.

**Live verified on `tenant_demo` 2026-05-10:** booking with `contactEmail='parent@demo.campusos.dev'` → bookedBy is a FRESH iam_person (not David Chen's), `platform_users` count delta = 0.

### MAJOR 5 — `WithdrawalService.complete` updates `sis_students` by id only

**File:** `apps/api/src/enrolment-advanced/withdrawal.service.ts`

The final UPDATE on `sis_students.enrollment_status='WITHDRAWN'` had no `school_id` predicate. The withdrawal row above was already locked + school-scoped, so the existing service path was not exploitable, but the project's hardening-by-default convention requires the predicate as defence in depth.

**Fix:** Added `WHERE school_id = $1::uuid AND id = $2::uuid` with `tenant.schoolId` as the first argument. Verified by spec test (`MAJOR 5 — sis_students UPDATE is school-scoped` asserts the SQL contains both predicates and the args bind correctly) AND by live smoke (Maya's `enrollment_status` flipped to WITHDRAWN through the new SQL shape).

### MAJOR 6 — exit-task per-department scoping deferred (Phase 2 punch list)

Reviewer accepted as Phase 2 hardening per the gate decision. The service comments document the deferred per-category function code split (LIB-001 → RECORDS, IT-002 → IT, etc.). Currently any actor with `STU-004:write` (now restricted to admin / EO / VP) can close any department's task. Pre-pilot work introduces the per-category gate.

### Test coverage

11 new regression tests in `enrolment-advanced.spec.ts` (vitest **230 → 241 passing across 18 spec files**):

- **3 BLOCKING 1 tests** — bookPublic does NOT create iam_person for missing slot, full slot, or unpublished slot.
- **MAJOR 4 rewrite** — bookPublic with existing-email always creates fresh iam_person (NOT reuse) + only 1 platform write (no platform_users).
- **2 BLOCKING 2 tests** — duplicate confirmation rolls back the auto-withdrawal in single tenant tx; continuing=true does NOT call the withdrawal create path.
- **5 BLOCKING 3 tests** — generic Staff (no STU-004) is row-scoped on withdrawal list, EO (Staff with STU-004:admin) sees school-wide, generic Staff defaults to own re-enrolment submissions, generic Staff defaults to own mid-year submissions, generic Staff cannot initiate withdrawal for arbitrary student.
- **MAJOR 5 test** — `WithdrawalService.complete` UPDATE on sis_students contains both `school_id` and `id` predicates with `tenant.schoolId` as the first bind argument.

### CI parity

- `pnpm format:check` clean.
- `pnpm lint:logs` clean (601 files).
- `pnpm --filter @campusos/api test`: **241/241 passing across 18 spec files**.
- `pnpm --filter @campusos/api build` clean.
- `pnpm --filter @campusos/web build` clean.

### Carry-forward

MAJOR 6 (per-department exit-task scoping) joins the Phase 2 punch list alongside items 9 / 11 / 13 / 14 / 16 / 22 / 25 / 26 / 30 / 32 / 33 — all part of the broader role-split work before real-school pilot.

## REVIEW-P2-5 ROUND 2 fix log (2026-05-10)

Round 2 returned **REJECT** with 1 BLOCKING + 0 MAJOR. The 2 BLOCKINGs and 2 MAJORs from Round 1 were confirmed fixed; one BLOCKING remained:

> **BLOCKING — public booking still creates orphan iam_person under last-seat race.** The Round 1 pre-flight slot read happens BEFORE iam_person creation, which catches bogus / unpublished / cancelled / already-full slot ids. But under concurrent last-seat pressure, two requests can both pass the unlocked pre-flight, both create fresh iam_person rows, and then only one wins the locked-tx capacity check — leaving the loser's iam_person + platform_users orphaned.

Reviewer offered three acceptable fixes (A: ON CONFLICT DO NOTHING + lookup-or-resurrect; B: hold the per-slot lock around the entire booking incl. identity creation; C: no iam_person on public path — pure external-contact rows). **Took Option C** per the reviewer's note that it is "the cleanest abuse-resistant model".

### Fix details

(BLOCKING — Option C, no iam_person on public booking)

**Migration `122_enr_tour_bookings_booked_by_nullable.sql`**: drops NOT NULL on `enr_tour_bookings.booked_by`. The booking row already carries `family_name + contact_email + contact_phone` plus a per-guest manifest in `enr_tour_booking_guests`, so the contact info is preserved without an iam_person row. The UNIQUE(slot_id, booked_by) constraint stays — Postgres treats NULL-vs-NULL as not-equal so multiple NULL rows per slot coexist (which is the right shape for distinct prospective families). Splitter trap caught + fixed pre-provision: `;` mid block-comment ("NULL on public bookings; EOs stitch identities later") rewritten with em-dash. Provisioned cleanly to both `tenant_demo` + `tenant_test` (119 migrations applied each). COMMENT ON COLUMN documents the new contract: `'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. NULL when the booking came in through the unauthenticated public path — no platform identity is created at booking time per REVIEW-P2-5 Round 2 BLOCKING fix to dodge orphan-identity races on the last-seat capacity gate. EOs stitch identities later via POST /tour-bookings/:id/link-application once a verified application surfaces. Authenticated bookings populate this with the actor person id at insert time.'`

**`TourBookingService.bookPublic()` rewritten**: removed `PrismaClient` constructor injection (no longer needed since `bookPublic` does ZERO platform writes). Validates `firstName` / `lastName` / `contactEmail` and routes straight into `createBookingForPerson(slotId, null, input)`. The locked tx then INSERTs into `enr_tour_bookings` with `bookedBy=null` at `$4::uuid` (the cast accepts NULL). `createBookingForPerson` signature updated to `bookedBy: string | null`. Authenticated bookings (parent dashboard etc.) continue to populate `booked_by` from `actor.personId`. The `link-application` admin path still takes a separate `personId` argument so EOs can stitch identities post-hoc once a verified workflow proves ownership. `TourBookingResponseDto.bookedBy` widened to `string | null`. Outbox `enr.tour.booked` payload likewise carries `bookedBy: null` for public bookings.

### Concurrency regression test (reviewer's explicit pass condition)

Added 2 new vitest cases to `enrolment-advanced.spec.ts` (54 tests now, was 52):

1. **"two concurrent bookings against a cap=1 slot — exactly 1 succeeds, ZERO platform writes from either"** — simulates Postgres `FOR UPDATE` by serialising tx callbacks through a per-slot mutex with mutable `current_bookings` state surviving across calls. Fires `Promise.allSettled([bookPublic(...), bookPublic(...)])` against a cap=1 slot. Asserts: 1 fulfilled + 1 rejected with `ConflictException`, `slotState.current === 1`, `platformPrisma.$executeRawUnsafe` was **never** called from either attempt (the keystone), exactly 1 outbox emit with `payload.bookedBy === null`.
2. **"public booking writes booked_by=NULL into enr_tour_bookings (Option C contract)"** — verifies the INSERT into `enr_tour_bookings` carries `null` at positional argument `$4` (the `booked_by` slot) and the outbox payload's `bookedBy` is `null`.

### Live verification on `tenant_demo` 2026-05-10

Created cap=1 slot, captured pre-state (iam_person=39, platform_users=24), fired 5 parallel public booking requests against the slot. Result: `1× 201 + 4× 409`, **iam_person delta=0, platform_users delta=0** (Option C contract — public path creates ZERO platform identities), exactly 1 row landed in `enr_tour_bookings` with `booked_by=NULL`, slot ended at `1/1`, zero `Race%` rows in `platform.iam_person`. Cleanup restored tenant to seed shape.

### CI parity

- `pnpm format:check` clean
- `pnpm lint:logs` clean (601 files)
- `pnpm --filter @campusos/api test`: **243/243 passing across 18 spec files** (54 P2-5 tests, +2 from Round 1)
- `pnpm --filter @campusos/api build` clean
- `pnpm --filter @campusos/web build` clean

## REVIEW-P2-5 ROUND 3 — closeout (PASS verdict)

Round 3 against `c5c87d7` returned **PASS**. Reviewer's per-finding verification table marks every prior blocker FIXED and confirmed every dimension score (Public Tours / Schema Compliance / Transactional Correctness / Identity-Privacy Model / Test Coverage / Prior P2-5 Blockers) at PASS.

One non-blocking documentation cleanup item flagged: the class-level legacy comment in `TourBookingService` still described the older ADR-055 flow where public booking creates/reuses `iam_person` and `platform_users`. The executable path was correct; only the JSDoc was stale. Closeout commit rewrites the class-level comment to describe the Option C no-platform-identity flow with the 7-step procedure (validate → lock → check capacity → INSERT booked_by=NULL → guests → bump → outbox), the rationale for choosing Option C ("two requests could both pass an unlocked pre-flight, both create fresh iam_person rows, then only one wins the locked capacity check — leaving the loser orphaned"), and the EO stitching path via `link-application`.

CI parity: format:check + lint:logs (601 files) + vitest 243/243 + API + web build all clean.

Tagged `p2c5-complete` at `c5c87d7` (the Round 2 fix that earned PASS) and `p2c5-approved` at the closeout commit. **Phase 2 Wave B (Pilot Enhancement) ships P2-5 clean — Wave B continues with the next cycle on the roadmap.**
