# Cycle 7 Handoff — Tasks & Approval Workflows

**Status:** Cycle 7 **IN PROGRESS** — Step 1 done (commit pending in this push). Cycles 0–6 are COMPLETE; Phase 2 Parent Polish (the cross-cutting bundle of 5 commits between `44dff03` and `c9d2de7` on 2026-05-03) extended the tenant base table count from 106 → 108 with `sch_calendar_event_rsvps` (`023`) and `sis_child_link_requests` (`024`); platform `schools` gained 4 nullable columns (`latitude`, `longitude`, `full_address`, `shared_billing_group_id`) and `enr_enrollment_periods` gained `allows_public_search` (`025`). Cycle 7 picks up from there. The Cycle 7 plan called its migrations `024` + `025` but those numbers are taken, so Cycle 7 ships them as **`026`** + **`027`**.

**Branch:** `main`  
**Plan reference:** `docs/campusos-cycle7-implementation-plan.html`  
**Vertical-slice deliverable:** Teacher publishes an assignment → TaskWorker consumes `cls.assignment.posted` → auto-task rule creates a TODO task on every enrolled student's to-do list → student opens the new "Tasks" app and marks DONE. Separately: teacher submits a leave request → WorkflowEngineService creates a multi-step approval (department head → principal) → both approve in turn → `approval.request.resolved` fires → LeaveService consumes it and approves the leave → coverage_needed flows as before. The cycle retroactively connects Cycles 1–6 by giving every domain module a unified task surface and a configurable approval engine.

This document tracks the Cycle 7 build — the M1 Task Management module (6 tables) + M2 Approval Workflows module (6 tables) — at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE6.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                  | Status            |
| ---- | ------------------------------------------------------ | ----------------- |
| 1    | Task Schema — Tasks, Archive, Auto-Rules               | **DONE**          |
| 2    | Workflow Schema — Templates, Requests, Steps           | pending           |
| 3    | Seed Data — Auto-Task Rules + Workflow Templates       | pending           |
| 4    | Task Worker — Kafka Consumer + Auto-Task Engine        | pending           |
| 5    | Task NestJS Module — CRUD + Acknowledgements           | pending           |
| 6    | Workflow Engine — Multi-Step Approval                  | pending           |
| 7    | Leave Approval Migration to Workflow Engine            | pending           |
| 8    | Tasks UI — To-Do List + Acknowledgements               | pending           |
| 9    | Approvals UI — Admin Queue + Workflow Config           | pending           |
| 10   | Vertical Slice Integration Test                        | pending           |

---

## What this cycle adds on top of Cycles 0–6

Cycle 7 is the first cross-cutting cycle of Phase 3 Wave 1. It does not introduce a new domain — instead, it factors out two patterns that earlier cycles hardcoded module-by-module and replaces them with one shared engine each:

- **Tasks (M1).** Cycles 1–6 each had their own ad-hoc to-do surface (Cycle 2 grade-publish notifications, Cycle 4 leave approval queues, Cycle 6 absence-request review queues). After Cycle 7 every persona has a single Tasks app driven by a Kafka consumer that translates domain events into actionable rows. The Task Worker (ADR-011) is the **sole writer** to `tsk_tasks` — domain modules emit events, auto-task rules subscribe, the worker creates rows. No domain module writes tasks directly. Manual tasks (someone typing into the Tasks app) flow through `TaskService` with `source='MANUAL'`.

- **Approval workflows (M2).** Cycle 4 baked a hardcoded approve/reject pattern into `LeaveService`, Cycle 5 did the same in `RoomChangeRequestService`, Cycle 6.1 added `ChildLinkRequestService` with the same shape. Cycle 7 ships `WorkflowEngineService` (ADR-012) — the **sole writer** to `wsk_approval_requests` and `wsk_approval_steps`. Source modules submit via REST and listen on `approval.request.resolved`. Step 7 migrates leave approval onto the engine while keeping the existing direct admin-override endpoints as a fallback. Room-change and child-link requests stay on their hardcoded patterns this cycle (the approval engine is fully capable of absorbing them later — flagged as future work).

