# REVIEW-P2-6-CHATGPT — Phase 2 Cycle 6 Payments Advanced

**Round 1 verdict**: REJECT — 4 BLOCKING + 4 MAJOR.
**Round 2 verdict (against `5f3ad04`)**: **PASS** — final gate
decision. Reviewer confirmed every prior blocker FIXED + every
dimension at PASS (Financial Aid / Billing Ops / Lunch Accounts /
Auto-Invoice Rules / Payment Allocation / Saved Payment Methods /
Test Coverage). One non-blocking hardening item carried to the
closeout commit.

**Closeout fix (Round 2 carry-forward, applied 2026-05-10)**:
`AutoInvoiceService` school-scoping cleanup. The Round 2 reviewer
flagged that `runGeneration()` loaded the fee schedule with
`WHERE id = $1::uuid` (no school predicate); `listRuns` and
`getRunById` used unscoped `WHERE 1=1` / `WHERE r.id = $1::uuid`;
the family-account lookup inside generation joined only on
`student_id`; and the existing-invoice duplicate check did not
join on `school_id`. All 5 paths now thread `getCurrentTenant().schoolId`
into the predicate:

- `listRuns` SELECT adds `WHERE r.school_id = $1::uuid`.
- `getRunById` SELECT adds `WHERE r.school_id = $1::uuid AND r.id = $2::uuid`
  (cross-school UUIDs collapse to 404).
- `runGeneration` fee-schedule lookup adds `WHERE school_id = $1::uuid AND id = $2::uuid`
  so the manual `generateFromFeeSchedule(crossSchoolFeeId)` admin path aborts
  BEFORE walking any students.
- Family-account lookup inside generation now JOINs `pay_family_accounts`
  on `school_id = $tenant.schoolId` so a leaked
  `pay_family_account_students` row cannot pull in a foreign-school
  family.
- Existing-invoice duplicate check JOINs `pay_invoices` on
  `school_id = $tenant.schoolId` so the dedup gate is school-scoped.

Test coverage: 295 → **297 passing across 19 spec files** (+2 new
regression tests pinning the new SQL shapes). CI parity green.

**Tagged**: `p2c6-complete` at `5f3ad04` (the Round 1 fix that earned
Round 2 PASS) and `p2c6-approved` at the closeout commit.

---

## Triage Table

| #   | Severity | Title                                                                    | Verdict        | Status |
| --- | -------- | ------------------------------------------------------------------------ | -------------- | ------ |
| 1   | BLOCKING | Financial-aid reads/writes not school-scoped                             | VALID          | FIXED  |
| 2   | BLOCKING | createApplication does not validate student/guardian/year against school | VALID          | FIXED  |
| 3   | BLOCKING | `pay.credit_note.issued` + `pay.payment.reversed` are best-effort emits  | VALID          | FIXED  |
| 4   | BLOCKING | `pay.lunch.low_balance` durability — alert-throttle hides Kafka failure  | VALID          | FIXED  |
| 5   | MAJOR    | Auto-invoice rules not school-scoped on list/get/update                  | VALID          | FIXED  |
| 6   | MAJOR    | Payment allocation does not validate invoice belongs to current school   | VALID          | FIXED  |
| 7   | MAJOR    | Saved payment method default-clear UPDATE missing school predicate       | VALID          | FIXED  |
| 8   | MAJOR    | (CAT live-output capture for sensitive cycles)                           | RECOMMENDATION | DEFER  |

---

## BLOCKING 1 — School-scope all financial-aid reads/writes

**Reviewer:** A school admin from school A could read/write financial
aid programmes/applications/awards in school B by guessing UUIDs
because every `WHERE id = $1::uuid` lookup omitted the `school_id`
predicate.

**Fix (commit XXXXX):** every read + write path on
`apps/api/src/payments/financial-aid.service.ts` now resolves
`getCurrentTenant().schoolId` and joins on `school_id`:

- `listPrograms` / `getProgramById` / `createProgram` / `patchProgram`
  — school predicate on every SELECT and UPDATE.
- `listApplications` / `getApplicationById` / `reviewApplication` —
  school predicate on every SELECT, FOR UPDATE lock, and UPDATE.
- `listAwardsForStudent` / `getAwardById` — school predicate on
  every SELECT.
