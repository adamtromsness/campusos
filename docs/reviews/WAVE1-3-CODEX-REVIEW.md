# Wave 1-3 Integration Test Quality Review

Date: 2026-05-18

Scope reviewed:

- Wave 1: `apps/api/test/integration/m83-finance`, `m84-payments`, `m86-procurement`, `procurement`
- Wave 2: `apps/api/test/integration/m00-platform`
- Wave 3: `apps/api/test/integration/m87-safety`, `m23-health`, `m27-student-services`, `wave3-immutable-contracts`
- Old source-module spec locations under the Wave 1-3 modules

I reviewed test quality from source. I did not run the full integration suite.

## Overall Verdict

**FAIL**

The integration tests are mostly real DB-backed tests, and there is strong coverage for many critical contracts. However, the suite does not meet the stated replacement bar because old mock specs remain under source modules, Wave 3 cross-school coverage is incomplete, mandatory-report safety tests are missing, `dpo_pseudonymisation_log` is not covered in the Wave 3 immutable contract suite, and one GL reconciliation test mutates schema state.

## Per-File Quality Matrix

| File | Result | Evidence / notes |
| --- | --- | --- |
| `m83-finance/budget-management.spec.ts` | **SOUND** | Real `TenantPrismaService` at line 72; raw SQL/outbox assertions at lines 695, 707, 740, 751, 758; cross-school NotFound at lines 975-1008; budget transfer rollback at lines 723-761. |
| `m83-finance/chart-of-accounts.spec.ts` | **SOUND** | Real service at lines 67-70; raw SQL at lines 145, 306, 783, 801, 841; cross-school list/NotFound coverage at lines 99-121, 256-280, 629-637, 888-895. |
| `m83-finance/gl-posting.spec.ts` | **SOUND** | Real service at lines 62-63; raw SQL at lines 110, 121, 244, 269; cross-school NotFound at lines 294-311 and 597-603; immutable `fin_gl_entries` tests at lines 689-756. |
| `m83-finance/gl-reconciliation.spec.ts` | **CONCERN** | Covers required reconciliation scenarios, but duplicate-posting test drops/recreates `fin_batches_source_event_uq` at lines 552 and 596. |
| `m84-payments/financial-aid.spec.ts` | **SOUND** | Real service at lines 55-57; raw SQL cleanup/seeding; cross-school NotFound at lines 325-334 and 602-615. |
| `m84-payments/invoice-lifecycle.spec.ts` | **SOUND** | Real service at lines 67-70; raw `platform_outbox` query at line 120; `pay.invoice.created` verified at lines 247-285; cross-school list isolation now asserts School B rows are absent at lines 609-650. |
| `m84-payments/late-fees.spec.ts` | **SOUND** | Real services at lines 61-65; raw SQL and cross-school scan at lines 558-581. |
| `m84-payments/lunch-accounts.spec.ts` | **SOUND** | Real service at lines 55-57; insufficient balance/no-write at lines 252-280; cross-school NotFound at lines 374-415; immutable transfer tests at lines 444-519. |
| `m84-payments/payment-plans.spec.ts` | **SOUND** | Real services at lines 67-71; raw SQL assertions present; NotFound paths covered. |
| `m84-payments/payment-processing.spec.ts` | **SOUND** | Real services at lines 70-74; `pay.payment.received` outbox verified at lines 174-185; cross-school list isolation now asserts School B rows are absent at lines 507-536. |
| `m84-payments/refunds-reversals.spec.ts` | **SOUND** | Real services at lines 80-87; `pay.refund.issued` outbox at lines 199-210; credit-note/reversal immutable tests at lines 598-669 and 882-956. |
| `m86-procurement/cross-school-and-immutable.spec.ts` | **SOUND** | Real services at lines 64-75; cross-school requisition, PO, distribution coverage at lines 115-279; immutable `fds_inventory_transactions` at lines 286-383. |
| `procurement/requisitions.spec.ts` | **SOUND** | Real `RequisitionService` with real tenant DB at lines 91-99; raw SQL at lines 146, 180, 453, 533, 584, 679, 739. |
| `procurement/purchase-orders.spec.ts` | **SOUND** | Real service at lines 88-90; raw budget commitment checks at lines 394-424 and 495-526. |
| `procurement/distribution-and-returns.spec.ts` | **SOUND** | Real services at lines 60-67; raw SQL at lines 185, 286, 306, 389, 573; concurrent return test at lines 540-551. |
| `procurement/procurement-settings.spec.ts` | **SOUND** | Real service at lines 26-29; raw DB state assertions at lines 63-90 and 111-117. |
| `m00-platform/configuration-trees.spec.ts` | **SOUND** | Real `TenantPrismaService` at line 60; raw SQL assertions throughout. |
| `m00-platform/configuration.spec.ts` | **SOUND** | Real `TenantPrismaService` at line 42; raw SQL assertions throughout. |
| `m00-platform/governance-erasure.spec.ts` | **SOUND** | Real service at line 57; cross-school NotFound at lines 232-240; pseudonymisation audit/immutable coverage at lines 355-561. |
| `m00-platform/guardian-authorization.spec.ts` | **SOUND** | Real `GuardianAuthorizationService` at line 40; custody/court/family-account/audit scenarios covered, see Check 7. |
| `m00-platform/permission-resolution.spec.ts` | **SOUND** | Cross-school permission negative case at lines 287-306; raw DB seeding/assertions present. |
| `m00-platform/student-owned.spec.ts` | **SOUND** | Real service at line 38; school/ownership guard paths covered with raw fixtures. |
| `m00-platform/tenant-isolation.spec.ts` | **SOUND** | Real tenant service at line 35; search-path and school-id isolation assertions at lines 83-145 and 340-358. |
| `m23-health/health-records.spec.ts` | **DEFECT** | Strong outbox/access-log coverage, but no School A/B cross-school isolation test found for m23-health. |
| `m23-health/iep-plans.spec.ts` | **DEFECT** | Strong IEP outbox coverage, but no School A/B cross-school isolation test found for m23-health. |
| `m27-student-services/counselling-sessions.spec.ts` | **DEFECT** | Session-note lock covered, but no School A/B cross-school isolation and no mandatory-report FILED immutability test. |
| `m27-student-services/mtss.spec.ts` | **DEFECT** | Real services/raw SQL, but no School A/B cross-school isolation found for m27. |
| `m27-student-services/referral-lifecycle.spec.ts` | **DEFECT** | Strong crisis escalation coverage, but no School A/B cross-school isolation found for m27. |
| `m27-student-services/wellbeing.spec.ts` | **DEFECT** | Strong wellbeing/outbox assertions, but no School A/B cross-school isolation found for m27. |
| `m87-safety/incident-lifecycle.spec.ts` | **SOUND** | Real service at lines 76-81; broad cross-school NotFound/empty-list coverage at lines 278-292, 392-454, 502-537, 613-658. |
| `wave3-immutable-contracts/wave3-immutable-contracts.spec.ts` | **DEFECT** | Covers `inc_incident_timeline`, `hlth_health_access_log`, and `svc_referral_activity`, but not `dpo_pseudonymisation_log`. |

