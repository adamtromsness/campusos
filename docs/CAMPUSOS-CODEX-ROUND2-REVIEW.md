# CampusOS Codex Round 2 Review

Source reviewed: current workspace after P2-H5.

Round 1 source: `CAMPUSOS-CODEX-PEER-REVIEW.md` (the file is at repo root, not under `docs/`).

## Summary

| Defect | Round 2 result |
| --- | --- |
| 1. SCHOOL-SCOPE | RESOLVED |
| 2. IMMUTABLE TRIGGERS - REVOKE | UNRESOLVED |
| 3. OUTBOX - `iep.accommodation.updated` | RESOLVED |
| 4. GUARDIAN AUTHORIZATION | RESOLVED |
| 5. GL RECONCILIATION | RESOLVED |
| 6. TEST QUALITY | UNRESOLVED |

## 1. SCHOOL-SCOPE - RESOLVED

The specific adjacent unscoped queries flagged in Round 1 are now scoped through the current school or validated through a school-owned parent in the same transaction.

### 1a. `student-note.service.ts` - RESOLVED

- `assertStudentExists` now requires `sis_students.id` and `sis_students.school_id = currentTenant.schoolId`: `apps/api/src/sis-advanced/student-note.service.ts:92`-`108`.
- `listForStudent` validates the student first, then binds `n.school_id = $2::uuid` in the note query: `apps/api/src/sis-advanced/student-note.service.ts:146`-`168`.
- `createForStudent` validates the target student inside the same tenant transaction as the insert, then inserts with the current `tenant.schoolId`: `apps/api/src/sis-advanced/student-note.service.ts:194`-`213`.

### 1b. `maps.service.ts` - RESOLVED

- Unit creation validates the parent `cur_curriculum_maps` row with `school_id = currentTenant.schoolId` inside the insert transaction: `apps/api/src/curriculum/maps.service.ts:658`-`703`.
- Unit reorder validates the parent map in the same transaction and both update phases join through `cur_curriculum_maps.school_id`: `apps/api/src/curriculum/maps.service.ts:767`-`809`.
- `alignStandard` still validates the standard through `StandardService.resolveById`; tenant standards are scoped by `cur_standards_frameworks.school_id`, while platform standards remain globally valid: `apps/api/src/curriculum/frameworks.service.ts:636`-`705`. It now also validates the target unit through `cur_units -> cur_curriculum_maps.school_id` before insert: `apps/api/src/curriculum/maps.service.ts:814`-`859`.
- `linkLesson` validates both the unit via `cur_curriculum_maps.school_id` and the lesson via `cls_lessons.school_id` in the same transaction: `apps/api/src/curriculum/maps.service.ts:887`-`939`.

### 1c. `orders.service.ts` - RESOLVED

- `ApprovalService.approve` locks approvals through `str_order_approvals -> str_orders -> str_stores` with `s.school_id = currentTenant.schoolId`: `apps/api/src/store/orders.service.ts:1102`-`1163`.
- `ApprovalService.decline` uses the same scoped join before mutating approval/order state: `apps/api/src/store/orders.service.ts:1171`-`1230`.
- `getApproval` reads through `str_orders -> str_stores.school_id`: `apps/api/src/store/orders.service.ts:1233`-`1260`.
- Helper updates now check affected rows and throw when scoped updates no-op: `advanceFromApprovalInTx` at `apps/api/src/store/orders.service.ts:961`-`983`; `cancelFromApprovalDeclineInTx` pre-checks the school before reservation release and checks affected rows at `apps/api/src/store/orders.service.ts:992`-`1020`.

### 1d. `sections.service.ts` - RESOLVED

- `ContributorService.add` authorizes the parent section through `pub_sections -> pub_publications.school_id` inside the insert transaction: `apps/api/src/publications/sections.service.ts:325`-`358`.
- `ContributorService.remove` deletes through `pub_sections -> pub_publications.school_id` and throws on zero affected rows: `apps/api/src/publications/sections.service.ts:389`-`407`.
- `CommentService.create` validates the parent section through `pub_publications.school_id` inside the insert transaction: `apps/api/src/publications/sections.service.ts:472`-`505`.
- `CommentService.resolve` locks and updates through `pub_sections -> pub_publications.school_id`: `apps/api/src/publications/sections.service.ts:508`-`537`.

### 1e. `inspections.service.ts` - RESOLVED

