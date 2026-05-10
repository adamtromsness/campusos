# P2C5 Review Notes — Schema decisions, deviations, edge cases, security

Auxiliary reading for the post-cycle architecture review of Phase 2 Cycle 5 (Enrolment Advanced). Companion to `HANDOFF-P2C5.md`.

---

## Schema decisions

### Migration numbering deviation

The plan called for migrations `106` + `107`, but those slots were taken by Cycle 6.1 polish (`106_inc_accountability.sql`) and Cycle 7 (`107_inc_drills.sql`). P2-5 used **119, 120, 121** following the established convention from Cycles 4–11 where plan-specified slots collide with already-applied migrations (precedent: P2C3 used `109` instead of plan's `101`; P2-4c used `116`/`117`/`118` instead of plan's `102`-onwards).

### Step 8 platform_tenant_configs deviation — tenant-scoped table instead

The plan called for storing the exit task template under `platform.platform_tenant_configs` keyed `withdrawal_exit_task_template`. **That platform table does not exist in the current schema** (verified via `\dt platform.*`). Decision: ship the template as a tenant-scoped table `enr_withdrawal_task_templates`. Rationale (documented inline in migration 121):

1. The data is per-school operational config (which department names a school assigns, which optional tasks it adds beyond the 7-task default). All other per-school operational config (fee schedules, bell schedules, dietary profiles, etc.) lives in tenant scope.
2. A future cross-school org-level default could lift this into platform scope without a service-side rewrite — the table would just gain a nullable `school_id` (NULL = org default) and the read path would COALESCE.
3. Adding a generic `platform_tenant_configs` k/v table for one feature would be a hammer-for-a-nail decision that future cycles would have to live with.

The CAT script + smoke verify the lazy-seeded baseline lands on first read, so a fresh tenant has a working withdrawal flow immediately.

### lazy-seed of DEFAULT template

`ExitTaskTemplateService.listActive('DEFAULT')` checks for active rows; if zero, it INSERTs the 7-task baseline + re-reads. This keeps the migration additive (no per-school INSERT in 121.sql) and makes the system work for any future tenant that lands without an explicit admin-side template configuration. The `ON CONFLICT DO NOTHING` on the lazy-seed loop handles the race where two requests for a fresh tenant land simultaneously.

### Multi-column lockstep CHECK convention

Same pattern as previous cycles (P2C3 telehealth `cancelled_chk`, P2C4c training `completed_chk`, etc.). The schema enforces the invariant the service is supposed to honour, so a manual SQL insert path or a future bug in the service still can't land a row in an inconsistent state. P2-5 uses this pattern on:

- `enr_tour_bookings.cancelled_chk` — CANCELLED ⇔ cancelled_at + cancellation_reason populated
- `enr_withdrawal_requests.completed_chk` — COMPLETED ⇔ completed_at + completed_by populated
- `enr_withdrawal_requests.hold_chk` — re_enrollment_hold_placed=true ⇔ re_enrollment_hold_reason populated
- `enr_withdrawal_exit_tasks.completed_chk` — COMPLETED/WAIVED ⇔ both audit fields, PENDING/NOT_APPLICABLE ⇔ neither
- `enr_reenrollment_confirmations.reason_chk` — confirmed_continuing=false ⇔ withdrawal_reason populated
- `enr_mid_year_admission_requests.capacity_chk` — capacity_available NOT NULL ⇔ capacity_checked_at + capacity_checked_by populated

Every multi-column CHECK was verified live — see live smoke transcript in HANDOFF-P2C5.md.

### Soft cross-schema refs per ADR-001/020

Following the project convention, every cross-schema reference is a soft UUID column with no DB-enforced FK:

- `enr_tour_slots.led_by` → `hr_employees(id)` is **DB-enforced** (intra-tenant) with `ON DELETE SET NULL`.
- `enr_tour_bookings.booked_by` → `platform.iam_person(id)` is **soft** (cross-schema).
- `enr_tour_bookings.linked_application_id` → `enr_applications(id)` is **DB-enforced** intra-tenant SET NULL.
- `enr_withdrawal_requests.requested_by` / `completed_by` → `platform.iam_person(id)` are **soft**.
- `enr_withdrawal_requests.student_id` → `sis_students(id)` is **DB-enforced** intra-tenant CASCADE.
- `enr_reenrollment_confirmations.submitted_by` / `processed_by` → `platform.iam_person(id)` are **soft**.
- `enr_reenrollment_confirmations.linked_withdrawal_id` → `enr_withdrawal_requests(id)` is **DB-enforced** intra-tenant SET NULL.
- `enr_mid_year_admission_requests.requested_by` / `capacity_checked_by` → `platform.iam_person(id)` are **soft**.
- `enr_mid_year_admission_requests.linked_application_id` → `enr_applications(id)` is **DB-enforced** intra-tenant SET NULL.

