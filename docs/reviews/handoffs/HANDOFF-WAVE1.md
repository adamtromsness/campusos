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
| 7    | `m83-finance/gl-posting.spec.ts` (posting + IMMUTABLE trigger)             | ⏳ pending  |
| 8    | `m83-finance/budget-management.spec.ts`                                     | ⏳ pending  |
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

### Finding 3 — Migration splitter chokes on migration 180

`packages/database/prisma/tenant/migrations/180_p2h5_sis_family_court_order_restrictions.sql`
violates the `CLAUDE.md` rule "Never put a `;` inside a string literal or
block comment" — its `COMMENT ON COLUMN` text contains four semicolons
(`tokens; values`, `denies; missing`). The provisioning splitter breaks the
single statement into multiple fragments and errors with "unterminated /*
comment". As a result `pnpm --filter @campusos/database exec tsx
src/provision-tenant.ts --subdomain=test` fails at migration 180, and any
migrations numbered 180+ that haven't already been applied are blocked.

Today `tenant_test` is past 180 (181 is applied) only because the schema
predates the rule violation. Fresh provisioning would fail. Fix is to
replace the four `;` in the COMMENT string with `,` or `—`.

Out of scope for Wave 1, but a 1-line fix once someone wants to re-provision.

## Files touched

```
apps/api/test/integration/helpers/tenant-context.ts        — +TEST_SCHOOL_B_ID, withTestTenantB
apps/api/test/integration/fixtures/platform.ts             — +School B school + routing
apps/api/test/integration/fixtures/finance.ts              — +REVENUE/AP accounts, +School B mirror, +is_system flag on Cash/AR/AP
apps/api/test/integration/helpers/reset.ts                 — +resetFinanceTables, +resetFinanceAdvancedTables
apps/api/test/integration/m83-finance/chart-of-accounts.spec.ts  — NEW (68 tests, 1 documented skip)
apps/api/src/modules/m83-finance/chart.service.spec.ts     — DELETED (mock spec replaced)
```

## Test counts

| Suite              | Before | After |
| ------------------ | ------ | ----- |
| Unit tests         | 2858   | 2845 (2791 passed + 54 skipped) |
| Integration tests  | 145    | 213  (212 passed + 1 documented skip) |

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