- `InspectionService.getById` binds `i.school_id = currentTenant.schoolId`: `apps/api/src/facilities/inspections.service.ts:135`-`149`.
- `InspectionService.create` validates both `fac_inspection_types.school_id` and `fac_buildings.school_id` inside the insert transaction: `apps/api/src/facilities/inspections.service.ts:151`-`220`.
- `ViolationService.listForInspection` joins through `fac_inspections.school_id`: `apps/api/src/facilities/inspections.service.ts:231`-`246`.
- `ViolationService.create` validates the parent inspection with `school_id` inside the insert transaction: `apps/api/src/facilities/inspections.service.ts:269`-`300`.
- Zone assignment creation validates `fac_zones.school_id`; patch joins through `fac_zones.school_id` and checks affected rows: `apps/api/src/facilities/inspections.service.ts:482`-`534`, `apps/api/src/facilities/inspections.service.ts:537`-`590`.
- Supply adjustment locks and updates through `fac_supply_inventory -> fac_buildings.school_id`: `apps/api/src/facilities/inspections.service.ts:658`-`738`.

### 1f. `custom-field.service.ts` - RESOLVED

- `upsertValues` now validates the target `entityId` belongs to the current school before any upsert. It maps `STUDENT`, `STAFF`, `GUARDIAN`, and `CLASS` to their school-owned tables and checks `id = $1 AND school_id = $2`: `apps/api/src/sis-advanced/custom-field.service.ts:354`-`381`.
- Definition validation remains school-scoped in the same transaction: `apps/api/src/sis-advanced/custom-field.service.ts:383`-`412`.

## 2. IMMUTABLE TRIGGERS - REVOKE - UNRESOLVED

P2-H5/P2-H6 added the table-level revokes and made the app role login-capable, but I do not find evidence that the application actually connects as the non-owner DML role in current runtime configuration.

Resolved portion:

- `IMMUTABLE_TABLES` contains the 12 Round 1 tables: `packages/database/src/provision-tenant.ts:22`-`35`.
- `provisionTenant` calls `applyImmutableRevokes` after tenant migrations: `packages/database/src/provision-tenant.ts:59`-`62`.
- `applyImmutableRevokes` creates/uses `DATABASE_APP_ROLE` defaulting to `campusos_app`, grants baseline DML, then revokes `UPDATE, DELETE, TRUNCATE` from each immutable table for the app role and `PUBLIC`: `packages/database/src/provision-tenant.ts:79`-`132`.
- The app role is now created/altered with `LOGIN PASSWORD`, fixing the previous `NOLOGIN` gap: `packages/database/src/provision-tenant.ts:84`-`109`.
- `.env.example` now documents a split owner migration URL and app DML URL: `.env.example:7`-`21`.

Still missing:

- The checked runtime connection strings still use the owner `campusos` role, not `campusos_app`: `.env.local:7` and `infrastructure/environments/dev/main.tf:282`.
- Application modules and tenant Prisma still read `DATABASE_URL`, with no runtime use of `DATABASE_APP_URL` found: `apps/api/src/tenant/tenant-prisma.service.ts:23`, `packages/database/src/client.ts:11`, `apps/api/src/tenant/tenant.module.ts:22`.

Verdict: the REVOKE DDL and login-capable app role are present, but the reviewed app configuration still connects as the owner role. The defect remains unresolved until deployed runtime uses the non-owner DML role.

## 3. OUTBOX - `iep.accommodation.updated` - RESOLVED

`emitAccommodationSnapshotByPlanId` has effectively been replaced by `emitAccommodationSnapshotInTx`, and accommodation snapshot emission now uses the active transaction.

- Plan updates run in `executeInTenantTransaction` and call `emitAccommodationSnapshotInTx(tx, id)` before commit: `apps/api/src/health/iep-plan.service.ts:300`-`326`.
- Accommodation insert, update, and delete all call `emitAccommodationSnapshotInTx` with the same transaction used for the domain write: `apps/api/src/health/iep-plan.service.ts:533`-`560`, `apps/api/src/health/iep-plan.service.ts:607`-`621`, `apps/api/src/health/iep-plan.service.ts:625`-`637`.
- The emitter reads the snapshot through the supplied `tx` and calls `outbox.enqueueInTx(tx, ...)` for topic `iep.accommodation.updated`: `apps/api/src/health/iep-plan.service.ts:908`-`970`.

## 4. GUARDIAN AUTHORIZATION - RESOLVED

The requested custody, payment-account, null-custody, and audit changes are now present.

- The service now reads `sis_family_relationships.custody_arrangement` and `court_order_restrictions`: `apps/api/src/iam/guardian-authorization.service.ts:95`-`125`.
- `canAuthorizePayment` validates `familyAccountId` by joining `pay_family_accounts` to `pay_family_account_students`, binding school, account holder, and student: `apps/api/src/iam/guardian-authorization.service.ts:241`-`274`.
- Decisions are persisted to `platform.auditLog.create`, with `dataSubjectId`, `tenantId`, capability, and grant result: `apps/api/src/iam/guardian-authorization.service.ts:160`-`185`.
- `portal_access_scope == null` is denied for academic, communications, and conference access: `apps/api/src/iam/guardian-authorization.service.ts:202`-`213`, `apps/api/src/iam/guardian-authorization.service.ts:301`-`315`, `apps/api/src/iam/guardian-authorization.service.ts:324`-`333`.
- Missing `familyId` fails closed: `apps/api/src/iam/guardian-authorization.service.ts:103`-`113`.
- Missing family relationship rows fail closed: `apps/api/src/iam/guardian-authorization.service.ts:131`-`135`.
- `custody_arrangement IS NULL` fails closed: `apps/api/src/iam/guardian-authorization.service.ts:136`-`150`.