## Check 1 — DB-Backed, Not Mock

Wave 1: **SOUND**

- Integration tests instantiate real services with real `TenantPrismaService`: finance at `budget-management.spec.ts:72`, payments at `invoice-lifecycle.spec.ts:67`, procurement at `requisitions.spec.ts:91`.
- No `vi.fn()`, `vi.mock()`, `jest.fn()`, or mocked Prisma calls were found under `apps/api/test/integration`.
- `RecordingKafkaProducer` appears only as an event recorder, which is acceptable.

Wave 2: **SOUND**

- Platform integration tests instantiate real services, for example `governance-erasure.spec.ts:57`, `guardian-authorization.spec.ts:40`, and `tenant-isolation.spec.ts:35`.

Wave 3: **SOUND**

- Health/student-services/safety tests instantiate real services with `TenantPrismaService`, for example `health-records.spec.ts:55`, `iep-plans.spec.ts:60`, `referral-lifecycle.spec.ts:62`, and `incident-lifecycle.spec.ts:76`.

## Check 2 — Real DB State Assertions

Wave 1: **SOUND**

- Raw SQL assertions verify persisted state: `gl-posting.spec.ts:121`, `invoice-lifecycle.spec.ts:120`, `payment-processing.spec.ts:159`, `refunds-reversals.spec.ts:191`, `purchase-orders.spec.ts:417`, and `procurement-settings.spec.ts:63`.

