# CampusOS Post-H5 Verification Audit

**Date:** 2026-05-17
**Scope:** Verify every hardening finding from `docs/campusos-hardening-cycles.html` and the Codex peer review at `CAMPUSOS-CODEX-PEER-REVIEW.md` is resolved in the current codebase.
**Excluded:** Test coverage metrics (separate workstream — Phase 3 incremental per-cycle).
**Method:** Source-grep + direct file reads. Every finding cites file:line.

---

## Section A — Security (P2-H1 + H5 follow-up)

### A.1 School-Scope Leaks — Codex adjacent-query defects

The Codex review flagged 6 adjacent-query gaps inside files already touched by the P2-H1 Round 1 fixes.

**A.1.a `sis-advanced/student-note.service.ts`**
- `assertStudentExists`: **RESOLVED** — `apps/api/src/sis-advanced/student-note.service.ts:101` reads `… WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`.
- `listForStudent`: **RESOLVED** — line 163 carries `AND n.school_id = $2::uuid` in the WHERE clause.
- `create`: **RESOLVED** — line 199 calls `assertStudentExists` inside the tenant tx; line 226 reload also carries `n.school_id = $2::uuid`.

**A.1.b `curriculum/maps.service.ts`**
- Unit create: **RESOLVED** — lines 668–670 validate `cur_curriculum_maps WHERE id = $1::uuid AND school_id = $2::uuid` inside the tenant tx before INSERT.
- Unit reorder: **RESOLVED** — lines 776–805 carry `AND m.school_id = $3::uuid` on every UPDATE.
- `alignStandard`: **RESOLVED** — lines 834–840 JOIN through curriculum_maps + filter `m.school_id`.
- `attachLesson`: **RESOLVED** — lines 903–907 validate unit's parent map, lines 913–920 validate lesson's school.

**A.1.c `store/orders.service.ts`**
- `ApprovalService.approve`: **RESOLVED** — lines 1120–1127 JOIN `str_order_approvals → str_orders → str_stores` with `s.school_id = $2::uuid FOR UPDATE`.
- `ApprovalService.decline`: **RESOLVED** — lines 1187–1194 same JOIN pattern.
- `ApprovalService.getApproval`: **RESOLVED** — lines 1242–1247 same JOIN.
- Helper affected-row check: **RESOLVED** — `advanceFromApprovalInTx`/`cancelFromApprovalDeclineInTx` invoked at lines 1161/1228 carry school predicate end-to-end.

**A.1.d `publications/sections.service.ts`**
- `ContributorService.add`: **RESOLVED** — lines 341–346 JOIN `pub_sections → pub_publications.school_id` before INSERT.
- `ContributorService.remove`: **RESOLVED** — lines 396–401 DELETE … USING `pub_publications p WHERE p.school_id = $2::uuid`; affected-row check at line 404.
- `CommentService.create`: **RESOLVED** — lines 485–490 JOIN through `pub_publications.school_id`.
- `CommentService.resolve`: **RESOLVED** — lines 516–521 triple JOIN with `FOR UPDATE OF c`.

**A.1.e `facilities/inspections.service.ts`**
- `InspectionService.getById`: **RESOLVED** — line 142 `WHERE i.id = $1::uuid AND i.school_id = $2::uuid`.
- `ViolationService.listForInspection`: **RESOLVED** — line 240 JOIN `fac_inspections i` with `i.school_id = $2::uuid`.
- `ViolationService.create`: **RESOLVED** — lines 282–285 validate parent inspection in current school before INSERT.
- Zone assignment create: **RESOLVED** — lines 504–507 validate `fac_zones … school_id` in tenant tx.
- Zone assignment patch: **RESOLVED** — lines 564–572 UPDATE JOIN to `fac_zones z WHERE z.school_id = $...`.
- Supply adjustment: **RESOLVED** — lines 674–680 JOIN `fac_buildings b` with `b.school_id` in FOR UPDATE.
- **Supply create: UNRESOLVED** — `apps/api/src/facilities/inspections.service.ts:632–647` INSERTs into `fac_supply_inventory` with `input.buildingId` without validating that building is in the current school. `adjust()` validates the JOIN through `fac_buildings.school_id`, but `create()` does not. A crafted cross-school `buildingId` lands a supply row in a foreign building.