Verdict: the Round 1 guardian authorization defect is resolved.

## 5. GL RECONCILIATION - RESOLVED

The requested amount, sign, account, duplicate, orphan, and alert checks are now present.

- Source-vs-GL checks now detect missing GL rows and amount mismatches while carrying source school/currency placeholders: `apps/api/src/finance/gl-reconciliation.worker.ts:176`-`320`.
- GL aggregation now groups by reference, account code, and batch school; it joins `fin_journal_batches` and `fin_chart_of_accounts`: `apps/api/src/finance/gl-reconciliation.worker.ts:216`-`286`.
- School mismatches are detected by comparing source `school_id` with GL batch school ids: `apps/api/src/finance/gl-reconciliation.worker.ts:322`-`340`.
- Sign and account mismatches are detected by comparing debit/credit legs against expected chart account codes: `apps/api/src/finance/gl-reconciliation.worker.ts:342`-`390`.
- Expected debit/credit account mappings are defined for all five source checks: `apps/api/src/finance/gl-reconciliation.worker.ts:656`-`727`.
- Duplicate postings are detected from repeated `fin_journal_batches.source_event_id`: `apps/api/src/finance/gl-reconciliation.worker.ts:246`-`282`.
- Orphan GL entries are detected by probing each known reference type and flagging unresolved `reference_id` rows: `apps/api/src/finance/gl-reconciliation.worker.ts:447`-`496`, `apps/api/src/finance/gl-reconciliation.worker.ts:729`-`735`.
- Failed checks now emit `fin.gl_reconciliation.discrepancy`: `apps/api/src/finance/gl-reconciliation.worker.ts:84`-`131`, `apps/api/src/finance/gl-reconciliation.worker.ts:395`-`420`.
- An alert consumer is wired in the Finance module and subscribes to `fin.gl_reconciliation.discrepancy`: `apps/api/src/finance/finance.module.ts:20`-`21`, `apps/api/src/finance/finance.module.ts:47`-`65`, `apps/api/src/finance/gl-reconciliation-alert.consumer.ts:51`-`57`.
- The consumer enqueues finance alert notifications and also writes an audit-log alert: `apps/api/src/finance/gl-reconciliation-alert.consumer.ts:63`-`111`.

Note: currency comparison is a structured no-op because the current `pay_*` and GL tables do not carry a currency column; the worker documents this at `apps/api/src/finance/gl-reconciliation.worker.ts:392`-`402`.

Verdict: the Round 1 GL reconciliation defect is resolved for the schema currently present.

## 6. TEST QUALITY - UNRESOLVED

P2-H5 added better test files, but the specific database-backed requirements are not fully met.

Resolved or partially resolved portions:

- A live immutable-role contract test exists and connects using `P2H5_APP_DATABASE_URL` when `P2H5_RUN_DB_TESTS=1`: `apps/api/src/__tests__/p2h5-immutable-role-contract.spec.ts:41`-`60`.
- That test attempts `UPDATE`, `DELETE`, and `ALTER TABLE ... DISABLE TRIGGER` for each immutable table: `apps/api/src/__tests__/p2h5-immutable-role-contract.spec.ts:66`-`88`.
- The outbox atomicity spec verifies a fake transaction handle is shared with `enqueueInTx` and exercises rollback behavior in a harness: `apps/api/src/health/iep-accommodation-outbox.spec.ts:90`-`162`.

Still missing:

- The cross-school "integration" file is a contract stub, not a database-backed actual-access suite. The enabled test bodies only assert `true` and do not seed School A/B records or call the services: `apps/api/src/__tests__/p2h5-school-scope-integration.spec.ts:34`-`83`.
- The same file documents that the actual fixture seed still "lands here" later: `apps/api/src/__tests__/p2h5-school-scope-integration.spec.ts:47`-`52`.
- The outbox atomicity test is not database-backed and does not invoke `IepPlanService`; it simulates domain writes and outbox enqueue against a local fake harness: `apps/api/src/health/iep-accommodation-outbox.spec.ts:27`-`87`, `apps/api/src/health/iep-accommodation-outbox.spec.ts:90`-`162`.
- The immutable trigger test is live only when explicitly enabled; it is a real live-role test under that gate, but the runtime role issue in Defect 2 means it does not prove the application itself connects as that role.

Verdict: live immutable-role assertions are present under an env gate, but the requested cross-school actual-access tests and database-backed outbox atomicity tests are still missing.
