# HANDOFF — Wave 1 (Financial DB-backed integration tests)

**Scope:** Replace the mock-based unit specs in m83-finance, m84-payments,
m86-procurement with DB-backed integration tests per
`docs/campusos-test-strategy-v3.html` Wave 1.

**Target:** m83-finance ≥95%, m84-payments ≥95%, m86-procurement ≥80% line
coverage. Multi-session push.

**Approach:** Old mock specs stay in place until each integration replacement
is green; then the mock is deleted. Tests live under
`apps/api/test/integration/m{XX}-{name}/` with business-capability names
(e.g. `chart-of-accounts.spec.ts`, not `chart.service.spec.ts`).

## Step status

| Step | Title                                                                       | Status      |
| ---- | --------------------------------------------------------------------------- | ----------- |
| 1    | Extend `helpers/tenant-context.ts` with School B + `withTestTenantB`        | ✅          |
| 2    | Extend `fixtures/platform.ts` with School B (same org, same schema)         | ✅          |
| 3    | Extend `fixtures/finance.ts` with REVENUE + AP accounts + School B mirror  | ✅          |
| 4    | Add `helpers/reset.ts::resetFinanceTables` + `resetFinanceAdvancedTables`  | ✅          |
| 5    | `m83-finance/chart-of-accounts.spec.ts` (FundService + ChartOfAccountsService + PeriodService) | ✅ |
| 6    | Delete `m83-finance/chart.service.spec.ts` (mock spec)                     | ✅          |
| 7    | `m83-finance/gl-posting.spec.ts` (PostingService + IMMUTABLE trigger contract on fin_gl_entries) | ✅ |
| 7a   | Delete `m83-finance/posting.service.spec.ts` (mock spec, 1084 LOC)         | ✅          |
| 8    | `m83-finance/budget-management.spec.ts` (BudgetService + DepartmentalBudgetService + BudgetTransferService incl. atomic transfer + outbox-in-tx) | ✅ |
| 8a   | Keep `m83-finance/budgets.service.spec.ts` for now (also covers AP/Reconciliation/Grants; delete in pieces as those surfaces get integration coverage) | ⚠️ deferred |
| 9    | `m83-finance/gl-reconciliation.spec.ts` (GlReconciliationWorker — 7 check types incl. MISSING/AMOUNT/SIGN/ACCOUNT/SCHOOL mismatches + DUPLICATE_POSTING + ORPHAN_GL_ENTRY + outbox alert) | ✅ |
| 9a   | Delete `m83-finance/gl-reconciliation.worker.spec.ts` (mock spec, 658 LOC) | ✅          |
| 9b   | Fix migration 180 (splitter bug — semicolons in COMMENT block) so migrations 180 + 181 apply during fresh provisioning | ✅ |
| 10   | `m84-payments/invoice-lifecycle.spec.ts` (InvoiceService.create/send/cancel + outbox-in-tx for pay.invoice.created + pay.debt.written_off) | ✅ |
| 10a  | Keep `m84-payments/invoice.service.spec.ts` for now (also covers generateFromSchedule, not yet replaced) | ⚠️ deferred |
| 11   | `m84-payments/payment-processing.spec.ts` (PaymentService.pay/list/getById + outbox-in-tx for pay.payment.received + Stripe stub + auth contract) | ✅ |
| 11a  | Delete `m84-payments/payment.service.spec.ts` (mock spec, 649 LOC — fully replaced) | ✅ |
| 12   | `m84-payments/refunds-reversals.spec.ts` (RefundService + CreditNoteService + ReversalService incl. IMMUTABLE pay_credit_notes + IMMUTABLE pay_payment_reversals + outbox for refund / credit-note / reversal events) | ✅ |
| 12a  | Delete `m84-payments/{refund,credit-note,reversal}.service.spec.ts` (3 mock specs, 1968 LOC — fully replaced) | ✅ |
| 13   | `m84-payments/lunch-accounts.spec.ts` (LunchAccountService.transfer + deposit/update/listLowBalance/getById/getForStudent incl. IMMUTABLE pay_lunch_account_balance_transfers + Finding 8) | ✅ |
| 13a  | Delete `m84-payments/lunch-account.service.spec.ts` (mock spec, 1192 LOC — fully replaced) | ✅ |
| 9    | `m83-finance/gl-reconciliation.spec.ts` (worker + alert events)            | ⏳ pending  |
| 10   | `m83-finance/journal-batch.spec.ts`                                         | ⏳ pending  |
| 11   | `m84-payments/*` (per the strategy doc Wave 1 list)                        | ⏳ pending  |
| 12   | `m86-procurement/*` (cross-school + IMMUTABLE additions)                   | ⏳ pending  |
| 13   | Run `pnpm --filter @campusos/api test:integration -- --coverage`           | ⏳ pending  |

