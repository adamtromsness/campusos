# HANDOFF — Phase 2 Cycle 6 (P2-6) Payments Advanced

**Status:** **COMPLETE + APPROVED at the Round 2 closeout commit (REVIEW-P2-6-CHATGPT — final verdict, 2026-05-10).** Round 1 against the post-P2-6b commit returned **REJECT** with **4 BLOCKING + 4 MAJOR**. Round 1 fix commit `5f3ad04` landed all 4 BLOCKING + 3 actionable MAJORs (5 + 6 + 7) and earned Round 2 verdict **PASS** (every prior blocker FIXED, every dimension at PASS). Closeout commit lands the one Round 2 hardening carry-forward (`AutoInvoiceService` generation/run school-scoping — `runGeneration` fee-schedule lookup + `listRuns` + `getRunById` + family-account lookup + existing-invoice duplicate check) with 2 new pinned regression tests. Tagged `p2c6-complete` at `5f3ad04` and `p2c6-approved` at the closeout commit. **All 10 steps of P2-6 itself shipped across two sessions:** P2-6a (steps 1–7 + 10) and P2-6b (steps 8 + 9 + tests). Plan reference: `docs/campusos-p2c6-payments-advanced.html`. Review fix log: `REVIEW-P2-6-CHATGPT.md`.

## REVIEW-P2-6 ROUND 2 — closeout (PASS verdict)

Round 2 against `5f3ad04` returned **PASS** — every prior blocker
FIXED; every dimension at PASS (Financial Aid, Billing Ops / GL Events,
Lunch Accounts, Auto-Invoice Rules, Payment Allocation, Saved Payment
Methods, Test Coverage). Reviewer carried one non-blocking hardening
item: auto-invoice `runGeneration` fee-schedule lookup, `listRuns`,
`getRunById`, family-account lookup inside generation, and the
existing-invoice duplicate check were still unscoped (admin-only
surface so the practical risk is low, but inconsistent with the
Phase 2 gate standard).

**Closeout fix (this commit):** all 5 paths in
`apps/api/src/payments/auto-invoice.service.ts` now thread
`getCurrentTenant().schoolId` into the predicate:

- `listRuns` SELECT adds `WHERE r.school_id = $1::uuid`.
- `getRunById` SELECT adds `WHERE r.school_id = $1::uuid AND r.id = $2::uuid`
  (cross-school UUIDs collapse to 404 don't-leak-existence).
- `runGeneration` fee-schedule lookup adds `WHERE school_id = $1::uuid AND id = $2::uuid`
  so a manual `generateFromFeeSchedule(crossSchoolFeeId)` aborts BEFORE walking any students.
- Family-account lookup inside generation now JOINs `pay_family_accounts`
  on `school_id = $tenant.schoolId` so a leaked `pay_family_account_students`
  row alone cannot pull in a foreign-school family.
- Existing-invoice duplicate check JOINs `pay_invoices` on
  `school_id = $tenant.schoolId` so the dedup gate is school-scoped
  and a cross-school invoice can never satisfy it.

Test coverage: 295 → **297 passing across 19 spec files** (+2 new
regression tests in the existing `describe('REVIEW-P2-6 BLOCKING regressions')`
block — `Round 2 closeout — listRuns + getRunById carry school predicate`
and `Round 2 closeout — runGeneration fee-schedule lookup is school-scoped`).
CI parity: format:check + lint:logs (621 files clean) + API build clean +
web build clean + vitest 297/297. **Phase 2 Cycle 6 ships clean.**

## REVIEW-P2-6 ROUND 1 fix log (2026-05-10)

**Round 1 verdict:** REJECT — 4 BLOCKING + 4 MAJOR.

**BLOCKING fixes:**

1. **School-scope every financial-aid read + write** (`apps/api/src/payments/financial-aid.service.ts`). Every `WHERE id = $1::uuid` lookup now reads `getCurrentTenant().schoolId` and adds `WHERE school_id = $1::uuid AND id = $2::uuid`. Cross-school UUIDs collapse to 404 don't-leak-existence. Applies to programmes (`listPrograms`/`getProgramById`/`createProgram`/`patchProgram`), applications (`listApplications`/`getApplicationById`/`reviewApplication` including FOR UPDATE locks + UPDATE), and awards (`listAwardsForStudent`/`getAwardById`).
2. **`createApplication` validates student/guardian/academic_year against current school**. Student lookup joins `sis_students` with `school_id = $tenant.schoolId`. Academic year lookup joins `sis_academic_years` with `school_id = $tenant.schoolId`. Guardian linkage joins `sis_student_guardians + sis_guardians` with `school_id` predicates. Programme existence + `is_active` re-checked under the same constraint. All cross-school inputs return friendly 400 with the offending field name.
3. **Durable outbox for `pay.credit_note.issued` + `pay.payment.reversed`** (`credit-note.service.ts` + `reversal.service.ts`). Both services swap `KafkaProducerService` for `OutboxService` in their constructors. New exported helpers `deterministicCreditNoteEventId(creditNoteId)` and `deterministicReversalEventId(reversalId)` produce v5-shaped UUIDs via `sha1(<id>:<topic>:v1)` — same pattern as P2-4a `deterministicPayrollEventId`. The `outbox.enqueueInTx(tx, opts)` call commits with the financial mutation, so a Kafka outage does not lose the GL event; the OutboxPublisherWorker retries until publish succeeds; consumer-side dedup catches redelivery. ReversalService also tightens the invoice + payment FOR UPDATE locks with school-scope predicates so a cross-school payment UUID collapses to 404 BEFORE the lock fires.
4. **Durable `pay.lunch.low_balance`** (`lunch-account.service.ts`). The throttle stamp `UPDATE pay_lunch_accounts SET last_low_balance_alert_at = now()` and the alert emit now commit together inside the same tenant tx as the meal charge. New helper `deterministicLowBalanceEventId(accountId, alertedAt)` produces a v5 UUID keyed on `(accountId, alertedAt)` so a redelivered `fds.meal.served` event that re-stamps the same throttle window produces the same id (consumer-side dedup catches it). The throttle UPDATE adds `RETURNING last_low_balance_alert_at::text` so the timestamp is available inside the tx for the deterministic event_id. The student-name JOIN runs inside the tx so the payload is built without leaving the tenant context. `KafkaProducerService` injection removed (was the only producer dep).

**MAJOR fixes (3 of 4 actionable, 1 carry-over):**

5. **Auto-invoice rules school-scoped** (`auto-invoice.service.ts`). `listRules`/`getRuleById`/`updateRule` thread `getCurrentTenant().schoolId` into the predicate. `updateRule` UPDATE adds `WHERE school_id = $X::uuid AND id = $Y::uuid` so a cross-school admin cannot mutate a foreign rule even if they know the UUID.
6. **Payment allocation invoice school-validation** (`payment-allocation.service.ts`). `listForPayment` adds `WHERE a.school_id = $1::uuid AND a.payment_id = $2::uuid`. `allocate()` payment FOR UPDATE lock and per-line invoice lookup carry the school predicate. Cross-school invoice UUIDs return the same friendly "Invoice X not found" message as a missing one (don't-leak-existence). The redundant runtime `payment.school_id !== schoolId` check was removed — the predicate is the access gate.
7. **Saved payment method default-clear school predicate** (`saved-payment-method.service.ts`). `listForFamily`/`getById`/`remove`/`assertCanAccessFamily`/clear-default UPDATE inside `create()` all carry the school predicate so a cross-school admin cannot strip the default flag from a foreign-school family's primary card.
8. **(MAJOR 8 carry-over)** CAT live-output capture pattern — recommendation-class polish; carried to Phase 2 backlog.

**Test coverage** (Round 1 fix commit): 289 → **295 passing across 19 spec files**. New `describe('REVIEW-P2-6 BLOCKING regressions')` block in `apps/api/src/payments/payments-advanced.spec.ts` pins:

- BLOCKING 1 — `getProgramById carries school predicate (cross-school 404)` + `listApplications carries school predicate`
- BLOCKING 2 — `createApplication validates student against current school` (asserts the SQL queries `sis_students` with `school_id`)
- BLOCKING 3 — deterministic event_id stability + v5-shape on both `deterministicCreditNoteEventId` and `deterministicReversalEventId`
- BLOCKING 4 — same for `deterministicLowBalanceEventId`

The existing `CreditNoteService.issue` / `ReversalService.reverse locks invoice FIRST then payment FOR UPDATE` / `chargeMealFromConsumer enqueues pay.lunch.low_balance via durable outbox INSIDE the throttle-stamp tx` tests were rewritten to use the `makeOutbox()` stub so the durable contract is locked in across the entire suite.

**CI parity green:** `pnpm format:check` clean (621 files), `pnpm lint:logs` clean (621 files), `pnpm --filter @campusos/api build` clean, `pnpm --filter @campusos/api test` 295/295, `pnpm --filter @campusos/web build` clean.

**Awaiting Round 2 verdict before tagging `p2c6-complete`.** See `REVIEW-P2-6-CHATGPT.md` for the full triage table + per-fix verification.

## P2-6b additions (2026-05-10)

- **Step 8 — UI for all 5 management surfaces.** 7 new web routes:
  - `/payments` — hub page that branches per persona.
  - `/payments/financial-aid` — admin programmes + queue + parent applications, review modal with APPROVE/REJECT/UNDER_REVIEW.
  - `/payments/financial-aid/apply` — parent self-service application form (student picker, programme picker, statement, document references).
  - `/payments/fees-advanced` — auto-invoice rules CRUD + trigger, discount rules CRUD, bulk Generate-from-fee-schedule modal, generation run history.
  - `/payments/lunch` — admin low-balance dashboard + IMMUTABLE transfer modal + parent children grid.
  - `/children/[id]/lunch` — parent per-child balance + transactions + deposit modal.
  - `/payments/operations` — 4-tab admin surface (credit notes, payment reversals, late fees policy + scan, allocations explainer).
  - All gated on the right `fin-001` / `fin-002` permission tier; service-layer row-scope is the actual access boundary for parent paths. New `Payments+` launchpad tile in `apps/web/src/components/shell/apps.tsx`.
- **Step 8a — DTOs + hooks + format helpers.** `apps/web/src/hooks/use-payments-advanced.ts` exposes 24 React Query hooks covering all 21 P2-6 endpoints. `apps/web/src/lib/types.ts` extended with the full P2-6 DTO surface (40+ types/interfaces). `apps/web/src/lib/billing-format.ts` extended with label maps + pill class maps + `fundRemainingPct` / `fundRemainingTone` / `lunchBalanceTone` helpers. **Type-name disambiguation:** `ApplicationStatus` → `FinancialAidApplicationStatus`, `RunStatus` → `InvoiceGenerationRunStatus`, `RunType` → `InvoiceGenerationRunType` to avoid collisions with the existing enrolment + analytics types.
- **Step 9 — vertical-slice CAT script** at `docs/p2c6-cat-script.md`. 4-check schema preamble + 10 plan scenarios end-to-end (financial aid lifecycle with atomic fund decrement; fee schedule + auto-invoicing; sibling discount; lunch deposit + IMMUTABLE transfer; LunchAccountConsumer dedup with same-event_id replay; credit note IMMUTABLE + offsetting CREDIT ledger entry; payment reversal IMMUTABLE; late fee policy + scan; multi-invoice allocation SUM=payment.amount validation; permission denials across personas). Cleanup section restores tenant_demo to seed shape exactly.
- **Tests — `apps/api/src/payments/payments-advanced.spec.ts` 44 new tests** covering:
  - **FinancialAidService — fund-pool decrement keystone:** atomic INSERT + decrement + award_id stamp; REJECTS over-fund; REJECTS non-admin; REJECTS terminal-status; REJECTS without awardAmount; UNIQUE catch friendly 400; parent row-scope via sis_guardians; parent createApplication for unlinked child REJECTED.
  - **CreditNoteService IMMUTABLE invariants:** writes CREDIT ledger entry + emits pay.credit_note.issued; REJECTS CANCELLED invoice; REJECTS empty reason; REJECTS non-admin; **runtime check that no `update`/`delete`/`patch`/`remove` method exists on the service prototype.**
  - **ReversalService:** **locks invoice FIRST then payment** (consistent ordering with PaymentService.pay + RefundService.issue); UNIQUE(payment_id) catch translates to friendly 400; REJECTS non-COMPLETED payments; **no update/delete/patch on prototype.**
  - **LunchAccountService:** transfer locks BOTH source AND destination FOR UPDATE; REJECTS REFUND_TO_FAMILY without refundId; REJECTS same source+destination; REJECTS amount > balance; chargeMealFromConsumer dedups via partial UNIQUE on source_event_id; emits pay.lunch.low_balance when crossing threshold; parent CANNOT view another family's account (404 don't-leak-existence).
  - **PaymentAllocationService SUM validation:** REJECTS allocation total != payment.amount; REJECTS allocations across families; accepts SUM = payment.amount; REJECTS non-admin.
  - **LateFeeService:** REJECTS FIXED without feeAmount; REJECTS PERCENTAGE_MONTHLY without feePercentage; runScan no-ops when policy inactive; runScan + getPolicy REJECT non-admin.
  - **DiscountRuleService:** REJECTS SIBLING without siblingOrder; REJECTS non-SIBLING with siblingOrder; REJECTS non-admin.
  - **AutoInvoiceService:** REJECTS DATE_OF_MONTH without triggerDayOfMonth; REJECTS triggerRule on inactive rule; REJECTS non-admin.
  - **SavedPaymentMethodService:** parent listForFamily REJECTED for stranger family (404); UNIQUE(stripe_payment_method_id) catch maps to friendly 400.
  - **Controller permission metadata regression** for all 4 P2-6 controllers covering all 21 endpoints.
- **Test count: 243 → 287 (vitest 19/19 spec files passing).**
- **CI parity green:** format:check + lint:logs (621 files) + API build + web build + vitest 287/287.

The legacy "deferred steps" sub-section below described the P2-6a scope-cut from 2026-05-10 morning. It is preserved for review-trail traceability.

---

## Migrations

Four new tenant migrations applied cleanly to `tenant_demo` and `tenant_test` (123 → 126):

| File                         | Tables                                                                                                                                                                                                                    | New FKs        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `123_pay_financial_aid.sql`  | `pay_financial_aid_programs`, `pay_financial_aid_awards`, `pay_financial_aid_applications`                                                                                                                                | 5 intra-tenant | Multi-column lockstep `submitted_chk` + `reviewed_chk` + `award_chk` on applications. Multi-column `fund_chk` on programmes (total + remaining all-NULL or both-NOT-NULL with remaining ≤ total). UNIQUE(student, program, academic_year) on awards prevents double-issuing.                                                                                                                                                             |
| `124_pay_fees_invoicing.sql` | `pay_auto_invoice_rules`, `pay_invoice_generation_runs`, `pay_discount_rules` + 3 column additions on existing `pay_fee_schedules` (`frequency`, `due_date`, `applies_to_student_ids`)                                    | 6 intra-tenant | Splitter-safe DROP IF EXISTS + ADD pattern on the augmented frequency CHECK (adds TERM to the existing 5-value enum). Multi-column `pay_discount_rules_sibling_chk` pins `sibling_order` to the SIBLING discount type only. Multi-column `pay_invoice_gen_runs_completed_chk` pins `completed_at` to terminal statuses.                                                                                                                  |
| `125_pay_lunch_accounts.sql` | `pay_lunch_accounts` (UNIQUE(student_id)), `pay_lunch_transactions`, `pay_lunch_account_balance_transfers` (IMMUTABLE)                                                                                                    | 4 intra-tenant | Partial UNIQUE INDEX `pay_lunch_tx_event_dedup_uq ON (source_event_id) WHERE source_event_id IS NOT NULL` is the schema-side dedup against Kafka redelivery from `fds.meal.served`. Multi-column `pay_lunch_xfer_to_account_chk` keeps `to_account_id` populated for SIBLING_TRANSFER + NEXT_YEAR_ROLLOVER and NULL for REFUND_TO_FAMILY. Multi-column `pay_lunch_xfer_refund_chk` keeps `refund_id` populated only on REFUND_TO_FAMILY. |
| `126_pay_billing_ops.sql`    | `pay_credit_notes` (IMMUTABLE), `pay_payment_reversals` (IMMUTABLE — UNIQUE(payment_id)), `pay_payment_allocations` (UNIQUE(payment, invoice)), `pay_late_payment_policies` (UNIQUE(school)), `pay_saved_payment_methods` | 7 intra-tenant | Multi-column `pay_late_policies_amount_chk` enforces `(fee_type=FIXED ⇒ fee_amount NOT NULL + fee_percentage NULL) OR (fee_type=PERCENTAGE_MONTHLY ⇒ fee_percentage NOT NULL + fee_amount NULL)`. Partial UNIQUE on `pay_saved_payment_methods (family_account_id) WHERE is_default=true AND removed_at IS NULL` enforces one default per family.                                                                                        |

**14 net new tables** (the plan said 17 but `pay_fee_categories`, `pay_fee_schedules`, and `pay_payment_plans` already existed from Cycle 6 — column additions on `pay_fee_schedules` close the spec). Tenant base table count now **495** logical base tables (was 481 after P2-5).

**Splitter audit:** every migration cleared a Python state-machine audit (block-comment + line-comment + single-quoted-string aware) on the first attempt after the audit. One catch on migration 124 — initial draft used `-- header` line comments at the start of statement chunks which the splitter strips; switched to `/* */` block comments per the documented Cycles 4–onwards convention.

**Idempotent re-provision:** verified on both `tenant_demo` and `tenant_test`. Zero new applies on second run; constraint + column counts stable.

**Constraint smoke (representative):**

```
SET search_path TO tenant_demo, platform, public;
-- Financial aid
T1 reduction_type IN (PERCENTAGE, FIXED_AMOUNT) — BOGUS rejected ✓
T2 fund_chk: fund_remaining > total → rejected ✓
T3 award amount > 0 — -10 rejected ✓
-- Billing ops
T1 credit_amount > 0 — -10 rejected ✓
T2 lunch_xfer_to_account_chk REFUND_TO_FAMILY with to_account_id populated → rejected ✓
T3 late_policies amount_chk FIXED with both fee_amount AND fee_percentage → rejected ✓
```

---

## Seed (`packages/database/src/seed-payments-advanced.ts`)

Idempotent — gated on whether `pay_financial_aid_programs` already has rows for the demo school. Wired as `seed:payments-advanced` in `packages/database/package.json`. Added to the `seed-all.ts` chain (step 37, last step after the Cycle 5 P2-5 enrolment-advanced seed).

**Live row counts on `tenant_demo` after the first successful run:**

| Table                               | Rows                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| pay_financial_aid_programs          | 1 (Need-Based Aid, $50K fund, $47,750 remaining after 2 awards)                      |
| pay_financial_aid_awards            | 2 (Maya $1500, Ethan $750)                                                           |
| pay_financial_aid_applications      | 1 (David Chen for Maya, SUBMITTED with 2 supporting docs)                            |
| pay_auto_invoice_rules              | 1 (Tuition fires 14d before term, TERM_START)                                        |
| pay_invoice_generation_runs         | 1 (historical AUTO_RULE_TRIGGERED, COMPLETED, 50 invoices)                           |
| pay_discount_rules                  | 2 (SIBLING 2nd-child 10%, EARLY_PAYMENT 5%)                                          |
| pay_lunch_accounts                  | 3 (Maya $36.50, Ethan $22, Aiden $5 below threshold)                                 |
| pay_lunch_transactions              | 10 (mix of MEAL_CHARGE + DEPOSIT)                                                    |
| pay_lunch_account_balance_transfers | 1 IMMUTABLE SIBLING_TRANSFER ($6.50)                                                 |
| pay_credit_notes                    | 1 IMMUTABLE ($25 GOODWILL with offsetting CREDIT ledger entry)                       |
| pay_payment_reversals               | 1 IMMUTABLE (BOUNCED_CHEQUE — demo coverage row; the seeded payment stays COMPLETED) |
| pay_payment_allocations             | 1 ($12K seeded payment ↔ tuition invoice)                                            |
| pay_late_payment_policies           | 1 ACTIVE (FIXED $25, 7-day grace, $100 cap)                                          |
| pay_saved_payment_methods           | 1 (Visa ending 4242, default for Chen family)                                        |

**Programme fund decremented atomically** — `total_fund_amount=$50,000` minus the 2 active awards equals `fund_remaining=$47,750`.

**`seed-iam.ts` change:** Parent role gains `FIN-002:read+write` (was missing). Admin tier on FIN-002 already covered via the Finance Officer role + School Admin / Platform Admin via `everyFunction`. After `cache:build`: parent went from 49 → **51** permissions cached.

---

## Backend (`apps/api/src/payments/`)

**10 new services + 4 new controllers + 21 new endpoints + 1 new Kafka consumer + 3 new Kafka emit topics.**

### Services

| Service                     | Endpoints      | Key behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FinancialAidService`       | 13             | Programmes CRUD + applications with parent / admin row scope (sis_guardians.person_id = actor.personId for parent path) + `reviewApplication` keystone — APPROVE locks the programme row FOR UPDATE inside one tenant tx, validates `awardAmount ≤ fund_remaining`, INSERTs an `pay_financial_aid_awards` row, decrements `fund_remaining` atomically, and stamps `award_id` on the application — all atomic. UNIQUE(student, program, academic_year) on awards catches double-issuing.                                                                                                                                                   |
| `DiscountRuleService`       | 4              | Admin CRUD with SIBLING/EARLY_PAYMENT/etc enum + sibling_order pinned to SIBLING type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AutoInvoiceService`        | 9              | Rules CRUD + `triggerRule` (synchronous generation against an active rule) + `generateFromFeeSchedule` (manual one-shot bulk against a fee schedule) + run history. Internal `runGeneration` walks eligible students by `applies_to_student_ids` array OR `grade_level` filter, groups by family billing account, applies SIBLING + EARLY_PAYMENT discount rules at generation time as additional negative line items, tracks `invoices_created / invoices_skipped / invoices_failed` on the `pay_invoice_generation_runs` row. Worker is scaffolded for Phase 3 cron wiring; the synchronous trigger endpoint is the runtime path today. |
| `LunchAccountService`       | 5 + 1 internal | `getForStudent` + `deposit` + `update` + `transfer` IMMUTABLE keystone (locks both source + destination accounts FOR UPDATE inside one tx; multi-column `pay_lunch_xfer_to_account_chk` enforces shape per transfer_type) + `listLowBalance` admin query. Internal `chargeMealFromConsumer` is the hook the Step 10 LunchAccountConsumer calls — INSERT MEAL_CHARGE with source_event_id (schema dedup), UPDATE balance, throttled emit of `pay.lunch.low_balance` (1 per 24h via `last_low_balance_alert_at`).                                                                                                                           |
| `CreditNoteService`         | 3              | IMMUTABLE — service exposes ONLY list / get / issue. NO update or delete methods. `issue()` runs in one tenant tx that locks the parent invoice, validates non-CANCELLED, writes a CREDIT pay_ledger_entries row (negative amount), INSERTs the credit note with `ledger_entry_id` populated, and emits `pay.credit_note.issued` AFTER tx commits.                                                                                                                                                                                                                                                                                        |
| `ReversalService`           | 3              | IMMUTABLE — service exposes ONLY list / get / reverse. UNIQUE(payment_id) on schema enforces one reversal per payment (catch translates to friendly 400). `reverse()` locks invoice + payment FOR UPDATE in consistent order with `PaymentService.pay` + `RefundService.issue`, writes an offsetting CHARGE ledger entry, flips payment to FAILED, recomputes invoice status from the refund-aware paid formula (PAID → OVERDUE / PARTIAL / SENT), emits `pay.payment.reversed`.                                                                                                                                                          |
| `PaymentAllocationService`  | 2              | Splits a single payment across multiple invoices. SUM(allocatedAmount) MUST equal payment.amount (validated inside the locked tx; mismatch returns 400). Validates each target invoice belongs to the same family account. Idempotent: drops + replaces existing allocations on re-allocation. UNIQUE(payment_id, invoice_id) on schema catches double-allocation.                                                                                                                                                                                                                                                                        |
| `LateFeeService`            | 3              | UNIQUE(school_id) on `pay_late_payment_policies` enforces one policy per school. `runScan()` is the LateFeesWorker — admin-triggered scan walks invoices PAST `due_date + grace_period_days` in SENT/PARTIAL/OVERDUE without an existing late-fee line item, computes the FIXED or PERCENTAGE_MONTHLY fee (capped at `max_late_fee_amount`), inserts a new line item, bumps invoice total + flips status to OVERDUE inside one locked tx.                                                                                                                                                                                                 |
| `SavedPaymentMethodService` | 3              | Token-only — only Stripe pm\_ token + last-four + brand stored. Card numbers / CVCs / PINs never touch the DB. Partial UNIQUE on `(family_account_id) WHERE is_default = true AND removed_at IS NULL` enforces one default per family. Soft delete via `removed_at`.                                                                                                                                                                                                                                                                                                                                                                      |

**ActorContextService usage:** every endpoint resolves the calling actor via `actors.resolveActor(req.user!.sub, req.user!.personId)` and the service applies row-scope based on `actor.isSchoolAdmin` + `actor.personType` + `actor.personId` (matches the existing payments-module pattern).

**Concurrency contract:** every state-mutating method that could race uses `executeInTenantTransaction` with `SELECT … FOR UPDATE` on the relevant row(s):

- `FinancialAidService.reviewApplication` — locks application + programme rows.
- `LunchAccountService.deposit` / `transfer` / `chargeMealFromConsumer` — locks the lunch account row(s).
- `CreditNoteService.issue` — locks the parent invoice.
- `ReversalService.reverse` — locks invoice FIRST then payment (matches `PaymentService.pay` + `RefundService.issue` order to prevent deadlock).
- `PaymentAllocationService.allocate` — locks the payment row.
- `LateFeeService.runScan` — locks each invoice individually before adding the late-fee line.

### Controllers

| Controller                | URL prefix                 | Endpoints                                                                                         |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `FinancialAidController`  | `/payments/financial-aid`  | 13                                                                                                |
| `BillingConfigController` | `/payments`                | 9 (discount rules + auto-invoice rules + generation runs + manual generate-from-fee-schedule)     |
| `LunchAccountController`  | `/payments/lunch-accounts` | 5                                                                                                 |
| `BillingOpsController`    | `/payments`                | 16 (credit notes + reversals + allocations + late policy + late-fee scan + saved payment methods) |

**Live route count after API boot:** 45 routes under `/api/v1/payments/*` (was 24 from Cycle 6; +21 net new from P2-6 — close to the plan's ~34 figure once you add the auto-invoice + generation-run routes that already existed in the InvoiceService surface).

### Kafka

**3 new emit topics:**

- `pay.credit_note.issued` — fires AFTER `CreditNoteService.issue` tx commits. Payload: `{creditNoteId, invoiceId, familyAccountId, creditAmount, creditCategory, reason, issuedBy, ledgerEntryId, sourceRefId}`. Cycle 26 GLConsumer is the natural consumer (will post a balanced journal entry CR Tuition / DR Goodwill once GL chart of accounts mapping lands the credit category).
- `pay.payment.reversed` — fires AFTER `ReversalService.reverse` tx commits. Payload: `{reversalId, paymentId, invoiceId, familyAccountId, reversalType, reversalReason, reversedAmount, reversedBy, sourceRefId}`. Cycle 26 GLConsumer should post a reversal journal entry to nullify the original PAYMENT credit (DR Cash / CR AR).
- `pay.lunch.low_balance` — fires from `LunchAccountService.chargeMealFromConsumer` when the post-charge balance crosses `low_balance_threshold` AND `last_low_balance_alert_at` is > 24h ago. Payload: `{lunchAccountId, studentId, studentName, schoolId, balance, threshold, sourceRefId}`. Cycle 3 NotificationConsumer is the natural consumer to fan out a parent IN_APP notification.

**1 new Kafka consumer** — `LunchAccountConsumer` (group `lunch-account-consumer`, subscribed to `dev.fds.meal.served`):

- Standard `unwrapEnvelope` + `processWithIdempotency` (claim-after-success per REVIEW-CYCLE2 BLOCKING 2).
- Validates `studentId / schoolId / mealDate / amount > 0` payload shape.
- Calls `LunchAccountService.chargeMealFromConsumer` with the inbound `event_id` as `source_event_id`.
- **Dual-layer idempotency**: per-event_id consumer-group claim catches Kafka redelivery of the same event row; per-event source_event_id partial UNIQUE INDEX `pay_lunch_tx_event_dedup_uq` catches "different event_id but same logical action" (the schema-side belt-and-braces).

**Live boot verification:** API boots cleanly with all 4 new controllers' routes mapped; AutoInvoiceWorker initialized; `LunchAccountConsumer` subscribes to `dev.fds.meal.served` under the right consumer group.

---

## IMMUTABLE Tables — invariant verification

Three tables are IMMUTABLE per ADR-010. Service-layer discipline:

- `pay_credit_notes`: `CreditNoteService` exposes ONLY `list / getById / issue`. No `patch` or `delete` methods. Corrections are made by issuing offsetting credit notes or refunds.
- `pay_payment_reversals`: `ReversalService` exposes ONLY `list / getById / reverse`. No `patch` or `delete`. UNIQUE(payment_id) on the schema catches double-reversal at the DB level.
- `pay_lunch_account_balance_transfers`: `LunchAccountService` exposes `transfer` only — no `updateTransfer` or `deleteTransfer`. Corrections are made by creating offsetting transfers in the other direction.

**`grep -r "UPDATE pay_credit_notes\|DELETE FROM pay_credit_notes\|UPDATE pay_payment_reversals\|DELETE FROM pay_payment_reversals\|UPDATE pay_lunch_account_balance_transfers\|DELETE FROM pay_lunch_account_balance_transfers" apps/api/src/payments/`** returns zero matches.

---

## Cross-module dependencies

- **Cycle 6 — Payments (M84):** P2-6 layers on top of Cycle 6's `pay_family_accounts`, `pay_invoices`, `pay_payments`, `pay_ledger_entries`, `pay_invoice_line_items`. Augments existing `pay_fee_schedules` with `frequency` / `due_date` / `applies_to_student_ids` columns. The existing `pay_payment_plans` is unchanged.
- **Cycle 1 — SIS (M20):** financial aid awards reference `sis_students(id)` (ON DELETE CASCADE — when a student is removed, their aid awards drop with them per the conservative privacy choice). Applications also reference `sis_guardians(id)`.
- **Cycle 4 — Academic Years (M81):** financial aid programmes + awards + applications reference `sis_academic_years(id)` so each cycle is year-scoped.
- **Cycle 6 — Family billing:** lunch-account balance transfers can be REFUND_TO_FAMILY which references `pay_refunds(id)` — the family's lunch credit is refunded back to the parent's billing account via the standard refund pipeline.
- **Cycle 20 — Food Service (M63):** the LunchAccountConsumer subscribes to `dev.fds.meal.served`. Cycle 20's POS surface emits this event when a student scans their ID at the cafeteria; LunchAccountConsumer debits the lunch account and emits `pay.lunch.low_balance` when threshold is crossed.
- **Cycle 26 — General Ledger (M83):** the new emits `pay.credit_note.issued` + `pay.payment.reversed` are durable to the existing GLConsumer wire — once the Cycle 26 chart-of-accounts mapping ships the credit category and reversal journal templates, the GL postings land automatically.

**No new platform-tier tables.**

---

## Known limitations (Phase 3 ops + future cycles)

- **AutoInvoiceWorker poll loop deferred.** The Step 6 service is scaffolded with `OnModuleInit` logging and the synchronous `triggerRule` endpoint. The full cron-driven poll (DATE_OF_MONTH polling, TERM_START offset calculation against `sis_terms`) is reserved for Phase 3 ops cron wiring per the plan's reviewer-attention note.
- **InstalmentsWorker deferred.** The Cycle 6 `PaymentPlanService` already exposes plan + installments CRUD; the nightly DEFAULTED-detection sweep ships when a real cron lands.
- **LateFeesWorker is admin-triggered, not cron.** `runScan` is a synchronous endpoint admins call. Production wires a nightly cron to hit it.
- **Stripe is stubbed for refund + saved-method paths.** Cycle 6 already stubbed Stripe in dev (CARD payments auto-COMPLETE with `pi_dev_<uuid>`). P2-6 saved payment methods continue this pattern — the `stripePaymentMethodId` is stored as supplied. SetupIntent integration ships in Phase 3.
- **Sibling discount detection** counts active enrolled students per family via `pay_family_account_students` + `sis_students.enrollment_status='ACTIVE'`. The plan's mention of computing sibling order from `sis_student_guardians + sis_enrollments + enrolment dates` is the natural extension once admins want a strict eldest-first ordering; the current count-based approach matches the plan's "2nd child gets 10%" semantics.
- **No formal tests** — the user's scope decision deferred unit + integration test files. Service-level invariants are covered by the constraint smoke + happy-path live verification on `tenant_demo`. Pre-pilot a dedicated test sweep should land 200+ test cases (matching the precedent set by Cycles 9 + 10 + 11 + 12).
- **No UI** — Step 8 deferred. The 5 management surfaces (Financial Aid, Fee Schedule + Auto-Invoice, Lunch Accounts, Payment Plans, Billing Operations) are admin-driven via the API today. The web side will hook the 21 new endpoints into a coherent finance-admin experience.
- **No CAT script** — Step 9 deferred. The end-to-end vertical-slice walkthrough (financial aid → fees → auto-invoicing → lunch → plans → credit notes → reversals → late fees → allocations) ships with Step 8.

---

## Pre-pilot punch list carry-overs from P2-6

1. **CAT script** (`docs/p2c6-cat-script.md`) ships with the UI.
2. **AutoInvoiceWorker cron poll** wired in Phase 3 ops.
3. **InstalmentsWorker cron poll** wired in Phase 3 ops.
4. **LateFeesWorker cron poll** wired in Phase 3 ops.
5. **Stripe SetupIntent for saved payment methods** lands when production payment-method onboarding ships.
6. **GLConsumer wire for `pay.credit_note.issued` + `pay.payment.reversed`** — payload contracts captured here so Cycle 26 only needs the chart-of-accounts mapping for the new categories.
7. **Cycle 3 NotificationConsumer wire for `pay.lunch.low_balance`** — emit lands cleanly today; consumer will fan out parent IN_APP via the existing notification pipeline.
8. **Cycle 20 fds.meal.served emit shape** — LunchAccountConsumer expects `{studentId, schoolId, mealDate, amount, posDeviceId, posSessionId, servedAt}`. Confirm Cycle 20's existing `fds.transaction.completed` either renames or extends to match this shape (or this consumer subscribes to whatever Cycle 20 actually emits).
9. **Sibling discount eldest-first ordering** if admins want a strict ordering vs the count-based approach.
10. **Test sweep** — unit + integration coverage matching the Cycles 9 + 10 + 11 + 12 precedent.

---

## CI

- `pnpm format:check` — green on 620 files (auto-fixed 19 P2-6 files via `pnpm format`).
- `pnpm lint:logs` — green (620 files clean).
- `pnpm --filter @campusos/api build` — clean on first attempt after `IsObject` unused-import removal.
- API boots cleanly; all 45 `/api/v1/payments/*` routes register; LunchAccountConsumer subscribes; AutoInvoiceWorker scaffolds.

Awaiting peer review verdict before tagging `p2c6-complete`.
