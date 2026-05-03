# Cycle 7 Handoff — Tasks & Approval Workflows

**Status:** Cycle 7 **IN PROGRESS** — Steps 1 + 2 + 3 + 4 + 5 + 6 done. Schemas land cleanly; demo seeded with 8 rules + 3 templates + 5 sample tasks + 1 historical audit; OPS-001 grants on the four non-admin personas; TaskWorker live; Step 5 ships the request-path API; **Step 6 ships the WorkflowEngineService** — sole writer to `wsk_approval_requests` and `wsk_approval_steps` per ADR-012, 7 endpoints under `/approvals`, multi-step sequential approval with FOR-UPDATE locking, dynamic approver resolution (SPECIFIC_USER / ROLE via iam_role_assignment / MANAGER + DEPARTMENT_HEAD fall back to school admin), `approval.step.awaiting` and `approval.request.resolved` envelopes captured live. Cycles 0–6 are COMPLETE; Phase 2 Parent Polish (the cross-cutting bundle of 5 commits between `44dff03` and `c9d2de7` on 2026-05-03) extended the tenant base table count from 106 → 108 with `sch_calendar_event_rsvps` (`023`) and `sis_child_link_requests` (`024`); platform `schools` gained 4 nullable columns (`latitude`, `longitude`, `full_address`, `shared_billing_group_id`) and `enr_enrollment_periods` gained `allows_public_search` (`025`). Cycle 7 picks up from there. The Cycle 7 plan called its migrations `024` + `025` but those numbers are taken, so Cycle 7 ships them as **`026`** + **`027`**.

**Branch:** `main`  
**Plan reference:** `docs/campusos-cycle7-implementation-plan.html`  
**Vertical-slice deliverable:** Teacher publishes an assignment → TaskWorker consumes `cls.assignment.posted` → auto-task rule creates a TODO task on every enrolled student's to-do list → student opens the new "Tasks" app and marks DONE. Separately: teacher submits a leave request → WorkflowEngineService creates a multi-step approval (department head → principal) → both approve in turn → `approval.request.resolved` fires → LeaveService consumes it and approves the leave → coverage_needed flows as before. The cycle retroactively connects Cycles 1–6 by giving every domain module a unified task surface and a configurable approval engine.

This document tracks the Cycle 7 build — the M1 Task Management module (6 tables) + M2 Approval Workflows module (6 tables) — at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE6.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                  | Status            |
| ---- | ------------------------------------------------------ | ----------------- |
| 1    | Task Schema — Tasks, Archive, Auto-Rules               | **DONE**          |
| 2    | Workflow Schema — Templates, Requests, Steps           | **DONE**          |
| 3    | Seed Data — Auto-Task Rules + Workflow Templates       | **DONE**          |
| 4    | Task Worker — Kafka Consumer + Auto-Task Engine        | **DONE**          |
| 5    | Task NestJS Module — CRUD + Acknowledgements           | **DONE**          |
| 6    | Workflow Engine — Multi-Step Approval                  | **DONE**          |
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

## Step 2 — Workflow Schema — Templates, Requests, Steps

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-03. Idempotent re-provision verified. Splitter-clean — proper state-machine audit (block-comments + line-comments + single-quoted-string awareness with `''` escape handling) confirmed zero `;` outside the legitimate statement terminators on the first attempt.

**Migration:** `packages/database/prisma/tenant/migrations/027_wsk_approval_workflows.sql`.

**Tables (6):**

1. **`wsk_workflow_templates`** — per-(school, request_type) approval chain definition. UNIQUE INDEX on `(school_id, request_type)` so each school has one active template per request type. `is_active` toggle for soft-deactivation. `request_type` is free-form TEXT — schools can author custom workflow types without a schema migration. The seed (Step 3) ships templates for LEAVE_REQUEST + ABSENCE_REQUEST + CHILD_LINK_REQUEST.

2. **`wsk_workflow_steps`** — ordered approval steps belonging to a template. `step_order` INT > 0 CHECK (no zero step). `approver_type` 4-value CHECK SPECIFIC_USER / ROLE / MANAGER / DEPARTMENT_HEAD. **Multi-column `approver_shape_chk`** enforces SPECIFIC_USER and ROLE ⇒ `approver_ref IS NOT NULL`, and MANAGER and DEPARTMENT_HEAD ⇒ `approver_ref IS NULL` (those two resolve dynamically from `hr_employees` + `sis_departments` at runtime). `is_parallel BOOLEAN DEFAULT false` ships now but the engine is sequential-only this cycle — column is forward-compatible per the plan. `timeout_hours INT` nullable with `> 0` CHECK when set. `escalation_target_id` is a soft FK to `platform.platform_users` for the future timeout sweeper. UNIQUE INDEX on `(template_id, step_order)` so two steps in the same template can't share a position. CASCADE on the template FK.

3. **`wsk_approval_requests`** — one row per submission. Status lifecycle PENDING → APPROVED / REJECTED / CANCELLED / WITHDRAWN (4 terminal states). **Multi-column `resolved_chk`** keeps `resolved_at` in lockstep with status — PENDING ⇒ NULL, every terminal status ⇒ NOT NULL. **Multi-column `reference_shape_chk`** enforces `reference_id` and `reference_table` are both set or both null (so a polymorphic ref is never half-populated). The `reference_id` + `reference_table` pair is the soft polymorphic ref to the originating domain row (e.g. `hr_leave_requests.id` + `'hr_leave_requests'`). Both columns are nullable to support CUSTOM workflows without a domain row. **Three indexes:** partial INDEX `(school_id, status, request_type) WHERE status NOT IN ('APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN')` for the admin "active queue" hot path; INDEX `(requester_id, created_at DESC)` for "my requests"; partial INDEX `(reference_table, reference_id) WHERE reference_id IS NOT NULL` for reverse-lookup from a domain row to its approval request. FK `template_id → wsk_workflow_templates(id)` is **NO ACTION** (refuses to delete a template that has historical requests against it — audit trail wins).