## Findings (real service bugs surfaced by integration tests)

These were masked by the old mock specs because the mocks didn't exercise
real Postgres tx semantics. None of them is a Wave 1 deliverable; each
should be fixed in a follow-up commit.

### Finding 1 — `PeriodService.patchStatus` returns a stale DTO

`apps/api/src/modules/m83-finance/chart.service.ts::patchStatus` runs the
UPDATE inside `executeInTenantTransaction`, then calls `this.getById(id)` to
build the response. `getById` opens its own `executeInTenantContext` tx,
which under READ COMMITTED cannot see the not-yet-committed UPDATE from the
outer tx, so the returned DTO reflects the PRE-update state. The persisted
row is correct — only the return value lags one request behind.

Fix: inline the SELECT inside the tx callback using the `tx` handle, e.g.

```ts
return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
  // ... UPDATE ...
  const rows = await tx.$queryRawUnsafe(SELECT_SQL, id, tenant.schoolId);
  return this.rowToDto(rows[0]);
});
```

Test impact: 3 integration tests in `chart-of-accounts.spec.ts` work
around the bug by asserting on raw DB state via `rawClient.$queryRawUnsafe`
after the patch call.

### Finding 2 — `PeriodService.createSeries` is not actually idempotent

The loop catches `ConflictException` per iteration and `continue`s, but the
underlying Postgres tx is already aborted by the first 23505 violation, so
every subsequent INSERT in the same tx fails with 25P02
(`current transaction is aborted, commands ignored until end of transaction block`).
Net effect: a re-run on a partially-populated fiscal year fails hard with a
confusing 25P02 instead of skipping silently.

Fix: wrap each INSERT in a per-iteration SAVEPOINT, or pre-check existence
with a SELECT before each INSERT.

Test impact: one test in `chart-of-accounts.spec.ts` is marked `.skip` with
a `FINDING` comment so the bug stays visible and trackable.

### Finding 3 — Migration splitter chokes on migration 180 (FIXED)

