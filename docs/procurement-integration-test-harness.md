# Procurement Integration Test Harness — Design

**Status:** Design proposal, awaiting sign-off.
**Goal:** Lift `apps/api/src/procurement` from **0% → ≥80%** line coverage with database-backed integration tests per the Tier 1 test-coverage plan rule ("Every test is DATABASE-BACKED. No mocks for DB queries.").
**Sized for:** 2–3 loops. This loop = design + scaffold. Next loop(s) = test bodies.

---

## Scope

### In scope (1,887 LOC of executable code)

| File | LOC | Services |
|---|---|---|
| `requisitions.service.ts` | 516 | `RequisitionService` |
| `purchase-orders.service.ts` | 797 | `PurchaseOrderService`, `GoodsReceiptService` |
| `distribution.service.ts` | 604 | `DistributionService`, `ReturnService`, `VendorPerformanceService`, `ProcurementSettingsService` |
| `procurement.controller.ts` | 270 | `ProcurementController` (28 endpoints) |

Three structural keystones to verify with **real DB state assertions**:

1. **Budget commitment.** `PurchaseOrderService.transition({action:'ISSUE'})` must atomically create a `prc_budget_commitments` row + bump `fin_budget_lines.encumbered_amount` in one tenant tx. CLOSE/CANCEL must release symmetrically.
2. **Cross-module distribution emit.** `DistributionService.create()` must write `prc_distributions` + `prc_distribution_lines` + emit `prc.distribution.completed` AFTER tx commits with the correct `destination_module` payload field.
3. **Vendor performance auto-scoring.** `GoodsReceiptService.create()` must atomically UPSERT `prc_vendor_performance` with on-time + quality scores in the same tx as the receipt insert + PO status flip.

### Explicitly out of scope

- DTO files (excluded from coverage per [the Tier 1 status doc](./campusos-test-coverage-plan.html)).
- `procurement.module.ts` (NestJS DI wiring, excluded).
- Concurrent-race tests requiring multiple Node processes (the design lays groundwork; first set of tests uses single-process atomicity assertions).
- Approval-workflow integration with `wsk_approval_requests` (current procurement implementation uses direct admin transitions; the workflow path is deferred to Phase 2 per the module-level doc).

---

## Architecture overview

```
apps/api/test/integration/                  ← new, all integration test files live here
├── setup.ts                                ← one-time per-suite: connect, ensure tenant_test, seed prereqs
├── teardown.ts                             ← one-time per-suite: disconnect
├── fixtures/
│   ├── platform.ts                         ← school, organisation, iam_person, platform_users
│   ├── employees.ts                        ← hr_employees rows (Rivera, Mitchell, Hayes)
│   ├── finance.ts                          ← fin_suppliers, fin_funds, fin_chart_of_accounts, fin_budgets, fin_budget_lines
│   └── procurement.ts                      ← prc_procurement_settings + per-test prc_* row builders
├── helpers/
│   ├── tenant-context.ts                   ← wrap test body in runWithTenantContextAsync
│   ├── actor.ts                            ← builders for ResolvedActor (admin/staff/student/parent)
│   ├── recording-kafka.ts                  ← KafkaProducerService stand-in that records emit() calls
│   └── reset.ts                            ← truncate-procurement-tables-between-tests helper
└── procurement/
    ├── requisitions.spec.ts
    ├── purchase-orders.spec.ts
    ├── goods-receipts.spec.ts
    ├── distribution.spec.ts
    ├── returns.spec.ts
    ├── vendor-performance.spec.ts
    └── procurement-settings.spec.ts

apps/api/vitest.integration.config.ts       ← new vitest config for integration runs
apps/api/package.json                       ← new "test:integration" script
.github/workflows/...                       ← (future) CI integration job
```

---

## Six design decisions

### D1. Schema lifecycle — **dedicated `tenant_test` schema, provision once per suite**

