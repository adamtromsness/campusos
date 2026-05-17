# CampusOS Codex Peer Review

Reviewed commit: `aead274719479a9ede875b8a1c11a65141ba0be6`

Scope: correctness review of the 4-cycle hardening sprint plan in `docs/campusos-hardening-cycles.html`. Completeness is intentionally out of scope except where an omitted check creates a correctness bypass in touched code.

## Summary

| Area | Result |
| --- | --- |
| School-scope fixes | DEFECT |
| Immutable triggers | DEFECT |
| Outbox migration | DEFECT |
| Guardian authorization service | DEFECT |
| GL reconciliation | DEFECT |
| Test quality | DEFECT |

## 1. School-Scope Fixes - DEFECT

Several modified services added correct school predicates on the named methods, but other queries in the same files remain bypassable by crafted IDs. The regression suite did not catch these because it mostly checks that a file contains `school_id` somewhere.

Defects found:

- `apps/api/src/sis-advanced/student-note.service.ts`
  - `assertStudentExists` checks `sis_students` by `id` only, without `school_id`.
  - `listForStudent` filters by `student_id` and visibility only; it does not require `n.school_id = currentTenant.schoolId`.
  - `create` accepts a caller-supplied `studentId`, passes the unscoped student existence check, then inserts a note with the caller's current school. A crafted cross-school `studentId` can read parent-visible notes or create notes attached to a foreign student.
  - Fix: validate `sis_students.id` with `school_id = currentTenant.schoolId`, and bind `n.school_id = currentTenant.schoolId` in list/read paths. Do the target-student validation inside the same transaction as note creation.

- `apps/api/src/curriculum/maps.service.ts`
  - Unit creation checks `cur_curriculum_maps` by `id` only, then inserts units for that map.
  - Unit reorder updates by `id` and `curriculum_map_id` only; the parent map's `school_id` is not checked.
  - `alignStandard` validates the standard's school but not the unit's school.
  - `attachLesson` validates the lesson's school but not the unit's school.
  - Fix: every unit write should resolve the parent `cur_curriculum_maps.school_id` and include that school predicate in the locking query and mutation, preferably with scoped CTEs.

- `apps/api/src/store/orders.service.ts`
  - `ApprovalService.approve`, `decline`, and `getApproval` operate on `str_order_approvals` by approval id only before invoking helper methods.
  - The helper updates include `str_stores.school_id`, but their affected-row counts are not checked. A foreign-school approval can be mutated, and the decline path can release reservations before the school-scoped order update no-ops.
  - Fix: approval reads, locks, and updates must join `str_order_approvals -> str_orders -> str_stores` and bind `str_stores.school_id = currentTenant.schoolId`. Helper methods should throw `NotFoundException` when their scoped update affects zero rows.

- `apps/api/src/publications/sections.service.ts`
  - The main section patch/remove/approve paths are scoped, but contributor and comment paths are not.
  - `ContributorService.create` inserts by `sectionId` only; `remove` deletes by contributor id only.
  - `CommentService.create` inserts by `sectionId` only; `resolve` locks and updates by comment id only.
  - Fix: contributor/comment create, delete, and resolve must authorize through `pub_sections -> pub_publications.school_id` before and inside the mutation.

- `apps/api/src/facilities/inspections.service.ts`
  - `ViolationService.resolve` was scoped, but `InspectionService.getById`, `ViolationService.listForInspection`, `ViolationService.create`, zone assignment create/patch, and supply adjustment all still rely on ids without binding the current school through the inspection/zone/building parent.
  - Fix: every inspection, violation, zone assignment, and supply write/read-by-id should join through the school-scoped parent and include the current `school_id` in the same SQL statement.

- `apps/api/src/sis-advanced/custom-field.service.ts`
  - The definition get/update paths are scoped, but `upsertValues` validates the custom-field definition school and not the target `entityId` school. A current-school definition can be used to attach values to a cross-school entity id if the entity table allows it.
  - Fix: validate the target entity against the current school for each supported entity type before upserting values.