**A.1.f `sis-advanced/custom-field.service.ts`**
- `upsertValues`: **RESOLVED** — lines 370–376 validate target `entityId` per `entity_type` with `school_id = $2::uuid` predicate for all four entity types (STUDENT/STAFF/GUARDIAN/CLASS).

**Original P2-H1 Round 1 fixes still in place**
- `family-relationship.service.ts`: **RESOLVED** — `school_id = $2::uuid` predicates at lines 76, 91–100, 110–118, 225–238, 253–259.
- `cross-school-staff.service.ts`: **RESOLVED** — `home_school_id = $2::uuid OR visiting_school_id = $2::uuid` at lines 114, 138, 207–209.
- `governance/erasure.service.ts` (pseudonymisation + privacy notice paths): **RESOLVED** — `school_id` predicates at lines 115, 164, 211, 310.

### A.2 Permission Codes

- GRP-002 in `permissions.json`: **RESOLVED** — `packages/database/data/permissions.json:354`.
- GRP-003 in `permissions.json`: **RESOLVED** — line 359.
- GRP-002 in `seed-iam.ts`: **RESOLVED** — granted to Teacher/Staff at `packages/database/src/seed-iam.ts:478–479, 706, 923, 1299–1300`.
- GRP-003 in `seed-iam.ts`: **RESOLVED** — lines 479, 1300.

### A.3 GuardianAuthorizationService

`apps/api/src/iam/guardian-authorization.service.ts`:
- Reads `sis_family_relationships.custody_arrangement`: **RESOLVED** — `loadCustodyContext()` at lines 109–125.
- Reads court-order restrictions JSONB: **RESOLVED** — line 119 selects `court_order_restrictions`.
- `canAuthorizePayment` validates `familyAccountId` binding: **RESOLVED** — lines 255–271 verify `fa.account_holder_id = $3 AND fas.student_id = $4`. The earlier "ignores familyAccountId" defect is closed.
- Fails closed on null `portal_access_scope`: **RESOLVED** — explicit null checks at lines 205–206, 225, 304, 327–328 (`if (link.portal_access_scope == null) return false`).
- Persists access decisions to durable audit storage: **RESOLVED** — `logAccessDecision()` at lines 160–193 writes `platform.audit_log` row with capability + granted + dataSubjectId per ADR-052 (not just Nest logger).

### A.4 @StudentOwned Decorator

- Decorator definition: **RESOLVED** — `apps/api/src/auth/student-owned.decorator.ts:55` exports `StudentOwned()` with `StudentOwnedOptions` (lines 35–53) including `studentIdParam`, `studentIdBody`, `allowAdminOverride`, `allowCoachDelegation`.
- **Application to target surfaces: UNRESOLVED** — grep across `apps/api/src` finds zero usages of `@StudentOwned()` on any controller method. The decorator is defined but not applied to any of the canonical student-owned tables: pfl_reflections, ath_recruiting_profiles, pfl_college_applications, sis_student_profiles, cls_ai_tutoring_sessions, pfl_resume_profiles. The plan's "Standardise Student-Owned Data Guards" goal is met at the helper level but not at the call sites.

### A.5 Engagement Score Component View

