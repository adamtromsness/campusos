# Wave 8 Final Verification

Date: 2026-05-21

Scope: `m09-behaviour`, `m24-library`, `m26-portfolio`, `m60-tickets`, `m02-workflows`, `m03-tasks`, `m80-hr`, `m82-substitutes`, `m90-visitors`, `m110-analytics`, and `shared/`.

## Step 1 - Full Suite Stability

Command:

```bash
pnpm --filter @campusos/api test:integration
```

Result: GREEN.

| Test Files | Total Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| 277 passed | 7553 | 7536 | 0 | 17 |

## Step 2 - Per-Target Coverage

Coverage command pattern:

```bash
pnpm --filter @campusos/api exec vitest run \
  --config vitest.integration.config.ts --coverage \
  --coverage.include="src/modules/${module}/**" \
  --coverage.exclude='**/*.dto.ts' --coverage.exclude='**/*.module.ts' \
  --coverage.exclude='**/index.ts' \
  --coverage.reporter=text-summary \
  test/integration/${module}
```

Shared command:

```bash
pnpm --filter @campusos/api exec vitest run \
  --config vitest.integration.config.ts --coverage \
  --coverage.include='src/shared/**' \
  --coverage.exclude='**/*.dto.ts' --coverage.exclude='**/*.module.ts' \
  --coverage.exclude='**/index.ts' \
  --coverage.reporter=text-summary \
  test/integration/shared
```

| Module | Target | Measured % | Statements Covered / Total | Meets Target? |
| --- | ---: | ---: | ---: | --- |
| m09-behaviour | 80% | 97.00% | 3406 / 3511 | Yes |
| m24-library | 80% | 96.52% | 4249 / 4402 | Yes |
| m26-portfolio | 80% | 98.09% | 3455 / 3522 | Yes |
| m60-tickets | 80% | 80.39% | 1673 / 2081 | Yes |
| m02-workflows | 80% | 97.27% | 751 / 772 | Yes |
| m03-tasks | 80% | 88.48% | 991 / 1120 | Yes |
| m80-hr | 80% | 92.64% | 6388 / 6895 | Yes |
| m82-substitutes | 80% | 96.27% | 2510 / 2607 | Yes |
| m90-visitors | 80% | 88.78% | 1820 / 2050 | Yes |
| m110-analytics | 80% | 88.45% | 3679 / 4159 | Yes |
| shared/ | 80% | 49.86% | 1788 / 3586 | No |

Notes:

- The first coverage loop hit transient Prisma `P1001` database connection errors for some targets. Retried target-specific runs completed successfully and the table above uses successful runs only.
- `m60-tickets` clears the target but has little margin at 80.39%.
- `shared/` fails the Wave 8 target at 49.86%.

## Global Coverage

Command:

```bash
pnpm --filter @campusos/api exec vitest run \
  --config vitest.integration.config.ts --coverage \
  --coverage.include='src/modules/**' \
  --coverage.include='src/shared/**' \
  --coverage.exclude='**/*.dto.ts' --coverage.exclude='**/*.module.ts' \
  --coverage.exclude='**/index.ts' \
  --coverage.reporter=text-summary \
  test/integration
```

Result: GREEN.

| Metric | Coverage | Covered / Total |
| --- | ---: | ---: |
| Statements | 87.18% | 133744 / 153398 |
| Branches | 84.81% | 28135 / 33171 |
| Functions | 91.20% | 7423 / 8139 |
| Lines | 87.18% | 133744 / 153398 |

## Step 3 - Quality Checks

