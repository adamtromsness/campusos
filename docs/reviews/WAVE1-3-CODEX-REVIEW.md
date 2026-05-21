# Wave 1-3 Integration Test Quality Re-Review

Date: 2026-05-18

Scope reviewed:

- Wave 1: `apps/api/test/integration/m83-finance`, `m84-payments`, `m86-procurement`, `procurement`
- Wave 2: `apps/api/test/integration/m00-platform`
- Wave 3: `apps/api/test/integration/m87-safety`, `m23-health`, `m27-student-services`, `wave3-immutable-contracts`
- Old source-module spec locations under the Wave 1-3 modules

I reviewed current source and test files. I did not run the full integration suite.

## Overall Verdict

**PASS WITH CONDITIONS**

The seven previously flagged gaps are mostly resolved. New DB-backed coverage now exists for Wave 3 cross-school isolation, mandatory-report immutability, and `dpo_pseudonymisation_log`; old source-module specs are gone; `msg.message.posted` and configured-window crisis escalation have explicit scope dispositions. The remaining condition is GL reconciliation duplicate-posting coverage: it still drops/recreates a unique index, although the schema mutation is now isolated to a `beforeAll`/`afterAll` block.

## Fixed-Item Recheck

| Item                                                 | Current result                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old mock specs removed                               | **RESOLVED**                  | `find` across `apps/api/src/modules/m83-finance`, `m84-payments`, `m86-procurement`, `m00-platform`, `m87-safety`, `m23-health`, and `m27-student-services` returned no `*.spec.ts` or `*.test.ts` files.                                                                                                                                                                                                                                                                        |
| Wave 3 cross-school isolation                        | **RESOLVED**                  | `m23-health/cross-school.spec.ts:65-88` constructs real services; School B health record/IEP/immunisation probes from School A assert `NotFoundException` or empty results at `170-194`, `197-208`, `214-241`, `247-270`, and `276-292`. `m27-student-services/cross-school.spec.ts:66-90` constructs real services; School B referral/session/check-in/MTSS probes from School A assert `NotFoundException` or empty results at `188-221`, `227-248`, `254-284`, and `299-325`. |
| Mandatory reports immutable after `FILED`            | **RESOLVED**                  | `m27-student-services/mandatory-reports.spec.ts:41-46` uses real service wiring; create lands `FILED` at `147-153`; immutable field patch attempts fail and re-read DB state at `158-187`; mutable status/response updates preserve core fields at `201-235`.                                                                                                                                                                                                                    |
| `dpo_pseudonymisation_log` in Wave 3 immutable suite | **RESOLVED**                  | `wave3-immutable-contracts.spec.ts:447-455` documents the added contract block; insert seed at `456-490`; update failures at `493-521`; delete failure at `523-531`.                                                                                                                                                                                                                                                                                                             |
| `msg.message.posted` Wave 3 health-context outbox    | **RESOLVED / NOT APPLICABLE** | `m23-health/health-records.spec.ts:45-56` documents that `msg.message.posted` is owned by `m40-communications` and that no `m23-health` service emits it. This is acceptable for the Wave 3 health scope.                                                                                                                                                                                                                                                                        |
| GL duplicate-posting test mutates schema             | **CONCERN REMAINS**           | `m83-finance/gl-reconciliation.spec.ts:560-576` still drops and recreates `fin_batches_source_event_uq`, now isolated to `beforeAll`/`afterAll`. This is safer than the prior mid-test mutation but still schema mutation inside an integration test.                                                                                                                                                                                                                            |
| Configured-window crisis auto-escalation             | **RESOLVED / NOT APPLICABLE** | `m27-student-services/referral-lifecycle.spec.ts:49-60` documents that escalation is manual via `CrisisEscalationService.escalate` or synchronous on crisis referral creation, with no cron/window sweep in the current codebase.                                                                                                                                                                                                                                                |

## Per-File Quality Matrix