Wave 2: **SOUND**

- Platform tests use raw SQL heavily, including governance audit/pseudonymisation state and tenant search-path assertions. Examples: `tenant-isolation.spec.ts:83-145`, `governance-erasure.spec.ts:355-561`, `guardian-authorization.spec.ts:222`.

Wave 3: **SOUND**

- Health outbox/access log assertions use raw SQL at `health-records.spec.ts:148-162`.
- IEP outbox assertions use raw SQL at `iep-plans.spec.ts:160-162`.
- Referral escalation state/outbox assertions use raw SQL at `referral-lifecycle.spec.ts:457-483` and `596-605`.
- Incident outbox/timeline assertions use raw SQL at `incident-lifecycle.spec.ts:179` and `wave3-immutable-contracts.spec.ts:188-240`.

## Check 3 — Cross-School Isolation

Wave 1: **SOUND**

- Finance has School A/B isolation and NotFound/empty-result assertions: `chart-of-accounts.spec.ts:99-121`, `gl-posting.spec.ts:294-311`, `budget-management.spec.ts:975-1008`.
- Payments has School A/B isolation: `invoice-lifecycle.spec.ts:609-650`, `payment-processing.spec.ts:507-536`, `lunch-accounts.spec.ts:374-415`, `refunds-reversals.spec.ts:504-521`.
- Procurement has School A/B isolation: `cross-school-and-immutable.spec.ts:115-279`.
- I found no integration test that asserts a cross-school leak as expected behavior.

Wave 2: **SOUND**

- Governance cross-school NotFound: `governance-erasure.spec.ts:232-240`.
- IAM/permission cross-school negative: `permission-resolution.spec.ts:287-306`.
- Tenant context isolation: `tenant-isolation.spec.ts:106-145` and `340-358`.

Wave 3: **DEFECT**

- `m87-safety` is covered: `incident-lifecycle.spec.ts:392-454`, `502-537`, `613-658`.
- I found no School A/B cross-school isolation tests in `m23-health`.
- I found no School A/B cross-school isolation tests in `m27-student-services`.

Fix: add School A/B tests for health records, IEP plans/accommodations, counselling sessions/notes, referrals, MTSS tiers, and wellbeing records. Each should seed School B data, act as School A, and assert `NotFoundException` or empty results.

## Check 4 — Immutable Trigger Tests

Wave 1: **SOUND**

- `fin_gl_entries`: `gl-posting.spec.ts:689-756`.
- `pay_credit_notes`: `refunds-reversals.spec.ts:598-669`.
- `pay_payment_reversals`: `refunds-reversals.spec.ts:882-956`.
- `pay_lunch_account_balance_transfers`: `lunch-accounts.spec.ts:444-519`.
- `fds_inventory_transactions`: `cross-school-and-immutable.spec.ts:286-383`.

Wave 2: **SOUND**

- Governance immutable `dpo_pseudonymisation_log` is covered in Wave 2 platform tests: `governance-erasure.spec.ts:497-561`.

Wave 3: **DEFECT**

- `svc_referral_activity`: `wave3-immutable-contracts.spec.ts:337-388`.
- `hlth_health_access_log`: `wave3-immutable-contracts.spec.ts:250-300`.
- `inc_incident_timeline`: `wave3-immutable-contracts.spec.ts:183-231`.
- `dpo_pseudonymisation_log` is not covered in `wave3-immutable-contracts.spec.ts`; it is covered in Wave 2 governance instead. Under the user’s Wave 3 table list, that is still a placement/coverage defect.

Fix: either move or duplicate the `dpo_pseudonymisation_log` immutable trigger assertions into the Wave 3 immutable contract suite, or correct the Wave 3 table list if DPO is intentionally Wave 2.

## Check 5 — Outbox Atomicity

Wave 1: **SOUND**

- `pay.invoice.created`: `invoice-lifecycle.spec.ts:247-285`.
- `pay.payment.received`: `payment-processing.spec.ts:144-185`.
- `pay.refund.issued`: `refunds-reversals.spec.ts:199-210`.

Wave 2: **SOUND / NOT APPLICABLE**