| Check | Result | Evidence |
| --- | --- | --- |
| DB-backed, no mocks | PASS | No `vi.fn()` or `vi.mock()` found in Wave 8 integration target files. Tests use real `TenantPrismaService` and live DB setup. |
| Real state assertions via raw SQL | PASS | Wave 8 specs use `$queryRaw` / `$executeRaw` to verify persisted rows, outbox rows, immutable triggers, tenant state, and isolation. |
| Cross-school isolation for each module | PASS | Each module has School A/B isolation coverage asserting `NotFoundException`, empty results, or scoped rows only. |
| `tkt_ticket_activity` immutable | PASS | `m60-tickets/ticket-lifecycle.spec.ts` verifies INSERT succeeds and UPDATE/DELETE raise SQLSTATE `23001`. |
| `@StudentOwned` on portfolio reflections | PASS | `portfolio-advanced.controller.ts` applies `@StudentOwned` to reflection routes; integration tests cover owner/admin/non-owner/cross-school behavior. |
| OutboxPublisherWorker drain + idempotency | PASS | `shared/outbox-publisher.spec.ts` covers pending-row drain/retry behavior; shared Kafka/idempotency specs cover duplicate suppression. |
| Tenant `is_frozen` gate + `SET LOCAL` verification | PASS | `shared/tenant-context.spec.ts` verifies `SET LOCAL search_path` behavior, non-leakage outside transaction, and frozen-tenant blocking. |
| `sub.assignment.confirmed` event | PASS | `m82-substitutes/substitutes-lifecycle.spec.ts` verifies confirmed assignment outbox emission and consumer handling. |
| Payroll GL emit on wage processing | PASS | `m80-hr/payroll-lifecycle.spec.ts` verifies `hr.payroll.processed` outbox emission; `m83-finance/gl-consumer.spec.ts` verifies GL consumer handling in the full suite. |
| Old mock specs removed from source modules | DEFECT for shared target | Wave 8 source module directories have no `*.spec.ts`, but `apps/api/src/shared/**` still contains source-tree specs under `dlq`, `observability`, `kafka`, `tenant`, `auth`, and `__tests__`. |
| No test asserts a leak as expected behavior | PASS for Wave 8 targets | Target-scope review found no Wave 8 test asserting cross-school leakage as expected behavior. |

Observed out-of-scope suite concern: the full suite still prints an `m66-athletics` test titled `School A admin can list School B rosters (no school scope on listForSeason - relies on season visibility)`. That module is outside Wave 8 scope, so it is not counted in this verdict, but it should be reviewed separately.

## Step 4 - Verdict

| Module | Target | Measured % | Meets Target? |
| --- | ---: | ---: | --- |
| m09-behaviour | 80% | 97.00% | Yes |
| m24-library | 80% | 96.52% | Yes |
| m26-portfolio | 80% | 98.09% | Yes |
| m60-tickets | 80% | 80.39% | Yes |
| m02-workflows | 80% | 97.27% | Yes |
| m03-tasks | 80% | 88.48% | Yes |
| m80-hr | 80% | 92.64% | Yes |
| m82-substitutes | 80% | 96.27% | Yes |
| m90-visitors | 80% | 88.78% | Yes |
| m110-analytics | 80% | 88.45% | Yes |
| shared/ | 80% | 49.86% | No |

Final verdict: FAIL.

Reason: the full integration suite is green with 0 failures, and 10 of 11 Wave 8 targets meet the 80% statement threshold, but `shared/` is only 49.86%. Additionally, if `shared/` is treated as part of the old-source-spec removal requirement, source-tree shared specs remain and should be migrated or explicitly exempted.

## Prioritized Fix List

1. Raise `src/shared/**` integration coverage from 49.86% to at least 80%, or narrow the shared Wave 8 coverage target to the intended shared runtime surface.
2. Decide whether `apps/api/src/shared/**/*.spec.ts` and `apps/api/src/shared/__tests__/*.spec.ts` are exempt from the old mock spec removal rule. If not exempt, migrate valid shared tests into `apps/api/test/integration/shared` or an approved unit-test location outside `src/shared`.
3. Add focused shared integration coverage for currently uncovered shared services, guards, tenant helpers, Kafka helpers, and observability utilities.
4. Review the out-of-scope `m66-athletics` roster visibility test separately, because its title suggests cross-school visibility may still be accepted behavior outside Wave 8.