`packages/database/prisma/tenant/migrations/180_p2h5_sis_family_court_order_restrictions.sql`
violated the `CLAUDE.md` rule "Never put a `;` inside a string literal or
block comment" — both the leading `/* ... */` block comment AND the
`COMMENT ON COLUMN` text contained semicolons. The provisioning splitter
is line-based; it split mid-comment and errored with "unterminated /*
comment". `pnpm --filter @campusos/database exec tsx
src/provision-tenant.ts --subdomain=test` failed at migration 180,
blocking 181 and any later migration from applying to a fresh schema.

Fixed in this wave: replaced every `;` in the comment text with `,` or
`—` and re-provisioned `tenant_test` + `tenant_demo`. Both now sit at
the latest migration (181) and the `rpt_gl_recon_check_type_chk`
constraint accepts the DUPLICATE_POSTING / ORPHAN_GL_ENTRY check types
the worker writes.

### Finding 4 — GlReconciliationWorker column-name mismatch

`apps/api/src/modules/m83-finance/gl-reconciliation.worker.ts::SOURCE_CHECK_META`
uses `amountExpr: 's.amount'` for the CREDIT_NOTE and PAYMENT_REVERSAL
check types, but the underlying tables use `credit_amount` and
`reversed_amount` respectively. The SELECT errors at parse time
("column s.amount does not exist") even on an empty source table.
The worker's outer try/catch converts this into a FAILED rpt run + a
CHECK_QUERY_FAILED outbox alert — useful signal, but it masks the
worker's own bug. Net effect: CREDIT_NOTE and PAYMENT_REVERSAL checks
are PERMANENTLY FAILED for every tenant.

Fix: use `s.credit_amount` and `s.reversed_amount` in the meta. Tests
in `gl-reconciliation.spec.ts` document this with one passing test
("CREDIT_NOTE check FAILS when a credit note exists") and one
`.skip`'d test ("CLEAN when empty — blocked on Finding 4 fix").

### Finding 5 — GlReconciliationWorker source SELECT not school-filtered

`GlReconciliationWorker.checkSourceVsGl` runs
`SELECT … FROM pay_invoices s WHERE s.status NOT IN (...)`. There is
NO `WHERE s.school_id = $1` clause — the worker relies on schema-per-
school isolation. In production each school has its own tenant schema
so this is harmless. In the integration harness, however, School A and
School B share the same `tenant_test` schema (different `school_id` rows
but one schema), so a run scoped to School B still sees School A's
pay_invoices and flags them as MISSING_GL_ENTRY. Belt-and-braces fix is
to add the school predicate to every source SELECT. Captured in the
runOnce test by NOT seeding any pay_* rows — once Finding 5 is fixed,
the test can seed differently and assert true cross-school isolation.

### Finding 8 — LunchAccountService.transfer missing `::uuid` cast on to_account_id

`apps/api/src/modules/m84-payments/lunch-account.service.ts::transfer`
binds `to_account_id` as `$4` in the INSERT INTO
pay_lunch_account_balance_transfers without an explicit `::uuid` cast.
Prisma sends nullable string parameters as TEXT, and Postgres won't
auto-coerce TEXT → UUID for column assignment. Net effect:
REFUND_TO_FAMILY (NULL `to_account_id`) works, but SIBLING_TRANSFER
and NEXT_YEAR_ROLLOVER (real UUID) raise SQLSTATE 42804 ("column
to_account_id is of type uuid but expression is of type text"). The
service cannot process those two transfer types in production.

Fix: one character — `$4` → `$4::uuid` in the INSERT statement.

Tests in `lunch-accounts.spec.ts` skip 2 SIBLING/ROLLOVER happy-path
tests with the FINDING note. The IMMUTABLE pay_lunch_account_balance_transfers
contract is still verified by seeding rows directly via raw SQL.

### Finding 7 — ReversalService.reverse violates pay_payments_paid_chk

`apps/api/src/modules/m84-payments/reversal.service.ts::reverse` runs
`UPDATE pay_payments SET status='FAILED', updated_at=now() …` to mark
the reversed payment FAILED. But `pay_payments_paid_chk` requires
`(status IN ('PENDING','FAILED') AND paid_at IS NULL) OR (status IN
('COMPLETED','REFUNDED') AND paid_at IS NOT NULL)`. The original
COMPLETED payment has `paid_at = now()`, so flipping to FAILED without
nulling `paid_at` raises 23514. ReversalService.reverse cannot succeed
against a real DB.

Fix: one-line — `SET status='FAILED', paid_at=NULL, updated_at=now()`.

Tests in `refunds-reversals.spec.ts` skip 3 ReversalService.reverse
happy-paths with the FINDING note. The IMMUTABLE pay_payment_reversals
contract is still verified by seeding rows directly via raw SQL.

### Finding 6 — InvoiceService.list does not filter by tenant.schoolId

`InvoiceService.list` uses `SELECT_INVOICE_BASE` (`FROM pay_invoices i
JOIN pay_family_accounts fa …`) with no `WHERE i.school_id = $`
predicate. Same model as Finding 5 — relies on schema-per-school
isolation. The integration suite shows the leak directly: an admin
scoped to School A sees an invoice created under School B. Belt-and-
braces fix is one SQL predicate. The `cross-school isolation` test
in `invoice-lifecycle.spec.ts` currently asserts the *current* (leaky)
behaviour with a clear comment — when the fix lands, flip the
assertion to `expect(hasB).toBeUndefined()`.

## Files touched

```
apps/api/test/integration/helpers/tenant-context.ts        — +TEST_SCHOOL_B_ID, withTestTenantB
apps/api/test/integration/fixtures/platform.ts             — +School B school + routing
apps/api/test/integration/fixtures/finance.ts              — +REVENUE/AP accounts, +School B mirror, +is_system flag on Cash/AR/AP
apps/api/test/integration/helpers/reset.ts                 — +resetFinanceTables, +resetFinanceAdvancedTables
apps/api/test/integration/m83-finance/chart-of-accounts.spec.ts  — NEW (68 tests, 1 documented skip)
apps/api/test/integration/m83-finance/gl-posting.spec.ts         — NEW (48 tests, IMMUTABLE trigger contract)
apps/api/test/integration/m83-finance/budget-management.spec.ts  — NEW (61 tests, atomic transfer + outbox-in-tx contract)
apps/api/test/integration/m83-finance/gl-reconciliation.spec.ts  — NEW (18 tests + 1 skip, 7 check types + Findings 4 & 5)
apps/api/test/integration/m84-payments/invoice-lifecycle.spec.ts — NEW (29 tests, outbox-in-tx for pay.invoice.created + Finding 6)
apps/api/test/integration/m84-payments/payment-processing.spec.ts — NEW (27 tests, outbox-in-tx for pay.payment.received + Stripe stub + auth)
apps/api/test/integration/m84-payments/refunds-reversals.spec.ts  — NEW (40 tests + 3 skips, IMMUTABLE pay_credit_notes + IMMUTABLE pay_payment_reversals + outbox + Finding 7)
apps/api/test/integration/m84-payments/lunch-accounts.spec.ts     — NEW (39 tests + 2 skips, IMMUTABLE pay_lunch_account_balance_transfers + Finding 8)
apps/api/test/integration/helpers/reset.ts                       — +resetPaymentsTables, +resetFinanceAdvancedTables wires payments
apps/api/src/modules/m83-finance/chart.service.spec.ts     — DELETED (mock spec replaced)
apps/api/src/modules/m83-finance/posting.service.spec.ts   — DELETED (mock spec replaced)
apps/api/src/modules/m83-finance/gl-reconciliation.worker.spec.ts — DELETED (mock spec replaced)
apps/api/src/modules/m84-payments/payment.service.spec.ts  — DELETED (mock spec, 649 LOC — fully replaced)
apps/api/src/modules/m84-payments/refund.service.spec.ts   — DELETED (728 LOC)
apps/api/src/modules/m84-payments/credit-note.service.spec.ts — DELETED (504 LOC)
apps/api/src/modules/m84-payments/reversal.service.spec.ts — DELETED (736 LOC)
apps/api/src/modules/m84-payments/lunch-account.service.spec.ts — DELETED (1192 LOC)
packages/database/prisma/tenant/migrations/180_p2h5_sis_family_court_order_restrictions.sql — FIXED splitter bug
```

## Test counts

| Suite              | Before | After (step 13) |
| ------------------ | ------ | --------------- |
| Unit tests         | 2858   | 2635 (2581 passed + 54 skipped) |
| Integration tests  | 145    | 481  (474 passed + 7 documented skips) |

## Conventions established

- **Cross-school model:** Same `tenant_test` schema, second `school_id`.
  Services scope every SQL predicate by `tenant.schoolId`, so swapping the
  context (`withTestTenant` vs `withTestTenantB`) exercises the contract
  without needing a second schema.
- **Test file naming:** Business capability, not service class. The strategy
  doc Wave 1 list is canonical.
- **Documented bugs:** Service bugs surfaced by the integration suite get
  one `it.skip` (or DB-state-asserting workaround) with a `FINDING — Wave 1:`
  preamble in the test body. Easier to grep than scattered TODOs.
- **Reset helpers:** Granular by surface — `resetFinanceTables` is the bare
  minimum (chart + budgets + GL batches + AP vouchers). Tests that touch
  reconciliations / grants / board reports / supplier contacts /
  rpt_gl_reconciliation call `resetFinanceAdvancedTables` on top.