- I did not find governance event topics requiring outbox verification. Governance erasure tests verify DB audit/pseudonymisation state, not outbox events.

Wave 3: **CONCERN**

- `iep.accommodation.updated`: covered at `iep-plans.spec.ts:297-325` and tenant/message-key checked at `427-440`.
- `hlth.allergy_alert.changed`: covered at `health-records.spec.ts:178-203` and update path at `275-303`.
- `msg.message.posted`: no Wave 3 health-context integration test found. If this event is in scope for Wave 3 health messaging, add a DB-backed test that triggers the health-context message and verifies the outbox/envelope.

## Check 6 — GL Reconciliation

Wave 1: **CONCERN**

Required scenarios are covered:

- Missing GL entry: `gl-reconciliation.spec.ts:284-312`.
- Amount mismatch: `gl-reconciliation.spec.ts:346-368`.
- Duplicate posting: `gl-reconciliation.spec.ts:538-585`.
- Orphan GL entry: `gl-reconciliation.spec.ts:628-675`.
- Alert event emission: `gl-reconciliation.spec.ts:312` and `240`.
- Sign/account comparison: `gl-reconciliation.spec.ts:373-418`.

Concern: duplicate-posting coverage drops/recreates a unique index at `gl-reconciliation.spec.ts:552` and `596`. That is useful for creating a corruption shape, but schema mutation inside integration tests is risky.

Wave 2: **SOUND / NOT APPLICABLE**

Wave 3: **SOUND / NOT APPLICABLE**

## Check 7 — Guardian Authorization

Wave 2: **SOUND**

`m00-platform/guardian-authorization.spec.ts` covers all requested scenarios:

- SOLE_A guardian B denied: lines 245-256.
- SOLE_B guardian A denied: lines 256-265.
- JOINT both allowed: lines 234-243.
- NULL custody fail-closed: lines 267-276.
- Missing family relationship fail-closed: lines 278-299.
- Court-order restrictions: academic at lines 354-365, health at 419-423, payment at 455-462, transport at 569-573, communications at 617-621, conference at 647-651.
- `canAuthorizePayment` familyAccountId binding: lines 466-549.
- Every access decision persisted to `platform_audit_log`: helper/query at lines 222-229, audit tests at lines 662-751.

Wave 1: **SOUND / NOT APPLICABLE**

Wave 3: **SOUND / NOT APPLICABLE**

## Check 8 — Safety-Critical Paths

Wave 3: **DEFECT**

Covered:

- IEP accommodation outbox in same transaction: `iep-plans.spec.ts:297-325`.
- Allergy alert outbox in same transaction: `health-records.spec.ts:178-203` and `275-303`.
- Referral crisis escalation writes priority/status/activity/outbox: `referral-lifecycle.spec.ts:448-483` and consistency check at `596-605`.
- Session notes lock rejects patch after `is_locked=true`: `counselling-sessions.spec.ts:788-824`.
- Health access logging: `health-records.spec.ts:403-418` and multiple-read check at `445-455`.

Missing:

- Mandatory reports immutable after `FILED` status. The service exists at `apps/api/src/modules/m27-student-services/counselling/mandatory-report.service.ts`, but no integration test for mandatory reports was found under `apps/api/test/integration/m27-student-services`.
- The referral crisis test verifies manual `CrisisEscalationService.escalate`; I did not find a configured-window auto-escalation test. If the requirement means automatic escalation within a configured time window, add a clock/configured-window test.

Wave 1: **SOUND / NOT APPLICABLE**

Wave 2: **SOUND / NOT APPLICABLE**

## Check 9 — Atomic Operations

Wave 1: **SOUND**

- Budget commitment: PO ISSUE encumbers via raw SQL at `purchase-orders.spec.ts:394-424`; PO CANCEL releases at `495-526`.
- Budget transfer insufficient-balance rollback: `budget-management.spec.ts:723-761`.
- Lunch account insufficient balance/no debit: `lunch-accounts.spec.ts:252-280`.

Wave 2: **SOUND / NOT APPLICABLE**

Wave 3: **SOUND / NOT APPLICABLE**

## Check 10 — Old Mock Specs Removed

Wave 1: **DEFECT**

Old `*.spec.ts` files remain under source modules, including:

- `apps/api/src/modules/m83-finance/budgets.service.spec.ts`
- `apps/api/src/modules/m83-finance/gl.consumer.spec.ts`
- `apps/api/src/modules/m83-finance/journal-batch-posted.consumer.spec.ts`
- `apps/api/src/modules/m84-payments/invoice.service.spec.ts`
- `apps/api/src/modules/m84-payments/payments-advanced.spec.ts`
- `apps/api/src/modules/m84-payments/controllers-batch.spec.ts`
- `apps/api/src/modules/m86-procurement/procurement.controller.spec.ts`

Wave 2: **DEFECT**

Old `*.spec.ts` files remain under `m00-platform`, including:

- `apps/api/src/modules/m00-platform/auth/auth.controller.spec.ts`
- `apps/api/src/modules/m00-platform/auth/auth.service.spec.ts`
- `apps/api/src/modules/m00-platform/iam/actor-context.service.spec.ts`
- `apps/api/src/modules/m00-platform/iam/assignment.service.spec.ts`
- `apps/api/src/modules/m00-platform/iam/effective-access-cache.service.spec.ts`
- multiple `community`, `crm`, and `ops` `__tests__/*.spec.ts` files

Wave 3: **DEFECT**

Old `*.spec.ts` files remain under Wave 3 modules:

- `apps/api/src/modules/m23-health/iep/iep-accommodation-outbox.spec.ts`
- `apps/api/src/modules/m23-health/records/health-advanced.spec.ts`
- `apps/api/src/modules/m23-health/records/health.controller.spec.ts`
- `apps/api/src/modules/m87-safety/incidents/incidents.spec.ts`

I did not find source `*.spec.ts` files under `m27-student-services`, but the check fails for Wave 3 because `m23-health` and `m87-safety` still have source specs.

Fix: delete replaced mock specs or move intentionally retained unit specs outside the replacement scope with clear naming/exclusions.

## Check 11 — Skipped Tests

Wave 1: **SOUND**

- No `.skip`, `.todo`, `describe.skip`, `it.skip`, `test.skip`, or `skip()` calls were found in Wave 1 integration tests.

Wave 2: **SOUND**

- No skipped/todo tests were found in Wave 2 integration tests.

Wave 3: **SOUND**

- No skipped/todo tests were found in Wave 3 integration tests.

Note: `apps/api/test/integration/helpers/recording-kafka.ts:29` contains the text `vi.fn()` in a comment only; it is not a skipped or mocked test.

## Summary Table

| Check | Wave 1 | Wave 2 | Wave 3 |
| --- | --- | --- | --- |
| 1. DB-backed, not mock | SOUND | SOUND | SOUND |
| 2. Real DB state assertions | SOUND | SOUND | SOUND |
| 3. Cross-school isolation | SOUND | SOUND | DEFECT |
| 4. Immutable trigger tests | SOUND | SOUND | DEFECT |
| 5. Outbox atomicity | SOUND | SOUND / N/A | CONCERN |
| 6. GL reconciliation | CONCERN | N/A | N/A |
| 7. Guardian authorization | N/A | SOUND | N/A |
| 8. Safety-critical paths | N/A | N/A | DEFECT |
| 9. Atomic operations | SOUND | N/A | N/A |
| 10. Old mock specs removed | DEFECT | DEFECT | DEFECT |
| 11. Skipped tests | SOUND | SOUND | SOUND |

## Prioritized Fix List For Claude Code

1. Remove or relocate old source-module mock specs for all Wave 1-3 modules, or explicitly exclude retained unit specs from this replacement criterion.
2. Add Wave 3 School A/B cross-school isolation tests for `m23-health` and `m27-student-services`.
3. Add DB-backed mandatory-report integration tests: create FILED report, attempt core-field patch, assert rejection and unchanged DB state.
4. Add or move `dpo_pseudonymisation_log` immutable trigger coverage into `wave3-immutable-contracts.spec.ts`, or correct the Wave 3 immutable table list.
5. Add Wave 3 health-context `msg.message.posted` outbox verification if that event is expected in the health context.
6. Replace the GL reconciliation duplicate-posting test’s drop/recreate-index approach with a safer fixture strategy.
7. Add configured-window auto-escalation coverage if crisis escalation is meant to happen automatically rather than via direct service call.

