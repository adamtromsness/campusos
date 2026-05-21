# Wave 1 Integration Test Quality Review

Date: 2026-05-17

Scope:

- `apps/api/test/integration/m83-finance/*.spec.ts`
- `apps/api/test/integration/m84-payments/*.spec.ts`
- `apps/api/test/integration/m86-procurement/*.spec.ts`
- `apps/api/test/integration/procurement/*.spec.ts`
- old source-module specs under `apps/api/src/modules/m83-finance`, `m84-payments`, and `m86-procurement`

I reviewed test quality, not just existence. I did not execute the full integration suite; this is a code review of the tests and their assertions.

## Overall Verdict

**CONCERN / DEFECTS REMAIN**

The new integration tests are generally real DB-backed tests: they instantiate real services with `TenantPrismaService`, run against `tenant_test`, and include raw SQL state assertions. That is a major improvement over the old mock-based specs.

The main remaining defects are:

- Old mock specs still exist under all three source module directories.
- Some m84 cross-school tests intentionally document data leaks instead of asserting the fixed NotFound / no-leak behavior.
- Several important paths are skipped, including payment reversals, lunch-account transfer happy paths, and procurement cross-school PO/distribution coverage.
- Atomic operation coverage is incomplete for ticket sales, gift card redemption, promotion max-uses, and executable budget-transfer lock-order/concurrency behavior.

## Per File Review