Service-layer validation matches: `MidYearAdmissionService.patch` validates `linkedApplicationId` against `enr_applications` in the calling school before write; `TourBookingService.linkApplication` does the same.

---

## Edge cases handled

### Capacity race protection

`TourBookingService.bookPublic` runs the entire booking inside `executeInTenantTransaction`:

1. `SELECT ... FROM enr_tour_slots WHERE school_id = $1 AND id = $2 FOR UPDATE` — locks the slot row.
2. Validates `is_published`, `is_cancelled`, and `current_bookings < max_bookings`.
3. INSERT booking + INSERT each guest + `UPDATE current_bookings = current_bookings + 1`.
4. `OutboxService.enqueueInTx` — outbox row written in same tx so a Kafka outage cannot roll back the booking.

The schema-side `current_chk` (`current_bookings <= max_bookings`) is the belt-and-braces against any direct-SQL bypass.

### Admin cancel decrements current_bookings

`TourBookingService.patch` flipping a CONFIRMED booking to CANCELLED:

1. Locks the booking row.
2. Decrements `enr_tour_slots.current_bookings` via `GREATEST(current_bookings - 1, 0)`.
3. Updates booking status + cancelled_at + reason.

The `GREATEST` clamp protects against a future double-cancel race (also there's the schema-side `current_bookings >= 0` CHECK).

### Cancelled bookings cannot be reactivated

`TourBookingService.patch` refuses any transition out of CANCELLED. Admins create a fresh booking instead. Documented in the JSDoc — keeps the audit clean.

### Re-enrolment hold blocks new confirmation submission

`ReenrolmentService.submit` calls `WithdrawalService.hasActiveHoldForStudent` before the INSERT. If a prior withdrawal placed a hold (`re_enrollment_hold_placed=true`), the parent submission is rejected with the canonical "contact admissions" message.

**Edge case not handled this cycle (carry-over):** a `confirmed_continuing=false` submission for a held student also auto-initiates a new withdrawal — but if the student is already withdrawn (the prior withdrawal is in COMPLETED status), this is conceptually fine because the new withdrawal layer represents the family closing out their record. Not a bug; documented.

### `confirmed_continuing=true` for a held student is correctly rejected

The hold check fires only on `confirmed_continuing=true` submissions (re-enrolment). A `confirmed_continuing=false` submission for a held student lands cleanly because the family is just confirming the existing departure — though the `WithdrawalService.create` call will create a NEW withdrawal row even though one may exist. Pre-pilot polish: dedupe by checking for an existing REQUESTED/IN_PROGRESS withdrawal for the same student.

### Withdrawal complete-gate is atomic

`WithdrawalService.complete`:

1. Locks the withdrawal row `FOR UPDATE`.
2. SELECT COUNT(\*) FROM exit_tasks WHERE status='PENDING' — runs in same tx as the lock so a concurrent task PATCH cannot slip past.
3. If pending > 0: throws `BadRequestException` with the count inlined.
4. UPDATE withdrawal SET status='COMPLETED', completed_at=now(), completed_by=$actor.
5. UPDATE sis_students SET enrollment_status='WITHDRAWN'.
6. Outbox enqueue `enr.student.withdrawn`.

All in same tx. The WAIVED/NOT_APPLICABLE statuses count as "resolved" — only PENDING blocks completion.

### Auto-initiated withdrawal carries the family narrative

When `ReenrolmentService.submit({confirmedContinuing:false, withdrawalReason: 'family relocating'})` lands, the auto-call to `WithdrawalService.create` passes:

```
{
  studentId,
  initiatedBy: 'FAMILY',
  requestedBy: actor.personId,
  withdrawalReasonCategory: 'OTHER',
  withdrawalReasonDetail: 'Auto-initiated from re-enrolment confirmation (confirmed_continuing=false). Family reason: ' + withdrawalReason,
  lastAttendanceDate: today,
}
```

So the new withdrawal record carries both the synthetic auto-initiated marker AND the family's actual reason text. Admin sees both on the detail page. Documented in `ReenrolmentService.submit`.

### Reenrolment + Withdrawal happen in separate logical scopes

The auto-withdrawal is created BEFORE the confirmation row is INSERTed (the `linkedWithdrawalId` is needed at INSERT time). They are **not** wrapped in a single tenant tx — the WithdrawalService opens its own. This means:

- If WithdrawalService.create succeeds but the confirmation INSERT fails (e.g. UNIQUE collision), the school ends up with an orphaned withdrawal in REQUESTED status.

Decision: accept this as a recoverable state. Admin can cancel the orphan withdrawal manually. The alternative (single tx across both services) would require either deeper service coupling or explicit tx passthrough — both reduce service-layer cleanliness for a low-likelihood failure mode (the only realistic UNIQUE collision is duplicate `(student, year)` which the parent-facing UI prevents by disabling the button).

Pre-pilot polish carry-over: detect the orphan-withdrawal case in ReenrolmentService.submit's catch block + cancel the just-created withdrawal before re-throwing.

---

## Security considerations

### Public booking endpoint (`POST /enrolment/tours/:slotId/book`) is unauthenticated

Per ADR-055 + the plan's vertical-slice contract, a prospective family can book without a CampusOS account. The endpoint:

- Requires the `X-Tenant-Subdomain` header (the public marketing site that hosts the booking page knows which school is being browsed). This is the existing project convention for public surfaces (matches `/api/v1/enrollment/search`).
- Creates an `iam_person` row with `person_type='GUARDIAN'` and a `platform_users` row with `account_status='PENDING_VERIFICATION'` if no existing user matches the contact email.
- Idempotent on email — re-booking with the same email reuses the existing iam_person.
- Has no rate limiting today. **Pre-pilot punch list:** add per-IP rate limiting to dodge spam booking abuse. The schema-side `enr_tour_bookings_slot_person_uq` UNIQUE prevents the same person re-booking the same slot.
- Has no captcha. Add as a Phase 3 ops item before pilot launches a public marketing surface.

### Parent row-scope on withdrawals + re-enrolment + mid-year requests

- `WithdrawalService.list` for non-admin non-staff actors filters via `student_id IN (SELECT s.id FROM sis_students s JOIN sis_student_guardians sg ON ... JOIN sis_guardians g ON g.person_id = $actor.personId)`.
- `WithdrawalService.create` for non-admin guardian actors calls `assertGuardianOfStudent` which runs the same join + checks ≥ 1 row exists.
- `ReenrolmentService.submit` calls the same guardian check; `list` row-scopes to `submitted_by = me` for non-admin non-staff.
- `MidYearAdmissionService.list` for non-admin non-staff filters `requested_by = me`.

A parent cannot withdraw, re-enrol, or apply mid-year on behalf of a child not linked to them via `sis_student_guardians`. Verified live in smoke (parent David Chen sees Maya's withdrawal but not Sofia's; parent attempt to withdraw Aiden returns 403).

### Admin scope vs Staff personType

`hasAdminScope` resolves via `actor.isSchoolAdmin || hasAnyPermissionInTenant(...['stu-004:admin'])`. Generic Staff with stu-004:write does NOT pass admin. Tested in `WithdrawalService` complete + placeReenrolHold + cancel + ExitTaskTemplateService.upsert.

### FERPA-adjacent fields handled

- `enr_withdrawal_requests.records_release_consented` — boolean flag the parent sets at submission. Not yet used to gate a records transfer (which is a Phase 3 item once the records-package generator ships).
- `enr_withdrawal_requests.destination_school_name` + `destination_school_country` — persisted for the audit. No external API calls.
- Tour booking guests' age + name — no PII concerns since the prospective family supplies them voluntarily; the schema captures `age` to plan the tour, not to track minors per se.

### Outbox emits include tenant_id

Both `enr.tour.booked` and `enr.student.withdrawn` are written to `platform.platform_outbox` with `tenant_id` populated from `getCurrentTenant().schoolId`. The `OutboxPublisherWorker` carries the subdomain through the Kafka header so consumers can re-enter the right tenant context.

### `sis_students.enrollment_status` flip is irreversible from this surface

Once a withdrawal is COMPLETED, the student is marked WITHDRAWN. Reverting requires direct SQL or a dedicated re-enrolment workflow. The schema's `enrollment_status_chk` only allows ENROLLED/TRANSFERRED/GRADUATED/WITHDRAWN. Documented in HANDOFF-P2C5.md cleanup steps.

---

## Performance notes

### Tour slot listing — partial INDEX on the public hot path

`enr_tour_slots_published_idx ON (school_id, tour_date, start_time) WHERE is_published=true AND is_cancelled=false` keeps the public browse query fast even as the slot table grows over multiple years. EXPLAIN confirms the planner picks the partial index for the public listPublic predicate.

### Withdrawal list with parent row scope

The parent-row-scoped query joins through 3 tables (`sis_students JOIN sis_student_guardians JOIN sis_guardians`). Indexes on the join columns exist from prior cycles (Cycle 1 SIS). Tested with the seed at ~10 students per parent — sub-millisecond. At 100 children per family the query is still cheap.

### Exit task summary computation in DTO

`WithdrawalResponseDto.exitTaskSummary` is computed in JS from the inlined `exitTasks` array (4 array filters). Per-row cost is bounded by the template size (7 tasks default; max ~20 in practice). For a queue of 100 withdrawals this is 100 × 7 × 4 = 2800 array passes — trivial. If this ever shows up in the profile, the schema-side counters (already on `enr_capacity_summary` for the parallel use case) are an option.

### Per-(student, year) UNIQUE on re-enrolment

`UNIQUE(student_id, academic_year_id)` on `enr_reenrollment_confirmations`. The schema-side UNIQUE catches the rare race where two parent submissions for the same (student, year) hit the API simultaneously. The service translates to a friendly 400.

### Outbox row size

Each `enr.tour.booked` envelope is ~400 bytes JSON. `enr.student.withdrawn` is similar. Volume is modest (tour bookings: ~10/day per school in steady state; withdrawals: ~30/year per school). Will not stress the outbox.

---

## Test coverage analysis

41 tests across 7 services + 5 controllers + the metadata-gate suite. Coverage:

| Surface             | Services tested                                                                | Negative paths                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TourSlot            | listPublic, create (admin gate, time validation, UNIQUE catch)                 | Forbidden non-admin, BadRequest endTime <= startTime, BadRequest UNIQUE collision                                                                        |
| TourBooking         | bookPublic (locked + outbox + ADR-055), patch (cancellation), link             | NotFound missing slot, BadRequest unpublished + cancelled, Conflict full slot, BadRequest reason missing on cancel, BadRequest application not in school |
| Withdrawal          | list, create, complete, cancel, placeReenrolHold                               | Forbidden non-guardian, BadRequest no template, BadRequest pending tasks, BadRequest hold without reason, Forbidden non-admin                            |
| ExitTask            | patch with completion semantics + parent transition                            | BadRequest closed parent, Forbidden no scope                                                                                                             |
| Reenrolment         | submit (with continuing + reason validation + hold check)                      | BadRequest mismatched continuing/reason, BadRequest hold blocks resub                                                                                    |
| MidYear             | list (parent scope), patch (admin gate + linkedApplication validation), submit | Forbidden parent patch, BadRequest cross-school application                                                                                              |
| ExitTaskTemplate    | listActive (lazy-seed), upsert                                                 | Forbidden non-admin upsert                                                                                                                               |
| Controller metadata | All 5 controllers — every method's @RequirePermission decorator                | Catches accidental gate downgrades                                                                                                                       |

Live verified end-to-end in `tenant_demo` smoke session — see HANDOFF-P2C5.md.

Coverage gaps acknowledged:

- `TourBookingService.getById` row scope (booking owner can read own — tested in service code, not in vitest).
- `WithdrawalService.list` pagination beyond LIMIT 500 (no scenario exercises >500 rows in test data).
- `WithdrawalService.cancel` for original requester (admin path tested; original-requester path is service-layer logic but not yet a vitest scenario).
- `MidYearAdmissionService.patch` partial-PATCH path (capacityAvailable + status combined update path tested implicitly via the service contract; explicit per-field test would clarify).

---

## Bug fixed during smoke

`OutboxService.enqueueInTx` had a **missing `::uuid` cast** on the `tenant_id` parameter (`$5`). The INSERT INTO `platform.platform_outbox` failed with `42804: column "tenant_id" is of type uuid but expression is of type text` for every emit from a tenant-scoped service. The fix added `::uuid` to `$5` and lives at `apps/api/src/kafka/outbox.service.ts:112`.

This was a **latent bug** — every prior cycle that called `enqueueInTx` (P2-4a payroll, P2-4b recruitment, P2-4c training, governance breach service, emergency-alert service) would have hit it on the first live emit but evidently never did under conditions that exercised the path. Cycles that rely on outbox emits should be re-verified live before pilot.

---

## Wave B opens here

P2-5 closes Wave A's "missing book-end" by giving the admissions office a complete lifecycle from first tour visit to final withdrawal. Wave B continues with the remaining `.1` cycles for cross-cutting concerns (analytics expansion, deeper governance, pre-pilot operational hardening). The roadmap calls for ~3 more cycles before the pilot-readiness pre-flight review.