4. **`wsk_approval_steps`** — one row per active or completed step on a request. `step_order INT > 0` CHECK. Status lifecycle AWAITING → APPROVED / REJECTED / SKIPPED. **Multi-column `actioned_chk`** enforces AWAITING ⇒ `actioned_at IS NULL`, APPROVED / REJECTED ⇒ `actioned_at IS NOT NULL`, and SKIPPED has no constraint on `actioned_at` (a skipped step was never actioned by anyone, so leaving the timestamp NULL is the correct shape). UNIQUE INDEX on `(request_id, step_order)` so two steps on the same request can't share a position. Partial INDEX `(approver_id, status) WHERE status='AWAITING'` is the approver's pending-queue hot path. CASCADE on the request FK. `approver_id NOT NULL` — the engine resolves the approver at step activation; ROLE-typed steps store one resolved user even if many holders exist (the engine picks one for sequential mode).

5. **`wsk_approval_comments`** — append-only thread on a request. `is_requester_visible BOOLEAN DEFAULT true` distinguishes public comments from approver-internal-only notes. INDEX `(request_id, created_at)` for the chronological thread render. CASCADE on the request FK.

6. **`wsk_workflow_escalations`** — append-mostly audit. One row per escalation. `original_approver_id` + `escalated_to_id` + `hours_overdue NUMERIC(5,1)` + `escalated_at` are set at INSERT. `resolved_at` + `resolved_by` are settable once when the escalation is acted on; **multi-column `resolved_chk`** keeps both fields all-set or all-null together. `hours_overdue >= 0` CHECK. Partial INDEX `(escalated_to_id, resolved_at) WHERE resolved_at IS NULL` for the escalation-recipient's queue. FKs to `wsk_approval_requests(id)` and `wsk_approval_steps(id)` are NO ACTION — the audit row outlives the request being audited. **Schema-only this cycle.** The escalation timeout worker is deferred per the plan.

**Migration discipline:**