What does not change: every existing module continues to function. Cycle 7 is purely additive on the request path; the migration in Step 7 is opt-in via the presence of a `LEAVE_REQUEST` workflow template.

---

## Step 1 — Task Schema — Tasks, Archive, Auto-Rules

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-03. Idempotent re-provision verified (zero new applies on the second run; the IF NOT EXISTS guards on every CREATE TABLE / CREATE INDEX / per-partition CREATE TABLE work as designed). Splitter-clean — Python audit script confirmed zero `;` inside any block comment or single-quoted string.

**Migration:** `packages/database/prisma/tenant/migrations/026_tsk_tasks_and_auto_rules.sql`.

**Tables (6):**

1. **`tsk_acknowledgements`** — first because the `tsk_tasks.acknowledgement_id` FK references it. Per-(school, subject_id) PENDING / ACKNOWLEDGED / ACKNOWLEDGED_WITH_DISPUTE / EXPIRED lifecycle. `source_type` 6-value CHECK (ANNOUNCEMENT / DISCIPLINE_RECORD / POLICY_DOCUMENT / SIGNED_FORM / CONSENT_REQUEST / CUSTOM); `source_ref_id` + `source_table` are a soft polymorphic ref to whichever domain table generated the request. `requires_dispute_option` flag drives the UI's "Dispute" button; multi-column `dispute_chk` enforces ACKNOWLEDGED_WITH_DISPUTE ⇒ `dispute_reason IS NOT NULL`; multi-column `ack_chk` enforces ACKNOWLEDGED / ACKNOWLEDGED_WITH_DISPUTE ⇒ `acknowledged_at IS NOT NULL`. INDEX(subject_id, status). INDEX(source_type, source_ref_id). Soft cross-schema FKs to `platform.iam_person` (subject_id) and `platform.platform_users` (created_by) per ADR-001/020.

2. **`tsk_auto_task_rules`** — per-(school, trigger_event_type) catalogue of auto-task rules. `priority` ENUM CHECK (LOW / NORMAL / HIGH / URGENT), `task_category` ENUM CHECK (ACADEMIC / PERSONAL / ADMINISTRATIVE / ACKNOWLEDGEMENT). `due_offset_hours` INT optional (when set, generated tasks get `due_at = event_time + offset`). `is_active` toggle for soft-deactivation (the Step 4 worker filters on it); `is_system` flag distinguishes seed rules (which schools cannot delete, only deactivate) from school-authored custom rules. Partial UNIQUE INDEX `(school_id, trigger_event_type) WHERE is_system = true` so the seed never inserts a duplicate system rule. Title and description templates support `{placeholder}` substitution; the worker handles substitution in code (Step 4).

3. **`tsk_auto_task_conditions`** — optional condition rows attached to a rule. `field_path` is a JSON dot-path into the inbound event payload; `operator` 7-value CHECK (EQUALS / NOT_EQUALS / IN / NOT_IN / GT / LT / EXISTS); `value JSONB` is the comparand (an array for IN/NOT_IN). The worker (Step 4) AND-s every row for a rule — all conditions must match for the rule to fire. ON DELETE CASCADE on the rule.

4. **`tsk_auto_task_actions`** — one or more action rows per rule. `action_type` 3-value CHECK (CREATE_TASK / CREATE_ACKNOWLEDGEMENT / SEND_NOTIFICATION); `action_config JSONB` carries the action-specific config. Most rules have one CREATE_TASK; acknowledgement rules have CREATE_ACKNOWLEDGEMENT followed by CREATE_TASK; future SEND_NOTIFICATION actions can run alongside. `sort_order` orders execution. ON DELETE CASCADE on the rule.