| File                                                          | Result      | Evidence / notes                                                                                                                             |
| ------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `m83-finance/budget-management.spec.ts`                       | **SOUND**   | Real `TenantPrismaService`; raw SQL state checks for budget transfers; cross-school NotFound and rollback coverage.                          |
| `m83-finance/chart-of-accounts.spec.ts`                       | **SOUND**   | Real service and raw SQL assertions; cross-school list/get isolation.                                                                        |
| `m83-finance/gl-posting.spec.ts`                              | **SOUND**   | Real GL service, raw persisted-state checks, cross-school NotFound, and immutable `fin_gl_entries` coverage.                                 |
| `m83-finance/gl-reconciliation.spec.ts`                       | **CONCERN** | Required reconciliation scenarios are covered, but duplicate-posting setup still drops/recreates `fin_batches_source_event_uq` at `560-576`. |
| `m84-payments/financial-aid.spec.ts`                          | **SOUND**   | Real service, raw SQL assertions, and cross-school NotFound coverage.                                                                        |
| `m84-payments/invoice-lifecycle.spec.ts`                      | **SOUND**   | Real service, raw `platform_outbox` checks, `pay.invoice.created`, and cross-school isolation.                                               |
| `m84-payments/late-fees.spec.ts`                              | **SOUND**   | Real services, raw SQL assertions, and cross-school list isolation.                                                                          |
| `m84-payments/lunch-accounts.spec.ts`                         | **SOUND**   | Real service, insufficient-balance/no-debit checks, cross-school NotFound, immutable balance-transfer coverage.                              |
| `m84-payments/payment-plans.spec.ts`                          | **SOUND**   | Real services, raw SQL assertions, and NotFound paths.                                                                                       |
| `m84-payments/payment-processing.spec.ts`                     | **SOUND**   | Real services, `pay.payment.received` outbox verification, and cross-school isolation.                                                       |
| `m84-payments/refunds-reversals.spec.ts`                      | **SOUND**   | Real services, `pay.refund.issued` outbox verification, immutable credit-note/reversal coverage.                                             |
| `m86-procurement/cross-school-and-immutable.spec.ts`          | **SOUND**   | Real services, cross-school requisition/PO/distribution coverage, immutable `fds_inventory_transactions`.                                    |
| `procurement/requisitions.spec.ts`                            | **SOUND**   | Real service and raw SQL state assertions.                                                                                                   |
| `procurement/purchase-orders.spec.ts`                         | **SOUND**   | Real service and raw budget commitment checks.                                                                                               |
| `procurement/distribution-and-returns.spec.ts`                | **SOUND**   | Real services, raw SQL assertions, concurrent return coverage.                                                                               |
| `procurement/procurement-settings.spec.ts`                    | **SOUND**   | Real service and raw DB state assertions.                                                                                                    |
| `m00-platform/configuration-trees.spec.ts`                    | **SOUND**   | Real tenant DB and raw SQL assertions.                                                                                                       |
| `m00-platform/configuration.spec.ts`                          | **SOUND**   | Real tenant DB and raw SQL assertions.                                                                                                       |
| `m00-platform/governance-erasure.spec.ts`                     | **SOUND**   | Real service, cross-school NotFound, pseudonymisation audit/immutable coverage.                                                              |
| `m00-platform/guardian-authorization.spec.ts`                 | **SOUND**   | Real service and full custody/court-order/family-account/audit coverage.                                                                     |
| `m00-platform/permission-resolution.spec.ts`                  | **SOUND**   | Cross-school permission negative case and raw DB fixtures.                                                                                   |
| `m00-platform/student-owned.spec.ts`                          | **SOUND**   | Real service and school/ownership guard paths.                                                                                               |
| `m00-platform/tenant-isolation.spec.ts`                       | **SOUND**   | Real tenant service, search-path and school-id isolation assertions.                                                                         |
| `m23-health/cross-school.spec.ts`                             | **SOUND**   | New real-service cross-school coverage for health records, IEP plans, and immunisation compliance.                                           |
| `m23-health/health-records.spec.ts`                           | **SOUND**   | Health outbox/access-log coverage; `msg.message.posted` documented as Wave 5/m40 scope.                                                      |
| `m23-health/iep-plans.spec.ts`                                | **SOUND**   | IEP accommodation outbox and same-transaction state checks.                                                                                  |
| `m27-student-services/counselling-sessions.spec.ts`           | **SOUND**   | Session-note locking and real DB state assertions.                                                                                           |
| `m27-student-services/cross-school.spec.ts`                   | **SOUND**   | New real-service cross-school coverage for referrals, sessions, check-ins, and MTSS tiers.                                                   |
| `m27-student-services/mandatory-reports.spec.ts`              | **SOUND**   | New mandatory-report `FILED` immutability coverage with raw DB re-reads.                                                                     |
| `m27-student-services/mtss.spec.ts`                           | **SOUND**   | Real services and raw DB assertions.                                                                                                         |
| `m27-student-services/referral-lifecycle.spec.ts`             | **SOUND**   | Crisis escalation state/outbox coverage; configured-window cron scope documented as not applicable.                                          |
| `m27-student-services/wellbeing.spec.ts`                      | **SOUND**   | Real service, outbox assertions, and raw state checks.                                                                                       |
| `m87-safety/incident-lifecycle.spec.ts`                       | **SOUND**   | Real service, cross-school NotFound/empty-list coverage, incident timeline/outbox assertions.                                                |
| `wave3-immutable-contracts/wave3-immutable-contracts.spec.ts` | **SOUND**   | Covers Wave 3 immutable tables plus added `dpo_pseudonymisation_log`.                                                                        |