- Block-comment header (no `--` line comments at file head).
- No semicolons inside any string literal, default expression, COMMENT, or CHECK predicate.
- `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency.

**Tenant logical base table count after Step 2:** 114 + 6 = **120**.

**FK summary:** 6 new intra-tenant DB-enforced FKs:

- `wsk_workflow_steps.template_id → wsk_workflow_templates(id) ON DELETE CASCADE`
- `wsk_approval_requests.template_id → wsk_workflow_templates(id)` (NO ACTION — refuses delete when historical requests exist)
- `wsk_approval_steps.request_id → wsk_approval_requests(id) ON DELETE CASCADE`
- `wsk_approval_comments.request_id → wsk_approval_requests(id) ON DELETE CASCADE`
- `wsk_workflow_escalations.request_id → wsk_approval_requests(id)` (NO ACTION)
- `wsk_workflow_escalations.step_id → wsk_approval_steps(id)` (NO ACTION)

0 cross-schema FKs.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK with savepoints, 23 assertions, all green):**

1. Happy path — 7 inserts across all 5 mutable tables (1 template + 3 steps + 1 request + 1 step + 1 comment) succeed.
2. `wsk_workflow_steps_order_chk` rejects `step_order=0`.
3. `wsk_workflow_steps_timeout_chk` rejects `timeout_hours=0`.
4. `wsk_workflow_steps_approver_type_chk` rejects approver_type='BOGUS'.
5. `wsk_workflow_steps_approver_shape_chk` rejects SPECIFIC_USER without `approver_ref`.
6. `wsk_workflow_steps_approver_shape_chk` rejects MANAGER with `approver_ref` set.
7. `wsk_workflow_steps_template_order_uq` rejects duplicate `(template, step_order)`.
8. `wsk_workflow_templates_school_type_uq` rejects duplicate `(school, request_type)`.
9. `wsk_approval_requests_status_chk` rejects status='BOGUS'.
10. `wsk_approval_requests_resolved_chk` rejects PENDING with `resolved_at` set.
11. `wsk_approval_requests_resolved_chk` rejects APPROVED without `resolved_at`.
12. `wsk_approval_requests_reference_shape_chk` rejects only `reference_id` set without `reference_table` (or vice versa).
13. `wsk_approval_steps_status_chk` rejects step status='BOGUS'.
14. `wsk_approval_steps_actioned_chk` rejects AWAITING with `actioned_at` set.
15. `wsk_approval_steps_actioned_chk` rejects APPROVED without `actioned_at`.
16. SKIPPED without `actioned_at` is **accepted** — confirms the SKIPPED branch of `actioned_chk` permits null timestamps.
17. `wsk_approval_steps_request_order_uq` rejects duplicate `(request, step_order)`.
18. CASCADE behavior verified: deleting the template (after first deleting the related approval requests) drops its 2 remaining steps; the 2 steps were visible right before the delete and 0 after.
19. NO ACTION FK fires when attempting to delete a template that still has approval requests against it (`foreign_key_violation`).
20. CASCADE on `wsk_approval_requests` delete drops the linked step + comment (both counts 0 after the delete).
21. `wsk_workflow_escalations_hours_chk` rejects `hours_overdue=-1.0`.
22. `wsk_workflow_escalations_resolved_chk` rejects an escalation with `resolved_at` set but `resolved_by` null.
23. Happy-path escalation insert succeeds with both `resolved_at` and `resolved_by` left null (the open-escalation shape).

**Sanity:** 6 logical wsk_* base tables in `tenant_demo` (`information_schema.tables` filter on `wsk\_%` returns exactly 6 — none of these tables are partitioned, so the count matches the logical-table count directly).

**Splitter audit:** A naive single-line regex found false positives because COMMENT strings span multiple lines; switched to a state-machine audit that handles block comments, line comments, and `''` escape sequences inside single-quoted strings. The state-machine audit reports zero `;` outside legitimate statement terminators. Migration applied first try with no rewrite — second cycle in a row to clear the splitter trap on first attempt.

---

## Step 3 — Seed Data — Auto-Task Rules + Workflow Templates

**Status:** DONE. New `packages/database/src/seed-tasks.ts` (idempotent, gated on `tsk_auto_task_rules` row count for the demo school). `seed:tasks` script wired into `package.json`. `seed-iam.ts` updated to grant `OPS-001:read+write` to Teacher / Student / Parent / Staff (the catalogue's existing entry for Internal Task Management — the plan's "SYS-001" wording is reconciled with the function library's `OPS-001` code so the catalogue stays at 447 functions × 3 tiers, no duplicate codes added). Build cache rebuilt; permission counts now read 38 / 19 / 19 / 18 for Teacher / Parent / Student / Staff respectively (each gained 2 perms from OPS-001:read + OPS-001:write).

**Permission grants:**

| Persona | Perms before | Perms after | Delta |
| ------- | -----------: | ----------: | ----- |
| Teacher | 36 | 38 | +`OPS-001:read+write` |
| Parent  | 17 | 19 | +`OPS-001:read+write` |
| Student | 17 | 19 | +`OPS-001:read+write` |
| Staff   | 16 | 18 | +`OPS-001:read+write` |

School Admin and Platform Admin already hold `OPS-001:admin` via the `everyFunction: ['read','write','admin']` catalogue grant — no change needed there. Catalogue total stays at **447 functions × 3 tiers = 1341 permission codes** (no new entries; OPS-001 was already in `permissions.json` waiting for Cycle 7 to use it).

**What's seeded on `tenant_demo` (test tenant stays empty by convention — matches prior seeds):**

1. **8 auto-task rules** (all `is_system=true, is_active=true`):

   | Trigger event | Target role | Priority | Due offset | Category | Actions |
   | ------------- | ----------- | -------- | ---------- | -------- | ------- |
   | `cls.assignment.posted` | STUDENT | NORMAL | 0h | ACADEMIC | CREATE_TASK |
   | `cls.grade.published` | STUDENT | LOW | 168h (7d) | ACADEMIC | CREATE_TASK |
   | `cls.grade.returned` | STUDENT | LOW | 168h | ACADEMIC | CREATE_TASK |
   | `hr.leave.approved` | SCHOOL_ADMIN | HIGH | 24h | ADMINISTRATIVE | CREATE_TASK |
   | `att.absence.requested` | SCHOOL_ADMIN | NORMAL | 24h | ADMINISTRATIVE | CREATE_TASK |
   | `msg.announcement.requires_acknowledgement` | (per-recipient) | NORMAL | 72h | ACKNOWLEDGEMENT | CREATE_ACKNOWLEDGEMENT, CREATE_TASK |
   | `sis.consent.requested` | GUARDIAN | HIGH | 168h | ACKNOWLEDGEMENT | CREATE_ACKNOWLEDGEMENT, CREATE_TASK |
   | `sys.profile.update_requested` | (per-recipient) | NORMAL | 168h | ADMINISTRATIVE | CREATE_TASK |

   Total actions: 10 (6 single-action rules × 1 + 2 dual-action acknowledgement rules × 2).

2. **2 auto-task conditions** — both gating on `payload.isPublished = true`:
   - `cls.assignment.posted` rule fires only when the assignment is published.
   - `cls.grade.published` rule fires only when the grade is published.

3. **3 workflow templates** (each `is_active=true`):
   - **Leave Request Approval** (`request_type=LEAVE_REQUEST`) — 2 steps: Step 1 `DEPARTMENT_HEAD` (timeout 48h), Step 2 `ROLE` `SCHOOL_ADMIN` (timeout 48h).
   - **Absence Request Review** (`request_type=ABSENCE_REQUEST`) — 1 step: `ROLE` `SCHOOL_ADMIN` (timeout 24h).
   - **Child Link Approval** (`request_type=CHILD_LINK_REQUEST`) — 1 step: `ROLE` `SCHOOL_ADMIN` (timeout 72h).

4. **5 sample tasks** all back-dated to `2026-04-15 10:00:00+00` so they land in the `tsk_tasks_2026_04` partition leaf:
   - **3 ACADEMIC tasks for Maya** keyed on her first 3 published `cls_assignments` rows (`source=AUTO`, `source_ref_id` = assignment id, due 2026-04-20).
   - **1 PERSONAL task for Maya** ("Study for Biology test", `source=MANUAL`, due 2026-04-18).
   - **1 ADMINISTRATIVE task for David** ("Update emergency contact information", `source=SYSTEM`, due 2026-04-25).

5. **1 historical approval-request audit row** — wraps Rivera's existing APPROVED sick leave (2026-03-09 → 2026-03-10 from the Cycle 4 seed):
   - `wsk_approval_requests` row with `status=APPROVED`, `request_type=LEAVE_REQUEST`, `reference_id` = Rivera's `hr_leave_requests.id`, `reference_table='hr_leave_requests'`, `submitted_at=2026-02-15`, `resolved_at=2026-02-17`.
   - 2 `wsk_approval_steps` rows: Step 1 approver = VP (Linda Park), `actioned_at=2026-02-16`, comments `'Coverage arranged with Park.'`; Step 2 approver = Principal (Sarah Mitchell), `actioned_at=2026-02-17`, comments `'Approved.'`.
   - Demonstrates the audit trail shape future engine writes will produce.

**Verification (live counts on `tenant_demo`):**

```
rules: 8           tasks: 5
conditions: 2      tasks-by-category: ACADEMIC=3 / ADMINISTRATIVE=1 / PERSONAL=1
actions: 10        workflow-templates: 3
                   workflow-steps: 4
                   approval-requests: 1
                   approval-steps: 2
