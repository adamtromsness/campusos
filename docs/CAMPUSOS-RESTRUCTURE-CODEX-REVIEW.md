# CampusOS Restructure Re-Review

Date: 2026-05-17

Scope reviewed:

- `apps/api/src/modules/m{XX}-{name}/`
- `apps/api/src/shared/`
- `apps/api/src/app.module.ts`

Verification performed:

- Parsed TypeScript imports under `apps/api/src/modules` and `apps/api/src/shared`.
- Checked cross-module imports for public API use.
- Built the API with `pnpm --filter @campusos/api build`; build passed.
- Scanned table-prefix ownership for obvious misplaced production files.

## Summary

| Check                                | Result               |
| ------------------------------------ | -------------------- |
| 1. Import breakage / stale old paths | Partially unresolved |
| 2. Module boundary violations        | Resolved             |
| 3. Circular dependencies             | Resolved             |
| 4. Shared placement                  | Partially unresolved |
| 5. Misplaced files                   | Partially unresolved |
| 6. NestJS module wiring              | Partially unresolved |

## 1. Import Breakage / Stale Old Paths

Result: **PARTIALLY UNRESOLVED**

No hard TypeScript import breakage was found. The API build passes, and canonical alias imports are now used for the old advanced modules in `app.module.ts`.

Evidence:

- `apps/api/src/app.module.ts:17` imports `M20SisModule` from `@modules/m20-sis/m20-sis.module`.
- `apps/api/src/app.module.ts:25` imports `M40CommunicationsModule` from `@modules/m40-communications/m40-communications.module`.
- `apps/api/src/app.module.ts:42` imports `M87SafetyModule` from `@modules/m87-safety/m87-safety.module`.
- `pnpm --filter @campusos/api build` passed.

However, there are still relative imports matching the old `../incidents/` shape that the review request explicitly called out. These are inside the same canonical `m87-safety` module, so they are not currently build-breaking cross-module imports, but they are still stale path-style references.

Evidence:

- `apps/api/src/modules/m87-safety/drills/drill.service.ts:12` imports DTOs from `../incidents/dto/incident.dto`.
- `apps/api/src/modules/m87-safety/emergency/procedure.service.ts:20` imports DTOs from `../incidents/dto/incident.dto`.
- `apps/api/src/modules/m87-safety/emergency/procedure.service.ts:21` imports `isUniqueViolation` from `../incidents/incident-type.service`.
- `apps/api/src/modules/m87-safety/reunification/reunification.service.ts:13` imports from `../incidents/dto/incident.dto`.
- `apps/api/src/modules/m87-safety/reunification/accountability.service.ts:12` imports from `../incidents/dto/incident.dto`.

Recommendation: add a public `m87-safety` barrel export for shared incident DTO/helpers, or move shared safety DTOs/helpers to a local `m87-safety/common` area and import them without reaching through the `incidents` feature folder.

## 2. Module Boundary Violations

Result: **RESOLVED**

The earlier direct cross-module internal imports have been cleaned up. Current cross-module imports go through module public APIs or Nest module files.

Evidence:

- Import graph scan found `CROSS_INTERNAL_COUNT 0`.
- `apps/api/src/modules/m00-platform/index.ts:1` through `apps/api/src/modules/m00-platform/index.ts:36` define the public platform API, including IAM services and modules.
- `apps/api/src/modules/m83-finance/index.ts:1` through `apps/api/src/modules/m83-finance/index.ts:3` expose `FinanceModule`, `JournalBatchService`, and `FinanceValidationService`.
- `apps/api/src/modules/m40-communications/index.ts:1` through `apps/api/src/modules/m40-communications/index.ts:3` expose the communications module and notification queue API.
- `apps/api/src/modules/m86-procurement/procurement.module.ts:2` through `apps/api/src/modules/m86-procurement/procurement.module.ts:5` import platform, shared Kafka, and finance through public APIs.

Residual note: some public barrels expose implementation services directly. That satisfies the stated boundary rule, but the public API is broad.

## 3. Circular Dependencies

Result: **RESOLVED**

No bidirectional module edges were found in the current module import graph.

Evidence:

- Import graph scan found no mutual `mXX -> mYY -> mXX` edges.
- The prior `m00-platform` to `m40-communications` back-edge through `RedisService` is gone from IAM; `apps/api/src/modules/m00-platform/iam/permission-check.service.ts:4` now imports `MetricsService` from shared observability instead.
- Shared Redis/cache infrastructure exists under `apps/api/src/shared/cache/redis.service.ts` and `apps/api/src/shared/cache/redis.module.ts`, separating the cache primitive from communications.

## 4. Shared Placement

Result: **PARTIALLY UNRESOLVED**

The major shared packages are genuinely cross-cutting:

- `@shared/auth` is imported by 37 modules plus root/shared code.
- `@shared/kafka` is imported by 37 modules plus root/shared code.
- `@shared/tenant` is imported by 37 modules plus root/shared code.
- `@shared/cache` is imported by 7 modules.

Several files still fail the strict "used by 3+ modules" placement rule. Some may be valid root application infrastructure, but they are not used by three or more modules today.

Evidence:

- `apps/api/src/app.module.ts:7` is the only module-level import of `@shared/dlq/dlq.module`.
- `apps/api/src/modules/m00-platform/iam/permission-check.service.ts:4` is the only module import of `@shared/observability/metrics.service`.
- `apps/api/src/modules/m00-platform/tenant/tenant.module.ts:3` is the only module import of `@shared/tenant/tenant-resolver.middleware`.
- `apps/api/src/main.ts:5` imports `@shared/observability/otel-bootstrap`; no module imports it.
- `apps/api/src/main.ts:13` imports `@shared/observability/structured-logger`; no module imports it.
- `apps/api/src/shared/kafka/kafka.module.ts:3` and `apps/api/src/shared/kafka/index.ts:4` are the only non-test production references to `kafka-consumer.service`.
- `apps/api/src/shared/kafka/kafka.module.ts:4` and `apps/api/src/shared/kafka/index.ts:6` are the only non-test production references to `idempotency.service`.

Recommendation: document an explicit exception for root bootstrapping/framework infrastructure in `shared/`, or move single-module implementation details back under their owning module.

## 5. Misplaced Files

Result: **PARTIALLY UNRESOLVED**

The previous major production misplacement appears mostly fixed:

- Finance advanced services now live under `m83-finance`; `apps/api/src/modules/m83-finance/finance-advanced.module.ts:10` through `apps/api/src/modules/m83-finance/finance-advanced.module.ts:13` explicitly state that the `fin_*` services were split out of the old commerce bundle.
- Procurement advanced services now live under `m86-procurement`; `apps/api/src/modules/m86-procurement/procurement.module.ts:23` through `apps/api/src/modules/m86-procurement/procurement.module.ts:45` document `prc_*` ownership plus intended finance integration.
- Store advanced services now live under `m67-store`; `apps/api/src/modules/m67-store/m67-store.module.ts:5` through `apps/api/src/modules/m67-store/m67-store.module.ts:9` describe only store core and store-advanced features.

No production `prc_*` table queries were found under `m83-finance`, and no production `str_*` table queries were found under `m83-finance` or `m86-procurement`.

Remaining issue: there is a stale commerce-bundle regression test under the store module that still covers finance journal batch behavior.

Evidence:

- `apps/api/src/modules/m67-store/__tests__/commerce-review-p2c29.spec.ts:9` imports `JournalBatchService` from `@modules/m83-finance`.
- `apps/api/src/modules/m67-store/__tests__/commerce-review-p2c29.spec.ts:19` through `apps/api/src/modules/m67-store/__tests__/commerce-review-p2c29.spec.ts:21` describe finance GL materialisation behavior.
- `apps/api/src/modules/m67-store/__tests__/commerce-review-p2c29.spec.ts:415` begins a finance-specific `JournalBatchService.post` test under the store test directory.

Recommendation: split this test file. Keep store tests in `m67-store`; move journal batch / finance assertions to `m83-finance`.

Note: there are intentional cross-domain table references, such as procurement validating `fin_budget_lines`, `fin_suppliers`, and `fin_chart_of_accounts`. Example: `apps/api/src/modules/m86-procurement/requisitions.service.ts:94` joins `fin_budget_lines` and `fin_chart_of_accounts`, and `apps/api/src/modules/m86-procurement/requisitions.service.ts:128` reads `fin_suppliers` for preferred vendor names. These look like domain integrations, not misplaced files.

## 6. NestJS Module Wiring

Result: **PARTIALLY UNRESOLVED**

The root app is wired and buildable, but the current module count does not match the requested "38 canonical modules" statement.

Evidence that wiring works:

- `apps/api/src/app.module.ts:12` describes the current app as `37 canonical modules`.
- `apps/api/src/app.module.ts:61` through `apps/api/src/app.module.ts:64` state that the root imports exactly 37 canonical modules.
- `apps/api/src/app.module.ts:88` through `apps/api/src/app.module.ts:125` register those canonical modules in the root `imports` list.
- `apps/api/src/modules/m00-platform/m00-platform.module.ts:21` through `apps/api/src/modules/m00-platform/m00-platform.module.ts:52` aggregate and export the platform leaf modules.
- `apps/api/src/modules/m67-store/m67-store.module.ts:11` through `apps/api/src/modules/m67-store/m67-store.module.ts:14` aggregate and export the store leaf modules.
- `pnpm --filter @campusos/api build` passed.

Remaining issues:

- There are 37 `mXX-*` top-level directories under `apps/api/src/modules`, not 38.
- `m60-tickets` is the current tickets module, while the previous/reviewed numbering used `m01-tickets`. If `m01` was intentionally renumbered to `m60`, update the restructure inventory. If not, the tickets module is in the wrong canonical slot.
- Several one-leaf canonical directories still use historical module filenames rather than a matching `mXX-name.module.ts` file, for example `apps/api/src/modules/m83-finance/finance.module.ts` instead of `m83-finance.module.ts`, and `apps/api/src/modules/m86-procurement/procurement.module.ts` instead of `m86-procurement.module.ts`. This does not break Nest wiring, but it weakens the "one canonical module per directory" convention.

Recommendation: reconcile the canonical module inventory to either 37 or 38 modules, and standardize top-level module filenames if the intended contract is `m{XX}-{name}/m{XX}-{name}.module.ts`.