## Check 1 - DB-Backed, Not Mock

Wave 1: **SOUND**. Tests instantiate real services with real `TenantPrismaService`; no Prisma/DB `vi.fn()`, `vi.mock()`, or `jest.fn()` usage was found under integration tests. `RecordingKafkaProducer` remains acceptable.

Wave 2: **SOUND**. Platform tests use real services and tenant DB wiring, including `guardian-authorization.spec.ts`, `governance-erasure.spec.ts`, and `tenant-isolation.spec.ts`.

Wave 3: **SOUND**. Health/student-services/safety tests use real service construction. New cross-school files instantiate `TenantPrismaService` at `m23-health/cross-school.spec.ts:65-88` and `m27-student-services/cross-school.spec.ts:66-90`.

## Check 2 - Real DB State Assertions

Wave 1: **SOUND**. Finance, payments, and procurement tests use raw SQL for persisted state and outbox checks.

Wave 2: **SOUND**. Platform tests verify tenant isolation, audit logs, governance erasure, and authorization decisions through real DB reads.

Wave 3: **SOUND**. Health outbox/access logs, IEP outbox rows, referral activity/outbox, incident timeline, immutable contracts, and mandatory-report state are checked through raw SQL. Mandatory-report re-reads are at `m27-student-services/mandatory-reports.spec.ts:169-185` and `201-235`.

## Check 3 - Cross-School Isolation

Wave 1: **SOUND**. Finance, payments, and procurement include School A/B NotFound or empty-list assertions. No test was found that asserts a cross-school leak as expected behavior.

Wave 2: **SOUND**. Governance, permission resolution, and tenant isolation include cross-school negative paths.

Wave 3: **SOUND**. `m87-safety` was already covered. New `m23-health/cross-school.spec.ts` covers School B health, IEP, and immunisation data from a School A actor at `170-292`. New `m27-student-services/cross-school.spec.ts` covers School B referral, session, check-in, and MTSS data from a School A actor at `188-325`.

## Check 4 - Immutable Trigger Tests

Wave 1: **SOUND**. `fin_gl_entries`, `pay_credit_notes`, `pay_payment_reversals`, `pay_lunch_account_balance_transfers`, and `fds_inventory_transactions` each have insert/update/delete trigger coverage.

Wave 2: **SOUND**. Governance immutable DPO audit coverage remains present in platform tests.

Wave 3: **SOUND**. `svc_referral_activity`, `hlth_health_access_log`, and `inc_incident_timeline` remain covered. `dpo_pseudonymisation_log` is now covered in `wave3-immutable-contracts.spec.ts:455-531`.

## Check 5 - Outbox Atomicity

Wave 1: **SOUND**. `pay.invoice.created`, `pay.payment.received`, and `pay.refund.issued` have outbox verification.

Wave 2: **SOUND / NOT APPLICABLE**. I did not find governance events in this review scope that require outbox verification.

Wave 3: **SOUND**. `iep.accommodation.updated` and `hlth.allergy_alert.changed` remain covered in their domain tests. `msg.message.posted` is documented as `m40-communications` ownership, not `m23-health`, at `m23-health/health-records.spec.ts:45-56`.

## Check 6 - GL Reconciliation

Wave 1: **CONCERN**. Required scenarios are covered:

- Missing GL entry
- Amount mismatch
- Duplicate posting
- Orphan GL entry
- Alert event emission
- Sign/account comparison

The remaining concern is test mechanics: `gl-reconciliation.spec.ts:560-576` drops and recreates `fin_batches_source_event_uq` to seed duplicate batches. The mutation is now block-scoped with `beforeAll`/`afterAll`, but it still changes shared schema state.

