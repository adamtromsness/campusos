# Cycle 6 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Scope:** Full Cycle 6 (Enrollment & Payments — `enr_*` schema in Steps 1+2, `pay_*` schema in Steps 3+4, seeds in Step 5, `EnrollmentModule` + `PaymentsModule` + `PaymentAccountWorker` in Steps 6+7, admin admissions UI in Step 8, parent application UI in Step 9, billing admin UI in Step 10, parent billing UI in Step 11, vertical-slice CAT in Step 12). The reviewer's brief was scoped beyond Cycle 6 and includes accumulated issues from prior cycles.
**Round 1 SHA under review:** `f7db6a5` (Cycle 6 COMPLETE through Step 12 + prettier formatting pass)
**Round 1 verdict:** **REJECT** — pending 8 actionable fixes (mix of BLOCKING + MAJOR)
**Round 2 SHA under review:** `64993a8` (REVIEW-CYCLE6 fix commit)
**Final verdict:** **APPROVED** at `64993a8` (April 29, 2026)

**Verdict trail:**

| Round | Date           | SHA       | Verdict                                                                          |
| ----: | -------------- | --------- | -------------------------------------------------------------------------------- |
|     1 | April 29, 2026 | `f7db6a5` | REJECT pending 8 actionable fixes (3 WRONG · 5 ACCEPTED-DEVIATION · 8 VALID-fix) |
|     2 | April 29, 2026 | `64993a8` | **APPROVED** — all 8 fixes confirmed; accepted deviations remain Phase 2         |

---

## Round 1 — Result: 8 VALID-fix · 3 WRONG · 5 ACCEPTED-DEVIATION

The reviewer flagged 9 critical/blocking issues + 7 majors. Ground-truthing each finding against `f7db6a5`:

- **3 of the BLOCKING claims are wrong** — the reviewer appears to have read stale or unrelated code.
- **5 are valid bugs that must land in Round 2** (issues 3, 4, 6, 7, 8, 9 from the brief — the gradebook leak, attendance read-side mutation, two financial-invariant bugs in invoice/refund, the generate-from-schedule double-bill race, and the capacity recompute race).
- **3 majors are valid bugs** (10 the offer-issued event payload bug, 11 the account-number race, 12 the tenant-resolver doc mismatch).
- **5 are accepted DEVIATIONs** that are forward-looking, already on the Phase 2 punch list, or re-litigate previously-approved ADRs.

### Triage table