5. **`tsk_tasks`** — RANGE-partitioned by `created_at` monthly, **24 partitions** covering 2025-08 → 2027-08 inclusive (matches the `msg_messages` window from Cycle 3). Composite PK `(id, created_at)` because the partition column must appear in the unique constraint — same pattern as `msg_notification_log (id, sent_at)`, `sis_attendance_records (id, school_year, class_id)`, `pay_ledger_entries (id, created_at)`. `source` 3-value CHECK (MANUAL / AUTO / SYSTEM); `priority` 4-value; `status` 4-value (TODO / IN_PROGRESS / DONE / CANCELLED); `task_category` 4-value. Multi-column `completed_chk` enforces TODO/IN_PROGRESS ⇒ `completed_at IS NULL` and DONE/CANCELLED ⇒ `completed_at IS NOT NULL`. `acknowledgement_id` FK → `tsk_acknowledgements(id) ON DELETE SET NULL` so deleting an acknowledgement leaves the task row defensible. `created_for_id` carries the assignee when one user creates a task for another. INDEX(owner_id, status, due_at) is the hot path for "my open tasks ordered by due date". Partial INDEX(owner_id, source, source_ref_id) WHERE source != 'MANUAL' for auto-task dedup investigation — authoritative idempotency is Redis SET NX (Step 4) since partitioned-table UNIQUE constraints must include the partition column, which would defeat dedup. Soft cross-schema FKs to `platform.platform_users` for `owner_id` + `created_for_id` per ADR-001/020.

6. **`tsk_tasks_archive`** — RANGE-partitioned by `created_at` annually, **3 partitions** covering 2025 / 2026 / 2027. Same shape as `tsk_tasks` plus `archived_at TIMESTAMPTZ NOT NULL DEFAULT now()`. No FK back to `tsk_acknowledgements` so a deleted ack leaves the archived row stable. INDEX(owner_id, completed_at DESC) for "my completed tasks newest-first". The archiver job (move DONE/CANCELLED rows older than 30 days from `tsk_tasks` to this table) is **deferred** — Cycle 7 ships only the schema.

**Migration discipline:**