Wave 2: **SOUND / NOT APPLICABLE**

Wave 3: **SOUND / NOT APPLICABLE**

## Check 7 - Guardian Authorization

Wave 2: **SOUND**. `m00-platform/guardian-authorization.spec.ts` covers SOLE_A, SOLE_B, JOINT, null custody fail-closed, missing relationship fail-closed, court-order restrictions, `familyAccountId` binding for payments, and `platform_audit_log` persistence.

Wave 1: **SOUND / NOT APPLICABLE**

Wave 3: **SOUND / NOT APPLICABLE**

## Check 8 - Safety-Critical Paths

Wave 3: **SOUND**.

- IEP accommodation outbox is covered by `m23-health/iep-plans.spec.ts`.
- Allergy alert outbox is covered by `m23-health/health-records.spec.ts`.
- Referral crisis escalation state/activity/outbox coverage remains in `m27-student-services/referral-lifecycle.spec.ts`.
- Configured-window auto-escalation is documented as not applicable because no cron/window sweep exists, at `referral-lifecycle.spec.ts:49-60`.
- Session-note locking is covered in `m27-student-services/counselling-sessions.spec.ts`.
- Mandatory reports immutable after `FILED` are now covered in `m27-student-services/mandatory-reports.spec.ts:147-235`.
- Health access logging remains covered in `m23-health/health-records.spec.ts`.

Wave 1: **SOUND / NOT APPLICABLE**

Wave 2: **SOUND / NOT APPLICABLE**

## Check 9 - Atomic Operations

Wave 1: **SOUND**. Budget commitment issue/cancel, budget transfer rollback, and lunch-account insufficient-balance/no-debit are covered with raw DB checks.

Wave 2: **SOUND / NOT APPLICABLE**

Wave 3: **SOUND / NOT APPLICABLE**

## Check 10 - Old Mock Specs Removed

Wave 1: **SOUND**. No `*.spec.ts` or `*.test.ts` files remain in `apps/api/src/modules/m83-finance`, `m84-payments`, or `m86-procurement`.

Wave 2: **SOUND**. No `*.spec.ts` or `*.test.ts` files remain in `apps/api/src/modules/m00-platform`.

Wave 3: **SOUND**. No `*.spec.ts` or `*.test.ts` files remain in `apps/api/src/modules/m87-safety`, `m23-health`, or `m27-student-services`.

## Check 11 - Skipped Tests

Wave 1: **SOUND**. No `.skip`, `.todo`, or `skip()` calls were found in Wave 1 integration tests.

Wave 2: **SOUND**. No `.skip`, `.todo`, or `skip()` calls were found in Wave 2 integration tests.

Wave 3: **SOUND**. No `.skip`, `.todo`, or `skip()` calls were found in Wave 3 integration tests.

## Summary Table

| Check                       | Wave 1      | Wave 2      | Wave 3      |
| --------------------------- | ----------- | ----------- | ----------- |
| 1. DB-backed, not mock      | SOUND       | SOUND       | SOUND       |
| 2. Real DB state assertions | SOUND       | SOUND       | SOUND       |
| 3. Cross-school isolation   | SOUND       | SOUND       | SOUND       |
| 4. Immutable trigger tests  | SOUND       | SOUND       | SOUND       |
| 5. Outbox atomicity         | SOUND       | SOUND / N/A | SOUND       |
| 6. GL reconciliation        | CONCERN     | SOUND / N/A | SOUND / N/A |
| 7. Guardian authorization   | SOUND / N/A | SOUND       | SOUND / N/A |
| 8. Safety-critical paths    | SOUND / N/A | SOUND / N/A | SOUND       |
| 9. Atomic operations        | SOUND       | SOUND / N/A | SOUND / N/A |
| 10. Old mock specs removed  | SOUND       | SOUND       | SOUND       |
| 11. Skipped tests           | SOUND       | SOUND       | SOUND       |

## Prioritized Fix List

1. Remove the remaining GL duplicate-posting schema mutation from `m83-finance/gl-reconciliation.spec.ts`. Prefer a dedicated corruption fixture path, a test-only helper that bypasses the uniqueness constraint without mutating shared schema, or moving this scenario to an isolated database/schema.
2. Run the full Wave 1-3 integration suite against `tenant_test` to validate that the new cross-school, mandatory-report, and immutable-contract tests pass together.
