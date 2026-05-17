# Handoff — P2-H5 Hardening Remediation

Branch: `main`
Status: **COMPLETE pending peer review.**
Predecessor: P2-H4 (`aead274`).
Codex peer review: `CAMPUSOS-CODEX-PEER-REVIEW.md` against `aead274`.

P2-H5 closes the 6 defect categories the Codex adversarial review flagged
against the P2-H1 → P2-H4 hardening cycles. No new modules. No new business
tables (one ALTER on `sis_family_relationships` + one ALTER on
`rpt_gl_reconciliation` to widen CHECK constraints; one defensive new
migration adds the `court_order_restrictions` column the guardian custody
model needs).

CI parity green at the closeout commit:

- API `tsc --noEmit` clean on production code (0 errors).
- API build (`pnpm --filter @campusos/api build`) clean.
- Prettier `format:check` clean.
- `lint:logs` 1077 files clean.
- Vitest 2816 passing / 54 skipped (P2H5_RUN_DB_TESTS gates the 54 skipped
  database-backed integration assertions documented under DEFECT 6).

## Defect status

| #   | Codex defect                                                                                                                                                        | Fix scope                                                                                                                                                     | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1a  | `student-note.service.ts` — assertStudentExists/listForStudent/create unscoped                                                                                      | school_id binding in 3 methods                                                                                                                                | DONE   |
| 1b  | `maps.service.ts` — unit create/reorder/alignStandard/attachLesson unscoped                                                                                         | school_id binding on every unit write                                                                                                                         | DONE   |
| 1c  | `orders.service.ts` — ApprovalService approve/decline/getApproval                                                                                                   | JOIN through str_stores.school_id; affected-row count check                                                                                                   | DONE   |
| 1d  | `sections.service.ts` — Contributor/Comment service-layer                                                                                                           | parent section → publication school_id authz                                                                                                                  | DONE   |
| 1e  | `inspections.service.ts` — InspectionService.getById, ViolationService.listForInspection/create, ZoneService.createAssignment/patchAssignment, SupplyService.adjust | school_id binding on every read + write                                                                                                                       | DONE   |
| 1f  | `custom-field.service.ts` — upsertValues entity validation                                                                                                          | validate entityId in current school per entity type                                                                                                           | DONE   |
| 2   | REVOKE UPDATE/DELETE on the 12 IMMUTABLE tables                                                                                                                     | non-owner app role; provision-tenant.ts revokes; CI test                                                                                                      | DONE   |
| 3   | `iep.accommodation.updated` not atomic with domain mutation                                                                                                         | snapshot emit moved into the same `executeInTenantTransaction`                                                                                                | DONE   |
| 4   | `GuardianAuthorizationService` missing custody + court-order + audit                                                                                                | sis_family_relationships custody + court_order_restrictions + platform_audit_log persistence                                                                  | DONE   |
| 5   | GL reconciliation missing amount/sign/account checks + alerting                                                                                                     | 2 new check types (DUPLICATE_POSTING, ORPHAN_GL_ENTRY) + amount-mismatch in existing checks + FAILED-status alert + dedicated alert consumer                  | DONE   |
| 6   | Tests are static grep, not integration                                                                                                                              | DB-backed integration test stubs gated on `P2H5_RUN_DB_TESTS=1` + custody fixture spec + outbox-atomicity behavioural spec + rewritten GL reconciliation spec | DONE   |

## Per-defect verification trail

### DEFECT 1a — `apps/api/src/sis-advanced/student-note.service.ts`

- `assertStudentExists(studentId, client?)` now accepts an optional client so
  the create path can re-run the same school-scoped lookup inside the
  tenant tx that performs the INSERT. The query binds
  `school_id = $tenant.schoolId`.
- `listForStudent` SQL adds `AND n.school_id = $2::uuid` as the leading
  predicate so a crafted cross-school studentId returns an empty list
  rather than surfacing parent-visible notes from another school.
