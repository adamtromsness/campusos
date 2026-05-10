# P2C6 — Review Notes

Author-side notes for the upcoming peer review. Captures schema decisions, plan deviations, edge cases, and non-blocking acknowledged limitations.

---

## Plan deviations

1. **Migration numbering.** Plan said `108_pay_financial_aid.sql` through `111_pay_billing_ops.sql`. Those slots were taken (108 = vis_muster_incident_uq, 109 = hlth_advanced, 110 = hlth_telehealth_cancelled_reason, 111 = hr_payroll). Used `123` through `126` per the established convention from prior cycles. No semantic difference; downstream tools pick up by name not number.
2. **Net new tables 14, not 17.** The plan listed 17 tables but `pay_fee_categories`, `pay_fee_schedules`, and `pay_payment_plans` already exist from Cycle 6. P2-6 creates 14 net new tables and augments `pay_fee_schedules` with 3 new columns (`frequency`, `due_date`, `applies_to_student_ids`).
3. **`pay_payment_plans` left unchanged.** Cycle 6 ships this table with a more sophisticated shape (separate `pay_payment_plan_installments` child table, `total_amount` + `installment_count` + `frequency` + `start_date` columns). The plan's looser `total_instalments + installment_amount + next_due_date` shape was not back-fitted because the existing model is richer and the runtime payment plan flow already works against it.
4. **AutoInvoiceWorker poll loop deferred.** The Step 6 service is scaffolded with `OnModuleInit` logging plus the synchronous `triggerRule` endpoint admins use today. The cron-driven poll (DATE_OF_MONTH polling, TERM_START offset calculation against `sis_terms`) is a Phase 3 ops task per the plan's reviewer-attention note.
5. **Steps 8 + 9 deferred.** Per the user's explicit scope decision at the start of the cycle, the UI (Step 8) and the vertical-slice CAT script (Step 9) ship in a follow-up session. Backend services + Kafka consumer + handoff docs land in this cycle.

---

## IMMUTABLE invariants — schema + service-layer enforcement

Three tables are IMMUTABLE per ADR-010:

| Table                                 | Service-layer                                                                               | Schema-side belt-and-braces                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pay_credit_notes`                    | `CreditNoteService` exposes `list / getById / issue` only. No `update` or `delete` methods. | None (relies on service discipline).                        |
| `pay_payment_reversals`               | `ReversalService` exposes `list / getById / reverse` only.                                  | UNIQUE(payment_id) catches double-reversal at the DB layer. |
| `pay_lunch_account_balance_transfers` | `LunchAccountService.transfer` is the sole writer. No update or delete methods exposed.     | None (relies on service discipline).                        |

`grep -r "UPDATE pay_credit_notes\|DELETE FROM pay_credit_notes\|UPDATE pay_payment_reversals\|DELETE FROM pay_payment_reversals\|UPDATE pay_lunch_account_balance_transfers\|DELETE FROM pay_lunch_account_balance_transfers" apps/api/src/payments/` returns zero matches.

The seed-time UPDATE on the `pay_lunch_accounts` balance after a transfer is on the `pay_lunch_accounts` table (mutable balance), NOT on the transfer audit row.

---

## Concurrency contract

Every state-mutating method that could race uses `executeInTenantTransaction` with `SELECT … FOR UPDATE`:

- **Financial aid approval:** locks parent application + parent programme rows; validates `awardAmount ≤ fund_remaining`; INSERTs award + decrements `fund_remaining` + stamps `award_id` on the application atomically. UNIQUE(student, program, academic_year) on awards is the schema-side dedup.
- **Lunch deposit + transfer + meal-charge consumer:** locks the relevant lunch account row(s) FOR UPDATE before any read or write. The transfer endpoint locks BOTH source + destination accounts in the same tx.
- **Credit note issue:** locks the parent invoice FOR UPDATE.
- **Payment reversal:** locks invoice FIRST then payment FOR UPDATE — consistent ordering with `PaymentService.pay` + `RefundService.issue` to prevent deadlock.
- **Payment allocation:** locks the payment row FOR UPDATE.
- **Late fee scan:** locks each invoice individually before adding the late-fee line item.

---

## Privacy + row-scope

| Surface                              | Visibility                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Financial aid programmes (read)      | All `fin-002:read` holders (admin + parent).                                                                                                                                                                      |
| Financial aid applications (read)    | Admin: all. Parent: own-submitted (`guardian_id` resolves to actor.personId via `sis_guardians`) OR own-children's applications (joins `sis_student_guardians`). Non-related guardians: 404 don't-leak-existence. |
| Financial aid awards                 | Admin: all. Parent: own children only (joins `sis_student_guardians`).                                                                                                                                            |
| Lunch accounts                       | Admin: all. Parent: own children only via `sis_student_guardians`. Student: own only via `sis_students.platform_student_id → platform_students.person_id`.                                                        |
| Lunch low-balance list               | Admin only.                                                                                                                                                                                                       |
| Lunch transfers                      | Admin only (write authority).                                                                                                                                                                                     |
| Discount rules                       | Admin only.                                                                                                                                                                                                       |
| Auto-invoice rules + generation runs | Admin only.                                                                                                                                                                                                       |
| Credit notes                         | Admin only.                                                                                                                                                                                                       |
| Payment reversals                    | Admin only.                                                                                                                                                                                                       |
| Payment allocations                  | Admin only.                                                                                                                                                                                                       |
| Late payment policy + scan           | Admin only.                                                                                                                                                                                                       |
| Saved payment methods                | Admin OR family member (account holder via `pay_family_accounts.account_holder_id = actor.personId`).                                                                                                             |

---

## Edge cases

1. **Application with `program_id` that doesn't exist or isn't active** → 400 from `createApplication` ("programId does not match a financial aid programme in this school" / "Financial aid programme is not active").
2. **Application for a student where the calling parent is not a guardian** → 403 ("You can only submit financial aid applications for your own children").
3. **APPROVE with `awardAmount > fund_remaining`** → 400 ("awardAmount $X exceeds programme fund_remaining $Y"). Validated inside the locked tx after `SELECT … FOR UPDATE` so concurrent approvals serialise.
4. **APPROVE without `awardAmount`** → 400 ("awardAmount > 0 is required to APPROVE an application").
5. **Reviewing a terminal-status application (APPROVED / REJECTED / WITHDRAWN)** → 400 ("Application is in terminal status X and cannot be re-reviewed").
6. **Lunch transfer with `to_account_id = from_account_id`** → 400 (validated app-side AND schema-side via `pay_lunch_xfer_distinct_chk`).
7. **Lunch transfer REFUND_TO_FAMILY without `refundId`** → 400 (app-side and schema-side `pay_lunch_xfer_refund_chk`).
8. **Lunch deposit attempt by parent for a child they aren't linked to** → 404 don't-leak-existence (the row-scope `assertCanReadStudent` returns 404 not 403 to avoid leaking student-account existence).
9. **Credit note against a CANCELLED invoice** → 400 ("Cannot issue credit against a CANCELLED invoice").
10. **Credit note `lineItemId` that belongs to a different invoice** → 400 ("lineItemId does not belong to this invoice").
11. **Reversal of a payment in non-COMPLETED status** → 400 ("Cannot reverse payment in status X; only COMPLETED payments can be reversed").
12. **Double-reversal of the same payment** → 400 ("Payment X has already been reversed") via UNIQUE(payment_id) catch.
13. **Payment allocation where SUM ≠ payment.amount** → 400 ("Allocation total $X must equal payment amount $Y").
14. **Payment allocation across invoices from different family accounts** → 400 ("Invoice X does not belong to the same family account as the payment").
15. **Late fee policy upsert with FIXED + missing fee_amount** → 400. Mirrored on the schema-side via `pay_late_policies_amount_chk`.
16. **LunchAccountConsumer redelivery of the same fds.meal.served event** → schema-side dedup via the partial UNIQUE INDEX `pay_lunch_tx_event_dedup_uq ON (source_event_id) WHERE source_event_id IS NOT NULL` catches the duplicate INSERT and the consumer logs + drops gracefully without double-charging the balance.
17. **LunchAccountConsumer for a student that doesn't have a lunch account** → consumer logs a WARN and drops (no balance to debit). The Phase 3 onboarding flow auto-creates a lunch account on enrolment.

---

## Security considerations

1. **Saved payment methods are token-only.** `pay_saved_payment_methods` stores the Stripe `pm_` token + `card_last_four` + `card_brand`. Card numbers, CVCs, PINs, and bank routing details never touch the DB. Stripe holds the sensitive data.
2. **Financial aid `supporting_documents` JSONB** is a list of `{s3Key, label}` objects. The S3 keys are signed-URL bound (Cycle 4 `hr_employee_documents` pattern). The actual upload + signed-URL gen path lands when the UI ships.
3. **Approval authority** for financial aid applications is admin-only (`fin-002:admin`). The Finance Officer role inherits via `everyFunction`.
4. **Programme fund decrement is atomic.** `fund_remaining` cannot oversell because the decrement is inside the same locked tx as the award INSERT.
5. **Reversal cannot cascade beyond the original payment.** UNIQUE(payment_id) on reversals enforces one reversal per payment. Re-recording a payment that was wrongly reversed requires a new `pay_payments` INSERT (not a modification of either the reversal or the original payment row).
6. **Lunch transfers carry `processed_by` and `processed_at` NOT NULL** — authorisation is a precondition of the row.
7. **Credit notes carry `issued_by` and `issued_at` NOT NULL** — authorisation is a precondition.

---

## Performance notes

1. **Financial aid programme fund query** runs inside a locked tx. Throughput is bounded by the per-programme write rate. Acceptable — financial aid approval is an admin-driven workflow with low concurrency.
2. **Auto-invoice generation** is synchronous and bounded by the number of eligible students per fee schedule. For a school with ~500 students, a single generation pass takes ~10–20 seconds with one DB round-trip per family + per discount lookup. The plan calls out batch optimisation as Phase 3 work.
3. **Late fee scan** is also synchronous and walks invoices PAST due_date + grace. For a school with hundreds of overdue invoices, the scan runs ~5–10 seconds. Production wires a nightly cron.
4. **Lunch account low-balance index** uses partial INDEX `pay_lunch_accounts_low_balance_idx ON (school_id) WHERE balance <= low_balance_threshold` — the admin "low balance" query plans against this directly.
5. **Lunch transactions index** uses `pay_lunch_tx_account_date_idx ON (lunch_account_id, meal_date DESC NULLS LAST)` for the per-student transaction history hot path.
6. **Credit notes index** uses `pay_credit_notes_school_issued_idx ON (school_id, issued_at DESC)` for the admin queue.
7. **Reversals index** uses `pay_payment_reversals_school_reversed_idx ON (school_id, reversed_at DESC)`.

---

## Test coverage gaps (deferred to Phase 3)

The user's scope decision at the start of P2-6 deferred unit + integration test files. Service-level invariants are covered by the constraint smoke (single BEGIN…ROLLBACK transactions on `tenant_demo`) plus happy-path live verification via the seed run. Pre-pilot a dedicated test sweep should land covering:

- Every service method's row-scope (admin / parent / student / non-related) for both happy + 404/403 paths.
- IMMUTABLE invariants (no UPDATE / no DELETE on credit_notes / reversals / lunch transfers).
- UNIQUE constraint catches translated to friendly 400s (programme name, award per (student, program, year), reversal per payment, allocation per (payment, invoice), saved-method default per family).
- Concurrency tests for the financial-aid approval keystone (parallel approves serialise on `FOR UPDATE`; second approve over budget rejects).
- LunchAccountConsumer dedup (same event_id redelivered → single MEAL_CHARGE row).
- LunchAccountConsumer payload validation (missing studentId / amount ≤ 0 / missing mealDate all drop the event with WARN).
- Auto-invoice generation correctness across grade_level filter + applies_to_student_ids array path + sibling discount + early-payment discount.

---

## Acknowledged non-blocking limitations carried to Phase 2 punch list

These join the existing pre-pilot backlog (CLAUDE.md "Wave 2 Phase 2 punch list"):

1. **AutoInvoiceWorker cron poll** — synchronous trigger ships today; cron wiring is Phase 3 ops.
2. **InstalmentsWorker cron poll** — same as above.
3. **LateFeesWorker cron poll** — same as above.
4. **Stripe SetupIntent + auto-replenish** — `pay_lunch_accounts.auto_replenish_enabled` + `_amount` columns ship forward-compatible. Stripe wiring is Phase 3.
5. **Means-testing calculator for financial aid** — out of scope this cycle. Service-side income band is admin-entered.
6. **Multi-currency support** — out of scope. NUMERIC is treated as USD across the cycle.
7. **Tax receipt generation for goodwill credits** — out of scope.
8. **NSLP free/reduced meal eligibility integration** — out of scope.
9. **Sibling discount matrix UI builder** — UI is Step 8 deferred.
10. **GL chart-of-accounts mapping for credit categories + reversal types** — Cycle 26 GLConsumer extension when those event types are wired into the journal-batch templates.