The named fixes in `family-relationship.service.ts`, `cross-school-staff.service.ts`, the scoped section patch/remove/approve paths, and the scoped governance pseudonymization/privacy notice paths look correct in isolation.

## 2. Immutable Triggers - DEFECT

The trigger function itself correctly raises an exception on normal `UPDATE` or `DELETE`, and the tenant migration creates triggers for the immutable tables.

The bypass risk is role/DDL control:

- The migrations do not include `REVOKE UPDATE, DELETE` on the immutable tables from the application role.
- The migrations do not demonstrate that the application role is a non-owner role without `ALTER TABLE` privilege.
- A role with table ownership or sufficient `ALTER` privilege can bypass all row triggers with `ALTER TABLE ... DISABLE TRIGGER prevent_mutation` or `DISABLE TRIGGER ALL`.

Fix:

- Run migrations as an owner/migration role, and ensure the application connects as a non-owner DML role.
- Explicitly revoke `UPDATE` and `DELETE` on all immutable tables from the application role, granting only the operations the app needs, such as `INSERT` and `SELECT`.
- Add a CI or migration verification test that connects as the application role and proves it cannot update/delete immutable rows and cannot disable triggers.

## 3. Outbox Migration - DEFECT

Six of the seven reviewed conversions place the outbox enqueue inside the same transaction as the domain write:

- `pay.payment.received` in `apps/api/src/payments/payment.service.ts`: SOUND.
- `pay.invoice.created` in `apps/api/src/payments/invoice.service.ts`: SOUND.
- `pay.refund.issued` in `apps/api/src/payments/refund.service.ts`: SOUND.
- `enr.student.enrolled` in `apps/api/src/enrollment/offer.service.ts`: SOUND.
- `msg.message.posted` in `apps/api/src/messaging/message.service.ts`: SOUND for outbox atomicity.
- `mtg.meeting.scheduled` in `apps/api/src/meetings/meeting.service.ts`: SOUND.

`iep.accommodation.updated` is not atomic:

- `apps/api/src/health/iep-plan.service.ts` performs plan/accommodation mutations in one transaction, then calls `emitAccommodationSnapshotByPlanId`.
- `emitAccommodationSnapshotByPlanId` opens a separate small transaction and enqueues the outbox event after the domain transaction has committed.
- A process crash or database/network failure between the domain commit and the later outbox enqueue can still lose the event.

Fix: pass the active transaction into the accommodation snapshot emitter and enqueue `iep.accommodation.updated` in the same transaction as the plan/accommodation insert, update, or delete. If the snapshot requires rereads, perform those reads through the same transaction before commit.

## 4. Guardian Authorization Service - DEFECT

The service has useful defensive defaults for some direct portal flags, but it does not implement the custody model described by the hardening plan.

Defects found:

- `GuardianAuthorizationService` loads only `sis_student_guardians`, `sis_guardians`, and `sis_students`. It does not read `sis_family_relationships.custody_arrangement` or the court-order restriction data that the plan says must drive access.
- `canAuthorizePayment` accepts `familyAccountId` but ignores it. A caller can ask about one student/guardian relationship while passing an unrelated family account.
- Conference access grants when `portal_access_scope` is `null` as long as `portal_access` is true, because the check is only `scope !== 'ACADEMIC_ONLY'`. Missing or null authorization data should fail closed unless the schema guarantees a safe default.
- Payment authorization denies when `sis_student_guardians.has_custody = false`, but a stale or incorrect guardian link with `has_custody = true` can override stricter family relationship or court-order restrictions because those tables are never consulted.
- Access decisions are logged only to the Nest logger; they are not written to a durable audit table or audit outbox event.

Fix:

- Resolve authorization from the authoritative custody relationship, including `sis_family_relationships.custody_arrangement` and court-order restrictions.
- Bind `familyAccountId` to the same student/family relationship before allowing payment authorization.
- Normalize missing/null custody and portal-scope data to deny unless an explicit allowed state exists.
- Persist each guardian access decision to durable audit storage or an audit outbox event.

## 5. GL Reconciliation - DEFECT

The worker catches missing GL references for five source types: invoices, payments, refunds, credit notes, and payment reversals. It does not catch all discrepancy types needed for reliable reconciliation.

Gaps:

- It checks only whether a GL entry exists by source type/id. It does not compare expected amount, sign, account, currency, school, duplicate postings, orphan GL entries, or partial/multi-line posting completeness.
- The migration comments reserve `AMOUNT_MISMATCH` for future work, so amount mismatch is knowingly not implemented.
- When a discrepancy is found, the worker writes `rpt_gl_reconciliation` and enqueues `fin.gl_reconciliation.discrepancy`. I did not find an implemented alert/notification consumer for that topic; the docs describe SRE alert wiring as a later phase. Today this is event emission plus logging, not a guaranteed alert.
- When a check query fails, `runCheck` logs a warning and writes a `FAILED` reconciliation row with zero discrepancies, but it emits no alert event. A broken reconciliation query can be missed unless someone reviews failed rows.

Fix:

- Extend reconciliation to compute expected GL lines and compare amount, sign, account, school, duplicate count, and orphan entries.
- Treat failed reconciliation checks as alert-worthy events.
- Wire an actual notification/alert consumer for `fin.gl_reconciliation.discrepancy`, or write urgent finance/admin notification rows directly through a reliable outbox-backed path.

## 6. Test Quality - DEFECT

The sampled tests are useful as static guardrails, but they are not integration tests for the correctness properties in this sprint. In particular, the school-scope regression tests do not attempt cross-school access.

Sampled tests:

1. `apps/api/src/__tests__/school-scope-regression.spec.ts` checks audited files contain a school predicate. This is static source inspection and missed unscoped queries in the same files.
2. The same suite checks mutation files contain `school_id` somewhere. This does not prove each mutation is scoped.
3. The same suite checks financial writers call tenant helpers. This does not prove tenant isolation on each SQL statement.
4. `apps/api/src/__tests__/atomic-operations.spec.ts` asserts source files exist. This is not behavioral.
5. The same atomic suite searches source for `FOR UPDATE`, `UPDATE`, or outbox calls. It does not run concurrent requests or prove atomicity.
6. `apps/api/src/__tests__/immutable-contracts.spec.ts` checks migration text contains triggers. It does not connect as the app role and attempt forbidden writes.
7. The same immutable suite checks service source does not write immutable tables. It cannot detect DDL/privilege bypasses.
8. `apps/api/src/iam/guardian-authorization.service.spec.ts` has real unit coverage for direct guardian-link flags, including non-custodial payment denial, but it does not cover family relationship custody data or court-order restrictions.
9. `apps/api/src/finance/gl-reconciliation.worker.spec.ts` exercises missing-entry reconciliation and outbox emission with fake clients, but it does not test amount mismatch, duplicates, or alert delivery.
10. The GL worker SQL-shape tests assert filters such as draft/cancelled exclusions, but they are white-box SQL checks rather than database-backed reconciliation scenarios.

Fix:

- Add database-backed cross-school tests that seed School A and School B records, authenticate as School A, and attempt reads/writes using School B ids for every service method touched by the hardening sprint.
- Add live trigger tests that run as the application role and verify immutable rows cannot be updated/deleted and triggers cannot be disabled.
- Add transaction-failure tests for each outbox conversion, including `iep.accommodation.updated`, proving no committed domain mutation can occur without a matching outbox row.
- Add guardian authorization fixtures for custody arrangements, missing/null custody data, and court-order restrictions.
- Add GL reconciliation fixtures for missing, mismatched, duplicate, orphaned, and failed-check cases, with assertions that an alert path is invoked.