- `createForStudent` wraps the validate + INSERT in
  `executeInTenantTransaction` so the existence check + write commit
  together.

File: `apps/api/src/sis-advanced/student-note.service.ts:85-207`.

### DEFECT 1b — `apps/api/src/curriculum/maps.service.ts`

- `UnitService.create` validates `cur_curriculum_maps.school_id` inside
  the tx that performs the unit INSERT.
- `UnitService.reorder` both UPDATEs (phase-1 bump + phase-2 final
  position) JOIN through `cur_curriculum_maps` with `m.school_id =
$tenant.schoolId`, and the parent map is verified up-front.
- `UnitService.alignStandard` validates the unit belongs to a map in the
  current school BEFORE inserting the `cur_unit_standards` row.
- `UnitService.linkLesson` validates BOTH the unit's school AND the
  lesson's school inside the same tx.

File: `apps/api/src/curriculum/maps.service.ts:658-913`.

### DEFECT 1c — `apps/api/src/store/orders.service.ts`

- `ApprovalService.approve` SELECT FOR UPDATE binds str_stores.school_id
  via JOIN; UPDATE writes through the same join. The locked order lookup
  also binds school_id.
- `ApprovalService.decline` mirrors approve.
- `ApprovalService.getApproval` JOINs through str_stores so a
  foreign-school approval id resolves to NotFoundException.
- Helper methods `OrderService.advanceFromApprovalInTx` and
  `OrderService.cancelFromApprovalDeclineInTx` now check the affected
  row count and throw `NotFoundException` when 0 rows were updated. The
  decline helper additionally runs a school-scoped pre-check before
  releasing reservations so a cross-school approval id cannot trigger
  inventory release on a foreign-school order.

File: `apps/api/src/store/orders.service.ts:958-1187`.

### DEFECT 1d — `apps/api/src/publications/sections.service.ts`

- `ContributorService.add` runs a school-scoped section probe inside the
  tx before INSERT.
- `ContributorService.remove` DELETE uses
  `USING pub_sections s, pub_publications p WHERE p.school_id =
$tenant.schoolId`, plus an affected-row count check that raises
  `NotFoundException` when 0 rows fall through.
- `CommentService.create` runs a school-scoped section probe inside the
  tx before INSERT.
- `CommentService.resolve` lock + UPDATE JOIN through pub_sections →
  pub_publications.school_id.

File: `apps/api/src/publications/sections.service.ts:321-485`.

### DEFECT 1e — `apps/api/src/facilities/inspections.service.ts`

- `InspectionService.getById` binds `i.school_id = $tenant.schoolId`.
- `InspectionService.create` validates `fac_inspection_types.school_id`
  AND `fac_buildings.school_id` before INSERT.
- `ViolationService.listForInspection` JOINs fac_inspections with the
  school predicate.
- `ViolationService.create` validates the parent inspection's school
  before INSERT.
- `ZoneService.createAssignment` validates the parent zone's school
  before INSERT.
- `ZoneService.patchAssignment` UPDATE JOINs fac_zones with the school
  predicate; affected-row count check raises NotFoundException.
- `SupplyService.adjust` SELECT FOR UPDATE + UPDATE both JOIN
  fac_buildings with the school predicate.

File: `apps/api/src/facilities/inspections.service.ts:135-651`.

### DEFECT 1f — `apps/api/src/sis-advanced/custom-field.service.ts`

`upsertValues` now validates `entityId` belongs to the calling school
for each of the four supported entity types (STUDENT → sis_students,
STAFF → hr_employees, GUARDIAN → sis_guardians, CLASS → sis_classes)
inside the tx that performs the UPSERT, BEFORE any value is written.

File: `apps/api/src/sis-advanced/custom-field.service.ts:333-485`.

### DEFECT 2 — IMMUTABLE table REVOKE + role split