|   # | Reviewer's claim                                                    | Triage (Claude)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --: | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | `ResolvedActor` no longer includes `employeeId`                     | **WRONG.** `apps/api/src/iam/actor-context.service.ts:25` — `employeeId: string \| null` is on the interface; `resolveActor` populates it via `resolveEmployeeId()`; staff services already consume `actor.employeeId`. The reviewer read a stale file.                                                                                                                                                                                                                                                                                    |
|   2 | Kafka consumers swallow handler failures                            | **WRONG.** `apps/api/src/kafka/kafka-consumer.service.ts` — REVIEW-CYCLE3 BLOCKING 1 already fixed this (rethrow + per-message attempts map + DLQ to `platform.platform_dlq_messages` after `MAX_HANDLER_ATTEMPTS=5`). The current code at lines 192–222 implements the at-least-once retry → DLQ contract the reviewer asked for.                                                                                                                                                                                                         |
|   3 | `GET /classes/:id/attendance/:date` is under-scoped + mutates state | **VALID — BLOCKING.** `apps/api/src/attendance/attendance.controller.ts:51-63` does NOT pass `actor` and does not check class visibility. `att-001:read` is held by parents and students; the service can write `PRESENT/PRE_POPULATED` rows when `period` is passed. A parent or student could probe arbitrary class attendance and trigger writes.                                                                                                                                                                                       |
|   4 | Teacher student-gradebook can leak grades from other classes        | **VALID — BLOCKING.** `gradebook.service.ts::getStudentGradebook` (line 206) calls `assertCanViewStudent` which authorises a STAFF caller if they teach **any** class for the student, then returns gradebook rows for **all** the student's active enrollments. A teacher who only teaches the student's Math class can see Science class snapshots.                                                                                                                                                                                      |
|   5 | StudentService visibility uses `personId` for STAFF                 | **WRONG.** `sis/student.service.ts:117` — STAFF branch correctly binds `actor.employeeId` against `ct.teacher_employee_id`. Cycle 4 Step 0 already migrated this to the bridged column.                                                                                                                                                                                                                                                                                                                                                    |
|   6 | Invoice cancellation leaves ledger balance wrong                    | **VALID — BLOCKING.** `payments/invoice.service.ts::cancel()` allows cancelling SENT/PARTIAL invoices but never writes a compensating ADJUSTMENT entry. The CHARGE that landed at SENT time stays in the ledger; the family balance reads inflated. The code's existing comment ("future ADJUSTMENT entries are the correction mechanism") is not enough — there's no automation that corrects the balance.                                                                                                                                |
|   7 | Refunds don't reconcile invoice paid status / amount                | **VALID — BLOCKING.** `SELECT_INVOICE_BASE` (line 98) computes `amount_paid` as `SUM(amount) WHERE pay_payments.status = 'COMPLETED'`. Partial refunds leave the payment at COMPLETED (per design), so `amount_paid` does not decrease and `balance_due` reads $0 even after a refund put $50 back on the ledger. The invoice status/balance disagrees with the ledger.                                                                                                                                                                    |
|   8 | `generateFromSchedule()` can double-bill under concurrency          | **VALID — BLOCKING.** `payments/invoice.service.ts::generateFromSchedule` reads the existence-check (lines 410–418) outside the per-family transaction (lines 427–454). Two simultaneous calls can both pass the check and both INSERT a DRAFT invoice for the same `(family_account_id, fee_schedule_id)`. There's no DB UNIQUE on that pair.                                                                                                                                                                                             |
|   9 | Capacity summary recompute has a lost-update race                   | **VALID — MAJOR.** `enrollment/capacity-summary.service.ts::recompute` aggregates source rows then UPSERTs with no lock. Two concurrent transitions for the same `(period, grade)` (e.g. one accept + one withdraw) can each compute from a partial snapshot, then last writer wins. Mitigation: `pg_advisory_xact_lock` keyed on `(period_id, grade)` at the top of `recompute`.                                                                                                                                                          |
|  10 | Offer issued event has the wrong `guardianPersonId`                 | **VALID — MAJOR.** `enrollment/offer.service.ts:205` literally does `guardianPersonId: dto.familyResponse` — copy-paste bug. The OfferDto doesn't expose `guardianPersonId` either; the service has to read it off the underlying application row.                                                                                                                                                                                                                                                                                         |
|  11 | Payment account number allocation is race-prone + name-link weak    | **PARTIAL VALID — MAJOR.** `payments/consumers/payment-account.consumer.ts::nextAccountNumber` does `MAX(num)+1` inside the tx, but the schema's `UNIQUE(school_id, account_number)` means two concurrent enrolments can both read MAX, both INSERT FA-1002, and one fails 23505. The current code does not retry. The name-based `sis_students` link is a known design decision documented in CLAUDE.md as Phase 2 punch (the future EnrollmentConfirmedWorker materialises `sis_students` from `enr_applications`); accept as DEVIATION. |
|  12 | Tenant resolver doc and behavior misaligned                         | **VALID — MINOR.** `tenant/tenant-resolver.middleware.ts:11` JSDoc says "X-Tenant-ID header (for service-to-service calls only)" but the implementation reads `X-Tenant-Subdomain`. Comment fix only; the dev-time header gating is a separate hardening ask we can defer.                                                                                                                                                                                                                                                                 |
|  13 | Consumer tenant routing trusts event headers                        | **ACCEPTED DEVIATION.** Already on the Phase 2 punch list — REVIEW-CYCLE5 MAJOR 1. The fix lives in `notification-consumer-base.ts::unwrapEnvelope` and applies to every consumer in the system, not just Cycle 6.                                                                                                                                                                                                                                                                                                                         |
|  14 | Platform/internal v11 endpoints need a non-tenant permission mode   | **DEVIATION — forward-looking.** No v11 internal-ops endpoints exist yet. This is a future-cycle concern; nothing in the current codebase needs the change.                                                                                                                                                                                                                                                                                                                                                                                |
|  15 | Ledger immutability is service-side only                            | **ACCEPTED DEVIATION.** ADR-010 explicitly says "service-side discipline, no DB trigger / revoke per the plan" — the immutability is part of the convention, not a missing constraint. Hardening to a row-level revoke + before-update trigger could land as a Phase 2 defence-in-depth item.                                                                                                                                                                                                                                              |
|  16 | Event publishing is not transactional / outbox                      | **ACCEPTED DEVIATION.** Already on the Phase 2 punch list — REVIEW-CYCLE5 MAJOR 2. Future cycles that need exactly-once delivery (e.g. payment + Stripe charge + downstream consumer) would adopt the outbox pattern; current consumers are tolerant of best-effort emit.                                                                                                                                                                                                                                                                  |