- All cross-school UUIDs collapse to 404 (don't-leak-existence).

**Verification:** new regression test
`BLOCKING 1 — getProgramById carries school predicate (cross-school 404)`
captures the SQL and asserts every programme lookup includes
`school_id` and `id` predicates. New regression test
`BLOCKING 1 — listApplications carries school predicate` asserts
the FROM clause carries `school_id`.

---

## BLOCKING 2 — Validate student / guardian / academic_year against current school

**Reviewer:** `createApplication` accepted any `studentId`,
`academicYearId`, and guardian linkage by UUID without verifying
those rows belonged to the calling school. A parent from school A
could create a financial-aid application targeting a school-B
student.

**Fix (commit XXXXX):** `FinancialAidService.createApplication` now:

1. Validates `programId` exists in the calling school AND is active.
2. Validates `studentId` joins through `sis_students` with
   `school_id = $tenant.schoolId`.
3. Validates `academicYearId` joins through `sis_academic_years`
   with `school_id = $tenant.schoolId`.
4. Validates the guardian link via `sis_student_guardians + sis_guardians`
   with `school_id` predicate on both joined tables.

Any cross-school UUID returns a friendly 400 with the offending
field name in the message.

**Verification:** new regression test
`BLOCKING 2 — createApplication validates student against current school`
captures the SQL and asserts `sis_students` was queried with
`school_id`. The original cross-school student + cross-school
academic-year tests added in Round 1 also remain green.

---

## BLOCKING 3 — Durable outbox for `pay.credit_note.issued` + `pay.payment.reversed`

**Reviewer:** Both events were post-commit `KafkaProducerService.emit()`
calls. If the broker is down at the moment of emit, the GL entry
commits to the database but the event is silently dropped — Cycle 26
GLConsumer never books the matching journal batch. This is the same
fix-class the P2-4a payroll review demanded for `hr.payroll.processed`.

**Fix (commit XXXXX):** both services now use the durable outbox.

`apps/api/src/payments/credit-note.service.ts`:

- Constructor injects `OutboxService` instead of `KafkaProducerService`.
- New exported helper `deterministicCreditNoteEventId(creditNoteId)`
  produces a v5-shaped UUID via `sha1(creditNoteId + ':pay.credit_note.issued:v1')`.
  Same pattern as `deterministicPayrollEventId` from P2-4a.
- `issue()` writes the credit note + ledger entry + outbox envelope
  inside one tenant tx. The outbox row commits with the financial
  mutation — Kafka outage does not lose the event; the
  `OutboxPublisherWorker` retries until publish succeeds; consumer-side
  dedup on `event_id` catches redelivery.

`apps/api/src/payments/reversal.service.ts`:

- Identical pattern with `deterministicReversalEventId(reversalId)`.
- The invoice + payment FOR UPDATE locks are also school-scoped so a
  cross-school payment UUID collapses to 404 BEFORE the lock fires.
  (`payment.school_id !== schoolId` runtime check removed — the
  predicate is the access gate.)

**Verification:** updated unit tests (`CreditNoteService.issue` and
`ReversalService.reverse locks invoice FIRST then payment FOR UPDATE`)
now use the `makeOutbox()` stub. The tests assert the
`enqueueInTx(tx, opts)` contract: topic + sourceModule + payload +
v5-shaped deterministic event_id all flow through. New regression
tests pin the event_id determinism + v5 shape as standalone contracts.

---

## BLOCKING 4 — Durable `pay.lunch.low_balance` — outbox enqueue inside tx

**Reviewer:** `LunchAccountService.chargeMealFromConsumer` stamped
`last_low_balance_alert_at = now()` inside the tenant tx, then
emitted `pay.lunch.low_balance` post-commit via best-effort Kafka.
The throttle stamp committed even when the broker was unreachable
— a transient Kafka outage suppressed the alert for 24h with zero
retry, no audit, no DLQ.

**Fix (commit XXXXX):** alert throttle stamp + outbox enqueue commit
together.

`apps/api/src/payments/lunch-account.service.ts`:

- Constructor swaps `KafkaProducerService` for `OutboxService` (Kafka
  was the only producer dependency; the swap removes it cleanly).
- New helper `deterministicLowBalanceEventId(accountId, alertedAt)`
  produces a v5-shaped UUID via
  `sha1(accountId + ':' + alertedAt + ':pay.lunch.low_balance:v1')`
  so a redelivered `fds.meal.served` event that re-stamps the same
  throttle window produces the same id and consumer-side dedup
  catches it.
- Restructured `chargeMealFromConsumer`: when the balance crosses
  the threshold, the throttle UPDATE adds `RETURNING last_low_balance_alert_at::text`
  so the alerted-at timestamp is available inside the tx for the
  deterministic event_id. The student-name JOIN
  (`sis_students → platform_students → iam_person`) also runs
  inside the tx so the payload is built without leaving the tenant
  context. The `outbox.enqueueInTx(tx, ...)` call commits atomically
  with the throttle stamp.

**Verification:** the existing unit test was rewritten to use
`makeOutbox()` + assert all of: throttle was stamped, exactly one
outbox row enqueued, payload carries balance/threshold/studentName,
and the event_id matches the v5 UUID shape. New regression test
pins the determinism contract on `deterministicLowBalanceEventId`
standalone.

---

## MAJOR 5 — Auto-invoice rules not school-scoped on list/get/update

**Fix (commit XXXXX):** `apps/api/src/payments/auto-invoice.service.ts`
`listRules` / `getRuleById` / `updateRule` now thread
`getCurrentTenant().schoolId` into the predicate. `listRules` SELECT
adds `WHERE r.school_id = $1::uuid`. `getRuleById` SELECT adds
`WHERE r.school_id = $1::uuid AND r.id = $2::uuid` (don't-leak-existence
404 for cross-school UUIDs). `updateRule` UPDATE adds
`WHERE school_id = $X::uuid AND id = $Y::uuid` so a cross-school
admin cannot mutate a foreign rule even if they know the UUID.

---

## MAJOR 6 — Payment allocation does not validate invoice belongs to current school

**Fix (commit XXXXX):** `apps/api/src/payments/payment-allocation.service.ts`
`listForPayment` adds `WHERE a.school_id = $1::uuid AND a.payment_id = $2::uuid`.
`allocate()` payment FOR UPDATE lock and per-line invoice lookup
both carry the school predicate. The redundant runtime
`payment.school_id !== schoolId` check is removed — the predicate
is the access gate. A cross-school invoice UUID returns the same
friendly "Invoice X not found" message as a missing one
(don't-leak-existence).

---

## MAJOR 7 — Saved payment method default-clear UPDATE missing school predicate

**Fix (commit XXXXX):** `apps/api/src/payments/saved-payment-method.service.ts`:

- `listForFamily` SELECT adds `WHERE school_id = $1::uuid AND family_account_id = $2::uuid`.
- `getById` SELECT adds `WHERE school_id = $1::uuid AND id = $2::uuid`.
- `remove` soft-delete UPDATE adds the same predicate.
- `assertCanAccessFamily` SELECT adds the school predicate so a
  cross-school family UUID returns 404 even if the calling parent
  shares an iam_person between schools.
- The atomic clear-default UPDATE inside `create()` adds
  `WHERE school_id = $1::uuid AND family_account_id = $2::uuid AND is_default = true`
  so a cross-school admin cannot strip the default flag from a
  foreign-school family's primary card.

---

## MAJOR 8 — CAT live-output capture (RECOMMENDATION)

Carried to Phase 2 backlog as documentation-style improvement.

---

## Regression Tests Added

```
apps/api/src/payments/payments-advanced.spec.ts
  describe('REVIEW-P2-6 BLOCKING regressions')
    it('BLOCKING 1 — getProgramById carries school predicate')
    it('BLOCKING 1 — listApplications carries school predicate')
    it('BLOCKING 2 — createApplication validates student against current school')
    it('BLOCKING 3 — deterministicCreditNoteEventId is stable + v5-shaped')
    it('BLOCKING 3 — deterministicReversalEventId is stable + v5-shaped')
    it('BLOCKING 4 — deterministicLowBalanceEventId is stable + v5-shaped')
```

Plus the existing CreditNoteService / ReversalService / LunchAccountService
unit tests were rewritten to use the `makeOutbox()` stub so the
durable contract is locked in across the entire suite.

---

## CI Parity

- `pnpm format:check` — **clean** (621 files)
- `pnpm lint:logs` — **clean** (621 files)
- `pnpm --filter @campusos/api build` — **clean** (no TypeScript errors)
- `pnpm --filter @campusos/api test` — **295/295 passing** (was 289;
  +6 new regression tests pin the BLOCKING contract)
- `pnpm --filter @campusos/web build` — **clean**

---

## Round 2 Verdict — PASS

Reviewer cache-busted each affected file in code on Round 2 and
confirmed every fix matches the wording above. All 4 prior blockers
FIXED; every dimension scored PASS. One non-blocking hardening item
flagged (auto-invoice generation/run school-scoping) — addressed in
the closeout commit (see top of file).

**Tagged**:

- `p2c6-complete` at `5f3ad04` (Round 1 fix that earned Round 2 PASS)
- `p2c6-approved` at the closeout commit

Phase 2 Cycle 6 ships clean.