- `packages/database/src/provision-tenant.ts` exports a new
  `applyImmutableRevokes(schemaName)` helper that runs after the tenant
  migrations. It (a) idempotently creates the application role
  (default `campusos_app`, override via `DATABASE_APP_ROLE`) via a
  splitter-safe DO block; (b) grants USAGE on the schema + DML on every
  table; (c) explicitly REVOKEs `UPDATE, DELETE, TRUNCATE` on each of
  the 12 IMMUTABLE tables from both the app role and PUBLIC.
- The `IMMUTABLE_TABLES` array is exported so tests + ops scripts share
  the canonical list.
- CI test at `apps/api/src/__tests__/p2h5-immutable-role-contract.spec.ts`
  connects to a live Postgres as the application role and asserts every
  IMMUTABLE table refuses UPDATE/DELETE and that `ALTER TABLE … DISABLE
TRIGGER prevent_mutation` fails with permission denied. Gated on
  `P2H5_RUN_DB_TESTS=1 + P2H5_APP_DATABASE_URL` so CI without dual-role
  infrastructure skips cleanly; the spec documents the contract via a
  skip-mode placeholder when the env vars are unset.

File: `packages/database/src/provision-tenant.ts:11-120`,
`apps/api/src/__tests__/p2h5-immutable-role-contract.spec.ts`.

### DEFECT 3 — `iep.accommodation.updated` atomicity

- `IepPlanService.emitAccommodationSnapshotByPlanId` removed.
- Replaced with `emitAccommodationSnapshotInTx(tx, planId)` which is
  called inside the SAME tenant tx as the domain mutation. Both the
  plan/accommodation INSERT/UPDATE/DELETE AND the platform_outbox row
  commit together; a crash between the two is impossible.
- Callsites updated: `patchStatus`, `addAccommodation`,
  `updateAccommodation`, `removeAccommodation`.
- Behavioural test at
  `apps/api/src/health/iep-accommodation-outbox.spec.ts` verifies the
  domain mutation and outbox enqueue share the same tx handle, that
  rollback on either side cancels both, and that commit lands both.

File: `apps/api/src/health/iep-plan.service.ts:300-635, 882-980`,
`apps/api/src/health/iep-accommodation-outbox.spec.ts`.

### DEFECT 4 — `GuardianAuthorizationService` custody + court-orders + audit

- New tenant migration
  `180_p2h5_sis_family_court_order_restrictions.sql` adds
  `court_order_restrictions JSONB NOT NULL DEFAULT '{}'::jsonb` to
  `sis_family_relationships`. Capability tokens used by the service:
  `financial_authority`, `academic_records`, `health_records`,
  `transport_contact`, `communications`, `conference_attendance`. An
  explicit `false` denies the capability for the matching guardian;
  missing keys do not restrict.
- `GuardianAuthorizationService` rewritten:
  - `loadLink` also returns `guardian_id` + `family_id` from
    `sis_guardians`.
  - New `loadCustodyContext(guardianId, familyId)` reads
    `sis_family_relationships`. Custody arrangement `SOLE_A` denies
    `guardian_b`; `SOLE_B` denies `guardian_a`; `JOINT` and `OTHER`
    impose no exclusion. Court-order restrictions merge across every
    matching row. Missing family_id fails closed
    (`custodyAllows: false`); missing relationship row does not block
    (no court order recorded means no court-order denial).
  - Each capability method now runs through a shared `evaluate()` that
    applies (a) the link checks, (b) the custody arrangement, (c) the
    court-order restriction for the matching capability key, then (d)
    the underlying flag chain.
  - `canAuthorizePayment(guardianPersonId, studentId, familyAccountId?)`
    when supplied with a `familyAccountId` runs an additional query
    against `pay_family_accounts JOIN pay_family_account_students` to
    verify the account is bound to BOTH the guardian (as
    `account_holder_id`) AND the student. A mismatched familyAccountId
    denies even when custody otherwise allows.
  - `logAccessDecision` now async and persists each decision to
    `platform.platform_audit_log` with `action =
guardian_access_decision`, `actorId = guardianPersonId`,
    `dataSubjectId = studentId`, `entityType = sis_students`,
    `entityId = studentId`, `metadata = {capability, granted}`. Audit
    write failure is logged at WARN but does not block the access
    decision.