```

All 5 tasks confirmed routed to the `tsk_tasks_2026_04` leaf (`SELECT COUNT(*) FROM ONLY tsk_tasks_2026_04` returns 5). Idempotent re-run logs `tsk_auto_task_rules already populated for demo school — skipping`. Test tenant stays empty (`tsk_auto_task_rules`, `tsk_tasks` both 0 rows on `tenant_test`).

**Plan vs. catalogue reconciliation:** The plan refers to "Functions SYS-001 (core)" but the function library at `packages/database/data/permissions.json` has the entry under `OPS-001` "Internal Task Management" (Internal Operations group). Adding a new SYS-001 entry would create a duplicate code (the catalogue's existing SYS-001 is "Access Management" — IAM admin). Resolution: use the existing `OPS-001` code in service-layer `@RequirePermission('ops-001:read|write|admin')` decorators when those land in Step 5, and update the plan's nomenclature to match. The function library is authoritative.

---

## Step 4 — Task Worker — Kafka Consumer + Auto-Task Engine

**Status:** DONE. `apps/api/src/tasks/task.worker.ts` + `apps/api/src/tasks/template-render.ts` + new `apps/api/src/tasks/tasks.module.ts` wired into `AppModule.imports` after `HouseholdsModule`. The TaskWorker is the **sole writer to `tsk_tasks`** per ADR-011 — domain modules emit Kafka events; auto-task rules subscribe; the worker creates rows.

**Files:**

- `apps/api/src/tasks/task.worker.ts` — TaskWorker consumer.
- `apps/api/src/tasks/template-render.ts` — `renderTemplate('Complete: {assignment_title}', {...})` placeholder substitution + `buildPlaceholderValues(payload)` flattens camelCase to snake_case so templates can use either form.
- `apps/api/src/tasks/tasks.module.ts` — wires `TaskWorker`, imports `TenantModule + IamModule + KafkaModule + NotificationsModule`.
- `apps/api/src/kafka/event-envelope.ts` — adds `unprefixTopic(wireTopic)` helper, the inverse of `prefixedTopic`, so the worker can match wire topics back to the logical `trigger_event_type` in the rule table.
- `apps/api/src/classroom/assignment.service.ts` — emits `cls.assignment.posted` on every create / update where `is_published=true` lands; injects `KafkaProducerService`; new private helpers `emitPosted()` and `loadClassDescriptor()`.
- `apps/api/src/classroom/grade.service.ts` — adds `isPublished: true` to the `cls.grade.published` payload so the seeded condition (`payload.isPublished = true`) actually evaluates against a present field. The topic name implies it but the field needs to be on the wire for the condition evaluator.

**Worker bootstrap:**

```
TaskWorker subscribed to 8 topic(s):
  dev.att.absence.requested,
  dev.cls.assignment.posted,
  dev.cls.grade.published,
  dev.cls.grade.returned,
  dev.hr.leave.approved,
  dev.msg.announcement.requires_acknowledgement,
  dev.sis.consent.requested,
  dev.sys.profile.update_requested