**Choice.** Use the existing `tenant_test` schema (per CLAUDE.md, it exists by convention and stays empty so unit tests don't pollute it). The first integration test run executes `pnpm --filter @campusos/database exec tsx src/provision-tenant.ts --subdomain=test` if the schema isn't already provisioned. The full `prc_*` table set is created via the existing tenant migrations.

| Alternative | Why rejected |
|---|---|
| Per-test ephemeral schema (`tenant_test_<random>`) | Schema creation + 100+ migrations ≈ 10–15s per test. 50 tests × 15s = 12+ min wall time. Untenable. |
| Run against `tenant_demo` with tx rollback | `executeInTenantContext` already wraps the inner work in a Prisma `$transaction`. Nesting another tx around it requires SAVEPOINTs that Prisma doesn't expose cleanly. Also pollutes the demo state used for manual QA. |
| Per-test schema drop + recreate | Same speed problem as ephemeral; plus the cleanup is fragile under test crashes. |

**Tradeoff:** Tests share one schema. They must clean up after themselves or be safely parallel-resistant. See D2.

### D2. Per-test isolation — **truncate procurement tables before each test; serialise integration suite**

**Choice.** A `beforeEach` hook truncates the `prc_*` tables (in dependency order: distribution_lines → distributions → returns → goods_receipt_lines → goods_receipts → purchase_order_lines → purchase_orders → requisition_lines → requisitions → budget_commitments → vendor_performance → procurement_settings) under the test school's `school_id`. Prerequisite fixtures (school, employees, suppliers, budget) survive across tests — they're shared infrastructure, not what's being tested.

Vitest's `pool: 'forks'` + `poolOptions.forks.singleFork: true` in the integration config serialises tests so the truncate doesn't race.

| Alternative | Why rejected |
|---|---|
| Per-test SAVEPOINT rollback | Can't nest under `executeInTenantContext`'s inner tx without raw client surgery. |
| Unique school_id per test | Adds 50× the seed cost (one school + employees + budget per test). |
| Parallel tests with school_id namespacing | Would require seeding N parallel schools. Same cost problem. |

**Tradeoff:** Integration suite runs serially. Slower than parallel, but acceptable — procurement is ~15–25 tests, single-process serialised should complete in <60s.

### D3. Service instantiation — **direct `new ServiceClass(realDeps)`, match existing spec pattern**

**Choice.** Each test imports the service classes directly and calls `new RequisitionService(tenantPrismaService, recordingKafka, financeValidationService)`. No `@nestjs/testing.Test.createTestingModule`. The `TenantPrismaService` is a `new TenantPrismaService()` instance reused across all integration tests in the file.

| Alternative | Why rejected |
|---|---|
| `Test.createTestingModule` with full module imports | Drags in guards, middleware, controllers — heavyweight boot per suite. Existing 21 Wave 3 spec files all instantiate services directly. |
| Bootstrap full Nest app via supertest | Heavier still. Useful for end-to-end HTTP tests; overkill for service-layer assertions. |

**Tradeoff:** Bypasses controller-level decorators (`@RequirePermission`, validation pipes). Tests assert service behaviour, not HTTP layer behaviour. A future "controller spec" wave can add the HTTP layer separately.

### D4. Kafka — **recording stand-in, capture emit() calls for assertion**

**Choice.** A `RecordingKafkaProducer` exposes the same `emit(opts)` shape as `KafkaProducerService` and pushes each call onto an in-memory array. Tests assert on the recorded calls. No real Kafka broker required.

| Alternative | Why rejected |
|---|---|
| Real `KafkaProducerService` against the dev broker | Adds Kafka as a CI dependency. The "DATABASE-BACKED" rule is about DB queries, not transport. |
| Mock with `vi.fn()` and assert call args | Same thing; the recording shim is more explicit and reusable across suites. |

**Tradeoff:** Doesn't verify Kafka topic existence on the broker. The deterministic event_id + envelope shape is asserted from the recorded call.

### D5. CI integration — **separate `test:integration` script, opt-in**

**Choice.**
- `pnpm --filter @campusos/api test` keeps running existing 21 Wave 3 unit specs only (vitest config unchanged).
- New `pnpm --filter @campusos/api test:integration` runs only `test/integration/**/*.spec.ts` via a separate `vitest.integration.config.ts` that requires `DATABASE_URL` pointing at a `_dev` or `_test` database (safety check copied from `db-reset.ts`).
- Optional `pnpm --filter @campusos/api test:all` chains both.
- CI workflow: spin up docker-compose Postgres, run `db:reset` once, then `test:integration`. Future loop adds the workflow YAML.

**Tradeoff:** Two test commands. Dev can run unit tests without Postgres; integration tests are explicit.

### D6. File naming — **`*.spec.ts` under `test/integration/`**

**Choice.** Same `.spec.ts` suffix as unit specs (per the earlier user decision), separated by directory. `test/integration/procurement/requisitions.spec.ts`. The integration vitest config's `include` glob points at `test/integration/**/*.spec.ts`. The unit vitest config (existing, `root: './src'`) doesn't see them.

| Alternative | Why rejected |
|---|---|
| `*.integration.spec.ts` co-located in `src/` | User explicitly chose `.spec.ts` naming. Directory separation gives the same isolation without inventing a new suffix. |

---

## Fixture strategy

### One-time per suite (in `setup.ts`)

Created once when the test process starts. Idempotent — re-runs are no-ops if the rows already exist.

| Object | Purpose | Why fixed across tests |
|---|---|---|
| `platform.organisations` row "Test Org" | Owns the test school | Schema requires it. |
| `platform.schools` row "Test School" (`TEST_SCHOOL_ID`) | Tenant root | Every procurement test uses this `school_id`. |
| `platform.platform_tenant_routing` row | Maps subdomain → schema | Required for `TenantPrismaService` to find `tenant_test`. |
| `platform.iam_person` rows × 5 | Test actors (admin, officer-staff, teacher-staff, student, guardian) | Stable actor identities. |
| `platform.platform_users` rows × 5 | Login identities for the actors | Wired to iam_person. |
| `tenant_test.hr_employees` × 3 | Rivera (teacher), Mitchell (admin), Hayes (counsellor) | Procurement services dereference `hr_employees.id` for actor.employeeId. |
| `tenant_test.fin_suppliers` × 2 | "Test Vendor A" + "Test Vendor B" | PO needs a vendor reference. |
| `tenant_test.fin_funds` × 1 + `fin_chart_of_accounts` × 3 (Cash 1000, AR 1100, Supplies 5000) | GL account references | Budget lines + PO lines point at these. |
| `tenant_test.fin_accounting_periods` × 1 OPEN | Posting needs an open period | Some receipt+distribution paths may post. |
| `tenant_test.sis_academic_years` × 1 (current year) | Budget year ref | `fin_budgets.academic_year_id` FK. |
| `tenant_test.fin_budgets` × 1 + `fin_budget_lines` × 1 (Supplies, $10,000 budgeted, $0 actual, $0 encumbered) | Budget commitment keystone needs a real budget line | Tests bump + release encumbered_amount against this. |

### Per test (cleared in `beforeEach`)

Truncate-and-fresh rows in: `prc_distribution_lines`, `prc_distributions`, `prc_returns`, `prc_goods_receipt_lines`, `prc_goods_receipts`, `prc_purchase_order_lines`, `prc_purchase_orders`, `prc_requisition_lines`, `prc_requisitions`, `prc_budget_commitments`, `prc_vendor_performance`, `prc_procurement_settings`. Also reset `fin_budget_lines.encumbered_amount` to 0 since budget-commitment tests mutate it.

### Per test (built in test body via fixture helpers)

`fixtures/procurement.ts` exports `makeRequisition()`, `makePurchaseOrder()`, `makeGoodsReceipt()` builders that return seeded rows with sensible defaults + overrides. Each builder calls real Prisma inside `runWithTenantContextAsync` against the test tenant.

---

## What gets asserted (per the Tier 1 rules)

**Per the test-coverage plan:**

> Every test is DATABASE-BACKED. Seed real data, call real service methods, assert real DB state. No mocks for DB queries.
>
> Financial tests must verify actual GL entries exist with correct amounts, signs, accounts, and currencies after each operation.
>
> IMMUTABLE table tests: verify INSERT succeeds, UPDATE/DELETE throws.
>
> Atomic operation tests: run concurrent requests and verify no race conditions.
>
> Test both happy path AND error paths.

| Test class | Example assertion shape |
|---|---|
| Happy-path lifecycle | After `PurchaseOrderService.transition(po, ISSUE)`, raw-SQL `SELECT status, ... FROM prc_purchase_orders WHERE id = $1` returns `ISSUED` and a `prc_budget_commitments` row exists with `committed_amount` matching the PO total. |
| Budget commitment math | After ISSUE: `fin_budget_lines.encumbered_amount` increased by PO total. After CANCEL: decreased back. After CLOSE: also decreased. |
| Cross-school isolation | Seed a second school + PO; calling `RequisitionService.list(actorForSchoolA)` returns 0 rows referencing school B. |
| Kafka emit shape | `recordingKafka.calls` contains exactly one entry with `topic = 'prc.distribution.completed'`, `sourceModule = 'procurement'`, `payload.destinationModule = 'tech'`, `payload.sourceRefId = distributionId`. |
| Error path | `POST` with insufficient budget remaining throws `BadRequestException` with the right message; no `prc_purchase_orders` row was inserted (raw-SQL count returns 0). |
| Auth gate | Calling a service method with a parent's `ResolvedActor` throws `ForbiddenException` and DB state is unchanged. |
| IMMUTABLE | (n/a for procurement — no tables flagged IMMUTABLE per ADR-010.) |
| Concurrent atomicity | (Deferred — first set of tests asserts in-tx atomicity by checking DB state mid-tx via a savepoint helper; multi-process race tests after harness baseline is green.) |

---

## Effort estimate

| Phase | Loops | Notes |
|---|---|---|
| **This loop (design + sign-off)** | — | Design doc + this conversation. |
| **Loop 2: scaffold** | 1 | Create `test/integration/` skeleton, `vitest.integration.config.ts`, `test:integration` script, `setup.ts` + `teardown.ts` + `fixtures/platform.ts` + `fixtures/employees.ts` + `fixtures/finance.ts` + `helpers/recording-kafka.ts` + `helpers/reset.ts`. End with a single trivial integration spec that exercises one endpoint to prove the wiring (e.g. `ProcurementSettingsService.getSettings` returning the empty default for the test school). Target: green test, no coverage assertion yet. |
| **Loop 3: requisitions + procurement-settings** | 1 | Cover RequisitionService end-to-end + ProcurementSettingsService. Target: ~30–40% module coverage. |
| **Loop 4: purchase orders + goods receipts** | 1 | Cover PurchaseOrderService + GoodsReceiptService. Includes the budget commitment keystone. Target: ~65–70% module coverage. |
| **Loop 5: distribution + returns + vendor performance** | 1 | Closes the cross-module distribution keystone + vendor scoring + returns. Target: ≥80% module coverage. |
| **Loop 6 (optional): CI workflow** | 1 | GitHub Actions YAML for the integration job. Defer until the local harness is proven. |

---

## Open questions for sign-off

1. **OK with `tenant_test` schema being used as the integration test target?** CLAUDE.md says it stays empty by convention; this design fills it with stable fixtures that live across test runs but reset per-test for procurement tables. Acceptable, or prefer a new schema name like `tenant_int`?
2. **OK with serial test execution?** The alternative (parallel) costs ~50× the per-test setup. Procurement's ~15–25 tests should finish in <60s serially.
3. **OK with `test:integration` being opt-in?** Dev runs unit tests without Postgres; CI runs both. Or do you want one unified `test` command that requires Postgres?
4. **OK with the loop sequencing (4 loops after this one)?** Or scope it differently — e.g. bigger loops, smaller loops?
5. **The two FK soft refs** (`prc_requisitions.requesting_person_id` to `iam_person`, `prc_distributions.distributed_by` to `hr_employees`) — should the test seed assert these exist before each test, or trust that the shared fixtures are stable?

Reply with the answers and the next loop scaffolds.