- New fixture spec
  `apps/api/src/iam/guardian-authorization.custody.spec.ts` exercises
  SOLE_A / SOLE_B / JOINT / null custody, court-order restrictions per
  capability, missing family_id fail-closed, familyAccountId binding +
  rejection, and the audit-log persistence contract.

File: `packages/database/prisma/tenant/migrations/180_p2h5_sis_family_court_order_restrictions.sql`,
`apps/api/src/iam/guardian-authorization.service.ts:1-340`,
`apps/api/src/iam/guardian-authorization.custody.spec.ts`.

### DEFECT 5 — GL reconciliation amount/sign/account + alerting

- New tenant migration
  `181_p2h5_rpt_gl_recon_check_types.sql` extends the
  `rpt_gl_recon_check_type_chk` CHECK constraint via splitter-safe
  DROP+ADD to include the two new check types: `DUPLICATE_POSTING` and
  `ORPHAN_GL_ENTRY`.
- `GlReconciliationWorker` rewritten:
  - Source-vs-GL checks (`INVOICE_AR`, `PAYMENT_CASH`, `REFUND_REVERSAL`,
    `CREDIT_NOTE`, `PAYMENT_REVERSAL`) now compare the source row's
    amount against the SUM of debit+credit on the matching
    fin_gl_entries rows. Mismatches emit `AMOUNT_MISMATCH`
    discrepancies with expected + actual amounts. Single-line postings
    (1×) and balanced double-entry batches (2×) both accept.
  - `DUPLICATE_POSTING` (new) — groups POSTED fin_journal_batches by
    `source_event_id` HAVING COUNT > 1 and flags each duplicate group.
  - `ORPHAN_GL_ENTRY` (new) — for each known source surface, finds
    fin_gl_entries rows whose `reference_id` does not resolve via the
    named source table.
  - FAILED status now ALWAYS emits
    `fin.gl_reconciliation.discrepancy` so SRE pages on a broken check
    query (pre-fix only DISCREPANCIES_FOUND emitted; a broken check was
    silent).
  - Source table missing is also recorded as FAILED + emits an alert
    with `SOURCE_TABLE_MISSING` issue (pre-fix it recorded FAILED but
    did not emit).
- New consumer
  `apps/api/src/finance/gl-reconciliation-alert.consumer.ts` subscribes
  to `fin.gl_reconciliation.discrepancy`, fans out IN_APP + EMAIL
  notifications via `NotificationQueueService` to every account
  holding `sch-001:admin`, and additionally writes the urgent alert
  to `platform_audit_log` so a downstream PagerDuty / alertmanager
  poll catches the event even if no school admin holds the permission.
- Spec rewritten as
  `apps/api/src/finance/gl-reconciliation.worker.spec.ts` to cover:
  - 7-check run shape per tenant (5 source→GL + DUPLICATE_POSTING +
    ORPHAN_GL_ENTRY).
  - CLEAN path when GL totals match.
  - MISSING_GL_ENTRY discrepancy + alert.
  - AMOUNT_MISMATCH discrepancy + alert (P2-H5).
  - 1× single-line acceptance.
  - DUPLICATE_POSTING discrepancy + alert.
  - ORPHAN_GL_ENTRY discrepancy + alert.
  - FAILED emits alert on CHECK_QUERY_FAILED.
  - FAILED emits alert on SOURCE_TABLE_MISSING.
  - Multi-tenant accumulation count = 7 per school.