- Component view restricted to ENG-001:admin: **RESOLVED** — `apps/api/src/engagement/engagement-score.service.ts:153, 178` set `stripComponents = !(await isEngagementAdmin(actor, this.permCheck))`.
- `isEngagementAdmin()` checks `ENG-001:admin`: **RESOLVED** — `apps/api/src/engagement/access.ts:106–112` requires school admin OR `eng-001:admin` (NOT `eng-001:read`).
- Aggregate `engagement_level` still visible to ENG-001:read: **RESOLVED** — when `stripComponents=true`, the DTO at lines 67, 110 keeps `engagement_level` + `composite_score` populated and nulls only the per-component breakdown.

### A.6 Soft-Integrity str_orders

- `assertExternalCustomerInCurrentSchool` called before INSERT: **RESOLVED** — `apps/api/src/store/orders.service.ts:494` calls the helper before manager-on-behalf INSERT; helper at lines 176–178 JOINs through `str_stores.school_id`.
- `assertStudentInCurrentSchool` called before manager-on-behalf STUDENT INSERT: **RESOLVED** — line 491 invokes the helper when `isStoreManager(actor)` and `orderType='STUDENT'`; helper validates `student_id` via `school_id = $tenant.schoolId` at lines 199–201.

---

## Section B — Schema & Immutability (P2-H2 + H5 follow-up)

### B.7 Schema Drift Fixes

- `fin_gl_entries.period_start`: **RESOLVED** — `packages/database/prisma/tenant/migrations/177_p2h2_tenant_schema_drift_and_immutable_triggers.sql:21–27` adds the column with backfill from `created_at::date` and `fin_gl_entries_period_start_idx`.
- `platform_signature_requests` table: **RESOLVED** — `packages/database/prisma/platform/migrations/20260516225445_p2h2_platform_schema_drift/migration.sql:62–90`; Prisma model at `packages/database/prisma/platform/schema.prisma:1219–1245` with PENDING/SIGNED/DECLINED/EXPIRED/REVOKED lifecycle.
- `partition_mgmt_health` table: **RESOLVED** — migration lines 92–114; Prisma model lines 1263–1283 with UNIQUE(schema_name, parent_table, partition_name).
- `compliance_ferpa_requests` table: **RESOLVED** — migration lines 116–145; Prisma model lines 1298–1324 with RECEIVED/IN_PROGRESS/COMPLETED/DENIED/CONTESTED lifecycle and 45-day deadline tracking.
- `platform_reference_health` registry shape: **RESOLVED** — migration lines 41–60 + Prisma schema lines 970–999. `platform_reference_health_source_uq` UNIQUE on `(source_schema, source_table, source_column)` at line 56; `target_module` + `severity` columns present; deduplication SQL at lines 49–54 keeps most-recent scan per source triple. Not event-log-per-scan shape.

### B.8 IMMUTABLE Triggers

- BEFORE UPDATE OR DELETE triggers on all 12 tables: **RESOLVED** — migration 177 lines 29–63 attach `CREATE TRIGGER prevent_mutation BEFORE UPDATE OR DELETE … EXECUTE FUNCTION public.raise_immutable_violation()` to `fin_gl_entries` (line 30), `pay_credit_notes` (33), `pay_payment_reversals` (36), `pay_lunch_account_balance_transfers` (39), `pay_ledger_entries` (42), `fds_inventory_transactions` (45), `pub_publication_versions` (48), `svc_referral_activity` (51), `tkt_ticket_activity` (54), `hlth_health_access_log` (57), `inc_incident_timeline` (60), `dpo_pseudonymisation_log` (63). Shared function defined in platform migration at `20260516225445_p2h2_platform_schema_drift/migration.sql:22–28` with ERRCODE `restrict_violation`.
- REVOKE UPDATE, DELETE in `provision-tenant.ts` (Codex-flagged gap): **RESOLVED** — `packages/database/src/provision-tenant.ts:79–128`. `IMMUTABLE_TABLES` array at lines 22–35; `applyImmutableRevokes()` function loops at lines 110–120 with `REVOKE UPDATE, DELETE, TRUNCATE ON [table] FROM [appRole]` (line 117) and `FROM PUBLIC` (line 119). App role created idempotently at lines 86–92 (default `campusos_app`, override `DATABASE_APP_ROLE`). Defence-in-depth comment at lines 10–20 documents that the app role lacks `ALTER TABLE` so it cannot `DISABLE TRIGGER`.