---

## Strong passes

These are still solid in `f7db6a5`:

- Tenant execution still uses interactive transaction + `SET LOCAL search_path` (REVIEW-CYCLE1 fix preserved).
- ADR-057 envelope is intact in `KafkaProducerService.emit`.
- Notification delivery is `PENDING → PROCESSING → SENT` with retry/backoff (REVIEW-CYCLE3 BLOCKING 2 fix preserved).
- HR leave + room booking + room change request locking is in place from prior cycles.
- App module registration is broadly intact and Cycle 6 modules are wired between `SchedulingModule` and `NotificationsModule`.
- `OfferService.respond` correctly locks both `enr_offers` AND `enr_applications` `FOR UPDATE OF o, a` in the same tx (Cycle 5 review carry-over honoured).
- `InvoiceService.send`, `PaymentService.pay`, `RefundService.issue` all `SELECT … FOR UPDATE` inside `executeInTenantTransaction`.
- `EnrollmentPeriodService` admin writes lock the row before window CHECK re-validation.

---

## Fix priority order (Round 1)

| Priority | Finding                                               | Risk                                                                                                                              | Effort                                                                                   |
| -------: | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
|    🔴 P0 | Issue 3 — Class attendance read leaks + writes        | Parents / students probe arbitrary class attendance; lazy writes fire                                                             | Small (pass actor + assertCanReadClassAttendance; only prepopulate if write-capable)     |
|    🔴 P0 | Issue 4 — Gradebook student view leaks across classes | Teacher of one class sees another teacher's grades                                                                                | Small (filter classes to the teacher's assigned set unless admin)                        |
|    🔴 P0 | Issue 6 — Invoice cancel doesn't reverse ledger       | Family balance permanently inflated after cancelling SENT/PARTIAL                                                                 | Small (write compensating ADJUSTMENT entry inside cancel tx for outstanding balance)     |
|    🔴 P0 | Issue 7 — Refund leaves invoice status stale          | Invoice reads `PAID` after partial refund; UI/parent see stale 0 balance                                                          | Small (recompute invoice status from ledger sum, not just COMPLETED payments)            |
|    🔴 P0 | Issue 8 — generate-from-schedule double-bill          | Two simultaneous bulk-generates create duplicate DRAFT invoices                                                                   | Small (advisory lock per `(family_account_id, fee_schedule_id)` + in-tx existence check) |
|    🟠 P1 | Issue 9 — Capacity recompute lost-update race         | Last-writer-wins on parallel transitions for same (period, grade)                                                                 | Small (pg_advisory_xact_lock at the top of `recompute`)                                  |
|    🟠 P1 | Issue 10 — Offer issued event payload bug             | Downstream consumers receive `dto.familyResponse` instead of `guardianPersonId` (currently no consumer for this event, so latent) | Trivial (replace `dto.familyResponse` with the application's `guardian_person_id`)       |
|    🟠 P1 | Issue 11 — Account number allocation race             | Concurrent enrolments can fail with raw 23505                                                                                     | Small (catch 23505 on family-account INSERT and retry the MAX+1 lookup)                  |
|    🟡 P2 | Issue 12 — Tenant resolver JSDoc mismatch             | Misleading docs; no runtime impact                                                                                                | Trivial (comment text only)                                                              |
|     ⚪ — | Issues 1, 2, 5                                        | Invalid claims; nothing to fix                                                                                                    | Document the verdict in this review and move on                                          |
|     ⚪ — | Issues 13, 15, 16                                     | Already accepted deviations; Phase 2 hardening                                                                                    | No code change                                                                           |
|     ⚪ — | Issue 14                                              | Forward-looking; v11 platform endpoints don't exist yet                                                                           | No code change                                                                           |

---

## Gate decision (Round 1)

**REJECT pending fixes.**

Eight code fixes are required (issues 3, 4, 6, 7, 8, 9, 10, 11) plus one comment fix (issue 12). The wrong claims (1, 2, 5) and the accepted deviations (13–16) are documented above and will not change in Round 2.

---

## Round 2 — Fixes applied

All 8 actionable findings landed in a single commit. The 3 wrong claims (1, 2, 5) are documented above and required no code change. The 5 accepted-DEVIATION items (13–16) remain on the Phase 2 punch list.

### Fix 3 — Class attendance read row scope + manager-only prepopulate (BLOCKING)

**Files:** `apps/api/src/attendance/attendance.controller.ts` and `apps/api/src/attendance/attendance.service.ts`

`GET /classes/:id/attendance/:date` now resolves the actor and passes it through. `getClassAttendance(classId, date, period, actor)` runs two new gates:

1. `canReadClassAttendance(classId, actor)` — admin → existence-check; STAFF → must appear in `sis_class_teachers`; STUDENT → must have an active enrollment; GUARDIAN → must have a linked child with an active enrollment. Failure → `404 Not Found` (collapsed from 403 to avoid id-probing).
2. `canWriteClassAttendance(classId, actor)` — admin OR STAFF in `sis_class_teachers`. Only callers passing this gate can fire the lazy `PRESENT/PRE_POPULATED` writes; everyone else gets read-only access.

The response is filtered for non-managers: STUDENT only sees their own attendance row, GUARDIAN only sees their linked children's. Managers (admin / class teacher) still see the full roster.

**Verified live (2026-04-29) on `tenant_demo`:**

- Setup: teacher prepopulated Period 1 of Maya's Algebra class on 2026-08-22 → 8-row roster materialised.
- Fix 3.1 (replay): parent (David Chen) on Maya's class returns **1 row** (`Maya Chen PRESENT`) — was previously the full 8-row roster.
- Fix 3.3 (replay): student (Maya) on own class returns **1 row** — was previously the full roster.
- Fix 3.2: parent on a class Maya is not enrolled in → `HTTP 404 — Class … not found`.
- Fix 3.4: student on a class she is not enrolled in → `HTTP 404`.
- Fix 3.5: parent passing `?period=1` against a fresh date → 0 rows before, 0 rows after — parent **did not** trigger prepopulate.
- Fix 3.6: teacher passing `?period=1` against a fresh date → 0 → 8 rows — teacher **did** trigger prepopulate.
- Manager full-roster view (additional check): teacher sees 8 rows.

Cleanup deleted the 8 PRE_POPULATED smoke rows.

### Fix 4 — Gradebook student view filters classes to teacher's assigned set (BLOCKING)

**File:** `apps/api/src/classroom/gradebook.service.ts` — `getStudentGradebook()`

`assertCanViewStudent` already authorised a STAFF caller if they teach **any** class for the student. Now the response itself filters the student's active classes to ones the teacher is assigned to (via `sis_class_teachers.teacher_employee_id = $actor.employeeId`). Admins still see everything; students/parents continue to see the student's full set; only the STAFF branch narrows.

**Verified live (2026-04-29) on `tenant_demo`:**

- Pre-state: Rivera taught all 4 of Maya's active classes (Algebra 1 / English 9 / Biology / World History).
- Fix 4.2 (admin): `GET /students/{Maya}/gradebook` → **4 classes** (Algebra 1, English 9, Biology, World History).
- Fix 4.3 (Rivera teaching all 4): teacher view returns **4 classes** (unchanged — Rivera teaches all of them).
- Smoke setup: stripped Rivera from 5 of 6 of his class assignments (kept only Algebra 1).
- Fix 4.5 (Rivera scoped): teacher view of Maya's gradebook now returns **1 class** (Algebra 1 only) — would previously have returned all 4.
- Fix 4.6 (admin still 4): admin view unchanged at 4.

Cleanup re-inserted Rivera on the 5 stripped classes — `sis_class_teachers` count restored to 6.

### Fix 6 — Invoice cancel writes compensating ADJUSTMENT entry (BLOCKING)

**File:** `apps/api/src/payments/invoice.service.ts` — `cancel()`

For invoices that have already passed DRAFT (i.e. a CHARGE entry hit the ledger at SENT time), `cancel()` now writes a compensating `ADJUSTMENT` ledger entry equal to `-(total - sum(completed payments))` inside the same tx that flips status to CANCELLED. DRAFT invoices skip the adjustment because no CHARGE has been written yet.

**Verified live (2026-04-29) on `tenant_demo`:**

- Pre-state: FA-1001 ledger SUM = $400 (CHARGE +$12k, PAYMENT -$12k, CHARGE +$400). Tech Fee 2026 invoice SENT, total $400, no payments. `/family-accounts/{id}/balance` returns `$400`.
- Admin cancels Tech Fee invoice → invoice status = CANCELLED + ledger ADJUSTMENT -$400 lands.
- `/family-accounts/{id}/balance` now returns `$0` — family is no longer billed for the cancelled SENT invoice.
- Ledger entries (newest first): `ADJUSTMENT -400 invoice cancelled — reversing outstanding $400.00 / CHARGE +400 / PAYMENT -12000 / CHARGE +12000`.

Cleanup reverted the cancel + dropped the ADJUSTMENT entry — final ledger SUM restored to $400.

### Fix 7 — Refund nets out invoice paid + reconciles invoice status (BLOCKING)

**Files:** `apps/api/src/payments/invoice.service.ts` (read-side `INVOICE_AMOUNT_PAID_SQL`), `apps/api/src/payments/payment.service.ts` (overpay check), `apps/api/src/payments/refund.service.ts` (status reconcile after refund).

The shared `amount_paid` formula is now:

```sql
COALESCE(SUM(p.amount) FROM pay_payments p WHERE invoice_id = i.id AND status IN ('COMPLETED','REFUNDED'), 0)
- COALESCE(SUM(r.amount) FROM pay_refunds r JOIN pay_payments p2 ON p2.id = r.payment_id WHERE p2.invoice_id = i.id AND r.status = 'COMPLETED', 0)
```

This includes REFUNDED payments in the inflow sum (so a fully-refunded payment still contributes its original value once) and subtracts COMPLETED refunds. Net behaviour:

- Payment $200 COMPLETED, no refund → paid = $200.
- Payment $200 COMPLETED + $50 partial refund (payment stays COMPLETED) → paid = $150.
- Payment $200 fully refunded (payment flips REFUNDED, refund COMPLETED $200) → paid = $0.

`RefundService.issue` also now locks the parent invoice **before** the payment row (matches `PaymentService.pay`'s lock order to avoid deadlock with concurrent pay+refund), and after the ledger write recomputes the invoice status using the same formula: `PAID` ↔ `PARTIAL` ↔ `SENT` based on the post-refund net paid. DRAFT and CANCELLED invoices are never re-flipped.

**Verified live (2026-04-29) on `tenant_demo`:**

- Step 1: parent pays Tech Fee $400 in full → invoice flips SENT→PAID, balanceDue=$0.
- Step 2: admin issues a $50 GOODWILL refund.
- Step 3: invoice now reads `status=PARTIAL  total=400  paid=350  balanceDue=50` — would previously have stayed `PAID  paid=400  balanceDue=0`.
- Step 4: ledger SUM = $50 (CHARGE +400, PAYMENT -400, REFUND +50). Family-account balance now $50.
- Step 5: parent pays the restored $50 balance → 201 (would previously have 400'd as "Invoice is already PAID").
- Step 6: invoice flips back to PAID with balanceDue=0.

Cleanup restored seed state ($400 ledger sum, Tech Fee SENT, no payments / refunds).

### Fix 8 — Generate-from-schedule advisory lock + in-tx existence check (BLOCKING)

**File:** `apps/api/src/payments/invoice.service.ts` — `generateFromSchedule()`

Each per-family invoice insert now runs inside `executeInTenantTransaction`, takes a `pg_advisory_xact_lock` keyed on `('pay_invoices_generate:' || family_account_id || ':' || fee_schedule_id)` at the top of the tx, and re-runs the existence check inside the lock. Two simultaneous bulk-generates targeting the same fee schedule serialise on the lock; the second tx re-reads the existence row, sees the first's invoice, and bumps `skipped` instead of inserting a duplicate.

**Verified live (2026-04-29) on `tenant_demo`:**

- Setup: picked Activity Fee schedule (no existing non-CANCELLED invoices referencing it).
- 5 parallel `POST /invoices/generate-from-schedule` calls fired against FA-1001.
- Results: exactly **one** call returned `created=1 skipped=0`; the other **four** returned `created=0 skipped=1`.
- `pay_invoices` now has exactly **1** non-CANCELLED invoice referencing the Activity Fee schedule.

Cleanup dropped the 1 winner invoice + line items.

### Fix 9 — Capacity recompute advisory lock (MAJOR)

**File:** `apps/api/src/enrollment/capacity-summary.service.ts` — `recompute()`

A `pg_advisory_xact_lock` keyed on `('enr_capacity_summary:' || period_id || ':' || grade_level)` is taken at the top of the recompute. Concurrent transitions for the same `(period, grade)` (e.g. one ACCEPT + one WITHDRAW arriving in parallel) now serialise; the schema's `UNIQUE(enrollment_period_id, grade_level)` on `enr_capacity_summary` is the belt-and-braces.

**Verified (2026-04-29):**

- Build artifact contains the new SQL: `grep pg_advisory_xact_lock dist/enrollment/capacity-summary.service.js` → 1 hit.
- Functional sanity: a SUBMITTED→UNDER_REVIEW transition on Aiden re-runs `recompute` and lands `applications_received=3` for Grade 9 (correct — Aiden + Maya + Olivia). Cleanup reverted Aiden + reset capacity_summary to seed shape.

The lock contention path (two concurrent transitions racing) is non-trivial to assert in a single-tenant smoke without bespoke fixtures; the lock guarantees serialisation and the schema guarantees one row per (period, grade), so a successful recompute proves the path is intact.

### Fix 10 — Offer issued event payload reads `guardian_person_id` from the locked application (MAJOR)

**File:** `apps/api/src/enrollment/offer.service.ts` — `issue()`

Previously emitted `guardianPersonId: dto.familyResponse` — a copy-paste bug (the field is for the parent's accept/decline answer, which is null on a fresh ISSUED offer). Fixed to read the application's `guardian_person_id` directly from the locked snapshot returned by the inner transaction.

**Verified live (2026-04-29) on `tenant_demo`:**

- Setup: temporarily set Aiden's `enr_applications.guardian_person_id` to David Chen's iam_person.id.
- Admin transitions Aiden SUBMITTED→UNDER_REVIEW→ACCEPTED, then issues an UNCONDITIONAL offer.
- Captured the wire envelope on `dev.enr.offer.issued` via `kafka-console-consumer.sh --from-beginning`.
- Latest envelope payload shows `"guardianPersonId":"019dc92d-088c-7442-abf6-0134867d2d92"` — David Chen's id (correct), studentFirstName=Aiden, applyingForGrade=9.
- Pre-fix this field would have been `null` (familyResponse on a fresh ISSUED offer).

Cleanup deleted the smoke offer + reverted Aiden to SUBMITTED + reset Grade 9 capacity_summary to seed shape.

### Fix 11 — Account number allocation advisory lock (MAJOR)

**File:** `apps/api/src/payments/consumers/payment-account.consumer.ts` — `createOrLinkAccount()`

Before computing the next `FA-####` account number via `MAX(account_number)+1`, the worker now takes a per-school `pg_advisory_xact_lock` keyed on `('pay_family_accounts:' || schoolId)`. Two concurrent enrolment events for the same school serialise on the lock; the schema's `UNIQUE(school_id, account_number)` is the belt-and-braces. This closes the documented race where two transactions both read MAX, both compute FA-1002, and one fails with raw 23505.

The reviewer also flagged that `sis_students` linking is name-based — that's a known Cycle 6 design decision documented in CLAUDE.md and HANDOFF-CYCLE6.md as the future EnrollmentConfirmedWorker's scope (Phase 2). Accepted as DEVIATION.

**Verified:** build artifact contains the new SQL — `grep pg_advisory_xact_lock dist/payments/consumers/payment-account.consumer.js` → 1 hit. Functional sanity: the existing CAT smoke (S6 keystone — parent ACCEPTs offer → PaymentAccountWorker reaction) still passes; the lock is invisible on the happy path.

### Fix 12 — Tenant resolver JSDoc rewritten (MINOR)

**File:** `apps/api/src/tenant/tenant-resolver.middleware.ts`

Block comment rewritten to accurately describe what the middleware does today: header-first (`X-Tenant-Subdomain`) then hostname's first DNS segment, with a Phase 2 note that header-based override should eventually be tightened to dev/test-only.

### Wrong claims — no code change

- **Issue 1** (`ResolvedActor` missing `employeeId`): the field is on the interface (line 25) and populated by `resolveActor` via `resolveEmployeeId`. Multiple staff services already consume `actor.employeeId`. No change required.
- **Issue 2** (Kafka consumers swallow handler failures): REVIEW-CYCLE3 BLOCKING 1 already implemented the rethrow + per-message attempts map + DLQ-after-MAX_HANDLER_ATTEMPTS pattern. The fix lives in `kafka-consumer.service.ts` lines 192–222 and was independently verified by the Round 2 of REVIEW-CYCLE3. No change required.
- **Issue 5** (StudentService visibility uses `personId` for STAFF): the `visibilityClause` STAFF branch correctly binds `actor.employeeId` against `sis_class_teachers.teacher_employee_id` (line 117). Cycle 4 Step 0 migrated this to the bridged column. No change required.

### Accepted DEVIATIONs — Phase 2 punch list

- **Issue 13** (Consumer envelope tenant validation): already on the punch list — REVIEW-CYCLE5 MAJOR 1. Affects every consumer; hardening lives in `notification-consumer-base.ts::unwrapEnvelope`.
- **Issue 14** (Platform/internal v11 endpoints): forward-looking — no v11 endpoints exist yet. Not a current bug.
- **Issue 15** (Ledger immutability is service-side only): ADR-010 explicit choice. Optional Phase 2 hardening adds a `BEFORE UPDATE/DELETE` trigger on `pay_ledger_entries` partitions.
- **Issue 16** (Outbox pattern for events): already on the punch list — REVIEW-CYCLE5 MAJOR 2. Best-effort emit is currently acceptable because every Cycle 6 emit's downstream consumer is already idempotent.

### Verification summary

- API + web build clean.
- All 8 fixed services compile (`pnpm --filter @campusos/api build`).
- 6 fixes verified live end-to-end on `tenant_demo` (3, 4, 6, 7, 8, 10) — every smoke produced the expected fix-induced behaviour AND the prior failure mode is unreachable.
- 2 fixes verified by build-artifact inspection + happy-path sanity (9, 11) — the concurrency-induced failure modes are non-trivial to assert in a single-process smoke; the SQL is in `dist/` and the happy paths still produce correct counters / account numbers.
- 1 fix is doc-only (12).
- All smoke residue cleaned up — `tenant_demo` is back to seed state ($400 ledger sum on FA-1001, Tech Fee SENT, Aiden SUBMITTED, Rivera assigned to all 6 classes).

### Round-2 fix summary table

| Finding      | Fix                                                                                                                        | Verification                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 3 (BLOCKING) | Actor-aware `getClassAttendance` + manager-only prepopulate + per-persona row scope                                        | 6 live scenarios on `tenant_demo`                                              |
| 4 (BLOCKING) | `getStudentGradebook` filters classes to STAFF caller's `sis_class_teachers` rows                                          | 4 live scenarios — teacher 1-class scope verified                              |
| 6 (BLOCKING) | `cancel()` writes compensating ADJUSTMENT entry inside the tx                                                              | Tech Fee cancel → balance 400 → 0 verified                                     |
| 7 (BLOCKING) | Refund-aware `amount_paid` formula in invoice + payment + RefundService recomputes invoice status with parent-invoice lock | $400 pay → PAID → $50 refund → PARTIAL → $50 pay → PAID verified               |
| 8 (BLOCKING) | `generate-from-schedule` advisory lock + in-tx existence check                                                             | 5 parallel → 1 winner + 4 skipped verified                                     |
| 9 (MAJOR)    | `recompute()` advisory lock keyed on (period, grade)                                                                       | Build artifact + happy-path counters verified                                  |
| 10 (MAJOR)   | Read `guardian_person_id` from locked application snapshot, not `dto.familyResponse`                                       | Wire envelope captured on `dev.enr.offer.issued` — guardianPersonId is correct |
| 11 (MAJOR)   | `nextAccountNumber` advisory lock keyed on schoolId                                                                        | Build artifact + happy-path account creation verified                          |
| 12 (MINOR)   | JSDoc rewrite                                                                                                              | text-only                                                                      |

The fixes ship in a single commit ready for Round 2 re-review.

---

## Round 2 — Result: APPROVED

The reviewer re-walked all 8 fixes against `64993a8` directly. Verbatim verdict:

> ## Final Cycle 6 Gate Decision at `64993a8`: **Approved**
>
> I reviewed commit `64993a8` directly. The Round-2 fixes are present and address the actionable Cycle 6 findings.
>
> ### Confirmed fixes
>
> - Attendance class reads are now actor-scoped; parent/student reads are filtered, and lazy prepopulation only runs for admins/class teachers.
> - Student gradebook access now filters staff/teacher views to only the classes that teacher is assigned to.
> - Invoice cancellation now writes a compensating `ADJUSTMENT` for outstanding balance on non-draft cancelled invoices.
> - Refund logic now subtracts completed refunds from invoice paid amount and recomputes invoice status after refund.
> - `generateFromSchedule()` now uses a per-family/schedule advisory lock and repeats the existence check inside the transaction.
> - Capacity recompute now uses a per-period/grade advisory lock.
> - `enr.offer.issued` now uses `guardian_person_id` from the locked application snapshot.
> - Payment account number allocation now uses a per-school advisory lock before `MAX(account_number)+1`.
>
> The prior stale findings are also resolved: `ResolvedActor.employeeId` exists and is populated, Kafka consumer retry/DLQ behavior is implemented, and tenant execution still uses interactive transactions with `SET LOCAL search_path`.
>
> ## Remaining accepted deviations
>
> The Phase 2 items remain acceptable as documented: consumer tenant-header validation, platform/internal non-tenant permission mode, DB-enforced ledger immutability, and outbox/event atomicity.
>
> ## Final verdict
>
> **Cycle 6 is approved to proceed.**

### Carry-over to Phase 2 (not Cycle 6 scope)

The accepted deviations are tracked here so they're easy to find when Phase 2 hardening lands:

- **MAJOR 13 — Consumer envelope tenant validation.** Already on the punch list since REVIEW-CYCLE5 MAJOR 1. Affects every consumer in the system. The fix lives in `apps/api/src/notifications/consumers/notification-consumer-base.ts::unwrapEnvelope` and should validate the `(tenant_id, subdomain)` pair from the inbound envelope against `platform_tenant_routing` before pinning context. Consider gating behind a defence-in-depth flag so existing topics keep working during rollout.
- **MAJOR 14 — Platform/internal v11 endpoints non-tenant permission mode.** Forward-looking; v11 endpoints don't exist yet. When they ship, `PermissionGuard` needs a path that resolves permissions outside any tenant context.
- **MAJOR 15 — Ledger immutability hardening.** Optional Phase 2: add a `BEFORE UPDATE/DELETE` trigger to every `pay_ledger_entries` partition, or revoke UPDATE/DELETE at the role level. ADR-010 currently relies on service-side discipline (no service method exposes mutation), which is reasonable but defence-in-depth would be stronger.
- **MAJOR 16 — Transactional outbox for Kafka emit.** Already on the punch list since REVIEW-CYCLE5 MAJOR 2. Future cycles that need exactly-once delivery (e.g. payment + Stripe charge + downstream consumer that has real-world side-effects) would adopt the outbox pattern: write the event row inside the same tx as the domain change, drain the outbox to Kafka via a separate worker. Cycle 6 emits are best-effort because every downstream consumer is idempotent on the (deterministic) event_id.
- **MAJOR 11 carry-over — `sis_students` materialisation.** The future EnrollmentConfirmedWorker will materialise `sis_students` rows from `enr_applications` on enroll and re-emit `enr.student.enrolled`, at which point `PaymentAccountWorker` will idempotently insert the `pay_family_account_students` link. Tracked in Step 7 + Step 12 documentation.

### Cycle 6 ships clean

All schema, seed, API, web, CAT deliverables, and architecture-review fixes are stable. The 12-commit Cycle 6 chain plus the 1-commit review-fix lands on `main` with CI green. Tagged as `cycle6-approved` at `64993a8`. Ready for the next cycle.