| Test file                                            | Result      | Notes                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m83-finance/budget-management.spec.ts`              | **SOUND**   | Real `TenantPrismaService` at lines 72-84; raw SQL state and outbox assertions at lines 693-720 and 738-761; cross-school NotFound at lines 975-1008. Budget transfer rollback is tested, but no executable concurrent lock-order test.                                                                                                                       |
| `m83-finance/chart-of-accounts.spec.ts`              | **CONCERN** | DB-backed and has cross-school NotFound/list tests, but `createSeries is idempotent` is skipped at line 726.                                                                                                                                                                                                                                                  |
| `m83-finance/gl-posting.spec.ts`                     | **SOUND**   | DB-backed at lines 62-63; raw SQL checks for journal batches / GL entries; cross-school NotFound at lines 294-311 and 597-603; immutable `fin_gl_entries` UPDATE/DELETE trigger tests at lines 689-756.                                                                                                                                                       |
| `m83-finance/gl-reconciliation.spec.ts`              | **CONCERN** | Covers missing GL, amount mismatch, sign mismatch, account mismatch, duplicate posting, orphan GL, and alert outbox. Concern: duplicate test drops/recreates the unique index at lines 561-607, which is heavy for integration tests and can hide migration/index problems. One credit-note clean-path test is skipped at line 748 due to a known worker bug. |
| `m84-payments/invoice-lifecycle.spec.ts`             | **DEFECT**  | DB-backed and verifies `pay.invoice.created` outbox. But the cross-school list test documents a live leak: lines 635-650 say School A sees School B invoices and assert `hasB` is defined. Fix service and flip this test to assert School B rows are absent; add/getById NotFound coverage for School B invoice as admin.                                    |
| `m84-payments/payment-processing.spec.ts`            | **DEFECT**  | DB-backed and verifies `pay.payment.received` outbox at lines 174-185. But the cross-school list test documents a live leak: lines 529-536 say School A sees School B payments and assert the School B payment is visible. Fix list scoping and flip the assertion.                                                                                           |
| `m84-payments/refunds-reversals.spec.ts`             | **CONCERN** | DB-backed, verifies `pay.refund.issued` outbox at lines 199-210, and covers immutable `pay_credit_notes` / `pay_payment_reversals`. Concern: important payment reversal behavior is skipped at lines 684, 736, and 856.                                                                                                                                       |
| `m84-payments/lunch-accounts.spec.ts`                | **DEFECT**  | DB-backed and covers insufficient-balance no-write at lines 252-280 plus immutable transfer trigger tests at lines 444-520. Defect: sibling transfer and rollover happy paths are skipped at lines 173 and 199 because the service cannot write those rows.                                                                                                   |
| `m84-payments/payment-plans.spec.ts`                 | **SOUND**   | DB-backed with raw SQL assertions and NotFound paths. No mocking found.                                                                                                                                                                                                                                                                                       |
| `m84-payments/late-fees.spec.ts`                     | **CONCERN** | DB-backed and includes school-scope scan coverage. Concern: policy upsert test is skipped at line 209.                                                                                                                                                                                                                                                        |
| `m84-payments/financial-aid.spec.ts`                 | **CONCERN** | DB-backed at lines 54-58 and has cross-school NotFound tests at lines 325-334 and 602-615. Concern: happy path and fund lockstep tests are skipped at lines 212 and 350.                                                                                                                                                                                      |
| `m86-procurement/cross-school-and-immutable.spec.ts` | **CONCERN** | DB-backed and has School B requisition -> School A NotFound at lines 110-134. Immutable `fds_inventory_transactions` is covered at lines 204-303. Concern: PO and distribution cross-school tests are skipped at lines 145 and 198.                                                                                                                           |
| `procurement/requisitions.spec.ts`                   | **SOUND**   | DB-backed with real `RequisitionService`, real tenant DB, raw SQL assertions, and `RecordingKafkaProducer`; no mocks.                                                                                                                                                                                                                                         |
| `procurement/purchase-orders.spec.ts`                | **SOUND**   | DB-backed with raw SQL keystone checks. PO ISSUE checks `fin_budget_lines.encumbered_amount` and `prc_budget_commitments` at lines 394-424; PO CANCEL releases at lines 495-526.                                                                                                                                                                              |
| `procurement/distribution-and-returns.spec.ts`       | **SOUND**   | DB-backed with raw SQL assertions and a concurrent returns test using `Promise.allSettled` at lines 540-551.                                                                                                                                                                                                                                                  |
| `procurement/procurement-settings.spec.ts`           | **SOUND**   | DB-backed at lines 25-29; raw SQL persistence/idempotency assertions at lines 60-90 and update persistence at lines 110-117.                                                                                                                                                                                                                                  |

## 1. DB-Backed, Not Mock-Based

Result: **SOUND for integration tests; DEFECT for old source specs**

The integration tests do not use `vi.fn()`, `vi.mock()`, `jest.fn()`, or mocked Prisma DB calls. They instantiate real `TenantPrismaService` and real service classes.

Evidence:

- `apps/api/test/integration/m83-finance/budget-management.spec.ts:72` creates `new TenantPrismaService()`.
- `apps/api/test/integration/m84-payments/invoice-lifecycle.spec.ts:67` creates `new TenantPrismaService()`.
- `apps/api/test/integration/m86-procurement/cross-school-and-immutable.spec.ts:60` creates `new TenantPrismaService()`.
- `apps/api/test/integration/procurement/requisitions.spec.ts:91` creates `new TenantPrismaService()`.
- No `vi.fn()` / `vi.mock()` usage was found under `apps/api/test/integration`; `RecordingKafkaProducer` is an explicit event-recorder helper, not a DB mock.

Defect: old source-module specs remain and are mock-based.

Examples:

- `apps/api/src/modules/m86-procurement/procurement.controller.spec.ts:22` states it is mock-based, and lines 59-97 build `vi.fn()` service stubs.
- `apps/api/src/modules/m84-payments/invoice.service.spec.ts:71` starts a fake-DB fixture shape instead of using a real DB.
- `apps/api/src/modules/m83-finance/gl.consumer.spec.ts:50` defines `makeTenantPrisma()` with fake `$queryRawUnsafe`.

Fix: remove or relocate old mock specs outside the Wave 1 replacement scope. If controller unit tests are intentionally retained, rename/scope them so they are not counted as replacement financial integration coverage.

## 2. Real State Assertions

Result: **SOUND**

The integration files include raw SQL state assertions after service calls. They do not rely only on service return values.

Examples:

- `gl-posting.spec.ts:121` queries `tenant_test.fin_gl_entries`.
- `invoice-lifecycle.spec.ts:120` queries `platform.platform_outbox`.
- `payment-processing.spec.ts:159` queries `pay_invoices`, and lines 166-168 query `pay_ledger_entries`.
- `refunds-reversals.spec.ts:181` queries payment/invoice state, and lines 191-193 query `pay_ledger_entries`.
- `purchase-orders.spec.ts:417` queries `fin_budget_lines`, and lines 424-425 query `prc_budget_commitments`.
- `procurement-settings.spec.ts:63` queries `prc_procurement_settings`.

## 3. Cross-School Isolation

Result: **CONCERN / DEFECT**

There is at least one cross-school test for each module, but the quality is uneven.

Sound examples:

- m83 finance: `chart-of-accounts.spec.ts:119-121` asserts School A cannot read School B fund; `gl-posting.spec.ts:294-311` asserts School A cannot post School B batch; `budget-management.spec.ts:975-1008` asserts School A cannot read School B budget transfer.
- m84 payments: `financial-aid.spec.ts:325-334` and `602-615` assert School A receives `NotFoundException` for School B records; `lunch-accounts.spec.ts:374-415` covers cross-school transfer endpoints.
- m86 procurement: `cross-school-and-immutable.spec.ts:110-134` asserts School A gets `NotFoundException` for a School B requisition.

Defects:

- `invoice-lifecycle.spec.ts:635-650` documents and asserts that School A sees School B invoices via list.
- `payment-processing.spec.ts:529-536` documents and asserts that School A sees School B payments via list.

Concerns:

- `m86-procurement/cross-school-and-immutable.spec.ts:145` skips PO cross-school getById coverage.
- `m86-procurement/cross-school-and-immutable.spec.ts:198` skips distribution cross-school coverage.

Fix: flip the m84 leak-documenting tests to assert no School B rows after fixing list predicates; unskip m86 PO/distribution cross-school coverage with full fixture setup.

## 4. Immutable Trigger Tests

Result: **SOUND with one caveat**

Required immutable tables are covered:

- `fin_gl_entries`: `gl-posting.spec.ts:689-756` tests UPDATE and DELETE failures after service-created inserts.
- `pay_credit_notes`: `refunds-reversals.spec.ts:598-669` seeds via service and tests UPDATE and DELETE failures.
- `pay_payment_reversals`: `refunds-reversals.spec.ts:882-956` inserts directly and tests UPDATE and DELETE failures.
- `pay_lunch_account_balance_transfers`: `lunch-accounts.spec.ts:446-519` inserts directly and tests UPDATE and DELETE failures.
- `fds_inventory_transactions`: `cross-school-and-immutable.spec.ts:206-303` inserts directly and tests UPDATE and DELETE failures.

Caveat: several immutable tests seed via direct SQL rather than service methods. That is acceptable for trigger-contract coverage, but it does not prove the service can create all those rows. This matters for lunch transfers, where the service happy paths are skipped.

## 5. Outbox Atomicity

Result: **SOUND for required financial events**

The required payment/finance event tests query `platform.platform_outbox` after real service calls.

Evidence:

- `pay.invoice.created`: `invoice-lifecycle.spec.ts:247-285` verifies send writes the outbox event.
- `pay.payment.received`: `payment-processing.spec.ts:144-185` verifies payment state, ledger entry, and outbox event.
- `pay.refund.issued`: `refunds-reversals.spec.ts:180-210` verifies payment/invoice state, ledger entry, and outbox event.

Additional positive coverage:

- `fin.budget_transfer.approved`: `budget-management.spec.ts:704-720` verifies the outbox row lands with the budget mutations.

## 6. GL Reconciliation

Result: **SOUND with one test-quality concern**

Coverage exists for all requested scenarios:

- Missing GL entry: `gl-reconciliation.spec.ts:294-327`.
- Amount mismatch: `gl-reconciliation.spec.ts:356-381`.
- Sign comparison: `gl-reconciliation.spec.ts:383-406`.
- Account comparison: `gl-reconciliation.spec.ts:408-429`.
- Duplicate posting: `gl-reconciliation.spec.ts:548-609`.
- Orphan GL entry: `gl-reconciliation.spec.ts:638-667`.
- Alert event emission: `gl-reconciliation.spec.ts:314-326` queries `platform_outbox` for `fin.gl_reconciliation.discrepancy`.

Concern: duplicate posting coverage drops and recreates `fin_batches_source_event_uq` at `gl-reconciliation.spec.ts:561-607`. That makes the test capable of creating a corruption shape, but it also mutates schema state inside a test. Prefer seeding duplicates through a purpose-built test-only fixture path, or isolate this in a transaction/schema that cannot affect later tests.

## 7. Budget Commitment Keystone

Result: **SOUND**

`purchase-orders.spec.ts` verifies the keystone via raw SQL:

- Before issue, `fin_budget_lines.encumbered_amount` is checked at lines 394-397.
- After PO ISSUE, `fin_budget_lines.encumbered_amount` is checked at lines 417-420.
- `prc_budget_commitments` is checked at lines 424-425.
- PO CANCEL releases commitment and encumbrance at lines 495-526.

## 8. Atomic Operations

Result: **DEFECT / CONCERN**

Covered:

- Budget transfer insufficient-balance rollback: `budget-management.spec.ts:723-761`.
- Procurement returns concurrency: `distribution-and-returns.spec.ts:540-551`.
- Lunch account insufficient transfer: `lunch-accounts.spec.ts:252-280`.

Defects / gaps:

- Gift card redemption over-balance was not found in these Wave 1 integration tests.
- Promotion `max_uses` exhaustion was not found in these Wave 1 integration tests.
- Ticket sales concurrency/edge cases were not found in these Wave 1 integration tests.
- Budget transfer lock ordering is described in comments at `budget-management.spec.ts:54-56`, but I did not find an executable concurrency/deadlock-order test.
- Lunch-account SIBLING_TRANSFER and NEXT_YEAR_ROLLOVER happy paths are skipped at `lunch-accounts.spec.ts:173` and `199`.

Fix: add DB-backed tests for the missing atomic cases and make the lock-ordering/concurrency claims executable.

## 9. Old Mock Specs Removed

Result: **DEFECT**

Old `*.spec.ts` files still remain inside all three source module directories.

Examples:

- `apps/api/src/modules/m83-finance/budgets.service.spec.ts`
- `apps/api/src/modules/m83-finance/gl.consumer.spec.ts`
- `apps/api/src/modules/m83-finance/journal-batch-posted.consumer.spec.ts`
- `apps/api/src/modules/m84-payments/invoice.service.spec.ts`
- `apps/api/src/modules/m84-payments/payments-advanced.spec.ts`
- `apps/api/src/modules/m84-payments/controllers-batch.spec.ts`
- `apps/api/src/modules/m84-payments/ledger.service.spec.ts`
- `apps/api/src/modules/m86-procurement/procurement.controller.spec.ts`

These are not harmless under the stated requirement. The user instruction says the Wave 1 integration tests replace old mock-based specs and any remaining spec under these modules is a defect.

Fix: delete the old mock specs or move deliberately retained unit/controller specs to a clearly separate unit-test location excluded from the Wave 1 replacement criterion.