### B.9 Seed Data

- `school_config` seed rows: **RESOLVED** — `packages/database/src/seed-config.ts:40–121` seeds engagement_score_weights (lines 43–46, sums to 100), engagement_level_thresholds (49–52), engagement_score_purpose (55–63), library_recommendation_weights (67–75, sums to 100), breach_escalation_thresholds (79–88), sar_default_deadline_days (91–95), wellbeing_alert_thresholds (98–107), no_show_alert_window_minutes (110–114), engagement_payment_component_enabled (117–121).
- `school_feature_flags` seed rows: **RESOLVED** — `seed-config.ts:138–170` seeds enrolment_public_search_enabled (140–145), payment_integration_stripe_live (147–152, disabled with reason `dev_demo_mode_uses_stubbed_pi_dev_uuid_intents`), ai_tutoring_enabled (154–159, quota 100k tokens/day), guardian_health_access_strict (161–169).
- Wired into seed chain: **RESOLVED** — `packages/database/src/seed-all.ts:39–44` runs `seed-config.ts` as step 4 immediately after IAM cache rebuild.

---

## Section C — Kafka & Financial Integrity (P2-H3 + H5 follow-up)

### C.10 Producers for the 3 BLOCKING Topics

- `pay.debt.written_off`: **RESOLVED** — `apps/api/src/payments/invoice.service.ts:376` emits via `outbox.enqueueInTx(tx, { topic: 'pay.debt.written_off', … })` inside the `cancel()` tenant tx (block at lines 360–392). Durable.
- `hlth.allergy_alert.changed`: **UNRESOLVED** — `apps/api/src/health/health-record.service.ts:137–152` defines `emitAllergyAlertChanged()` as `void this.kafka.emit({ topic: 'hlth.allergy_alert.changed', … })` (line 138). Best-effort, not outbox-durable. Called fire-and-forget from `create` (line 340) and `update` (line 403) outside any transaction context. The plan's P2-H3 Step 1 pattern explicitly required: *"Financial and safety topics (#9, #10, #11) must use the outbox pattern."* `hlth.allergy_alert.changed` is finding #10 and is a safety event (allergen exposure) — it must be outbox-durable.
- `fds.meal.served`: **UNRESOLVED** — `apps/api/src/food-service/pos.service.ts:447–463` emits via `await this.kafka.emit({ topic: 'fds.meal.served', … })` (line 448) outside the transaction scope (after `executeInTenantTransaction()` commits). The topic registry at `docs/kafka-topic-registry.md:223` reclassifies this as OBSERVABLE, which would justify best-effort, but the P2-H3 Step 1 plan listed it as BLOCKING finding #11 and required outbox. Either the classification is correct and the plan needs amending, or the emit needs to move to outbox; the current state is inconsistent with the original BLOCKING requirement.

### C.11 Outbox Atomicity for the 7 Financial / Safety Emits