- Block-comment header (no `--` line comments at the top of file — per the splitter quirk from Cycles 4–6).
- No semicolons inside any string literal, default expression, COMMENT, or CHECK predicate (the splitter cuts on every `;` regardless of quoting).
- `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency. Re-running the provisioner should be a no-op.
- 24 monthly partitions written out one per line as `CREATE TABLE IF NOT EXISTS tsk_tasks_YYYY_MM PARTITION OF tsk_tasks FOR VALUES FROM (...) TO (...)` — same convention as `msg_messages`.

**Tenant logical base table count after Step 1:** 108 + 6 = **114** (the 24 monthly partitions + 3 yearly partitions are not counted as logical base tables, matching the `sis_attendance_records`, `msg_messages`, `msg_notification_log`, `msg_moderation_log`, and `pay_ledger_entries` precedent).

**FK summary:** 4 new intra-tenant DB-enforced FKs:

- `tsk_auto_task_conditions.rule_id → tsk_auto_task_rules(id) ON DELETE CASCADE`
- `tsk_auto_task_actions.rule_id → tsk_auto_task_rules(id) ON DELETE CASCADE`
- `tsk_tasks.acknowledgement_id → tsk_acknowledgements(id) ON DELETE SET NULL` — replicated onto each of the 24 monthly partitions plus the parent (25 rows in `pg_constraint` for one logical FK; same precedent as `pay_ledger_entries.family_account_id`)

0 cross-schema FKs.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK with savepoints, 12 assertions, all green):**

1. Happy path — 5 inserts across `tsk_acknowledgements` + `tsk_auto_task_rules` + `tsk_auto_task_conditions` + `tsk_auto_task_actions` + `tsk_tasks` succeed.
2. `tsk_tasks_status_chk` rejects status='BOGUS'.
3. `tsk_tasks_completed_chk` rejects status=TODO with non-null completed_at.
4. `tsk_tasks_completed_chk` rejects status=DONE with null completed_at.
5. `tsk_acknowledgements_dispute_chk` rejects status=ACKNOWLEDGED_WITH_DISPUTE without dispute_reason.
6. `tsk_acknowledgements_ack_chk` rejects status=ACKNOWLEDGED without acknowledged_at.
7. Partition out-of-window: INSERT with created_at='2024-12-31' rejected (the window starts at 2025-08, no partition covers 2024). PostgreSQL surfaces this as a check_violation against the implicit partition predicate.
8. Partition routing: the 2026-04-15 row from assertion 1 lands inside the leaf table `tsk_tasks_2026_04` (verified via `SELECT … FROM ONLY tsk_tasks_2026_04 WHERE id=…` — returns 1 row).
9. ON DELETE CASCADE: deleting the rule drops the linked condition + action rows (both counts go to 0).
10. ON DELETE SET NULL: deleting an acknowledgement leaves the linked `tsk_tasks` row in place with `acknowledgement_id` cleared to NULL (so 0 rows still link to the deleted ack id, and 1 row exists with the new task id and NULL ack).
11. Partial UNIQUE: a duplicate `(school_id, trigger_event_type)` row with `is_system=true` is rejected by `tsk_auto_task_rules_school_event_uq`; the same `(school, event)` with `is_system=false` is accepted, proving the school-custom override path works.
12. `tsk_auto_task_conditions_operator_chk` rejects operator='BOGUS'.

Sanity counts (filtered to `tenant_demo`):

- 24 monthly partition leaves under `tsk_tasks` (`pg_inherits` join).
- 3 yearly partition leaves under `tsk_tasks_archive`.
- 25 rows in `pg_constraint` for the `tsk_tasks.acknowledgement_id` SET NULL FK — one on the parent + one on each of the 24 monthly partitions, matching the `pay_ledger_entries.family_account_id` precedent from Cycle 6.

**Splitter audit:** Python audit script (regex over single-quoted strings and `/* */` block comments) confirmed zero stray `;` inside either form before the first provision attempt. The migration applied on the first try with no rewrite needed — first cycle since Cycle 4 to clear the splitter trap on the first attempt.

**What's deferred to later steps:**

- The Step 3 seed populates the 8 system auto-task rules + their conditions and actions; Step 1 ships only the empty schema.
- The Step 4 Task Worker becomes the sole writer to `tsk_tasks` (ADR-011); Step 1 has no service code yet.
- The archiver job (background sweep moving DONE/CANCELLED rows from `tsk_tasks` to `tsk_tasks_archive` after 30 days) is deferred to ops — schema is ready in Step 1, the cron is not.
- `tsk_task_tags` from the ERD is intentionally not included (deferred per the plan's "What's In / What's Deferred" callout).

---

## Open items / known gaps

This section will be filled in as steps land. For Step 1 specifically:

- The auto-task dedup mechanism is dual-layer (partial INDEX on the partitioned table for read-side investigation + Redis SET NX as authoritative). The schema-level INDEX is non-unique because partitioned tables require the partition key in any UNIQUE constraint, which would defeat the dedup goal. Documented here so a reviewer doesn't ask "why no UNIQUE on the auto-task path?".
- `tsk_tasks_archive` ships with 3 yearly partitions (2025 / 2026 / 2027). Adding 2028+ partitions is a routine schema ALTER when the time comes — not a Cycle 7 ship blocker.

---

## Cycle 7 exit criteria (from the plan)

1. Tenant schema: 12 new tables (6 task + 6 workflow). tsk_tasks RANGE-partitioned monthly.
2. Task Worker: sole writer to tsk_tasks (ADR-011). Subscribes to all auto-task trigger topics. 8 seeded rules.
3. Workflow Engine: sole writer to wsk_approval_requests/steps (ADR-012). Multi-step sequential approval. 3 seeded templates.
4. Leave approval migrated from hardcoded to workflow engine. Backward-compatible admin override.
5. Task API: ~8 endpoints. Manual CRUD, status transitions, acknowledgements.
6. Approval API: ~7 endpoints. Submit, step advancement, comments, withdrawal.
7. Tasks UI: to-do list with category grouping, task detail, acknowledgement flow, manual creation.
8. Approvals UI: pending queue, detail with step timeline, workflow configuration.
9. Vertical slice: assignment → auto-task → student sees it. Leave → multi-step approval → resolved → coverage flows.
10. HANDOFF-CYCLE7.md and CLAUDE.md updated. CI green.