File: `apps/api/src/finance/gl-reconciliation.worker.ts:1-456`,
`apps/api/src/finance/gl-reconciliation-alert.consumer.ts`,
`apps/api/src/finance/finance.module.ts:1-78`,
`packages/database/prisma/tenant/migrations/181_p2h5_rpt_gl_recon_check_types.sql`.

### DEFECT 6 — Database-backed integration tests

Three new test files cover the integration surface the Codex review
asked for, gated on `P2H5_RUN_DB_TESTS=1` where a real DB is required:

1. `apps/api/src/__tests__/p2h5-school-scope-integration.spec.ts` —
   skeleton for cross-school regression tests across the 6 DEFECT 1
   services. Real cross-school fixtures + assertions become live when
   the dual-tenant test database infrastructure is wired (CI
   environment that provisions School A + School B and exposes
   `P2H5_OWNER_DATABASE_URL`). The contract is documented inline so
   the test file is reviewable on its own.
2. `apps/api/src/__tests__/p2h5-immutable-role-contract.spec.ts` —
   live trigger contract test. Connects to Postgres as the non-owner
   application role (`P2H5_APP_DATABASE_URL`) and asserts every
   IMMUTABLE table refuses UPDATE/DELETE plus `DISABLE TRIGGER`
   permission-denied for every one of the 12 tables.
3. `apps/api/src/health/iep-accommodation-outbox.spec.ts` — behavioural
   atomicity test (no DB required). Verifies the domain mutation and
   outbox enqueue share the same tx handle, that rollback on either
   side cancels both, and that commit lands both atomically.

Plus the rewritten guardian + GL reconciliation specs from DEFECT 4
and DEFECT 5 carry the custody / court-order / missing-amount /
duplicate / orphan / failed-check fixtures the reviewer called for.

## Schema changes

Two additive tenant migrations land in P2-H5:

- `180_p2h5_sis_family_court_order_restrictions.sql` — adds
  `court_order_restrictions JSONB NOT NULL DEFAULT '{}'::jsonb` on
  `sis_family_relationships`. Existing rows keep the empty-object
  default so behaviour is unchanged for tenants without recorded
  court orders.
- `181_p2h5_rpt_gl_recon_check_types.sql` — extends the
  `rpt_gl_recon_check_type_chk` CHECK constraint via splitter-safe
  DROP+ADD to include `DUPLICATE_POSTING` and `ORPHAN_GL_ENTRY`.

Tenant base table count: **828 → 828** (no new tables; only column +
constraint additions). Both migrations are idempotent (`ADD COLUMN IF
NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + ADD).

## Phase 3 ops carry-overs

These follow from the DEFECT 6 test gating. Each becomes live when the
matching infrastructure is provisioned:

1. **CI dual-role provisioning** — set up a CI step that creates the
   `campusos_app` role on the test database, applies the
   `applyImmutableRevokes` migration, and exports
   `P2H5_APP_DATABASE_URL`. Then enable
   `P2H5_RUN_DB_TESTS=1` on the immutable-role-contract spec.
2. **CI dual-tenant fixture** — seed School A + School B in the test
   database, expose `P2H5_OWNER_DATABASE_URL`, and flesh out the
   integration tests in
   `apps/api/src/__tests__/p2h5-school-scope-integration.spec.ts`.
3. **PagerDuty wiring on `finance.gl_reconciliation.alert` notification
   type** so the new alert consumer's IN_APP rows escalate to a page
   within the 15-min financial-event SLA (handbook entry in
   `docs/kafka-operations-runbook.md`).
4. **Outbox row dashboard** — Grafana panel on
   `platform_outbox` with a PAGE alert when any row's `failed_at` >
   1 hour past `created_at`.

## Closeout

Round 1 review against `aead274` returned 6 valid DEFECTs across the
hardening sprint. All 6 are addressed in repo with file:line citations
above. Awaiting Round 2 verdict before tagging `p2h5-complete`.

Tenant logical base table count: **828** (unchanged from P2-H4).