- `pay.payment.received`: **RESOLVED** — `apps/api/src/payments/payment.service.ts:260` enqueues via `outbox.enqueueInTx(tx, …)` inside `executeInTenantTransaction` (lines 247–291).
- `pay.invoice.created`: **RESOLVED** — `apps/api/src/payments/invoice.service.ts:285` enqueues inside tenant tx (block 241–295); post-commit fallback removed (comment at 297–300).
- `pay.refund.issued`: **RESOLVED** — `apps/api/src/payments/refund.service.ts:272` enqueues inside tenant tx (block 223–297).
- `enr.student.enrolled`: **RESOLVED** — `apps/api/src/enrollment/offer.service.ts:401` enqueues inside tenant tx (block 371–443); post-commit emit removed (comment 441–442).
- **`iep.accommodation.updated` (Codex-flagged): RESOLVED** — `apps/api/src/health/iep-plan.service.ts:908–975`. `emitAccommodationSnapshotInTx(tx, …)` now accepts the active transaction (lines 909–912), performs reads through the same `tx` parameter (lines 915, 932), and enqueues via `outbox.enqueueInTx(tx, …)` (line 952). Called from `createPlan` (line 325), `updatePlan` (line 559), `addAccommodation` (line 620), `updateAccommodation` (line 636) — all inside their parent `executeInTenantTransaction` blocks. The Codex defect (separate transaction after domain commit) is closed.
- `msg.message.posted`: **RESOLVED** — `apps/api/src/messaging/message.service.ts:211` enqueues inside tenant tx (block 175–227); post-commit emit removed (comment 246).
- `mtg.meeting.scheduled`: **RESOLVED** — `apps/api/src/meetings/meeting.service.ts:317` enqueues inside tenant tx (block 286–333).

### C.12 GL Reconciliation Worker

`apps/api/src/finance/gl-reconciliation.worker.ts`:
- AMOUNT_MISMATCH detection: **RESOLVED** — `checkSourceVsGl()` at lines 158–244 pulls source amount (170–172) and GL aggregate via `SUM(g.debit + g.credit)` (183–195), then asserts at lines 224–240 that GL total is either 1× or 2× the source absolute amount; on miss pushes `{ issue: 'AMOUNT_MISMATCH', expected, actual }`.
- DUPLICATE_POSTING detection: **RESOLVED** — `checkDuplicatePostings()` at lines 247–282 GROUPs by `source_event_id` and emits a row for any `batch_count > 1`.
- ORPHAN_GL_ENTRY detection: **RESOLVED** — `checkOrphanGlEntries()` at lines 285–333 selects GL entries with `NOT EXISTS` against the referenced source row per reference type.
- Alerts (not just logs): **RESOLVED** — `emitAlert()` at lines 395–420 enqueues `fin.gl_reconciliation.discrepancy` via `outbox.enqueueInTx(tx, …)` (line 414) with `severity: 'URGENT'`. Triggers on both `DISCREPANCIES_FOUND` (110–118) and `FAILED` (127). Consumer wired at `apps/api/src/finance/gl-reconciliation-alert.consumer.ts:1–81` subscribes to the topic and enqueues IN_APP + EMAIL notifications via `NotificationQueueService.enqueue()` for every school admin (line 67) within the 15-min financial-event SLA.

### C.13 Kafka Topic Registry

- File exists: **RESOLVED** — `docs/kafka-topic-registry.md`.
- Classification per topic: **RESOLVED** — lines 6–15 define COMMAND / NOTIFICATION / OBSERVABLE / FUTURE; every topic row carries a Class column.
- Producer + consumers per topic: **RESOLVED** — every row lists both.
- Topic count: **RESOLVED** — 133 topic rows (`grep "^| \`" docs/kafka-topic-registry.md | wc -l`), exceeding the CLAUDE.md "~110" reference.

---

## Section D — Policy & Operational (P2-H4 + H5 follow-up)

### D.14 Policy Documents