```

The bootstrap reads `tsk_auto_task_rules` across **every active school** (via `platform.schools` + `platform_tenant_routing` + `executeInExplicitSchema`), takes the union of distinct `trigger_event_type` values, env-prefixes them via `prefixedTopic()`, and subscribes under the `task-worker` consumer group. Adding a new auto-task rule with a never-before-seen trigger type at runtime requires a worker restart — documented limitation; the seed only adds rules at provisioning time today.

**Per-event flow (matches the Cycle 3 + Cycle 5 consumer convention):**

1. `unwrapEnvelope` reads `event_id`, `tenant_id`, `tenant-subdomain` (envelope-first, header-fallback) and reconstructs `TenantInfo`. Drops malformed events.
2. `processWithIdempotency('task-worker', event)` — read-only `IdempotencyService.isClaimed` check. Already-claimed events are dropped silently.
3. `runWithTenantContextAsync` opens the tenant context.
4. Query `tsk_auto_task_rules WHERE trigger_event_type = $1 AND is_active = true` — returns 0..N rules.
5. For each rule, AND-evaluate `tsk_auto_task_conditions` against the payload. The 7-value operator enum (EQUALS / NOT_EQUALS / IN / NOT_IN / GT / LT / EXISTS) is implemented in `evaluateCondition()` in the worker file. Field paths are JSON dot-paths into the payload.
6. Resolve owners via `resolveOwners(rule, eventType, event)`:
   - `cls.assignment.posted` → join `sis_enrollments + sis_students + platform_students + platform_users` for the class. Returns one account_id per ACTIVE enrollee.
   - `target_role='SCHOOL_ADMIN'` → query `platform.iam_effective_access_cache` with the `'sch-001:admin' = ANY(permission_codes)` filter joined to school + platform scopes (matches the `AbsenceRequestNotificationConsumer.loadSchoolAdminAccounts` precedent).
   - `target_role='STUDENT'` → `payload.studentId` → 1 account.
   - `target_role='GUARDIAN'` → `payload.guardianAccountId` → 1 account.
   - Fallback → `payload.recipientAccountId` / `accountId`.
7. Execute actions in `sort_order`:
   - `CREATE_ACKNOWLEDGEMENT` → INSERT into `tsk_acknowledgements` per owner. Returns a `Map<owner_id, ack_id>` so the next CREATE_TASK in the same rule links via `acknowledgement_id`. Source-type heuristic (`inferAckSourceType(topic)`) picks the right enum value from the topic name (announcement / consent / discipline / policy / form / CUSTOM fallback).
   - `CREATE_TASK` → for each owner: per-(owner, source_ref_id) **Redis SET NX** dedup on `tsk:auto:{subdomain}:{owner}:{source_ref_id}` (30-day TTL); if claimed, INSERT into `tsk_tasks` with `source='AUTO'`, `status='TODO'`, the rule's priority + category, the rendered title + description, and `acknowledgement_id` from the prior action when applicable. Each successful insert emits `task.created` with `correlation_id = inbound event_id`.
   - `SEND_NOTIFICATION` → reserved for future cycles; logged and skipped.
8. Post-process — `IdempotencyService.claim('task-worker', event_id)` so a redelivery of the exact same event-id is dropped at step 2 next time.

**Dedup is dual-layer per the Step 1 schema notes:**

- Per-`event_id` consumer-group claim catches Kafka redelivery of the same event row.
- Per-(owner, source_ref_id) Redis SET NX catches "different event_id but same logical action" — e.g. a teacher PATCHing `isPublished=true` on an already-published assignment re-emits with a new `event_id`, but the source_ref_id matches the existing task. The Redis claim returns false; INSERT is skipped.

The schema-level partial INDEX on `(owner_id, source, source_ref_id) WHERE source != 'MANUAL'` is non-unique (partitioned tables can't constrain across partitions without including the partition key) — it's investigation support, not a dedup gate.

**Live verification on `tenant_demo` (Step 4 smoke, 2026-05-03):**

1. **Pre-create the 8 trigger topics** with `kafka-topics.sh --create --if-not-exists` for each `dev.<event_type>` (one-time dev workaround — the same race is documented for Cycle 3's audience-fan-out worker on a fresh broker; auto.create.topics.enable handles publish-side but subscribe-before-publish is racy).
2. Boot the API. Worker logs `TaskWorker subscribed to 8 topic(s):` cleanly.
3. Teacher (Rivera) logs in, POST `/classes/{Algebra}/assignments` with `{title:"Step 4 Live Smoke — Photosynthesis Lab", maxPoints:50, isPublished:true}`.
4. AssignmentService emits `cls.assignment.posted` with `isPublished:true` + classId + assignment_title + class_name + due_date placeholders.
5. Within ~3 seconds, the worker creates 1 row in `tsk_tasks` for Maya:
   - `title = "Complete: Step 4 Live Smoke — Photosynthesis Lab"` (rendered from `title_template = "Complete: {assignment_title}"`)
   - `owner_id = student@demo.campusos.dev` (the only ACTIVE enrollee in the class — Maya)
   - `source = 'AUTO'`, `source_ref_id = <assignment id>`, `priority = 'NORMAL'`, `task_category = 'ACADEMIC'`, `status = 'TODO'`
6. **Redis dedup verified** — PATCH the same assignment with `isPublished:true` again. Worker logs `[task-worker] dedup hit on tsk:auto:demo:<owner>:<source_ref_id> — skipping task creation`. Task count for the assignment stays at 1.
7. Cleanup — DELETE the smoke task + smoke assignment + matching Redis key so the next CAT run starts clean.

**Out of scope this step (deferred):**

- The remaining 7 auto-task rules wired in Step 3 are scaffolded but not exercised end-to-end yet (the keystone path verifies the engine works; the smaller paths follow the same code path and reuse the same resolveOwners / template-render / dedup machinery).
- The `cls.grade.returned` topic has no producer yet — the rule is in place for when the grade-return flow ships.
- Runtime rule-add (without worker restart) — the seed-only convention covers this for now; a notify-on-rule-change channel would be a Phase 2 hardening.
- The dev-cluster topic-creation race documented in Cycles 3+5 strikes again. A startup pre-create-topics step or a "warmup emit" sweep would harden first-boot. Documented as known issue.

---

## Step 5 — Task NestJS Module — CRUD + Acknowledgements

**Status:** DONE. The request-path API on top of the Step 1 schema. TasksModule grows two services + two controllers; TaskWorker stays the sole writer to AUTO/SYSTEM rows but TaskService now owns MANUAL creation, status transitions, and the row-scope read paths.

**Files:**

- `apps/api/src/tasks/dto/task.dto.ts` — DTOs and the four enum constants (TASK_PRIORITIES, TASK_STATUSES, TASK_CATEGORIES, TASK_SOURCES; ACK_STATUSES, ACK_SOURCE_TYPES). All enum values are `IsIn`-validated against the same arrays the schema CHECK constraints use, so a future enum addition lands in one place.
- `apps/api/src/tasks/task.service.ts` — TaskService.
- `apps/api/src/tasks/acknowledgement.service.ts` — AcknowledgementService.
- `apps/api/src/tasks/task.controller.ts` + `apps/api/src/tasks/acknowledgement.controller.ts` — 9 endpoints total.
- `apps/api/src/tasks/tasks.module.ts` — adds TaskService + AcknowledgementService to providers, both controllers to the controllers list, and exports the services for consumers in later cycles.

**9 new endpoints (5 tasks + 4 acks):**

| Verb | Path | Permission | Notes |
| ---- | ---- | ---------- | ----- |
| GET    | `/tasks` | `ops-001:read` | Default scope: `owner_id = actor` OR `created_for_id = actor` (admin sees all). Filters: `status`, `taskCategory`, `priority`, `dueAfter`, `dueBefore`, `includeCompleted` (default false — TODO/IN_PROGRESS only). Sorted by due date NULLS LAST, then priority urgency. Default limit 100 / max 200. |
| GET    | `/tasks/assigned` | `ops-001:read` | "Tasks delegated to me by another user" — `created_for_id = actor` AND `owner_id != actor`. The inbox of work others have asked me to do. |
| GET    | `/tasks/:id` | `ops-001:read` | Row-scope: caller must be owner OR creator OR admin; otherwise 404 (no leak). |
| POST   | `/tasks` | `ops-001:write` | Creates a MANUAL task. `assigneeAccountId` (optional) lands the task on someone else's list with `created_for_id = caller` — admin-only this cycle (non-admin delegation rejected with 403). ACKNOWLEDGEMENT-category tasks rejected for non-admins (those flow through the worker). Emits `task.created`. |
| PATCH  | `/tasks/:id` | `ops-001:write` | Status transitions + retitle + reschedule. Service handles the multi-column `completed_chk` lockstep — TODO/IN_PROGRESS clear `completed_at`, DONE/CANCELLED set it via `COALESCE(completed_at, now())` so a re-DONE doesn't bump the timestamp. Emits `task.completed` only on the first DONE transition. |
| GET    | `/acknowledgements` | `ops-001:read` | Default: own pending (`subject_id = actor.personId AND status = 'PENDING'`). Admins can pass `?all=true` for the tenant-wide history. |
| GET    | `/acknowledgements/:id` | `ops-001:read` | Row-scope: caller's `personId` must equal `subject_id`, or admin. 404 on mismatch. |
| POST   | `/acknowledgements/:id/acknowledge` | `ops-001:write` | Flips PENDING → ACKNOWLEDGED, sets `acknowledged_at = now()`, **DONE-cascades every linked `tsk_tasks` row in the same transaction**. Emits `student.acknowledgement.completed`. |
| POST   | `/acknowledgements/:id/dispute` | `ops-001:write` | Same as acknowledge but flips to ACKNOWLEDGED_WITH_DISPUTE with a required `reason` (1–2000 chars; class-validator rejects empty). Linked tasks still flip to DONE. |

**Row-scope contract:**

- **Tasks:** caller can see/edit a task when `owner_id = actor.accountId` OR `created_for_id = actor.accountId`. Admins (`actor.isSchoolAdmin`) bypass. Non-matching rows return 404 (not 403) so an attacker can't probe ids.
- **Acknowledgements:** caller can see/act on an ack when `subject_id = actor.personId`. Admins bypass. Non-matching rows return 404.

**Convention adopted (clarifying the schema):**

- `owner_id` — the person whose to-do list the task lands on (the assignee in everyday terms).
- `created_for_id` — set when one user creates a task on behalf of another. The task lives on `owner_id`'s list; `created_for_id` carries the original creator. The `/tasks/assigned` endpoint queries `WHERE created_for_id = me AND owner_id != me` — the "I delegated this and it lives on someone else's list" view.
- AUTO tasks (worker writes): `owner_id = the assignee`, `created_for_id = NULL`. The Step 4 worker already follows this convention.
- MANUAL self-task: `owner_id = me, created_for_id = NULL`.
- MANUAL delegation: `owner_id = assignee, created_for_id = me` (admin-only this cycle).

The plan's row-auth note "Teachers can see tasks they created for students (created_for_id set, owner_id = teacher's accountId)" reads as if the task lives on the teacher's list; the schema and the to-do list mental model are clearer with the convention above. Documented here so a reviewer can see the deliberate divergence.

**Status-transition multi-column CHECK handling:**

The schema's `tsk_tasks_completed_chk` requires:
- TODO / IN_PROGRESS ⇒ `completed_at IS NULL`
- DONE / CANCELLED ⇒ `completed_at IS NOT NULL`

The service handles the lockstep so callers don't have to: when the PATCH lands `status=DONE` or `CANCELLED`, the same UPDATE sets `completed_at = COALESCE(completed_at, now())` (so re-DONE doesn't bump the timestamp); when status flips back to TODO/IN_PROGRESS, `completed_at = NULL` clears in the same UPDATE. Re-opening a DONE task is allowed — the schema doesn't prohibit it and users sometimes mark something done then realise they're not actually done.

**Acknowledge / dispute tx model:**

Both flows use `executeInTenantTransaction` and lock the ack row with `SELECT … FOR UPDATE` so two parallel acknowledgements serialise. Inside the same tx:

1. Validate caller is the subject (`actor.personId = subject_id`) or admin.
2. Validate status is currently PENDING; reject 400 otherwise.
3. UPDATE `tsk_acknowledgements` — flip status, set `acknowledged_at = now()`, set `dispute_reason` (null on acknowledge, non-null on dispute).
4. UPDATE `tsk_tasks` — flip every linked row (`acknowledgement_id = $1`) that is not already DONE or CANCELLED to status='DONE' + `completed_at = now()`. Multi-column `completed_chk` is satisfied by the same UPDATE setting both columns.

The Kafka emit happens **outside** the tx — the row is committed before the network call so a transient broker hiccup doesn't roll back the user's action.

**Live verification on `tenant_demo` (Step 5 smoke, 23 scenarios all pass):**

Tasks (S1–S14):

1. Maya `GET /tasks` returns her 4 open tasks (3 ACADEMIC + 1 PERSONAL — DONE/CANCELLED filtered by default).
2. Maya `GET /tasks?status=DONE` returns 0.
3. David `GET /tasks` returns his 1 ADMINISTRATIVE row.
4. Maya `POST /tasks` creates a manual PERSONAL task — emits `task.created`.
5. PATCH TODO → IN_PROGRESS leaves `completed_at` NULL.
6. PATCH IN_PROGRESS → DONE auto-sets `completed_at` and emits `task.completed`.
7. PATCH DONE → TODO clears `completed_at` to NULL (re-open path).
8. Sarah (admin) `GET /tasks` returns all 6 tenant-wide rows.
9. David `GET /tasks/{Maya's id}` returns 404 (row scope, no leak).
10. Maya delegates with `assigneeAccountId` → 403 (`Only admins can create tasks on behalf of another user this cycle`).
11. Sarah delegates a task to David — succeeds.
12. David's list now includes the delegation with `createdForName='Sarah Mitchell'`.
13. Sarah's `/tasks/assigned` shows the delegation with `ownerName='David Chen'`.
14. No-auth `GET /tasks` returns 401.

Acknowledgements (A1–A9):

15. Maya `GET /acknowledgements` returns her 2 pending acks (seeded directly via SQL since no producer exists yet for `msg.announcement.requires_acknowledgement` / `sis.consent.requested`).
16. Maya `POST /acknowledgements/:id/acknowledge` flips status ACKNOWLEDGED + sets `acknowledged_at`.
17. Linked task confirmed DONE with `completed_at` set (cascade verified).
18. Re-acknowledge correctly 400's with "Only PENDING acknowledgements can be acknowledged".
19. Maya disputes the second ack with a reason — flips to ACKNOWLEDGED_WITH_DISPUTE + records `dispute_reason`.
20. Empty-reason dispute → 400 from class-validator (1–2000 char range enforced).
21. David's `GET /acknowledgements` returns 0 (different subject).
22. David's GET on Maya's ack id returns 404 (row scope).
23. Sarah (`?all=true`) sees both tenant-wide acks with their final statuses.

**Wire envelopes captured live (ADR-057 shape):**

- `dev.task.completed` — `{event_id, event_type, source_module:'tasks', tenant_id, correlation_id, payload:{taskId, ownerId, title, taskCategory, source:'MANUAL', sourceRefId:null, completedAt}}`.
- `dev.student.acknowledgement.completed` — `{... source_module:'tasks' ..., payload:{acknowledgementId, subjectId, status:'ACKNOWLEDGED_WITH_DISPUTE', sourceType:'DISCIPLINE_RECORD', sourceRefId, disputeReason}}`.

Smoke residue cleaned (3 manual tasks + 4 ack-tasks + 2 acks deleted) — tenant returns to the post-Step-3 seed state (5 sample tasks, 0 acks).

**Bug caught and fixed during the smoke:**

The first ack-smoke run keyed `subject_id` to the principal's `iam_person.id` instead of Maya's (the SQL JOIN reused the same `pu` row for both `subject_id` and `created_by`). Maya's GET returned 0 acks even though the rows existed. Re-seeded the test acks with the correct `subject_id` lookup keyed via Maya's `platform_users.email` and the smoke ran clean. The service's row-scope check correctly returned 0 / 404 — the bug was test-data only, not a service-layer issue.

**Out of scope this step (deferred):**

- Teachers delegating tasks to students they teach (this cycle restricts delegation to admins; future iteration can open it up using the `sis_class_teachers` row-scope pattern from Cycle 2).
- Bulk task admin operations (`ops-001:admin` tier).
- Task tags (`tsk_task_tags` was deferred at the schema level per the plan; the API would land alongside).
- Receipt of `task.completed` events anywhere — the emit lands but no consumer wires it through to a notification yet (similar pattern to Cycle 5's `sch.coverage.assigned` documented carry-over).

---

## Step 6 — Workflow Engine — Multi-Step Approval

**Status:** DONE. The keystone of M2 Approval Workflows ships. WorkflowEngineService is the **sole writer to `wsk_approval_requests` and `wsk_approval_steps` per ADR-012** — source modules submit via the REST endpoint (or call `submit()` programmatically in Step 7's `LeaveService` migration) and listen on `approval.request.resolved` to apply the approved action.

**Files:**

- `apps/api/src/workflows/dto/workflow.dto.ts` — DTOs + the 3 enum constants (REQUEST_STATUSES, STEP_STATUSES, APPROVER_TYPES). Validation on `requestType` (1–64 chars), `referenceId`/`referenceTable` paired-or-null, comments (max 2000 chars), `body` (1–2000 chars on comments).
- `apps/api/src/workflows/workflow-engine.service.ts` — the engine. `submit()`, `advanceStep()`, `withdraw()`, `addComment()`, `list()`, `getById()`, plus the private `resolveApprover()` and the exported `roleTokenToName()` helper.
- `apps/api/src/workflows/workflow.controller.ts` — 7 endpoints under `/approvals`.
- `apps/api/src/workflows/workflows.module.ts` — wires the service + controller; imports TenantModule + IamModule + KafkaModule; exports the service so Step 7's `LeaveService` can inject it.
- `apps/api/src/app.module.ts` — adds WorkflowsModule between TasksModule and the global guards.

**7 endpoints:**

| Verb | Path | Permission | Notes |
| ---- | ---- | ---------- | ----- |
| POST | `/approvals` | `ops-001:write` | Submit a new approval request. Engine selects the active workflow template by `request_type`, creates the request row + Step 1 with a resolved approver, all in one tx. Emits `approval.step.awaiting` (a future notification consumer or task-rule will turn this into a task on the approver's list). |
| GET  | `/approvals` | `ops-001:read` | List with row scope: admin sees all (or `?mine=true` for own as requester); non-admin sees `requester_id = me OR EXISTS approver_id = me on any step`. Filters: `status`, `requestType`. |
| GET  | `/approvals/:id` | `ops-001:read` | Full detail: request + step history + comments. Non-admin row scope: requester or any current/past approver. 404 on no access. |
| POST | `/approvals/:id/steps/:stepId/approve` | `ops-001:write` | Step approval. Locks step + request rows FOR UPDATE inside the tx. Validates step status is AWAITING. Activates the next step or resolves the request as APPROVED. Emits `approval.step.awaiting` for the next step or `approval.request.resolved` on terminal. |
| POST | `/approvals/:id/steps/:stepId/reject` | `ops-001:write` | Same lock pattern. Marks the step REJECTED, marks every still-AWAITING step SKIPPED, resolves the request as REJECTED, emits `approval.request.resolved` with `status='REJECTED'`. |
| POST | `/approvals/:id/comments` | `ops-001:write` | Append a comment. `isRequesterVisible` defaults true; false marks it approver-internal-only. |
| POST | `/approvals/:id/withdraw` | `ops-001:write` | Requester pulls back a still-PENDING request. Marks every AWAITING step SKIPPED + status=WITHDRAWN. **Does NOT emit `approval.request.resolved`** — the requester pulled back, source modules shouldn't act on it. |

**Approver resolution (`resolveApprover`):**

The engine picks **one** account_id per step (sequential mode this cycle):

- **SPECIFIC_USER** — `approver_ref` is a `platform_users.id` UUID. Returns it directly after a `LIMIT 1` existence check.
- **ROLE** — `approver_ref` is a role token like `'SCHOOL_ADMIN'`. The engine maps token → IAM role name via the new exported `roleTokenToName()` helper (matches Cycle 3's `roleNameToToken` convention but inverted) and queries `platform.iam_role_assignment + roles + iam_scope + iam_scope_type` for the first ACTIVE assignment with `r.name = $token` AND `(SCHOOL scope on this school OR PLATFORM scope)`. Excludes the requester so a self-approving template doesn't self-resolve.
- **MANAGER** and **DEPARTMENT_HEAD** — both fall back to the first school admin (`'sch-001:admin' = ANY(eac.permission_codes)` on the school + platform scope chain) since the proper hr_employees / sis_departments traversal is **deferred per the plan**. The fallback is logged at `LOG` level so a reviewer reading boot logs can see the deferral firing. The `ORDER BY 1 LIMIT 1` clause is deterministic — the smallest UUID wins.

**Submit flow (`submit()`):**

Inside `executeInTenantTransaction`:

1. Look up the active workflow template by `(school_id, request_type)`. Reject 400 if none configured.
2. Load all template steps ordered by `step_order ASC`. Reject 400 if zero steps.
3. Resolve the Step 1 approver via `resolveApprover()`. Reject 400 if no resolution.
4. INSERT `wsk_approval_requests` with `status='PENDING'`, `submitted_at=now()`. Schema's `resolved_chk` allows null `resolved_at` for PENDING.
5. INSERT `wsk_approval_steps` for Step 1 with `status='AWAITING'`, no `actioned_at` (allowed by `actioned_chk`).

Outside the tx: emit `approval.step.awaiting` so future consumers can react. Returns the full DTO.

**Advance flow (`advanceStep()`):**

Inside `executeInTenantTransaction`:

1. `SELECT … FOR UPDATE` on `wsk_approval_steps WHERE id=$1 AND request_id=$2` — locks the step row so two parallel approvers serialise.
2. `SELECT … FOR UPDATE` on `wsk_approval_requests` — locks the parent.
3. Validate step is AWAITING + caller is approver (or admin).
4. UPDATE the step with `status=$decision`, `actioned_at=now()`, `comments=$comment`.
5. On REJECTED: SKIP every remaining AWAITING step, UPDATE request to `status='REJECTED'`, `resolved_at=now()`. Emit `approval.request.resolved` with `status='REJECTED'`.
6. On APPROVED: query for the next template step. If none → resolve as APPROVED + emit. If one exists → resolve its approver + INSERT the new AWAITING step row + emit `approval.step.awaiting`.

The Kafka emit happens **outside the tx** (committed first) so a broker hiccup doesn't roll back the user's action.

**Comment visibility model:**

- Admins see every comment.
- Approvers (current or past on any step) see every comment — they need internal context to collaborate.
- The requester sees only `is_requester_visible = true` rows.

The query uses an EXISTS clause keyed on `wsk_approval_steps.approver_id = $actor.accountId` so an internal-only comment is filtered for the requester but visible to fellow approvers.

**Live verification on `tenant_demo` (Step 6 smoke, 12 scenarios all pass):**

1. Rivera POSTs `/approvals` with `requestType='LEAVE_REQUEST'` and a leave id from the Cycle 4 seed → engine creates request + Step 1 with approver=admin@ (the first school admin alphabetically since DEPARTMENT_HEAD falls back to school admin).
2. Rivera GET own → visible (requester scope).
3. David GET → 404 (not requester, not approver, not admin).
4. SQL inspection confirms Step 1 approver = `admin@demo.campusos.dev` (Platform Admin holds sch-001:admin via `everyFunction`).
5. David POST `.../approve` → 403 "You are not the assigned approver for this step".
6. Sarah (admin) POST `.../approve` Step 1 → succeeds via admin override; Step 2 activates with approver=Sarah Mitchell (ROLE='SCHOOL_ADMIN' resolves Sarah). Request status remains PENDING.
7. Re-approve Step 1 → 400 "Only AWAITING steps can be approved; this one is APPROVED".
8. Sarah adds an admin-internal comment (`isRequesterVisible:false`).
9. Rivera GET → sees 0 comments (filtered out by visibility model).
10. Sarah GET → sees 1 comment (admin override).
11. Sarah POST `.../approve` Step 2 → request resolves to APPROVED, both steps APPROVED, `resolved_at` populated.
12. `dev.approval.request.resolved` envelope captured on the wire with full ADR-057 shape — `event_type='approval.request.resolved'`, `source_module='workflows'`, payload `{requestId, requestType:'LEAVE_REQUEST', referenceId, referenceTable:'hr_leave_requests', requesterId, status:'APPROVED'}`.

**Smoke residue cleaned.** The smoke approval request was deleted (CASCADE drops its steps + comments). Tenant returns to the post-Step-3 seed state — 1 historical approval request (Cycle 4 audit) + 2 historical steps.

**Two issues caught and fixed during the smoke:**

1. **Stale node process holding port 4000.** A leftover process from the Step 5 smoke owned :4000 even though I'd `kill`'d its parent shell. New `node main.js` spawns failed with `EADDRINUSE` and the curl was hitting the old binary that didn't have the new routes. Resolved by `kill -9 $(lsof -ti :4000)` then restart.
2. **`SELECT DISTINCT … ORDER BY` SQL bug** in the school-admin fallback path. PostgreSQL requires ORDER BY columns to appear in the SELECT list when using DISTINCT. Switched the ORDER BY to positional `ORDER BY 1` (referencing the single SELECT column). Migration not needed — pure service code fix.

**Out of scope this step (deferred per the plan):**

- Parallel approval steps (`is_parallel=true`) — the column ships forward-compatible from Step 2 but the engine is sequential-only. Adding parallel mode requires reworking `advanceStep` to keep multiple AWAITING steps active simultaneously and resolve once any of them rejects (or all approve).
- Proper `MANAGER` / `DEPARTMENT_HEAD` resolution — currently both fall back to the first school admin. The proper traversal needs `hr_employees.supervisor_id` and `sis_departments.head_id` columns that aren't populated in the demo seed. Documented in `resolveApprover` JSDoc + a runtime LOG line so the deferral is visible.
- Escalation timeout worker — the schema (Step 2) has `wsk_workflow_escalations` ready and the step's `timeout_hours` carries the deadline, but no cron sweeps + escalates yet. Phase 2 hardening.

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