- `docs/ai-data-policy.md`: **RESOLVED** — 182 lines, 8 sections: Scope (line 9), Hard Categorical Exclusions (24, 11-row table for health/behaviour/counselling/wellbeing/mandatory-reports/etc.), PII Minimisation Before Provider Calls (48), Provider Configuration (99, zero-retention + training opt-out + EU/US region pinning), Opt-Out Effect (115, 24h hard-deletion of cls_ai_tutoring_*), Model Output Audit Retention (137, 90-day pseudonymisation via dpo_pseudonymisation_log), Implementation Status (156), Audit + Review (172).
- `docs/retention-pseudonymisation-matrix.md`: **RESOLVED** — 160 lines, 7 subsection tables covering 36 record classes: Operational+Academic (6 rows), Health+Safety (6), Financial (7 incl. pay_ledger_entries line 55 + GL entries line 51), Counselling+Safeguarding (3), HR+Workforce (6), Audit+Logs (11 incl. hlth_health_access_log line 83), Identity+Governance (5). Each entry carries retention duration + legal basis + pseudonymisation action.
- `docs/migration-orchestration.md`: **RESOLVED** — 255 lines, 11 sections: cluster capacity (line 23), authoring rules (35, splitter + idempotency + expand/contract), online index creation (100, CREATE INDEX CONCURRENTLY), rollout sequencing (118, canary → prod canary → wave-of-10 → schema drift verification), is_frozen gate (188), failure rollback (205, forward-fix only), communication template (235, T-72h/T-24h/T-0/T+1h), migration_status table for resumable execution (151–161, PENDING/IN_PROGRESS/APPLIED/FAILED).
- `docs/kafka-operations-runbook.md`: **RESOLVED** — 329 lines, 11 sections: consumer retry policy by event class (17, 15-min SRE response on financial DLQ at line 28), DLQ table shape (49), alert thresholds (75), replay procedure with event_id preservation rule (103), poison-message quarantine (151), financial SLAs for 11 topics (180), safety SLAs for 7 topics (205), GL reconciliation procedure (218), schema compatibility (269), outbox reconciliation (290), Phase 3 carry-over (319).

### D.15 SoftIntegrityHealthWorker

- File: **RESOLVED** — `apps/api/src/observability/reference-health/reference-health.worker.ts` (named `ReferenceHealthScannerWorker`, line 44).
- Walks SOFT_FK_REGISTRY: **RESOLVED** — line 4 import + lines 98–104 iteration; platform-scoped entries scanned once, tenant-scoped entries scanned per active tenant.
- Counts dangling references: **RESOLVED** — LEFT JOIN pattern at lines 127–132 (`WHERE t."${targetColumn}" IS NULL`).
- Stores to `platform_reference_health`: **RESOLVED** — UPSERT at lines 166–196 with `orphan_count` + `scanned_at`.
- Nightly schedule: **RESOLVED** — `onModuleInit` at line 51 starts warmup (60s default, `REFERENCE_HEALTH_WARMUP_MS`) then `setInterval(..., intervalMs)` at lines 63–67 with default 3 600 000 ms (1 hour, `REFERENCE_HEALTH_SCAN_INTERVAL_MS`). Cleanup on shutdown at lines 75–77.

### D.16 Worker Jitter Helper

- File: **RESOLVED** — `apps/api/src/observability/worker-jitter.ts`.
- `jitterDelayMs(tenantId, windowMs)`: **RESOLVED** — line 35, sha256 of tenantId, first 6 bytes mod windowMs.
- `jitterWeekday(tenantId)`: **RESOLVED** — line 48, `hash.readUInt8(0) % 7`.
- `jitterMonthDayOffset(tenantId, maxDay=5)`: **RESOLVED** — line 58, `hash.readUInt8(1) % maxDay`.

### D.17 Election min_votes_for_results

- Schema field: **RESOLVED** — `packages/database/prisma/tenant/migrations/179_p2h4_ext_elections_min_votes.sql:20` adds `min_votes_for_results INT NOT NULL DEFAULT 5`; line 26 adds CHECK (>= 1).
- Service-layer enforcement: **RESOLVED** — `apps/api/src/clubs/election.service.ts:335` reads the field in `getResults()`; line 385 short-circuits with `{ resultsSuppressed: true, results: [] }` when `totalVotersChecked < minVotesForResults`.

### D.18 School Size Preset

- Seed row: **RESOLVED** — `packages/database/src/seed-config.ts:124` defines `school_size_preset` with default STANDARD and per-preset boolean hide-flags at lines 125–132. CLAUDE.md confirms this is a `school_config` row (not `platform_tenant_configs`).

---

## Summary

| Section | Findings checked | Resolved | Unresolved |
| ------- | ---------------- | -------- | ---------- |
| A — Security | 31 | 29 | 2 |
| B — Schema & immutability | 11 | 11 | 0 |
| C — Kafka & financial | 14 | 12 | 2 |
| D — Policy & operational | 9 | 9 | 0 |
| **Total** | **65** | **61** | **4** |

### Unresolved Items (Inventory)

1. **A.1.e — `facilities/inspections.service.ts` SupplyService.create** (`apps/api/src/facilities/inspections.service.ts:632–647`). INSERT into `fac_supply_inventory` accepts `input.buildingId` with no school-scope validation. Companion `adjust()` correctly validates via JOIN to `fac_buildings.school_id`. Class of defect matches the Codex adjacent-query pattern: the named fix was applied to one method in the file but not its sibling. **Fix:** add an `assertBuildingInCurrentSchool(buildingId)` call before the INSERT at line 638, modeled on the `adjust()` JOIN pattern at lines 674–680.

2. **A.4 — @StudentOwned decorator not applied** (`apps/api/src/auth/student-owned.decorator.ts:55` defined, zero usages across `apps/api/src`). The helper exists but is not annotating any controller method on the six canonical student-owned tables (`pfl_reflections`, `ath_recruiting_profiles`, `pfl_college_applications`, `sis_student_profiles`, `cls_ai_tutoring_sessions`, `pfl_resume_profiles`). The defense is currently service-layer only; the decorator's value as a discoverable controller-level guard is unrealized. **Fix:** annotate the relevant controller methods with `@StudentOwned({ studentIdParam, ... })`, OR document this as a "service-layer-only" guard pattern and either delete the decorator or treat the helper file itself as the canonical guard.

3. **C.10.b — `hlth.allergy_alert.changed` is best-effort, not outbox-durable** (`apps/api/src/health/health-record.service.ts:137–152`, called fire-and-forget from lines 340 + 403). P2-H3 Step 1 plan text required this safety topic to use the outbox pattern. A broker outage between the domain commit and the post-tx emit can silently drop an allergen alert. **Fix:** replace `void this.kafka.emit(...)` with `await this.outbox.enqueueInTx(tx, ...)` inside the same `executeInTenantTransaction` that writes the health-record allergy field.

4. **C.10.c — `fds.meal.served` is best-effort, not outbox-durable** (`apps/api/src/food-service/pos.service.ts:447–463`, emit at line 448 outside the tx). Plan-text said outbox; topic registry at `docs/kafka-topic-registry.md:223` says OBSERVABLE (best-effort permitted). **Fix:** either (a) move the emit inside the POS transaction with `outbox.enqueueInTx`, OR (b) ratify the OBSERVABLE classification in writing — pick one and reconcile so the plan and registry agree. Note the LunchAccountConsumer's `source_event_id` dedup recovers from drops on the next event, but this is recovery, not delivery durability.

### Overall Verdict: **FAIL**

Four unresolved items. None are systemic regressions of the H5 hardening contract — the heaviest fixes (Codex iep.accommodation atomicity, REVOKE on immutable tables, family-relationship custody resolution, GuardianAuthorizationService durable audit, GL reconciliation amount/duplicate/orphan checks + alert consumer, all 4 policy docs, immutable triggers across 12 tables) are all closed. The four gaps are localized:

- Two are sibling-method-not-fixed defects (A.1.e supply create, A.4 decorator unwired) — same shape as the Codex adjacent-query pattern that prompted H5 itself.
- Two are durability-classification inconsistencies on safety-class Kafka emits (C.10.b, C.10.c) — registry and plan disagree.

These should be cleaned up in a single follow-up commit before the second-round review fires. Until then the hardening sprint is one commit away from PASS.
