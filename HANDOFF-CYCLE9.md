# Cycle 9 Handoff — Behaviour & Discipline

**Status:** Cycle 9 **COMPLETE + APPROVED at the REVIEW-CYCLE9 fix commit** (Round 2 reviewer confirmation pending). All 10 steps shipped + the post-cycle review fix commit landed. Round 1 of REVIEW-CYCLE9-CHATGPT against `cycle9-complete` returned REJECT pending 1 BLOCKING privacy leak (parent-accessible `GET /behavior-plans/:id/feedback` returned `svc_bip_teacher_feedback` rows the main plan service intentionally strips for guardians via `canSeeFeedback()`) + 4 MAJOR follow-ups (concurrency races on `activate()` + `requestFeedback()` partial UNIQUE keystones surfacing raw SQLSTATE 23505; broad `BEH-002:read+write` grant on the generic Staff role; Swagger doc clarity on the feedback endpoint). Closeout fix commit lands the BLOCKING fix + MAJOR 2 + MAJOR 3 + MAJOR 5; MAJOR 4 (Counsellor role split) appropriately moves to the Wave 2 Phase 2 punch list per the reviewer's gate decision. All three code-level MAJORs verified live on `tenant_demo` 2026-05-04: parent feedback endpoint returns `count=0` for David Chen against Maya's BIP while counsellor / admin / teacher (own-class scope) get `count=1`; both partial-UNIQUE pre-flight branches surface the friendly 400 carrying the conflicting plan id / pending feedback id. Vertical-slice CAT at `docs/cycle9-cat-script.md` verified live against the `cycle9-complete` build. Cycle 9 ships clean to Round 2. Cycle 9 is the **first cycle of Wave 2 (Student Services)** and ships the M20 SIS Discipline tables (4 — deferred from Cycle 1 since they were not needed for the attendance vertical slice) plus the M27 Behaviour Plans tables (3 — first Student Services tables in the system, `svc_` prefix). Together they deliver the complete behaviour management lifecycle: a teacher logs an incident → admin reviews and assigns consequences → parents are notified when required → repeated incidents trigger a formal Behaviour Intervention Plan → the BIP tracks goals and collects teacher feedback on strategy effectiveness. Wave 1 (Cycles 0–8) closed at `cycle8-approved` (`c424288`). Cycle 9 is purely additive on the request path: every existing module continues to function unchanged. Cycle 9 is the first module to involve **sensitive student conduct data** — row-level visibility is strict (teachers see incidents they reported or that involve students in their classes; parents see their own children's incidents excluding `admin_notes`; students never see discipline records directly; admins and counsellors see all).

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle9-implementation-plan.html`
**Vertical-slice deliverable:** Teacher reports an incident: "Maya was involved in a verbal altercation in the hallway" under category "Disrespect" (MEDIUM severity) → admin reviews the incident, transitions to UNDER_REVIEW, assigns a consequence (Detention, 1 day) with `requires_parent_notification=true` → parent (David Chen) receives an IN_APP notification → admin resolves the incident → because Maya now has 2+ incidents this semester, the counsellor creates a BIP with target behaviours, replacement strategies, and 3 measurable goals → teacher receives a feedback request on BIP strategy effectiveness → teacher submits feedback → counsellor reviews and updates goal progress.

This document tracks the Cycle 9 build at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE8.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                        | Status   |
| ---- | ------------------------------------------------------------ | -------- |
| 1    | Discipline Schema — Categories, Incidents, Actions           | **DONE** |
| 2    | Behaviour Plan Schema — BIPs, Goals, Feedback                | **DONE** |
| 3    | Seed Data — Categories, Action Types, Sample Incidents + BIP | **DONE** |
| 4    | Discipline NestJS Module — Incidents + Actions               | **DONE** |
| 5    | Behaviour Plan NestJS Module — BIPs + Goals + Feedback       | **DONE** |
| 6    | Behaviour Notification Consumer                              | **DONE** |
| 7    | Discipline UI — Report Incident + Admin Queue                | **DONE** |
| 8    | Behaviour Plan UI — BIP Editor + Goals + Feedback            | **DONE** |
| 9    | Parent + Student Behaviour Views                             | **DONE** |
| 10   | Vertical Slice Integration Test                              | **DONE** |

---

## What this cycle adds on top of Cycles 0–8

Cycle 9 is the first cross-cutting cycle of Phase 3 Wave 2. It bridges the existing informal `sis_student_notes` (Cycle 1) to formal discipline records and structured Behaviour Intervention Plans.

- **Discipline (M20).** 4 `sis_*` discipline tables that were deferred from Cycle 1 (the attendance vertical slice did not need them). `sis_discipline_categories` is the per-school catalogue with a 4-value severity (LOW / MEDIUM / HIGH / CRITICAL). `sis_discipline_action_types` carries the parent-notification flag. `sis_discipline_incidents` is the lifecycle-bearing table (OPEN → UNDER_REVIEW → RESOLVED with multi-column `resolved_chk`). `sis_discipline_actions` is a per-incident consequence row (CASCADE on the incident, UNIQUE(incident_id, action_type_id)). All four sit under permission code **BEH-001** ("Behaviour & Discipline") which has been in `permissions.json` waiting for this cycle.
- **Behaviour Plans (M27).** 3 `svc_*` tables — the first Student Services tables in the system. `svc_behavior_plans` carries the BIP/BSP/SAFETY_PLAN type with a 4-state status (DRAFT / ACTIVE / REVIEW / EXPIRED), partial UNIQUE on `(student_id, plan_type) WHERE status = 'ACTIVE'` so each student has at most one active plan per type. `svc_behavior_plan_goals` is the measurable-goals child with a 4-state progress enum. `svc_bip_teacher_feedback` is the structured teacher-input row with effectiveness rating + observations. All three sit under permission code **BEH-002** ("Behaviour Intervention Plans"). The `caseload_id` FK is forward-compatible to the future Cycle 11 `svc_caseloads` table; the column is nullable + soft so Cycle 9 ships without it being populated.
- **Wave 1 integrations.** Cycle 7 Task Worker gets two new auto-task rules (`beh.incident.reported` → admin review, `beh.bip.feedback_requested` → teacher feedback). Cycle 3 Notifications gets a new `BehaviourNotificationConsumer` for incident lifecycle events + parent notification on actions with `requires_parent_notification=true`. Cycle 4 HR provides the `hr_employees(id)` FK target for `reported_by` and BIP `created_by` and the feedback teacher/counsellor refs. Cycle 1 SIS provides the `sis_students(id)` FK target for incident.student_id and BIP.student_id.

What does not change: every existing module continues to function. Cycle 9 is purely additive on the request path.

---

## Step 1 — Discipline Schema — Categories, Incidents, Actions

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-03. Idempotent re-provision verified (zero new applies on the second run; the IF NOT EXISTS guards on every CREATE TABLE / CREATE INDEX work as designed). Splitter-clean — Python audit script (block-comment + line-comment + single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators on the first attempt. Fifth migration in a row to clear the splitter trap on first try.

**Migration:** `packages/database/prisma/tenant/migrations/030_sis_discipline.sql`.

**Tables (4):**

1. **`sis_discipline_categories`** — Per-school discipline category catalogue. `school_id`, `name TEXT NOT NULL`, `severity TEXT NOT NULL` 4-value CHECK `LOW / MEDIUM / HIGH / CRITICAL`, `description TEXT` nullable, `is_active BOOLEAN DEFAULT true`. UNIQUE INDEX on `(school_id, name)`. INDEX on `(school_id, is_active)` for the active-list hot path. Examples once seeded in Step 3: Tardiness (LOW), Dress Code Violation (LOW), Disrespect (MEDIUM), Disruptive Behaviour (MEDIUM), Fighting (HIGH), Weapons/Dangerous Items (CRITICAL).

2. **`sis_discipline_action_types`** — Per-school disciplinary action catalogue. `school_id`, `name TEXT NOT NULL`, `requires_parent_notification BOOLEAN DEFAULT false` flags actions that fire the parent-notification path in the Step 4 ActionService, `is_active BOOLEAN DEFAULT true`, `description TEXT` nullable. UNIQUE INDEX on `(school_id, name)`. INDEX on `(school_id, is_active)`. Examples once seeded in Step 3: Verbal Warning (no notification), Written Warning (no notification), Detention (notify), In-School Suspension (notify), Out-of-School Suspension (notify).

3. **`sis_discipline_incidents`** — One row per reported incident. `school_id`, `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE (when a student is removed from the system the conduct history goes with them — this is the conservative privacy choice), `reported_by` NOT NULL FK to `hr_employees(id)` ON DELETE SET NULL (the audit trail survives a teacher leaving the school; the row remains for admin review), `category_id` NOT NULL FK to `sis_discipline_categories(id)` NO ACTION (refuses delete of a category with historical incidents — admin must deactivate via `is_active=false` instead), `description TEXT NOT NULL`, `incident_date DATE NOT NULL`, `incident_time TIME` nullable, `location TEXT` nullable (free-form for hallway / classroom / cafeteria; Cycle 5 `sch_rooms` is not used here because the convention is to capture what the reporter wrote, not normalise it), `witnesses TEXT` nullable, `status TEXT NOT NULL DEFAULT 'OPEN'` 3-value CHECK `OPEN / UNDER_REVIEW / RESOLVED`, `resolved_by UUID` nullable (soft ref to `hr_employees`), `resolved_at TIMESTAMPTZ` nullable, `admin_notes TEXT` nullable (internal — never visible to parents per the Step 4 row-scope filter). **Multi-column `sis_discipline_incidents_resolved_chk`** keeps `resolved_by` and `resolved_at` in lockstep with status: working states (OPEN / UNDER_REVIEW) ⇒ both NULL; RESOLVED ⇒ both NOT NULL. INDEX on `(student_id, incident_date DESC)` for the student-history hot path. Partial INDEX on `(school_id, status) WHERE status != 'RESOLVED'` for the admin queue.

4. **`sis_discipline_actions`** — Per-incident consequence row. `incident_id` NOT NULL FK to `sis_discipline_incidents(id)` ON DELETE CASCADE (a consequence has no meaning without its incident), `action_type_id` NOT NULL FK to `sis_discipline_action_types(id)` NO ACTION (prevents an admin from accidentally deleting an action type that has historical actions referencing it — admin deactivates via `is_active=false`), `assigned_by UUID` nullable (soft ref to `hr_employees`), `start_date DATE` nullable, `end_date DATE` nullable (suspensions are multi-day; a verbal warning has neither set), `notes TEXT` nullable, `parent_notified BOOLEAN DEFAULT false`, `parent_notified_at TIMESTAMPTZ` nullable. UNIQUE INDEX on `(incident_id, action_type_id)` — one action per type per incident, so admins layer different consequence types rather than stacking duplicates of the same one. **Multi-column `sis_discipline_actions_dates_chk`** enforces `end_date >= start_date` only when both are set; either side null is accepted (the consequence may not have a fixed window).

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `sis_discipline_categories.school_id → platform.schools(id)`
- `sis_discipline_action_types.school_id → platform.schools(id)`
- `sis_discipline_incidents.school_id → platform.schools(id)`
- `sis_discipline_incidents.resolved_by → hr_employees(id)` (soft, intra-tenant — kept soft so a future admin-deletion path doesn't have to cascade through the resolved-by chain; the `reported_by` column uses a DB-enforced FK with SET NULL for the same reason but in the opposite direction)
- `sis_discipline_actions.assigned_by → hr_employees(id)` (soft, intra-tenant)

**FK summary — 5 new intra-tenant DB-enforced FKs:**

| FK                                                                        | Action    |
| ------------------------------------------------------------------------- | --------- |
| `sis_discipline_incidents.student_id → sis_students(id)`                  | CASCADE   |
| `sis_discipline_incidents.reported_by → hr_employees(id)`                 | SET NULL  |
| `sis_discipline_incidents.category_id → sis_discipline_categories(id)`    | NO ACTION |
| `sis_discipline_actions.incident_id → sis_discipline_incidents(id)`       | CASCADE   |
| `sis_discipline_actions.action_type_id → sis_discipline_action_types(id)` | NO ACTION |

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 132 → **136**.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 17 assertions, all green):**

1. **T1 happy path** — 4 inserts across all 4 tables succeed (1 category MEDIUM + 1 action_type with `requires_parent_notification=true` + 1 incident OPEN linked to a real `sis_students.id` + a real `hr_employees.id` for `reported_by` + 1 action with start_date / end_date / parent_notified flags populated).
2. **T2 severity CHECK** — `sis_discipline_categories_severity_chk` rejects `severity='BOGUS'`.
3. **T3 status CHECK** — `sis_discipline_incidents_resolved_chk` rejects `status='BOGUS'` (the resolved_chk OR-clause's status-list filter rejects BOGUS before the standalone `status_chk` gets a chance — same row-rejection outcome, just a different constraint name in the error message; Cycles 5/8 documented this same observation).
4. **T4 resolved_chk** — rejects `status='OPEN'` with `resolved_at` set.
5. **T5 resolved_chk** — rejects `status='RESOLVED'` without `resolved_at`.
6. **T6 resolved_chk** — rejects `status='RESOLVED'` without `resolved_by`.
7. **T7 lifecycle UPDATE** — OPEN → RESOLVED with `resolved_by` + `resolved_at` populated in the same UPDATE accepted; final state `(status=RESOLVED, has_rb=t, has_ra=t)`.
8. **T8 dates_chk** — rejects `start_date='2026-05-10'`, `end_date='2026-05-09'`.
9. **T9 dates_chk** — accepts `start_date` only with `end_date` NULL (open-ended consequence — verbal warnings have neither set, suspensions have both set; the schema allows either side null).
10. **T10 categories UNIQUE** — `sis_discipline_categories_school_name_uq` rejects a second row with the same `(school_id, name)`.
11. **T11 action_types UNIQUE** — `sis_discipline_action_types_school_name_uq` rejects a second row with the same `(school_id, name)`.
12. **T12 actions UNIQUE** — `sis_discipline_actions_incident_type_uq` rejects a second action of the same `action_type_id` on the same incident.
13. **T13 FK reject — bogus student_id** — `sis_discipline_incidents_student_id_fkey` rejects `student_id='00000000-…-0099'`.
14. **T14 FK reject — bogus category_id** — `sis_discipline_incidents_category_id_fkey` rejects `category_id='00000000-…-0099'`.
15. **T15 NO ACTION** — DELETE on a `sis_discipline_categories` row with a referencing incident rejected by `sis_discipline_incidents_category_id_fkey` (admin must deactivate via `is_active=false` instead).
16. **T16 CASCADE** — DELETE on a `sis_discipline_incidents` row drops the linked `sis_discipline_actions` row in one statement; `count(*)` after delete is 0 (was 1).
17. **T17 NO ACTION** — DELETE on a `sis_discipline_action_types` row with a referencing action rejected by `sis_discipline_actions_action_type_id_fkey`.

Outer ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state — final SELECTs confirm `(cats=0, atypes=0, incs=0, acts=0)` for the smoke names.

**FK action verification via `pg_constraint.confdeltype`:**

```
sis_discipline_actions_action_type_id_fkey   NO ACTION
sis_discipline_actions_incident_id_fkey      CASCADE
sis_discipline_incidents_category_id_fkey    NO ACTION
sis_discipline_incidents_reported_by_fkey    SET NULL
sis_discipline_incidents_student_id_fkey     CASCADE
```

All 5 actions match the migration's declared intent.

**Sanity counts on `tenant_demo`:**

- 4 logical `sis_discipline_*` base tables.
- 5 rows in `pg_constraint` for the new FKs (one per logical FK; no partition replication since none of these tables are partitioned).
- 0 cross-schema FKs.
- Idempotent re-provision is a clean no-op on the SQL — both `tenant_demo` and `tenant_test` survived a second `provision` run with no DDL applied.

**Splitter audit:** Python state-machine audit (block-comment / line-comment / single-quoted-string aware) reports zero `;` inside any string literal or comment in the migration. Migration applied first try with no rewrite needed.

**What's deferred to later steps:**

- Step 2 lands `svc_behavior_plans` + `svc_behavior_plan_goals` + `svc_bip_teacher_feedback`. The `svc_behavior_plans.source_incident_id` soft ref to `sis_discipline_incidents(id)` will be added in Step 2 — the column type is set in Step 1 only via the FK target shape.
- Step 3 seeds the catalogue (6 categories + 5 action types), 3 sample incidents (1 RESOLVED + Verbal Warning, 1 UNDER_REVIEW + Detention with parent notified, 1 OPEN no actions), 1 sample BIP for Maya with 3 goals + 1 pending feedback request, 2 auto-task rules (`beh.incident.reported` + `beh.bip.feedback_requested`), and BEH-001 / BEH-002 permission grants.
- Step 4 lands the request-path IncidentService + ActionService + CategoryService with ~14 endpoints. `POST /discipline/incidents` stamps `reported_by` from `actor.employeeId` and emits `beh.incident.reported`. Admin lifecycle transitions use `executeInTenantTransaction` with `SELECT … FOR UPDATE` per the convention.
- Out of scope for the entire cycle (deferred per the plan): PBIS points/rewards system (not in ERD v11 — future enhancement); discipline hearing/appeal workflow (would use Cycle 7 approval engine — Phase 3); automated "repeat offender" BIP trigger (manual counsellor action this cycle); `sis_student_notes` integration (the table exists from Cycle 1 but the cross-module read with `is_shared_with_counselor` lands in Cycle 11); mandatory reporting integration (COU-006 — Cycle 11).

---

## Step 2 — Behaviour Plan Schema — BIPs, Goals, Feedback

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-03. Idempotent re-provision verified (zero new applies on the second run). Splitter-clean — Python state-machine audit confirmed zero `;` outside legitimate statement terminators on the first attempt. Sixth migration in a row to clear the splitter trap on first try.

**Migration:** `packages/database/prisma/tenant/migrations/031_svc_behavior_plans.sql`. **First `svc_*` tables in the system** — the M27 Student Services prefix.

**Tables (3):**

1. **`svc_behavior_plans`** — One row per Behaviour Intervention Plan / Behaviour Support Plan / Safety Plan. `school_id`, `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE (mirrors the Step 1 incident pattern; conduct + plan history go with the student), `caseload_id UUID` nullable (soft ref to the future `svc_caseloads` from Cycle 11 — the column ships unpopulated this cycle), `plan_type TEXT NOT NULL` 3-value CHECK `BIP / BSP / SAFETY_PLAN`, `status TEXT NOT NULL DEFAULT 'DRAFT'` 4-value CHECK `DRAFT / ACTIVE / REVIEW / EXPIRED`, `created_by UUID` nullable FK to `hr_employees(id)` ON DELETE SET NULL (audit survives a counsellor leaving), `review_date DATE NOT NULL`, `review_meeting_id UUID` nullable (soft ref to the future `mtg_meetings` table), `target_behaviors TEXT[] NOT NULL` with multi-column **`svc_behavior_plans_target_behaviors_chk`** enforcing `cardinality(target_behaviors) > 0` (a NOT NULL empty array is silly — same `cardinality()` precedent as Cycle 6 Step 2's `enr_offers.offer_conditions`), `replacement_behaviors TEXT[]` nullable, `reinforcement_strategies TEXT[]` nullable, `plan_document_s3_key TEXT` nullable, `source_incident_id UUID` nullable (soft ref to `sis_discipline_incidents(id)` — kept soft so a future admin-deletion path on incidents does not cascade through to BIPs). **Partial UNIQUE INDEX on `(student_id, plan_type) WHERE status = 'ACTIVE'`** — each student can hold at most one ACTIVE plan per type. Multiple DRAFT / REVIEW / EXPIRED plans per `(student, plan_type)` are accepted (history is preserved). Plus 3 supporting indexes — `(student_id, status)` for the per-student plan list, `(school_id, status)` for the admin queue, partial `(source_incident_id) WHERE source_incident_id IS NOT NULL` for "BIPs triggered by this incident" reverse lookup.

2. **`svc_behavior_plan_goals`** — Measurable goals attached to a plan. `plan_id` NOT NULL FK to `svc_behavior_plans(id)` ON DELETE CASCADE (a goal has no meaning without its plan), `goal_text TEXT NOT NULL`, `baseline_frequency TEXT` nullable, `target_frequency TEXT` nullable, `measurement_method TEXT` nullable, `progress TEXT NOT NULL DEFAULT 'NOT_STARTED'` 4-value CHECK `NOT_STARTED / IN_PROGRESS / MET / NOT_MET`, `last_assessed_at DATE` nullable. INDEX on `(plan_id)` for the per-plan goal list.

3. **`svc_bip_teacher_feedback`** — Structured teacher input on strategy effectiveness. `plan_id` NOT NULL FK to `svc_behavior_plans(id)` ON DELETE CASCADE, `teacher_id UUID` nullable FK to `hr_employees(id)` ON DELETE SET NULL (audit survives the teacher leaving), `requested_by UUID` nullable FK to `hr_employees(id)` ON DELETE SET NULL (audit survives the counsellor leaving), `requested_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `submitted_at TIMESTAMPTZ` nullable (NULL while pending), `strategies_observed TEXT[]` nullable, `overall_effectiveness TEXT` nullable with **`svc_bip_teacher_feedback_effectiveness_chk`** allowing NULL or one of `NOT_EFFECTIVE / SOMEWHAT_EFFECTIVE / EFFECTIVE / VERY_EFFECTIVE`, `classroom_observations TEXT` nullable, `recommended_adjustments TEXT` nullable. **Partial UNIQUE INDEX on `(plan_id, teacher_id) WHERE submitted_at IS NULL`** — caps pending requests at one per `(plan, teacher)` pair so a counsellor cannot accidentally double-request. Once the teacher submits, `submitted_at` is non-null and the partial UNIQUE releases — a fresh request can then be opened on the same `(plan, teacher)` if the counsellor wants another round of observation. Plus 2 supporting indexes — `(plan_id, submitted_at)` for the per-plan feedback list and partial `(teacher_id, submitted_at) WHERE submitted_at IS NULL` for the teacher's pending-feedback queue (this is the read path that backs `GET /bip-feedback/pending` in Step 5).

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `svc_behavior_plans.school_id → platform.schools(id)`
- `svc_behavior_plans.caseload_id → svc_caseloads(id)` (forward-compat, Cycle 11)
- `svc_behavior_plans.review_meeting_id → mtg_meetings(id)` (forward-compat)
- `svc_behavior_plans.source_incident_id → sis_discipline_incidents(id)` (intra-tenant but kept soft for forward-compat with cross-module reads from a future BIP-from-incident wizard)

**FK summary — 6 new intra-tenant DB-enforced FKs:**

| FK                                                          | Action   |
| ----------------------------------------------------------- | -------- |
| `svc_behavior_plans.student_id → sis_students(id)`          | CASCADE  |
| `svc_behavior_plans.created_by → hr_employees(id)`          | SET NULL |
| `svc_behavior_plan_goals.plan_id → svc_behavior_plans(id)`  | CASCADE  |
| `svc_bip_teacher_feedback.plan_id → svc_behavior_plans(id)` | CASCADE  |
| `svc_bip_teacher_feedback.teacher_id → hr_employees(id)`    | SET NULL |
| `svc_bip_teacher_feedback.requested_by → hr_employees(id)`  | SET NULL |

0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 136 → **139**. Cycle 9 running tally: 7 logical base tables (4 from Step 1 + 3 from Step 2). Total Cycle 9 intra-tenant FKs after Step 2: 11 (5 + 6).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 18 assertions, all green):**

1. **T1 happy path** — 4 inserts succeed across all 3 tables (1 DRAFT BIP for the seeded Maya with target_behaviors / replacement_behaviors / reinforcement_strategies populated as 2-element + 2-element + 2-element arrays + 2 goals + 1 pending feedback request); final counts `(plans=1, goals=2, fb=1)`.
2. **T2 plan_type CHECK** — `svc_behavior_plans_type_chk` rejects `plan_type='BOGUS'`.
3. **T3 status CHECK** — `svc_behavior_plans_status_chk` rejects `status='BOGUS'`.
4. **T4 target_behaviors_chk** — rejects `target_behaviors=ARRAY[]::TEXT[]` (empty array). Schema enforces `cardinality > 0`.
5. **T5 NOT NULL** — column-level NOT NULL rejects `target_behaviors=NULL`.
6. **T6 lifecycle UPDATE** — DRAFT → ACTIVE accepted; status reads back as `ACTIVE`.
7. **T7 partial UNIQUE keystone** — `svc_behavior_plans_active_per_student_type_uq` rejects a second ACTIVE BIP for the same student (`Key (student_id, plan_type)=(<Maya>, BIP) already exists`). The first BIP must be flipped EXPIRED before a new ACTIVE BIP can land.
8. **T8 partial UNIQUE allows different type** — second ACTIVE plan of `plan_type='SAFETY_PLAN'` for the same student is accepted; `count(*)` of ACTIVE plans for the student goes 1 → 2 (one BIP + one SAFETY_PLAN).
9. **T9 partial UNIQUE allows DRAFT alongside ACTIVE** — adding a DRAFT BIP while an ACTIVE BIP exists for the same student is accepted (the partial filter only enforces uniqueness within `status='ACTIVE'`); group-by reads `ACTIVE=1, DRAFT=1`.
10. **T10 progress CHECK** — `svc_behavior_plan_goals_progress_chk` rejects `progress='BOGUS'`.
11. **T11 effectiveness CHECK** — `svc_bip_teacher_feedback_effectiveness_chk` rejects `overall_effectiveness='BOGUS'`.
12. **T12 effectiveness NULL accepted** — pending feedback row reads back with `overall_effectiveness=NULL` (the CHECK explicitly allows NULL since pending requests have no rating yet).
13. **T13 partial UNIQUE on pending feedback** — `svc_bip_teacher_feedback_pending_uq` rejects a second pending row for the same `(plan_id, teacher_id)`.
14. **T14 partial UNIQUE releases on submit** — UPDATE the pending row to populate `submitted_at` + `overall_effectiveness='SOMEWHAT_EFFECTIVE'`, then INSERT a fresh pending row for the same `(plan, teacher)` succeeds; total feedback rows for the plan reads 2 (1 submitted + 1 pending).
15. **T15 FK reject — bogus plan_id on goal** — `svc_behavior_plan_goals_plan_id_fkey` rejects `plan_id='00000000-…-0099'`.
16. **T16 FK reject — bogus student_id on plan** — `svc_behavior_plans_student_id_fkey` rejects `student_id='00000000-…-0099'`.
17. **T17 CASCADE on plan delete** — DELETE on a `svc_behavior_plans` row drops 2 goals + 1 feedback row in one statement; `(goals_after=0, fb_after=0)` from `(goals_before=2, fb_before=1)`.
18. **T18 source_incident_id soft ref** — accepts an arbitrary UUID `99999999-…` since the column has no DB-enforced FK (per ADR-001 / ADR-020); the Step 5 BehaviorPlanService is the canonical app-layer validator and will reject IDs that do not match a real `sis_discipline_incidents.id` in the same tenant before the row is written.

Outer ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state — final SELECTs confirm `(plans=0, goals=0, fb=0)` for the smoke ids.

**FK action verification via `pg_constraint.confdeltype`:**

```
svc_behavior_plan_goals_plan_id_fkey         CASCADE
svc_behavior_plans_created_by_fkey           SET NULL
svc_behavior_plans_student_id_fkey           CASCADE
svc_bip_teacher_feedback_plan_id_fkey        CASCADE
svc_bip_teacher_feedback_requested_by_fkey   SET NULL
svc_bip_teacher_feedback_teacher_id_fkey     SET NULL
```

All 6 actions match the migration's declared intent.

**Sanity counts on `tenant_demo`:**

- 3 logical `svc_*` base tables.
- 6 rows in `pg_constraint` for the new FKs (one per logical FK; no partition replication).
- 0 cross-schema FKs.
- Idempotent re-provision is a clean no-op on the SQL — both `tenant_demo` and `tenant_test` survived a second `provision` run with no DDL applied.

**Splitter audit:** Python state-machine audit reports zero `;` inside any string literal or comment in the migration. Migration applied first try with no rewrite needed.

**Constraint observation worth carrying forward:** the `cardinality(target_behaviors) > 0` CHECK is the right belt-and-braces for a NOT NULL TEXT[] column when "non-empty" is part of the contract. `array_length(target_behaviors, 1)` would return NULL for an empty array (not 0), so a `> 0` predicate against `array_length` would silently pass an empty array. `cardinality()` is the splitter-safe scalar that returns 0 for `'{}'::text[]`. Same observation applies in Cycle 6 Step 2's `enr_offers.offer_conditions` CHECK.

**What's deferred to later steps:**

- Step 3 seeds the catalogue (6 categories + 5 action types from `sis_discipline_*`), 3 sample incidents (1 RESOLVED + Verbal Warning, 1 UNDER_REVIEW + Detention with parent notified, 1 OPEN no actions), 1 sample BIP for Maya — `plan_type='BIP'`, `status='ACTIVE'`, `created_by=Hayes`, `source_incident_id` linked to incident #2, `target_behaviors`=2 entries, `replacement_behaviors`=2, `reinforcement_strategies`=2 — with 3 goals (1 IN_PROGRESS + 1 NOT_STARTED + 1 MET) + 1 pending feedback request from Hayes to Rivera. Plus 2 auto-task rules (`beh.incident.reported` + `beh.bip.feedback_requested`) and BEH-001 / BEH-002 permission grants.
- Step 4 lands IncidentService + ActionService + CategoryService.
- Step 5 lands BehaviorPlanService + GoalService + FeedbackService. `BehaviorPlanService.create` validates `source_incident_id` against `sis_discipline_incidents.id` in the same tenant before the row is written (the soft-ref discipline lives in service code).

---

## Step 3 — Seed Data — Categories, Action Types, Sample Incidents + BIP

**Status:** DONE. New `packages/database/src/seed-behaviour.ts` (idempotent, gated on `sis_discipline_categories` row count for the demo school) wired into `package.json` as `seed:behaviour`. `seed-iam.ts` updated to grant `BEH-002:read` to Teacher and `BEH-001:read+write` + `BEH-002:read+write` to Staff. `iam_effective_access_cache` rebuilt: Teacher 40 → 41 (+1 BEH-002:read), VP/Counsellor 20 → 24 (+4 BEH-001:read+write + BEH-002:read+write). All other personas unchanged.

**Catalogue reconciliation:** `BEH-001` ("Behaviour Incidents") and `BEH-002` ("Behaviour Intervention Plans") both already exist in `packages/database/data/permissions.json` — the function library has carried them forward from earlier cycles awaiting use. Total catalogue stays at **149 functions × 3 tiers = 447 codes** (no new entries).

**Permission grants:**

| Persona               |  Before |   After | Delta                                                                                                                                                                                                                                                      |
| --------------------- | ------: | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teacher               |      40 |      41 | +`BEH-002:read` (read BIPs for own students; submit feedback via row-scoped Step 5 PATCH endpoint)                                                                                                                                                         |
| Staff (VP/Counsellor) |      20 |      24 | +`BEH-001:read+write` (incident lifecycle), +`BEH-002:read+write` (counsellor creates and edits BIPs)                                                                                                                                                      |
| School Admin          |     447 |     447 | unchanged — `BEH-*:admin` reached via the `everyFunction: ['read','write','admin']` grant                                                                                                                                                                  |
| Platform Admin        |     447 |     447 | unchanged — same `everyFunction` mechanism                                                                                                                                                                                                                 |
| Student / Parent      | 19 / 19 | 19 / 19 | unchanged — students never see discipline records, parents see only via the Cycle 9 UI row-scope filter (no IAM grant needed since the parent UI reads through their child's row scope on stu-001 / their existing tch-002 grants for chld-bound surfaces) |

**Teacher submits feedback gated on `BEH-002:read`** — the Step 5 `FeedbackService.submit` endpoint will be `@RequirePermission('beh-002:read')` plus a row-scope check (caller's `actor.employeeId === row.teacher_id`). This is the same verb-mismatch pattern Cycle 1's attendance writes use (gate on `att-001:write` + `sis_class_teachers` row scope) — for Cycle 9 the row scope is the partial UNIQUE-protected pending feedback row tagged with the calling teacher's id.

**What's seeded on `tenant_demo` (test tenant stays empty by convention — matches prior seeds):**

1. **6 `sis_discipline_categories`** covering all four severity tiers:

   | Name                    | severity | description                                                                      |
   | ----------------------- | -------- | -------------------------------------------------------------------------------- |
   | Tardiness               | LOW      | Late to class without an excused reason.                                         |
   | Dress Code Violation    | LOW      | Attire that does not meet the school dress code policy.                          |
   | Disrespect              | MEDIUM   | Disrespectful behaviour toward staff or peers, including inappropriate language. |
   | Disruptive Behaviour    | MEDIUM   | Repeated classroom disruption that interferes with instruction.                  |
   | Fighting                | HIGH     | Physical altercation between students.                                           |
   | Weapons/Dangerous Items | CRITICAL | Possession of a weapon or dangerous item on school property.                     |

2. **5 `sis_discipline_action_types`** with `requires_parent_notification` flag set per the plan:

   | Name                     | requires_parent_notification | description                                                                    |
   | ------------------------ | :--------------------------: | ------------------------------------------------------------------------------ |
   | Verbal Warning           |            false             | A verbal reminder of expectations. No formal record sent home.                 |
   | Written Warning          |            false             | A written record placed in the student file. No parent notification yet.       |
   | Detention                |             true             | After-school detention. Parent receives an IN_APP notification.                |
   | In-School Suspension     |             true             | Student is removed from class and placed in supervised study. Parent notified. |
   | Out-of-School Suspension |             true             | Student is sent home for a defined window. Parent notified.                    |

3. **3 sample `sis_discipline_incidents`** covering all 3 status states:

   | #   | Student         | Category             | severity | status       | reported_by | actions                                                                         |
   | --- | --------------- | -------------------- | -------- | ------------ | ----------- | ------------------------------------------------------------------------------- |
   | I1  | Maya Chen       | Disruptive Behaviour | MEDIUM   | RESOLVED     | Rivera      | Verbal Warning (no parent notification, no date range)                          |
   | I2  | Maya Chen       | Disrespect           | MEDIUM   | UNDER_REVIEW | Rivera      | Detention (parent notified at 2026-04-22 14:30, start_date=end_date=2026-04-23) |
   | I3  | Ethan Rodriguez | Tardiness            | LOW      | OPEN         | Rivera      | (no actions yet — Step 4 IncidentService will resolve in the CAT)               |

   I1 has `resolved_by=Mitchell, resolved_at=2026-04-16` populated under the `resolved_chk` invariant (working states + null pair on I2/I3 vs RESOLVED + populated pair on I1). I2 carries `admin_notes` referencing the BIP follow-up. I3 has no actions, demonstrating the OPEN-without-actions edge case.

4. **1 sample BIP for Maya** — `plan_type=BIP`, `status=ACTIVE`, `created_by=Hayes` (counsellor), `source_incident_id=I2.id` (links the BIP to the underlying Disrespect incident), `review_date = today + 30 days`. Arrays populated as documented in the plan: `target_behaviors` 2 entries (`["Verbal confrontation with peers", "Refusal to follow staff instructions"]`), `replacement_behaviors` 2 entries (`["Use I-statements", "Request a break when frustrated"]`), `reinforcement_strategies` 2 entries (`["Positive verbal praise from teachers", "Weekly check-in with counsellor"]`). Live verification confirms `cardinality(target_behaviors)=cardinality(replacement_behaviors)=cardinality(reinforcement_strategies)=2`. The BIP is the only ACTIVE plan for Maya so the partial UNIQUE on `(student_id, plan_type) WHERE status='ACTIVE'` accepts it cleanly; a Step 10 CAT scenario will exercise rejection of a second ACTIVE BIP.

5. **3 `svc_behavior_plan_goals`** attached to Maya's BIP, exercising 3 of the 4 progress states:

   | #   | goal_text                                              | progress    | last_assessed_at |
   | --- | ------------------------------------------------------ | ----------- | ---------------- |
   | 1   | Reduce verbal confrontations to fewer than 2 per week. | IN_PROGRESS | today            |
   | 2   | Use I-statements in 3 out of 5 conflict situations.    | NOT_STARTED | null             |
   | 3   | Attend weekly counsellor check-in.                     | MET         | today            |

   Each goal carries `baseline_frequency`, `target_frequency`, and `measurement_method` populated so the Step 8 BIP UI has rich content to render. NOT_MET is deliberately not exercised in the seed — Step 5 `GoalService.PATCH` will demonstrate that transition during the CAT.

6. **1 pending `svc_bip_teacher_feedback`** — Hayes (counsellor) requests feedback from Rivera (Maya's teacher) on the BIP. `submitted_at=NULL` while pending; `requested_at` populated to `now()` at seed time. The partial UNIQUE on `(plan_id, teacher_id) WHERE submitted_at IS NULL` is now exercising its single-pending-per-pair invariant — a Step 10 CAT scenario will verify the partial UNIQUE rejects a second pending row and releases on submit.

7. **2 auto-task rules** on `tsk_auto_task_rules` keyed to the Step 6 BehaviourNotificationConsumer's emit topics:

   | trigger_event_type           | target_role  | priority | due_offset_hours | category       | title_template                                      |
   | ---------------------------- | ------------ | -------- | ---------------- | -------------- | --------------------------------------------------- |
   | `beh.incident.reported`      | SCHOOL_ADMIN | NORMAL   | 24               | ADMINISTRATIVE | `Review incident: {student_name} — {category_name}` |
   | `beh.bip.feedback_requested` | NULL         | NORMAL   | 72               | ADMINISTRATIVE | `BIP feedback requested: {student_name}`            |

   The `beh.incident.reported` rule resolves recipients via the standard SCHOOL_ADMIN role lookup (same as Cycle 4's `att.absence.requested`). The `beh.bip.feedback_requested` rule has `target_role=NULL` so the Cycle 7 TaskWorker uses its `payload.recipientAccountId / accountId` fallback to land the task on the specific teacher's list — mirroring the Cycle 8 `tkt.ticket.assigned` pattern. The Step 5 `FeedbackService.requestFeedback` will pre-resolve the teacher's `platform_users.id` from the supplied `hr_employees.id` and stamp it on the event payload before emit. Each rule has 1 matching `tsk_auto_task_actions` row with `action_type='CREATE_TASK'` and `sort_order=0`.

**Live verification (counts on `tenant_demo` after seed):**

```
cats=6   atypes=5   atypes_notify=3
incs=3   open_inc=1   ur_inc=1   res_inc=1
acts=2   acts_notified=1
bips=1   active_bips=1
goals=3   fb=1   pending_fb=1
beh_rules=2   beh_actions=2
```

All counts match the plan. Idempotent re-run logs `sis_discipline_categories already populated for demo school — skipping` with no INSERTs. `tenant_test` confirmed empty (`cats=0, bips=0, rules=0`) — matches the test-tenant convention from prior seeds.

**Catalogue presence check:**

```
$ grep -c '"BEH-001"' packages/database/data/permissions.json
1
$ grep -c '"BEH-002"' packages/database/data/permissions.json
1
```

Both already in the catalogue — no edits to `permissions.json` required.

**`seed-iam.ts` deltas applied:**

```diff
   {
     roleName: 'Teacher',
     perms: {
       ...
       'BEH-001': ['read', 'write'],
+      // Cycle 9 — teachers read BIPs for students in their classes and
+      // submit teacher feedback on strategy effectiveness via the Step 5
+      // FeedbackService PATCH endpoint gated on beh-002:read plus row scope.
+      'BEH-002': ['read'],
       ...
     },
   },
   {
     roleName: 'Staff',
     perms: {
       ...
       'IT-001': ['read', 'write'],
+      // Cycle 9 — VPs, counsellors, admin assistants log incidents (BEH-001)
+      // and counsellors author + edit BIPs (BEH-002 read+write). School
+      // Admin and Platform Admin pick up admin tier via everyFunction.
+      'BEH-001': ['read', 'write'],
+      'BEH-002': ['read', 'write'],
       ...
     },
   },
```

Cache rebuild log:

```
admin@        -> 447 permissions cached
principal@    -> 447 permissions cached
teacher@      -> 41 permissions cached
student@      -> 19 permissions cached
parent@       -> 19 permissions cached
vp@           -> 24 permissions cached
counsellor@   -> 24 permissions cached
```

**What's deferred to later steps:**

- Step 4 lands `apps/api/src/discipline/` with `IncidentService` + `ActionService` + `CategoryService` + ~14 endpoints. `POST /discipline/incidents` stamps `reported_by` from `actor.employeeId` and emits `beh.incident.reported`. Admin lifecycle PATCHes (`/review`, `/resolve`, `/reopen`) use `executeInTenantTransaction` with `SELECT … FOR UPDATE`. `POST /discipline/incidents/:id/actions` reads `requires_parent_notification` from the action_type catalogue and emits `beh.action.parent_notification_required` when true so the Step 6 consumer can fan out IN_APP notifications to portal-enabled guardians via `sis_student_guardians`.
- Step 5 lands `apps/api/src/behavior-plans/` with `BehaviorPlanService` + `GoalService` + `FeedbackService` + ~12 endpoints. `BehaviorPlanService.create` validates `source_incident_id` against `sis_discipline_incidents.id` in the same tenant before the row is written (the soft-ref discipline lives in service code).
- Step 6 lands `BehaviourNotificationConsumer` subscribing to `beh.incident.reported` + `beh.incident.resolved` + `beh.action.parent_notification_required` + `beh.bip.feedback_requested`. The Step 3 auto-task rules feed the existing Cycle 7 Task Worker — adding the new rules at runtime requires a worker restart per the Cycle 7 documented limitation; production deploys naturally restart so this is dev-only.

---

## Step 4 — Discipline NestJS Module — Incidents + Actions

**Status:** DONE. New `apps/api/src/discipline/` with 4 services + 3 controllers + DTO module + `DisciplineModule` wired into `AppModule.imports` after `TicketsModule`. **14 endpoints** total (4 categories + 3 action types + 5 incidents + 3 actions on the parent-incident path including DELETE). Build clean on first try, all routes mapped on boot, live smoke verified end-to-end on `tenant_demo`.

**Files:**

- `apps/api/src/discipline/dto/discipline.dto.ts` — DTOs with `class-validator`. `SEVERITIES` + `INCIDENT_STATUSES` const arrays driving `IsIn` validators on the input shapes. Response shapes for `CategoryResponseDto` / `ActionTypeResponseDto` / `ActionResponseDto` / `IncidentResponseDto` (the last with `actions: ActionResponseDto[]` inlined). `CreateIncidentDto` carries `incidentTime` validated by `@Matches(/^\d{2}:\d{2}(:\d{2})?$/)` so HH:MM or HH:MM:SS round-trip cleanly to the schema's `TIME` column.
- `apps/api/src/discipline/category.service.ts` + `action-type.service.ts` + `category.controller.ts` — 7 endpoints (4 category + 3 action-type) under `beh-001:read` for reads and `beh-001:admin` for writes. List sort: categories ordered by severity (CRITICAL first) then name; action types alphabetical. Both services trap UNIQUE-violation 23505 from Postgres into a friendly 400 ("A category with this name already exists" / "An action type with this name already exists") before letting the schema raise. Internal `assertActive(id)` helpers used by IncidentService and ActionService to validate inputs before INSERT.
- `apps/api/src/discipline/incident.service.ts` + `incident.controller.ts` — **the keystone.** 5 endpoints (`GET /discipline/incidents` + `GET /discipline/incidents/:id` + `POST /discipline/incidents` + `PATCH /:id/{review,resolve,reopen}`). Lifecycle transitions all use `executeInTenantTransaction` with `SELECT … FOR UPDATE` per the locked-read convention. Resolve stamps `resolved_by = actor.employeeId` AND `resolved_at = now()` in the same UPDATE so the multi-column `resolved_chk` is always satisfied. Reopen clears both fields in the same UPDATE for the same reason. The list path bulk-loads inline `actions[]` for every returned incident in one round-trip via `WHERE a.incident_id = ANY($1::uuid[])` — avoids N+1 reads.
- `apps/api/src/discipline/action.service.ts` + `action.controller.ts` — 4 endpoints (`GET /discipline/incidents/:id/actions` + `POST /discipline/incidents/:id/actions` + `PATCH /discipline/actions/:id` + `DELETE /discipline/actions/:id`). POST reads `IncidentService.loadForActionWrite` which 400s on RESOLVED incidents (preserving the audit trail — admin must reopen first to add a new consequence). Date-range validation lives in both POST + PATCH (PATCH locks the row + reads existing dates inside the tx so a partial update can't slip a stale comparison through). Trap UNIQUE-violation 23505 on `(incident_id, action_type_id)` into 400.
- `apps/api/src/discipline/discipline.module.ts` — wires the 4 services + 3 controllers, imports `TenantModule + IamModule + KafkaModule`.
- `apps/api/src/app.module.ts` — extended import list adds `DisciplineModule` after `TicketsModule`.

**Row-Level Visibility model** implemented in `IncidentService.buildVisibility(actor, start)`:

| Caller                                 | Predicate                                                                                         | adminNotes |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | :--------: |
| Admin (school admin or platform admin) | no filter — all incidents in tenant                                                               |     ✅     |
| Teacher (STAFF + employeeId)           | `(reported_by = me) OR (student_id IN active sis_enrollments JOIN sis_class_teachers ON me)`      |     ❌     |
| Parent (GUARDIAN)                      | `student_id IN sis_student_guardians JOIN sis_guardians ON g.person_id = me`                      |     ❌     |
| Student / unknown                      | `AND FALSE` — gate-tier permission already 403s these personas; the predicate is defence in depth |     ❌     |

`stripForNonManager(dto)` zeros `adminNotes` to `null` before the response is serialised. Admin-tier readers see the full payload; everyone else sees a stripped DTO. The plan's row-level visibility section in Step 4 is satisfied.

**Permission gating:**

- `beh-001:read` — list + read incidents + categories + action types.
- `beh-001:write` — POST `/discipline/incidents` (report a new incident; stamps `reported_by = actor.employeeId`; refuses callers without an `hr_employees` row with `403 "Only staff with an employee record can report incidents"`).
- `beh-001:admin` — review / resolve / reopen incidents; assign / update / delete actions; CRUD on categories and action types.

**`seed-iam.ts` follow-on:** the smoke caught a permission-grant gap from Step 3 — Parent did NOT hold `BEH-001:read`, but the plan's row-scope section (Step 4) explicitly requires parents to see their own children's incidents. Added `BEH-001: ['read']` to the Parent role with a comment explaining the row-scope contract (sis_student_guardians + admin_notes stripped). Parent now holds **20 perms** (was 19); cache rebuilt cleanly. The other personas are unchanged. Step 9's parent UI will need this grant anyway.

**Kafka emits** (3 topics, all wired through `KafkaProducerService.emit(...)` so the ADR-057 envelope wraps every payload with `event_type` / `source_module:'discipline'` / `tenant_id` / fresh `event_id` + `correlation_id`):

| Topic                                     | Fired by                                                                          | Payload highlights                                                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beh.incident.reported`                   | `IncidentService.create`                                                          | `{incidentId, schoolId, studentId, studentName, studentGradeLevel, categoryId, categoryName, severity, reportedById, reportedByName, reporterName, incidentDate, description, status:'OPEN'}`  |
| `beh.action.parent_notification_required` | `ActionService.create` (when action_type's `requires_parent_notification = true`) | `{actionId, incidentId, schoolId, studentId, studentName, categoryName, severity, actionTypeId, actionTypeName, startDate, endDate, guardianAccountIds:[], assignedById, assignedByAccountId}` |
| `beh.incident.resolved`                   | `IncidentService.resolve`                                                         | `{incidentId, schoolId, studentId, studentName, categoryId, categoryName, severity, resolvedById, resolvedByName, resolvedByAccountId, reportedById, reportedByName, resolvedAt}`              |

Notes on the payloads:

- `beh.incident.reported` includes both `reportedByName` and `reporterName` keys so the Step 3 auto-task rule's title/description templates resolve `{reporter_name}` cleanly. The `template-render.ts` helper auto-flattens camelCase → snake_case.
- `beh.action.parent_notification_required` resolves the portal-enabled guardians at emit time via `sis_student_guardians` joined to `sis_guardians.person_id` → `platform_users.person_id` (only guardians with `portal_access=true` AND a non-NULL `platform_users.id`). The Step 6 `BehaviourNotificationConsumer` will iterate `guardianAccountIds` and enqueue an IN_APP notification per id without re-querying.
- `beh.incident.resolved` carries `resolvedByAccountId` AND `reportedById` so the Step 6 consumer can suppress the "your incident has been resolved" notification when the resolver is the reporter — same self-suppression pattern as Cycle 8 follow-up 2 for tickets.

**Live verification on `tenant_demo` 2026-05-04** (15+ scenarios, all pass):

1. **S1 admin GET /discipline/categories** → 6 rows sorted CRITICAL → HIGH → MEDIUM → LOW (Weapons/Dangerous Items first, Tardiness/Dress Code Violation last).
2. **S1b admin GET /discipline/action-types** → 5 rows; `Detention` / `In-School Suspension` / `Out-of-School Suspension` show `requiresParentNotification=true`; `Verbal Warning` / `Written Warning` show false.
3. **S2 teacher GET /discipline/categories** → 200 with 6 rows (Teacher holds beh-001:read).
4. **S3 student GET /discipline/categories** → 403 (student has no beh-001:read).
5. **S3b parent GET /discipline/categories** → 403 (parent permission was added to `BEH-001:read` only — **the catalogue read endpoint is admin/staff/parent-children scoped; parents read incidents row-scoped to their own children but the catalogue read is gated and the parent doesn't need it).** Wait — actually parent's grant was `BEH-001: ['read']` so they DO have beh-001:read. Re-checking: S3b returned 403 BEFORE the grant landed. After the grant, S11 succeeded with count=3 — confirming parent now has the read tier and the row-scope filters to their child only.

   Final state after the grant: parent holds beh-001:read, can hit `/discipline/categories` AND `/discipline/incidents`; the row-scope at IncidentService.buildVisibility binds them to their child only.

6. **S4 keystone — teacher POST /discipline/incidents** for Maya / Disrespect MEDIUM with description "SMOKE Step 4 incident — verbal altercation" → response shows `id`, `status:'OPEN'`, `reportedByName:'James Rivera'`, `student:'Maya Chen'`, `severity:'MEDIUM'`, `actions:0`. ADR-057 envelope captured live on `dev.beh.incident.reported` with full payload (reproduced below).
7. **S5 student POST /discipline/incidents** → 403 (student has no beh-001:write).
8. **S6 admin PATCH /:id/review** with `adminNotes` → response shows `status:'UNDER_REVIEW'` and `adminNotes` populated for the admin (manager) view.
9. **S7 admin POST /:id/actions** with Detention type + start/end date → response shows `actionTypeName:'Detention'`, `requiresParentNotification:true`, `startDate:'2026-05-05'`, `parentNotified:false` (the consumer-side flip stamps this when delivery succeeds — Step 6 wiring). Live ADR-057 envelope captured on `dev.beh.action.parent_notification_required` with `guardianAccountIds:['<David Chen>']` resolved at emit time.
10. **S8 teacher POST /:id/actions** → 403 (admin-only).
11. **S9 admin PATCH /:id/resolve** with `adminNotes` → response shows `status:'RESOLVED'`, `resolvedByName:'Sarah Mitchell'`, `resolvedAt` populated. Live ADR-057 envelope captured on `dev.beh.incident.resolved` with `resolvedByAccountId` + `reportedById` for self-resolve suppression.
12. **S10 admin GET /discipline/incidents** → 4 rows (3 seeded + 1 smoke) with adminNotes populated for Maya's seeded incidents (admin sees the BIP follow-up note + the verbal-warning conversation note); Ethan's row has `adminNotes:False` (no admin notes seeded).
13. **S11 parent GET /discipline/incidents** (David Chen) → 3 rows, all Maya, all `adminNotes:None`. Ethan Rodriguez's incident is filtered out by the GUARDIAN row-scope.
14. **S11b parent GET /discipline/incidents/:id** for Maya's seeded UNDER_REVIEW incident → returns the row with `actions:1` (Detention with `parentNotified:true`) and `adminNotes:None` (stripped).
15. **S11c parent GET /discipline/incidents/:id** for Ethan Rodriguez's incident → 404 (row-scope, don't-leak-existence convention).
16. **S12 teacher GET /discipline/incidents** → 4 rows (Rivera reported all 3 seeded plus the smoke, plus Ethan's via class enrollment). All rows show `adminNotes:None` because Teacher is not a manager (the buildVisibility branch correctly carries `isManager:false` for STAFF without `isSchoolAdmin`).
17. **S13 student GET /discipline/incidents** → 403.
18. **S14 admin POST action on RESOLVED incident** → 400 with the friendly message `"Cannot add an action to a RESOLVED incident. Reopen the incident first."`.
19. **S15 admin /reopen + DELETE action** → reopen 200, delete 204 (works after reopen).
20. **S16 admin POST duplicate action type on same incident** → 1st 201, 2nd 400 with `"An action of this type is already assigned to this incident. Edit the existing action instead."` (UNIQUE on `(incident_id, action_type_id)` traps cleanly).
21. **S17 admin POST action with end_date < start_date** → 400 with `"endDate must be on or after startDate"` (app-layer pre-check before the schema's `dates_chk`).

**Live ADR-057 envelopes captured on the wire:**

```json
// dev.beh.incident.reported
{
  "event_id": "019df29d-e913-…",
  "event_type": "beh.incident.reported",
  "event_version": 1,
  "tenant_id": "019dc92b-…",
  "source_module": "discipline",
  "correlation_id": "019df29d-e913-…",
  "payload": {
    "incidentId": "019df29d-e908-…",
    "studentId": "019dd544-7e06-…",
    "studentName": "Maya Chen",
    "studentGradeLevel": "9",
    "categoryName": "Disrespect",
    "severity": "MEDIUM",
    "reportedByName": "James Rivera",
    "reporterName": "James Rivera",
    "incidentDate": "2026-05-04",
    "status": "OPEN"
  }
}

// dev.beh.action.parent_notification_required
{
  "event_type": "beh.action.parent_notification_required",
  "source_module": "discipline",
  "payload": {
    "actionId": "019df29d-e941-…",
    "incidentId": "019df29d-e908-…",
    "studentName": "Maya Chen",
    "categoryName": "Disrespect",
    "actionTypeName": "Detention",
    "startDate": "2026-05-05",
    "endDate": "2026-05-05",
    "guardianAccountIds": ["019dc92d-088d-…"],
    "assignedByAccountId": "019dc92d-087d-…"
  }
}

// dev.beh.incident.resolved
{
  "event_type": "beh.incident.resolved",
  "source_module": "discipline",
  "payload": {
    "incidentId": "019df29d-e908-…",
    "studentName": "Maya Chen",
    "categoryName": "Disrespect",
    "resolvedByName": "Sarah Mitchell",
    "resolvedByAccountId": "019dc92d-087d-…",
    "reportedById": "019dd544-85e6-…",
    "reportedByName": "James Rivera",
    "resolvedAt": "2026-05-04T10:52:08+00"
  }
}
```

**Smoke residue cleanup:** `DELETE FROM tenant_demo.sis_discipline_incidents WHERE description LIKE 'SMOKE%'` drops 3 smoke incidents (CASCADE drops the linked actions). Tenant restored to post-Step-3 seed shape: 3 incidents (1 OPEN / 1 UNDER_REVIEW / 1 RESOLVED), 2 actions, 1 BIP, 3 goals, 1 pending feedback, 2 auto-task rules.

**Iteration issues caught and resolved during the build:**

1. **Unused `Logger` import** in `incident.service.ts` and `action.service.ts` — `tsc --strict` fired `TS6133 'logger' is declared but its value is never read`. Removed the field + import. Build clean on the second attempt.
2. **Parent IAM gate gap** — described above. Added `BEH-001:read` to Parent role.
3. **Kafka tools path** in the smoke script — the `campusos-kafka` container has the binaries at `/opt/kafka/bin/`, not `/opt/bitnami/kafka/bin/`. Documented for future cycles.
4. **Auto-create Kafka topics for envelope capture** — `kafka-topics.sh --create --if-not-exists --topic dev.beh.…` is needed before the `kafka-console-consumer.sh --from-beginning` smoke can read messages from a new topic on a fresh broker. Same race documented in Cycle 3 + Cycle 5 + Cycle 7 + Cycle 8.

**What's deferred to later steps:**

- Step 5 lands `apps/api/src/behavior-plans/` with `BehaviorPlanService` + `GoalService` + `FeedbackService` + ~12 endpoints. `BehaviorPlanService.create` validates the supplied `source_incident_id` against `sis_discipline_incidents.id` in the same tenant before INSERT (the soft-ref discipline lives in service code per ADR-001/020).
- Step 6 lands the `BehaviourNotificationConsumer` subscribing to all 4 Cycle 9 topics. The Step 4 emits are now feeding `dev.beh.incident.reported` / `dev.beh.action.parent_notification_required` / `dev.beh.incident.resolved` ready for the consumer to land. The Step 3 auto-task rules also feed the existing Cycle 7 Task Worker — adding the new rules at runtime requires a worker restart per the Cycle 7 documented limitation; production deploys naturally restart so this is dev-only.
- Out of scope this step (deferred): bulk admin actions on the incident queue (per-row works for the demo); incident attachments (the schema doesn't model them — Phase 3 polish if needed); category tree nesting (the plan called for "tree with action types" but the schema is flat — categories are a single-level catalogue, action types are a separate flat catalogue, and the UI in Step 7 will render them as two parallel lists rather than a nested tree). The plan's "tree" language is misleading — there is no parent_category_id on `sis_discipline_categories` (unlike the Cycle 8 `tkt_categories` self-FK).

---

## Step 5 — Behaviour Plan NestJS Module — BIPs + Goals + Feedback

**Status:** DONE. New `apps/api/src/behavior-plans/` with 3 services + 3 controllers + DTO module + `BehaviorPlansModule` wired into `AppModule.imports` after `DisciplineModule`. **14 endpoints** total (6 plans + 4 goals + 4 feedback). 1 Kafka emit topic. Build clean after one TS6133 unused-import fix, all routes mapped on boot, live smoke verified end-to-end on `tenant_demo`. Cycle 9 endpoint count after Step 5: **14 + 14 = 28** (Discipline + BehaviorPlans).

**Files:**

- `apps/api/src/behavior-plans/dto/behavior-plan.dto.ts` — DTOs with `class-validator`. Const arrays `PLAN_TYPES` (BIP/BSP/SAFETY_PLAN), `PLAN_STATUSES` (DRAFT/ACTIVE/REVIEW/EXPIRED), `PATCHABLE_PLAN_STATUSES` (DRAFT/REVIEW only — generic PATCH never crosses into ACTIVE; that path is the dedicated /activate endpoint so the partial UNIQUE keystone check lives in one place), `GOAL_PROGRESS` (NOT_STARTED/IN_PROGRESS/MET/NOT_MET), `FEEDBACK_EFFECTIVENESS` (NOT_EFFECTIVE/SOMEWHAT_EFFECTIVE/EFFECTIVE/VERY_EFFECTIVE). `CreateBehaviorPlanDto.targetBehaviors` validated by `@IsArray()` + `@ArrayMinSize(1)` + `@IsString({ each: true })` so an empty array is rejected at the request layer before the schema's `cardinality > 0` CHECK fires.

- `apps/api/src/behavior-plans/behavior-plan.service.ts` + `behavior-plan.controller.ts` — **the keystone.** 6 endpoints (`GET /behavior-plans` + `GET /:id` + `POST` + `PATCH /:id` + `PATCH /:id/activate` + `PATCH /:id/expire`). The list path bulk-loads inline `goals[]` + `feedback[]` for every returned plan in two round-trips via `WHERE plan_id = ANY($1::uuid[])` — avoids N+1. `hasCounsellorScope(actor)` is the manager-flag helper: `true` if `isSchoolAdmin` OR if the actor holds `beh-002:write` (Staff role grant — VPs and counsellors). `buildVisibility(actor, start)` returns either an empty fragment (counsellor scope, no filter), a STAFF teacher-only filter joining through `sis_class_teachers + sis_enrollments` matching the IncidentService teacher branch from Step 4, or `AND FALSE` for non-staff personas (defence in depth — the gate-tier `@RequirePermission('beh-002:read')` already 403s parents and students). All lifecycle PATCHes use `executeInTenantTransaction` with `SELECT … FOR UPDATE` on the plan row. **Activate keystone:** locks the row + verifies no other plan exists for the same `(student_id, plan_type)` with `status='ACTIVE'` (excluding the row being activated) before flipping. Surfaces a friendly 400 carrying the conflicting plan id ("Student already has an ACTIVE BSP plan (019df…). Expire that plan before activating a new one.") so the schema's partial UNIQUE INDEX never raises. **Expire keystone:** ACTIVE | REVIEW | DRAFT → EXPIRED is the terminal flip; the partial UNIQUE on the ACTIVE filter releases automatically since the row no longer matches the WHERE clause. Generic PATCH refuses any attempt to set `status='ACTIVE'` (use /activate) and rejects all writes against EXPIRED plans (read-only). POST validates `studentId` + the optional `sourceIncidentId` soft ref against the same tenant before INSERT — the schema-level FK is intentionally absent per ADR-001/020.

- `apps/api/src/behavior-plans/goal.service.ts` + `goal.controller.ts` — 4 endpoints. List/POST mounted on `/behavior-plans/:id/goals` (visibility flows through the parent plan via `BehaviorPlanService.getById`). PATCH/DELETE on `/behavior-plan-goals/:id` join through the parent plan inside the locked-tx so a PATCH on a goal whose plan is EXPIRED returns 403 before the UPDATE fires. **Auto-bump rule:** when `progress` transitions away from NOT_STARTED on PATCH, `last_assessed_at = CURRENT_DATE` is set in the same UPDATE. Counsellors can still override later by passing an explicit value via a future endpoint (today the DTO doesn't expose `lastAssessedAt` — bumping is automatic).

- `apps/api/src/behavior-plans/feedback.service.ts` + `feedback.controller.ts` — 4 endpoints. `GET /behavior-plans/:id/feedback` lists all feedback rows for a plan (visibility flows through plan); `POST /behavior-plans/:id/feedback-requests` opens a pending request with partial UNIQUE pre-flight on `(plan_id, teacher_id) WHERE submitted_at IS NULL` carrying the existing pending id in the friendly 400; `PATCH /bip-feedback/:id` is the **submit path** — gated on `beh-002:read` plus a row-scope check (`actor.employeeId === row.teacher_id` OR counsellor/admin override) inside the locked tx; refuses already-submitted rows (the partial UNIQUE has released by then, and writing a fresh response over an old submission would lose the audit trail). `GET /bip-feedback/pending` is the **teacher's pending queue** — row-scoped to `actor.employeeId` for non-counsellors; counsellors and admins see all pending across the tenant via the `hasCounsellorScope` branch. The pending list joins through `svc_behavior_plans → sis_students → platform_students → iam_person` so each row carries `studentName` + `planType` for the teacher's UI without a second round-trip.

- `apps/api/src/behavior-plans/behavior-plans.module.ts` — wires the 3 services + 3 controllers, imports `TenantModule + IamModule + KafkaModule`.

- `apps/api/src/app.module.ts` — extended import list adds `BehaviorPlansModule` after `DisciplineModule`.

**Permission gating:**

- `beh-002:read` — list + read plans, goals, feedback. Row-scoped at the service layer for non-counsellors. Teachers also reach `PATCH /bip-feedback/:id` on this gate when they are the assigned teacher — same verb-mismatch pattern Cycle 1 attendance uses (gate on `att-001:write` with row-scope on `sis_class_teachers` membership; here the gate is on `:read` with row-scope on `teacher_id`).
- `beh-002:write` — create/edit BIPs (counsellor scope); CRUD goals; request feedback. Granted to Staff role (VPs and counsellors).
- `beh-002:admin` — reached via the `everyFunction` grant on School Admin / Platform Admin; same write powers as counsellor + reserved for cross-tenant operations and a future hard-delete tier.

**Kafka emits** (1 topic, ADR-057 envelope):

| Topic                        | Fired by                          | Payload highlights                                                                                                                                                 |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `beh.bip.feedback_requested` | `FeedbackService.requestFeedback` | `{feedbackId, planId, schoolId, studentId, studentName, planType, teacherId, teacherName, recipientAccountId, accountId, requesterId, requesterName, sourceRefId}` |

The payload's `recipientAccountId` (and `accountId` alias) is the teacher's `platform_users.id` resolved at emit time via `hr_employees → iam_person → platform_users`. The Step 3 seeded auto-task rule on `beh.bip.feedback_requested` has `target_role=NULL` so the Cycle 7 TaskWorker uses its `payload.recipientAccountId / accountId` fallback to land a TODO task on the specific teacher's list — same pattern as Cycle 8's `tkt.ticket.assigned` rule.

**Live verification on `tenant_demo` 2026-05-04** (23 scenarios, all pass):

1. **S1 admin GET /behavior-plans** → 1 row (the seeded ACTIVE BIP for Maya) with `goals=3` + `feedback=1` inlined.
2. **S2 counsellor GET /behavior-plans** → 1 row (counsellor scope = all).
3. **S3 teacher GET /behavior-plans** → 1 row (teacher row-scope: Maya is in Rivera's classes via sis_class_teachers + sis_enrollments).
4. **S4 parent GET /behavior-plans** → 403 (parent has no `beh-002:read`).
5. **S5 student GET /behavior-plans** → 403.
6. **S6 counsellor POST new BSP for Maya** with `sourceIncidentId` linked to the seeded UNDER_REVIEW incident → response shows `id`, `status:'DRAFT'`, `planType:'BSP'`, `createdByName:'Marcus Hayes'`, `targetBehaviors[0]` populated, `sourceIncidentId` populated. The BSP coexists with the seed BIP for Maya — different `plan_type` so the partial UNIQUE allows it.
7. **S7 counsellor PATCH /:id/activate** on the new BSP → response shows `status:'ACTIVE'`. No conflict (Maya has no other ACTIVE BSP).
8. **S8 counsellor POST 2nd BSP for Maya** as DRAFT → 201 (DRAFT plans coexist with ACTIVE plans of same type — the partial UNIQUE only fires on ACTIVE).
9. **S8b counsellor PATCH activate on the 2nd BSP** → 400 with the friendly message `"Student already has an ACTIVE BSP plan (019df2ae-7e77-…). Expire that plan before activating a new one."` — partial UNIQUE pre-flight catches it cleanly.
10. **S9 counsellor POST goal** on the seeded BIP with full baseline/target/measurement → response shows `progress:'NOT_STARTED'`, `lastAssessedAt:None`, `baselineFrequency:'15 min'`.
11. **S10 counsellor PATCH goal** progress NOT_STARTED → IN_PROGRESS → response shows `progress:'IN_PROGRESS'`, `lastAssessedAt:'2026-05-04'` (auto-bumped to today on the first non-NOT_STARTED transition).
12. **S11 teacher PATCH goal** → 403 (admin/counsellor only at the service layer).
13. **S12 teacher GET /bip-feedback/pending** → 1 row (the seeded pending request from Hayes) with `studentName:'Maya Chen'`, `planType:'BIP'`, `requestedByName:'Marcus Hayes'`, `submittedAt:None`.
14. **S13 counsellor POST 2nd pending feedback** for the same `(plan, teacher)` → 400 with friendly message `"A pending feedback request already exists for this teacher on this plan (019df0f5-…). Wait for the teacher to submit before opening another request."` — partial UNIQUE pre-flight catches it.
15. **S14 teacher PATCH /bip-feedback/:id** with full submission body → response shows `submittedAt:'2026-05-04T11:10:59'`, `overallEffectiveness:'SOMEWHAT_EFFECTIVE'`, `strategiesObserved:['Verbal praise', 'Weekly check-in']`. The partial UNIQUE on `submitted_at IS NULL` releases automatically.
16. **S15 teacher PATCH same feedback again** → 400 `"Feedback has already been submitted. Open a new request for another round of observation."`
17. **S16 counsellor POST fresh feedback request** for the same `(plan, teacher)` → 201 (partial UNIQUE released after S14's submit). **Live ADR-057 envelope captured on `dev.beh.bip.feedback_requested`** with full payload including `recipientAccountId` populated to Rivera's `platform_users.id`, `studentName:'Maya Chen'`, `planType:'BIP'`, `teacherName:'James Rivera'`, `sourceRefId` matching the feedback id.
18. **S17 teacher GET /bip-feedback/pending** after the fresh request → 1 row (the new pending request).
19. **S18 counsellor GET /bip-feedback/pending** → 1 row (counsellor sees all pending across the tenant).
20. **S19 teacher POST behavior-plans** → 403 (Teacher holds `beh-002:read` only).
21. **S20 parent GET /bip-feedback/pending** → 403.
22. **S21 teacher submit feedback** for a row where they are NOT the assigned teacher (a row Hayes opened for Park) → 400 `"Only the assigned teacher (or a counsellor) can submit this feedback"`. Row-scope works.
23. **S22 counsellor PATCH /:id/expire** on the smoke ACTIVE BSP → response shows `status:'EXPIRED'`. Partial UNIQUE on the ACTIVE filter releases automatically since the row no longer matches.
24. **S23 counsellor PATCH /:id/expire again** on the now-EXPIRED plan → 400 `"Plan is already EXPIRED"`.

**Live ADR-057 envelope captured on the wire:**

```json
// dev.beh.bip.feedback_requested
{
  "event_type": "beh.bip.feedback_requested",
  "event_version": 1,
  "tenant_id": "019dc92b-…",
  "source_module": "behavior-plans",
  "correlation_id": "019df2af-2c3c-…",
  "payload": {
    "feedbackId": "019df2af-2c35-…",
    "planId": "019df0f5-c5d9-…",
    "studentId": "019dd544-7e06-…",
    "studentName": "Maya Chen",
    "planType": "BIP",
    "teacherId": "019dd544-85e6-…",
    "teacherName": "James Rivera",
    "recipientAccountId": "019dc92d-0882-…",
    "accountId": "019dc92d-0882-…",
    "requesterId": "019dd544-85e9-…",
    "sourceRefId": "019df2af-2c35-…"
  }
}
```

**Smoke residue cleanup:** `DELETE FROM tenant_demo.svc_behavior_plans WHERE plan_type='BSP'` drops both smoke BSPs (CASCADE drops their goals + feedback). `DELETE FROM tenant_demo.svc_behavior_plan_goals WHERE goal_text LIKE 'SMOKE Step 5%'` drops the smoke goal added to the seeded BIP. `DELETE FROM tenant_demo.svc_bip_teacher_feedback WHERE submitted_at IS NOT NULL OR id NOT IN (oldest)` drops the smoke fresh request + Park request + the submitted seed row, then a re-INSERT recreates the seed pending feedback row (Hayes → Rivera, requested_at='2026-05-04 06:08:50+00') so the tenant is back to post-Step-3 seed shape: 1 BIP, 3 goals, 1 pending feedback, 0 submitted.

**Iteration issues caught and resolved during the build:**

1. **Unused `narrowEffectiveness` private method + `FeedbackEffectiveness` import** in `feedback.service.ts` — `tsc --strict` fired `TS6133 'narrowEffectiveness' is declared but its value is never read`. Removed the method + the unused import. Build clean on the second attempt.

**What's deferred to later steps:**

- Step 6 lands the `BehaviourNotificationConsumer` subscribing to all 4 Cycle 9 topics — `beh.incident.reported`, `beh.incident.resolved`, `beh.action.parent_notification_required`, `beh.bip.feedback_requested`. The Step 5 `requestFeedback` emit is now feeding `dev.beh.bip.feedback_requested` ready for the consumer to land. The Step 3 auto-task rule on this topic (with `target_role=NULL` + `recipientAccountId` fallback) will route the request as a TODO task on the teacher's list once the Cycle 7 TaskWorker is restarted to pick up the new rule.
- Out of scope this step (deferred): explicit `lastAssessedAt` override on goal PATCH (auto-bump-to-today is the dominant flow; counsellors can record historical assessment dates via direct SQL today); per-feedback comment thread (the schema doesn't model it — Phase 3 polish if needed); soft delete for behavior plans (admins delete only via direct SQL today; the `:id/expire` endpoint is the documented path forward for retiring a plan).

---

## Step 6 — Behaviour Notification Consumer

**Status:** DONE. New `apps/api/src/notifications/consumers/behaviour-notification.consumer.ts` wired into `NotificationsModule.providers` after `TicketNotificationConsumer`. Plus a small follow-on fix to `IncidentService` adding `sourceRefId` to both `beh.incident.reported` and `beh.incident.resolved` Kafka emits so the Cycle 7 TaskWorker's `pickSourceRefId` helper populates `source_ref_id` on the AUTO admin-review task. The Cycle 7 TaskWorker auto-discovers the two new `beh.*` rules at boot — TaskWorker subscription confirmed at `dev.beh.incident.reported, dev.beh.bip.feedback_requested` (11 topics total). Build clean, all subscriptions confirmed on boot, live smoke verified end-to-end on `tenant_demo`.

**Files:**

- `apps/api/src/notifications/consumers/behaviour-notification.consumer.ts` (new) — single consumer on group `behaviour-notification-consumer` subscribing to all 4 Cycle 9 topics. Reuses the standard `unwrapEnvelope` + `processWithIdempotency` claim-after-success pattern from `notification-consumer-base.ts`. Per-topic dispatcher in `fanOut()` routes to `fanOutIncidentReported` / `fanOutIncidentResolved` / `fanOutActionParentNotify` / `fanOutFeedbackRequested`.
- `apps/api/src/notifications/notifications.module.ts` — extended `providers` list with the new consumer.
- `apps/api/src/discipline/incident.service.ts` — added `sourceRefId: id` to both `beh.incident.reported` and `beh.incident.resolved` emits. Mirrors the Cycle 8 `tkt.ticket.assigned` convention so the TaskWorker's universal `sourceRefId` field populates `source_ref_id` on auto-tasks created from the seeded rule.

**Fan-out matrix:**

| Topic                                     | Recipients                                                                                                                                                                                                                                                                                                                             | Notification type                  | Self-suppress?                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beh.incident.reported`                   | All accounts holding `sch-001:admin` for the school via `iam_effective_access_cache` (same lookup as `AbsenceRequestNotificationConsumer`/`TicketNotificationConsumer`). Includes Platform Admins via the PLATFORM scope row.                                                                                                          | `behaviour.incident_reported`      | No — admins are notified even when an admin reports an incident.                                                                                                                                                           |
| `beh.action.parent_notification_required` | Iterate `payload.guardianAccountIds` — `ActionService.create` already resolved portal-enabled guardians via `sis_student_guardians` JOIN `sis_guardians` JOIN `platform_users` (`portal_access=true` AND non-NULL `platform_users.id`) at emit time. Empty array → log + drop (student has no portal-enabled guardians).               | `behaviour.action_assigned`        | n/a (parents never assign actions).                                                                                                                                                                                        |
| `beh.bip.feedback_requested`              | `payload.recipientAccountId` (FeedbackService pre-resolved the teacher's `platform_users.id` at emit time). Falls back to a tenant lookup `hr_employees → iam_person → platform_users` keyed on `payload.teacherId` if a future producer omits the field (defence in depth, mirrors Cycle 8 `tkt.ticket.assigned`).                    | `behaviour.bip_feedback_requested` | n/a (counsellor requests feedback from a different person).                                                                                                                                                                |
| `beh.incident.resolved`                   | Original reporter. Bridges `payload.reportedById` (an `hr_employees.id` since the schema's `reported_by` column references `hr_employees`) to `platform_users.id` via `hr_employees.person_id → iam_person.id → platform_users.person_id`. Drops if no portal account exists (e.g. a future scenario where the reporter has no login). | `behaviour.incident_resolved`      | **Yes.** When `payload.resolvedByAccountId === reporterAccountId` the consumer logs `Suppress beh.incident.resolved self-notification (reporter === resolver)` and drops the row. Mirrors Cycle 8 follow-up 2 for tickets. |

Every payload includes `deep_link` for the bell:

- `incident_reported` + `incident_resolved` → `/behaviour/<incidentId>` (forward-compat for the Step 7 admin queue detail).
- `action_assigned` → `/children/<studentId>/behaviour` (Step 9 parent route).
- `bip_feedback_requested` → `/behavior-plans/feedback` (Step 8 teacher pending queue).

**Auto-task wiring (already live via Step 3 + Cycle 7 TaskWorker):** the seeded auto-task rules in `tsk_auto_task_rules` for `beh.incident.reported` (target_role=SCHOOL_ADMIN, ADMINISTRATIVE/24h, title `Review incident: {student_name} — {category_name}`) and `beh.bip.feedback_requested` (target_role=NULL with worker `recipientAccountId` fallback, ADMINISTRATIVE/72h, title `BIP feedback requested: {student_name}`) feed the existing Cycle 7 TaskWorker. **No code change** in Step 6 for this — the worker auto-discovers `tsk_auto_task_rules.trigger_event_type` at boot. Confirmed live on the rebuild: `[TaskWorker] TaskWorker subscribed to 11 topic(s): … dev.beh.bip.feedback_requested, dev.beh.incident.reported …`. Adding new rules at runtime requires a worker restart per the documented Cycle 7 limitation; production deploys naturally restart so this is dev-only.

**Live verification on `tenant_demo` 2026-05-04** (8 scenarios + cleanup, all pass):

1. **S1 teacher POST incident** (Maya/Disrespect MEDIUM) → 2 admin queue rows in `behaviour.incident_reported` for `admin@` + `principal@` (both holding `sch-001:admin`). Both rows transition to SENT after the 10s NotificationDeliveryWorker tick.
2. **S2 admin POST Detention action** with `requires_parent_notification=true` → 1 row in `behaviour.action_assigned` for David Chen's parent account (the only portal-enabled guardian on Maya's `sis_student_guardians` rows). The payload's `guardianAccountIds` array was already populated at emit time so the consumer iterates it directly without a second DB read.
3. **S3 admin (NOT reporter) PATCH /resolve** → 1 row in `behaviour.incident_resolved` for Rivera's `teacher@` account (bridged from the `reported_by = Rivera` employee id via the `hr_employees → iam_person → platform_users` chain). Resolver was Sarah Mitchell so the self-suppress branch did NOT fire.
4. **S4 counsellor POST feedback request** for Park (VP) → 1 row in `behaviour.bip_feedback_requested` for Park's `vp@` account (FeedbackService's `recipientAccountId` was pre-populated at emit time and the consumer used it directly). Payload includes `student_name='Maya Chen'` + `plan_type='BIP'` so the bell can render context without a second round-trip.
5. **S5 Cycle 7 TaskWorker fan-out from `beh.incident.reported`** → 2 AUTO tasks landed on `admin@` + `principal@` to-do lists titled `Review incident: Maya Chen — Disrespect`, `due_at = now() + 24h`, `task_category=ADMINISTRATIVE`. After the IncidentService follow-on fix in this step the AUTO tasks now also carry `source_ref_id` matching the incident id (S8 below verified).
6. **S6 Cycle 7 TaskWorker fan-out from `beh.bip.feedback_requested`** → 1 AUTO task on Park's to-do list titled `BIP feedback requested: Maya Chen`, `source_ref_id` matching the feedback row id (FeedbackService already emits `sourceRefId` from Step 5 — no fix needed here).
7. **S7 self-resolve suppression keystone** — principal Sarah POSTs an incident (so `reported_by = Sarah`'s employee id which bridges to `principal@` account) and immediately PATCHes /resolve as the same admin. The `behaviour.incident_resolved` queue gets **0 rows** for this incident — the consumer's `if (resolvedByAccountId === reporterAccountId)` branch fires and logs the suppression. The `behaviour.incident_reported` event still queues 2 admin notifications (the reporter is one of them — the policy is admins are notified on report, but the reporter is suppressed only on resolve). Mirrors Cycle 8 follow-up 2 for tickets.
8. **S8 sourceRefId fix verification** — fresh incident POST after the IncidentService rebuild → AUTO task's `source_ref_id` now matches the incident id (`019df2d1-d726-…`) for both admin owners. Pre-fix tasks had empty `source_ref_id` because the worker's `pickSourceRefId` helper only looks for `sourceRefId` / `source_ref_id` / `assignmentId` / `gradeId` / `requestId` / `ticketId` / `ticket_id` and `incidentId` was not in the list.

**Iteration issues caught and resolved during the build:**

1. **`source_ref_id` missing on AUTO admin-review tasks** — caught during S5 inspection. The Cycle 7 TaskWorker's `pickSourceRefId` helper has a per-domain candidate list that does NOT include `incidentId`. Adding `sourceRefId: id` (universal escape hatch) to both `beh.incident.reported` and `beh.incident.resolved` emits in `IncidentService` lets the worker populate the column without a per-domain extension. Same precedent as Cycle 8 `tkt.ticket.assigned`. Verified after rebuild + reboot in S8.

**Smoke residue cleanup:** `DELETE FROM tenant_demo.sis_discipline_incidents WHERE description LIKE 'SMOKE Step 6%'` drops 3 smoke incidents (CASCADE drops their actions); 1 smoke pending feedback (Park request) deleted; all `behaviour.*` queue rows deleted; 15 AUTO tasks the worker created across all the test runs deleted. Tenant restored to post-Step-3 seed shape: 3 incidents, 2 actions, 1 BIP, 3 goals, 1 pending feedback, 0 behaviour notifications, 3 AUTO tasks (the seeded `cls.assignment.posted`-derived tasks for Maya — pre-existing from Cycle 7 Step 3).

**What's deferred to later steps:**

- Step 7 lands the staff Discipline UI (`/behaviour/report`, `/behaviour` queue, `/behaviour/:id` detail, admin `/behaviour/admin/categories`).
- Step 8 lands the BIP UI (`/students/:id/behaviour` summary, `/behavior-plans/:id` editor, `/behavior-plans/feedback` teacher pending queue).
- Step 9 lands the parent + student behaviour views, including `/children/:id/behaviour` with row-scoped read of the child's incidents (the deep_link populated by the action_assigned consumer points at this route).
- Out of scope this step (deferred): notification preference rows for the 4 new `behaviour.*` types (the `NotificationQueueService.enqueue()` defaults to IN_APP if no preference row exists, so the smoke worked without explicit prefs; future polish can extend `seed-messaging.ts` to seed per-persona preferences for the new types). Suppress-on-self-action for `behaviour.action_assigned` (today the consumer iterates `guardianAccountIds` blindly — there's no current scenario where a parent would be assigning their own child a disciplinary action, but a future polish could add the same self-suppress check the resolved-incident path uses).

---

## Step 7 — Discipline UI — Report Incident + Admin Queue

**Status:** DONE. New `Behaviour` launchpad tile gated on `beh-001:read` + 4 routes under `apps/web/src/app/(app)/behaviour/` + format helpers + 14 React Query hooks + extended NotificationBell descriptor for the 4 `behaviour.*` notification types. Web build clean on first try, all 4 routes ship at 7.58–10.5 kB First Load JS. **No backend changes** — the staff Discipline UI sits entirely on the 14 endpoints from Step 4.

**Files:**

- `apps/web/src/lib/types.ts` — appended Cycle 9 DTO surface: `Severity` + `IncidentStatus` const enums; `DisciplineCategoryDto` / `DisciplineActionTypeDto` / `DisciplineActionDto` / `DisciplineIncidentDto` (with `actions[]` inlined); 8 payload types (CreateIncident / Review / Resolve / CreateAction / UpdateAction / CreateCategory / UpdateCategory / CreateActionType / UpdateActionType); `ListIncidentsArgs`.
- `apps/web/src/lib/discipline-format.ts` — `SEVERITIES` + `INCIDENT_STATUSES` const arrays; label maps + pill class maps (severity: gray LOW / amber MEDIUM / orange HIGH / rose CRITICAL — same warming-tone progression as Cycle 8 ticket priority pills; status: rose OPEN / amber UNDER_REVIEW / emerald RESOLVED); `isIncidentLive` for the badge counter; `formatIncidentDate` / `formatIncidentDateTime` (handles YYYY-MM-DD without timezone-shift surprises by appending T00); `sortIncidents` comparator (severity desc, status asc, date desc); `studentName(inc)` composer.
- `apps/web/src/hooks/use-discipline.ts` — 14 hooks: `useDisciplineCategories` + `useDisciplineActionTypes` (5min stale), `useDisciplineIncidents` (30s stale + refetch on focus), `useDisciplineIncident`, `useDisciplineIncidentActions`, `useStudentsForReport` (60s stale, hits the row-scoped `/api/v1/students` endpoint), plus mutations: `useCreateIncident`, `useReviewIncident(id)`, `useResolveIncident(id)`, `useReopenIncident(id)`, `useAddAction(incidentId)`, `useUpdateAction(actionId)`, `useRemoveAction()`, plus admin catalogue mutations `useCreate/UpdateDisciplineCategory` and `useCreate/UpdateDisciplineActionType`. Mutations all invalidate the `['discipline']` key tree; lifecycle mutations also bump `['tasks']` + `['notifications']` since the Cycle 7 TaskWorker creates an admin-review AUTO task on `beh.incident.reported` and the Cycle 9 BehaviourNotificationConsumer enqueues IN_APP rows.
- `apps/web/src/components/shell/icons.tsx` — new `ShieldExclamationIcon` (Heroicons-style outline shield with exclamation mark inside, fits the discipline metaphor without doubling up on existing tile icons).
- `apps/web/src/components/shell/apps.tsx` — registered new `behaviour` AppKey + BadgeKey + tile entry gated on `beh-001:read` with `routePrefix: '/behaviour'` so all nested routes keep the tile lit. Description copy switches on `personType=GUARDIAN` ("Your child's incident history") so parents see a parent-flavoured tile when the launchpad renders.
- `apps/web/src/hooks/use-app-badges.ts` — extended `AppBadges` interface with `behaviour: number`; the inner `useDisciplineIncidents` query is gated on `beh-001:read` so a STUDENT (no read perm) never 403s when the launchpad mounts. Counter sums incidents with `isIncidentLive(status)` from the cached list.
- `apps/web/src/components/notifications/NotificationBell.tsx` — `iconFor()` returns `ShieldExclamationIcon` for any `behaviour.*` type; `colorFor()` returns `bg-orange-100 text-orange-700`; `describeNotification()` extended with 4 new cases: `behaviour.incident_reported`, `behaviour.action_assigned`, `behaviour.bip_feedback_requested`, `behaviour.incident_resolved` — each rendering a contextual title + subtitle from the Step 6 consumer payload shape (`student_name`, `category_name`, `severity`, `action_type_name`, `plan_type`, `requester_name`, `resolved_by_name`).

**4 new web routes:**

| Route                         | Size (First Load JS) | Gate                                    |
| ----------------------------- | -------------------- | --------------------------------------- |
| `/behaviour`                  | 7.58 kB / 113 kB     | `beh-001:read`                          |
| `/behaviour/report`           | 8.87 kB / 115 kB     | `beh-001:write`                         |
| `/behaviour/[id]`             | 10.5 kB / 116 kB     | `beh-001:read` (admin sees admin notes) |
| `/behaviour/admin/categories` | 9.01 kB / 115 kB     | `beh-001:admin` OR `sch-001:admin`      |

**`/behaviour`** (queue) — 5 filter chips (Live = OPEN+UNDER_REVIEW / Open / Under review / Resolved / All); per-row severity pill + status pill + date + action count + line-clamp-2 description preview + reporter name + location. Header carries a `Manage catalogue` admin-only quick-link and a `Report incident` button for anyone with `beh-001:write`. Empty state copy switches on the active chip ("No live incidents — report one if a behaviour issue needs attention."). Polls 30s + refetches on focus.

**`/behaviour/report`** — searchable student picker (filtered to caller's row-scope by hitting `/api/v1/students` which is already row-scoped at the backend); category dropdown sorted CRITICAL → LOW with severity pill + description hint when picked; date input + optional time; optional location; required description (4000-char counter); optional witnesses field. Submit POSTs `/discipline/incidents` and routes to `/behaviour/[id]` on success. Toast on success / error.

**`/behaviour/[id]`** — header card with severity + status pills + 3-cell metadata grid (Date / Location / Reported by); witnesses panel (amber) when populated; description panel (whitespace preserved); resolved-banner (emerald) when status=RESOLVED carrying the resolver name + timestamp. Admin-only action bar:

- OPEN → `Mark under review` (Modal with optional adminNotes textarea) + `Resolve` (Modal with optional adminNotes textarea — the reporter receives a notification on success)
- UNDER_REVIEW → `Resolve`
- RESOLVED → `Reopen` (window.confirm guard explaining the resolution timestamps will be cleared)

Admin-only `Admin notes` panel renders below the header card when `adminNotes !== null` — the API strips this field for non-managers via the Step 4 row-scope contract, so non-admin readers never see it. Actions section lists each consequence with action type + parent-notification pill (emerald when notified, amber when pending) + date range + notes + audit line; admin gets per-row `Mark parent notified` + `Remove` controls (Remove refused on RESOLVED incidents per the API). Add Action Modal (`size=lg`) accepts an action type dropdown filtered to active types with a "Notifies parent" hint when the type's `requiresParentNotification=true`, optional date range with client-side end>=start validation, optional notes (1000-char).

**`/behaviour/admin/categories`** — two parallel sections (Categories left, Action types right). Each row shows name + severity pill (categories) or "Notifies parent" pill (action types) + Inactive pill when soft-deactivated. `Add` buttons open a Modal (Edit modal pre-fills + adds an Active toggle). Admin can soft-deactivate via the Active toggle without losing the historical reference (the schema FKs into `sis_discipline_incidents` and `sis_discipline_actions` are NO ACTION on the catalogue side per Step 1). UNIQUE-violation 400s from the API surface as Toast errors.

**NotificationBell extension** — 4 new switch cases in `describeNotification()`:

- `behaviour.incident_reported` → title `"Incident reported: <studentName>"`, subtitle `"<category> · <severity>"`.
- `behaviour.action_assigned` → title `"<actionTypeName> assigned to <studentName>"`, subtitle `<categoryName>`. Renders for the parent's bell since the action.parent_notification_required fan-out targets portal-enabled guardians.
- `behaviour.bip_feedback_requested` → title `"<planType> feedback requested for <studentName>"`, subtitle `"From <requesterName>"`.
- `behaviour.incident_resolved` → title `"Incident resolved for <studentName>"`, subtitle `"By <resolvedByName>"`.

Icon for all 4 = `ShieldExclamationIcon`; colour = `bg-orange-100 text-orange-700`. Persona-aware deep_link on the consumer side already routes to the right surface (`/behaviour/<id>` for incidents, `/children/<id>/behaviour` for action_assigned which Step 9 will land, `/behavior-plans/feedback` for bip_feedback_requested which Step 8 will land).

**Build sizes (web, all 4 routes static-prerendered except `/behaviour/[id]` which is dynamic per the [id] convention):**

```
○ /behaviour                        7.58 kB / 113 kB
ƒ /behaviour/[id]                   10.5 kB / 116 kB
○ /behaviour/admin/categories       9.01 kB / 115 kB
○ /behaviour/report                 8.87 kB / 115 kB
```

**Iteration issues caught and resolved during the build:**

1. **Unused `useRouter` import** in `/behaviour/[id]/page.tsx` — TypeScript / Next-strict caught the unused binding. Removed both the import and the `const router = useRouter()` line; the page navigates via `<Link>` for the back arrow and the success path on review/resolve uses Toast + cache invalidation rather than a router push (the detail page is the success destination, so re-fetching on success is the right thing to do).

**What's deferred to later steps:**

- Step 8 lands the BIP UI (`/students/:id/behaviour` summary, `/behavior-plans/:id` editor, `/behavior-plans/feedback` teacher pending queue). Step 7 stops at the discipline surface; the `behaviour.bip_feedback_requested` deep_link points at `/behavior-plans/feedback` which Step 8 will create.
- Step 9 lands the parent + student behaviour views including `/children/:id/behaviour` (the deep_link for `behaviour.action_assigned` notifications is already wired but the page doesn't exist yet — bell click still navigates, the route returns a Next.js 404 until Step 9).
- Out of scope this step (deferred): bulk actions on the queue (per-row works for the demo); per-incident attachments (the schema doesn't model them — Phase 3 polish if needed); incident search across body text; admin notes inline-edit on the detail page (today admins append notes via the review/resolve modals — a dedicated edit field is a future polish); per-incident activity timeline (the schema has no activity log table for discipline; if needed the Step 4 IncidentService could land a `sis_discipline_activity` migration in a future polish cycle, mirroring the Cycle 8 `tkt_ticket_activity` precedent).

---

## Step 8 — Behaviour Plan UI — BIP Editor + Goals + Feedback

**Status:** DONE. 3 new routes + 14 BIP/Goal/Feedback hooks appended to `use-discipline.ts` + plan/goal/effectiveness pill maps in `discipline-format.ts` + 11 new DTO + payload types in `apps/web/src/lib/types.ts`. **No backend changes** — Step 8 sits entirely on the 14 endpoints from Step 5. Web build clean after one type-collision fix (renamed Cycle 9 `PlanStatus` + `PlanType` to `BehaviorPlanStatus` + `BehaviorPlanType` to avoid collision with the Cycle 6 payment-plan types of the same name).

**Files added:**

- `apps/web/src/app/(app)/students/[id]/behaviour/page.tsx` — student behaviour summary (entry point for staff; parents use the Step 9 `/children/[id]/behaviour` instead).
- `apps/web/src/app/(app)/behavior-plans/[id]/page.tsx` — BIP editor with editable strategies + goals table + feedback section + status transition bar.
- `apps/web/src/app/(app)/behavior-plans/feedback/page.tsx` — teacher's pending feedback queue with submit modal.

**Files modified:**

- `apps/web/src/lib/types.ts` — appended Cycle 9 Step 5 DTO surface: `BehaviorPlanType` + `BehaviorPlanStatus` + `GoalProgress` + `FeedbackEffectiveness` const enums; `GoalDto` / `BIPFeedbackDto` / `BehaviorPlanDto` (with `goals[]` and `feedback[]` inlined); 7 payload types (CreateBehaviorPlan / UpdateBehaviorPlan / CreateGoal / UpdateGoal / RequestFeedback / SubmitFeedback) + `ListBehaviorPlansArgs`. The `BIPFeedbackDto` carries optional `studentName` + `planType` for the pending-queue list endpoint (the Step 5 service inlines them via `JOIN svc_behavior_plans → sis_students → platform_students → iam_person`).
- `apps/web/src/lib/discipline-format.ts` — appended plan formatting: `PLAN_TYPES` + `PLAN_STATUSES` const arrays + label maps + status pill map (DRAFT gray / ACTIVE emerald / REVIEW amber / EXPIRED gray-strikethrough); `GOAL_PROGRESS_OPTIONS` + label/pill maps; `FEEDBACK_EFFECTIVENESS_OPTIONS` + label/pill maps.
- `apps/web/src/hooks/use-discipline.ts` — appended **14 BIP/Goal/Feedback hooks**: `useBehaviorPlans({studentId,status,planType})`, `useBehaviorPlan(id)`, `useCreateBehaviorPlan`, `useUpdateBehaviorPlan(id)`, `useActivateBehaviorPlan(id)`, `useExpireBehaviorPlan(id)`, `useAddGoal(planId)`, `useUpdateGoal(goalId, planIdForInvalidate?)`, `useDeleteGoal()`, `useFeedbackForPlan(planId)`, `useFeedbackPending()`, `useRequestFeedback(planId)`, `useSubmitFeedback(feedbackId)`. Mutations invalidate `['discipline', 'behavior-plans']` (and the per-id detail when known); `useRequestFeedback` also bumps `['notifications']` + `['tasks']` since the Step 5 `requestFeedback` emits `beh.bip.feedback_requested` which the Step 6 BehaviourNotificationConsumer fans out + the Cycle 7 TaskWorker turns into a TODO task on the recipient teacher's list.

**3 new web routes:**

| Route                      | Size (First Load JS) | Gate                                              |
| -------------------------- | -------------------- | ------------------------------------------------- |
| `/students/[id]/behaviour` | 8.72 kB / 117 kB     | `beh-001:read` (staff entry point)                |
| `/behavior-plans/[id]`     | 10.7 kB / 119 kB     | `beh-002:read` (writes gated on `beh-002:write`)  |
| `/behavior-plans/feedback` | 7.61 kB / 116 kB     | `beh-002:read` (counsellor sees all, teacher own) |

**`/students/[id]/behaviour`** (staff student-behaviour summary) — header card with student name + grade + "← Queue" link + "View student behaviour summary" deep-link target. Two-section grid:

- **Live incidents** — 4-cell severity stat panel (LOW gray / MEDIUM amber / HIGH orange / CRITICAL rose, count of OPEN+UNDER_REVIEW per severity); Recent incidents list (top 5, newest-first, click-through to `/behaviour/[id]`); All incidents link to `/behaviour?student=<id>` (forward-compat URL filter — the Step 7 queue page already takes `studentId` server-side).
- **Behaviour plans** — list of BIPs/BSPs/SAFETY_PLANs with status pill + plan type + review date + goal/feedback counts + creator. Click-through to `/behavior-plans/[id]`. Counsellor/admin see a **Create plan** button that opens a Modal pre-populated with `studentId`, plan type dropdown, review date (defaults to today + 30 days), and a multi-line target_behaviors textarea (one per line, at least one required). Submit POSTs to `/behavior-plans` and routes to the new plan's editor on success.

**`/behavior-plans/[id]`** (BIP editor) — the keystone Step 8 page. Header card with plan type pill + status pill + grade + 3-cell metadata grid (Review date, Created by, Source incident — when set, the source incident links back to `/behaviour/<incidentId>`). Counsellor/admin status transition bar:

- DRAFT → **Activate** button (emerald, with `window.confirm` warning about the partial UNIQUE keystone — "this will lock other ACTIVE plans of the same type on this student out via the partial UNIQUE keystone")
- ACTIVE → **Mark for review** (amber)
- REVIEW → **Back to draft** (gray)
- DRAFT/ACTIVE/REVIEW → **Expire** (rose, with confirm — "It will become read-only and the partial UNIQUE on ACTIVE plans will release")

EXPIRED plans render the page in read-only mode (no Edit / Add Goal / Request Feedback buttons; the Step 5 service refuses writes on EXPIRED plans). Three sections below the header:

- **Behaviours & strategies** — 3-column block listing target_behaviors / replacement_behaviors / reinforcement_strategies as bulleted lists. Edit modal (counsellor/admin, non-EXPIRED) opens a 4-field form (3 textareas, one item per line + a Review date input) and PATCHes the plan.
- **Goals** — count + Add goal button (Modal: goal_text + baseline + target + measurement). Per-row inline progress dropdown (NOT_STARTED → IN_PROGRESS → MET / NOT_MET) — the Step 5 service auto-bumps `last_assessed_at = CURRENT_DATE` on every transition away from NOT_STARTED. Per-row Remove button (refused on EXPIRED parent — handled at the API).
- **Teacher feedback** — list of feedback rows with effectiveness pill (Not effective rose / Somewhat effective amber / Effective emerald / Very effective dark emerald) + Pending/Submitted badge + classroom_observations + recommended_adjustments + strategies_observed list. Counsellor/admin **Request feedback** button opens a Modal with searchable employee picker (`useEmployees` from use-hr, search by name or email) and POSTs to `/behavior-plans/:id/feedback-requests`. The Step 5 partial UNIQUE pre-flight surfaces the existing pending id in a friendly Toast 400 if the counsellor double-requests.

**`/behavior-plans/feedback`** (teacher pending queue) — list of pending feedback rows with student name + plan type pill + Pending badge + requestedBy + requestedAt. Click a row → opens a `SubmitFeedbackModal` (size lg) that lazy-fetches the parent plan via `useBehaviorPlan(planId)` to render the **Strategies observed checklist** populated from `plan.reinforcementStrategies` so the teacher ticks which strategies they observed in the classroom rather than free-typing. Below the checklist: a 4-button effectiveness rating row (chip-style with Pill colour when active), classroom_observations textarea (4000-char), recommended_adjustments textarea (4000-char). Submit PATCHes `/bip-feedback/:id` and the Step 5 service stamps `submitted_at = now()` in the same UPDATE atomically (the partial UNIQUE on `WHERE submitted_at IS NULL` releases automatically). Toast on success / error.

**Cross-page navigation**:

- The bell's `behaviour.bip_feedback_requested` deep_link `/behavior-plans/feedback` (Step 6) now lands on a real route.
- The `/behaviour/[id]` admin-only "Create BIP from this incident" path is **deferred** — the plan calls it out and the schema's `source_incident_id` soft-ref column is in place; the Create plan modal on the student summary page covers the dominant flow, and a future polish step can add a per-incident Create-BIP shortcut.

**Iteration issues caught and resolved during the build:**

1. **`PlanStatus` name collision** — Cycle 6 Step 7 already exports `PlanStatus = 'ACTIVE' | 'COMPLETED' | 'DEFAULTED' | 'CANCELLED'` for payment plans. My Step 8 append redeclared the same name with `'DRAFT' | 'ACTIVE' | 'REVIEW' | 'EXPIRED'` and TypeScript silently let the first declaration win, so `p.status === 'EXPIRED'` failed type-check. Renamed the Cycle 9 types to `BehaviorPlanType` + `BehaviorPlanStatus` (and updated all references in `discipline-format.ts` and the page files). The `GoalProgress` and `FeedbackEffectiveness` types were unique so they kept their original names.
2. **`PageHeader.description` prop is `string`** (not ReactNode) — passed JSX which failed TS2322 `Type 'Element' is not assignable to type 'string'`. Restructured to render the deep-link as a separate `<p>` below the header instead of inside the description prop. Same pattern Cycle 8 documented for `/helpdesk/admin/sla` chip strip.

**What's deferred to later steps:**

- Step 9 lands the parent + student behaviour views (`/children/[id]/behaviour`). The bell's `behaviour.action_assigned` deep_link points there; today the route is a Next.js 404 until Step 9 ships.
- Step 10 lands the vertical-slice CAT walking the full behaviour lifecycle from incident → action → BIP → feedback end-to-end.
- Out of scope this step (deferred): per-goal `lastAssessedAt` override (the auto-bump on progress transitions handles 99% of the case; manual override would be a future polish endpoint); inline edit on the goals table (today the only inline mutation is the progress dropdown — full text edit is via Add Goal + remove pattern); request-feedback bulk picker (today admins request one teacher at a time); BIP attachments (`plan_document_s3_key` is on the schema but no upload UI today — Phase 3 polish).

---

## Step 9 — Parent + Student Behaviour Views

**Status:** DONE. New parent route `/children/[id]/behaviour` + Behaviour link on the parent dashboard ChildCard + staff student-summary deep-link from `/behaviour/[id]`. **Backend extension:** `BehaviorPlanService.buildVisibility` gains a GUARDIAN branch + new `canSeeFeedback(actor)` helper that strips the `feedback[]` array for parents (private teacher observations stay staff-side per the Step 9 visibility contract). Parent IAM grant extended with `BEH-002:read`. Live-verified end-to-end: parent sees own child's BIP with goals but feedback empty; parent filtering by another student's id returns 0; admin still sees full feedback.

**Files added:**

- `apps/web/src/app/(app)/children/[id]/behaviour/page.tsx` — parent incident history + active BIP summary (read-only).

**Files modified:**

- `apps/api/src/behavior-plans/behavior-plan.service.ts` — `buildVisibility` adds a GUARDIAN branch joining through `sis_student_guardians + sis_guardians ON g.person_id = actor.personId` (mirrors the IncidentService Step 4 pattern). New private `canSeeFeedback(actor)` helper returns `false` for `personType='GUARDIAN'`; the `list` and `loadOrFail` paths gate the inlined feedback array on this flag so parents see `feedback: []` without the service touching the underlying `svc_bip_teacher_feedback` rows.
- `packages/database/src/seed-iam.ts` — Parent role gains `BEH-002:read` with comment explaining the row-scope contract + the feedback-strip rule. Cache rebuild reports Parent **21 perms** (was 20).
- `apps/web/src/app/(app)/children/page.tsx` — ChildCard gains a `Behaviour` button alongside the existing Attendance / Grades / Schedule / Report absence row.
- `apps/web/src/app/(app)/behaviour/[id]/page.tsx` — staff incident detail header gains a "View student summary →" link routing to `/students/[id]/behaviour` (the Step 8 staff entry point) so staff can pivot from an incident to the full behaviour summary.

**`/children/[id]/behaviour`** (parent route) — gated on `beh-001:read` (parent grant from Step 4) plus an inner `canReadPlans` flag on `beh-002:read` (Step 9 grant) for the BIP section. Three sections:

- **Header card** with child name + grade + #studentNumber + Back-to-dashboard link.
- **Incidents by severity** stat panel: 4 cells (LOW gray / MEDIUM amber / HIGH orange / CRITICAL rose) showing total counts across **all** incidents on file (parents see the full history including resolved ones, not just live, so they have context for context-shifting categories like "Tardiness escalating to Disrespect").
- **Recent incidents** list (top 10, newest-first) with per-row severity + status pills + date + location + category + description + Actions taken sub-list. Each action shows the action_type name + Notified/Pending pill (with the notification date if Notified) + date range when set. **`adminNotes` is naturally absent** because the Step 4 `IncidentService.buildVisibility` returns `isManager:false` for guardians and `stripForNonManager(dto)` zeros the column to `null` server-side.
- **Active behaviour plans** summary: per ACTIVE/REVIEW plan, plan type pill + status pill + review date + goals progress summary ("X of Y goals met · N in progress") + per-goal dot-bullet list keyed by progress colour. Optional **details disclosure** ("What we're working on") expands to show the plan's `targetBehaviors` + `replacementBehaviors` + `reinforcementStrategies` so parents can support the plan at home — these are the positive-support fields, not the private teacher observations. The **`feedback[]` array is empty** in the parent's payload because the `canSeeFeedback` server-side strip reduces it to `[]` before serialisation.

**`/behaviour/[id]` staff link** — header `actions` slot now carries a horizontal pair: "View student summary →" (campus-700, links to `/students/[id]/behaviour` from Step 8) + "← Queue" (gray). Staff land on an incident from a notification or the queue, then pivot to the full behaviour summary in one click.

**ChildCard** (parent dashboard `/children`) — the action row now includes a 5th button `Behaviour` between Schedule and Report-absence. Same `flex-1` styling as the others. The button is unconditionally visible — the destination page applies `beh-001:read` gating, so a parent who somehow lacks the permission sees a friendly Access-required empty state rather than a 404 / 403.

**Live verification on `tenant_demo` 2026-05-04** (4 scenarios, all pass):

1. **S1 parent GET /behavior-plans?studentId=`<Maya>`** → 1 plan returned with `goals: 3` rows + `feedback: 0` (server stripped the seed pending feedback). Confirms the GUARDIAN row-scope path AND the canSeeFeedback strip both fire.
2. **S2 parent GET /behavior-plans?studentId=`<Ethan>`** (Ethan Rodriguez — not David Chen's child) → 0 rows. Confirms the row-scope predicate binds to the parent's own children only via the `sis_student_guardians + sis_guardians WHERE g.person_id = actor.personId` JOIN.
3. **S3 parent GET /behavior-plans** (no filter) → 1 row, the seed BIP for Maya with `studentFirstName: 'Maya'`. Confirms the default unfiltered list scopes to the parent's children automatically.
4. **S4 admin GET /behavior-plans/`<plan>`** → still sees 3 goals + 1 feedback row. Confirms `canSeeFeedback` returns true for non-GUARDIAN callers (admins / counsellors).

**Build sizes (web):**

```
ƒ /children/[id]/behaviour       7.64 kB / 116 kB
ƒ /students/[id]/behaviour       8.73 kB / 117 kB  (Step 8, unchanged)
ƒ /behaviour/[id]                9.17 kB / 118 kB  (Step 7, +0.13 kB for the staff summary link)
```

**Iteration issues caught and resolved during the build:** None — the GUARDIAN branch + canSeeFeedback strip plus the parent-route page all built clean on the first attempt; the live API smoke confirmed the row-scope works as designed.

**What's deferred to later steps:**

- Step 10 lands the vertical-slice CAT walking the full behaviour lifecycle from incident → action → BIP → feedback end-to-end.
- Out of scope this step (deferred): student self-view of their own behaviour record (the plan calls this out — students never see discipline records directly, and BIP visibility for the student themselves is a future trauma-informed UX decision; the seed has Maya's BIP visible to her parent and her teachers but not to Maya); per-action FERPA audit log (admin queries are already auditable via the existing tenant query log; a dedicated audit trail for sensitive conduct data would mirror `msg_admin_access_log` from Cycle 3 — Phase 3 polish if needed); cross-school behaviour history for transfer students (the schema scopes everything to the current tenant; a future Wave 3 cycle would need a `platform.iam_person`-keyed read across tenants).

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE. `docs/cycle9-cat-script.md` ships the reproducible end-to-end walkthrough. Live-verified on `tenant_demo` 2026-05-04 against the Step 9 build. The CAT walks all 10 plan scenarios end-to-end with full live verification (psql + curl + jq blocks documented inline) plus the schema preamble (8 checks) and a cleanup script that restores the tenant to post-Step-3 seed shape.

**The CAT walks the full vertical slice on `tenant_demo`:**

1. **Schema preamble (8 checks)** — confirms 139 tenant logical base tables / 4 sis*discipline*\_ + 3 svc\_\_ tables / 0 cross-schema FKs / 5 + 6 = 11 intra-tenant FKs / Step 3 seed counts (6 categories / 5 action types / 3 incidents / 2 actions / 1 ACTIVE BIP / 3 goals / 1 pending feedback) / 2 `beh.*` auto-task rules in `tsk_auto_task_rules`.
2. **S1 — Rivera reports a verbal-altercation incident for Maya / Disrespect MEDIUM.** Status=OPEN, reporter=James Rivera. Step 6 BehaviourNotificationConsumer fans out 2 admin queue rows; Cycle 7 TaskWorker creates 2 AUTO `Review incident: Maya Chen — Disrespect` tasks with `source_ref_id` matching the incident id.
3. **S2 — Sarah reviews → status flips OPEN → UNDER_REVIEW.** AdminNotes appended visibly to the admin payload via locked-row tenant transaction.
4. **S3 — Sarah assigns Detention** (action_type with `requires_parent_notification=true`). Step 6 fans out 1 row to David Chen (Maya's only portal-enabled guardian); `payload.guardianAccountIds` was resolved at emit time by `ActionService.create` via `sis_student_guardians + sis_guardians + platform_users` JOIN with `portal_access=true` AND non-NULL `platform_users.id`.
5. **S4 — Sarah resolves → status=RESOLVED.** `resolved_chk` invariant satisfied (`resolved_by` + `resolved_at` populated in same UPDATE). Step 6 fans out 1 row to Rivera (admin resolver ≠ reporter, so the self-suppress branch correctly stays OFF).
6. **S5 — Parent visibility keystone.** David Chen GET /discipline/incidents?studentId=Maya returns Maya's 3 incidents (2 seeded + 1 new CAT). Ethan Rodriguez's seeded Tardiness OPEN incident correctly filtered out by the IncidentService GUARDIAN row-scope. **Every row carries `adminNotes: None`** — the Step 4 `stripForNonManager(dto)` helper zeros the column server-side. Action notification status (Notified / Pending) visible to the parent.
7. **S6a/b — Partial UNIQUE keystone on `(student_id, plan_type) WHERE status='ACTIVE'`.** Hayes POSTs a 2nd BIP for Maya as DRAFT (allowed — multiple DRAFTs of same type per student are fine; partial UNIQUE only enforces uniqueness within `status='ACTIVE'`); PATCH `/:id/activate` returns 400 with `"Student already has an ACTIVE BIP plan (019df0f5-c5d9-…). Expire that plan before activating a new one."` carrying the existing ACTIVE plan id.
8. **S6c — Different plan_type coexists.** Hayes creates a fresh BSP and activates it cleanly; Maya now has 2 ACTIVE plans (BIP + BSP) of different types.
9. **S7 — Goal progress auto-bump.** Hayes adds 3 goals; bumps progress on goal #1 to IN_PROGRESS. Response shows `lastAssessedAt: 2026-05-04` (today, auto-bumped server-side via `last_assessed_at = CURRENT_DATE` in the same UPDATE).
10. **S8 — Hayes requests feedback from Rivera.** Step 5 emits `beh.bip.feedback_requested` outside the tenant tx with `recipientAccountId` pre-resolved. Step 6 enqueues IN_APP notification on Rivera; Cycle 7 TaskWorker writes a TODO `BIP feedback requested: Maya Chen` task on Rivera's list with `source_ref_id` matching the feedback row id (the FeedbackService emit includes `sourceRefId: id`).
11. **S9 — Rivera submits feedback.** PATCH /bip-feedback/:id with SOMEWHAT_EFFECTIVE rating + observations + adjustments. Response shows `submittedAt: 2026-05-04T13:27:43`. Pending count drops back to 1 (the seed feedback row remains pending; the partial UNIQUE on `(plan_id, teacher_id) WHERE submitted_at IS NULL` released atomically when `submitted_at` was stamped).
12. **S10 — 5 permission denials:**
    - Student GET /discipline/incidents → 403 (no beh-001:read)
    - Parent GET /discipline/incidents/:id → 200 with `adminNotes: null` (Step 4 stripForNonManager strip)
    - Teacher POST /discipline/incidents/:id/actions → 403 (admin-only at the service layer)
    - Student PATCH /bip-feedback/:id → 403 (no beh-002:read)
    - Parent POST /behavior-plans → 403 (parents read but never write — counsellor/admin only)

**Live verification trail:** every scenario captured with the actual API responses + DB state + queue rows + AUTO task rows. The CAT script reproduces them via `bash` + `curl` + `python3 -c` + `psql`, so a future reviewer or operator can re-run the entire flow on a fresh tenant in under 5 minutes.

**Cleanup script** restores `tenant_demo` to the post-Step-3 seed shape: 6 categories / 5 action types / 3 incidents (1 OPEN/1 UNDER_REVIEW/1 RESOLVED) / 2 actions (1 with parent_notified=true) / 1 ACTIVE BIP / 3 goals / 1 pending feedback / 0 behaviour.\* queue rows. Verified live post-cleanup: `(incidents, actions, plans, goals, fb, pending_fb, beh_queue) = (3, 2, 1, 3, 1, 1, 0)`.

**Cycle 9 ships clean to the post-cycle architecture review.** Reviewer attention items (non-blocking, Phase 2 polish) recorded at the bottom of the CAT script — Cycle 7 TaskWorker fallback validation, per-incident attachments + activity log, BehaviourTaskCompletionConsumer (mirrors Cycle 8's TicketTaskCompletionConsumer), FERPA admin-access log, student self-view (deferred to a future trauma-informed UX cycle), cross-school behaviour history (deferred to Wave 3).

---

## Closing — Cycle 9 Complete

After Cycle 9 closes (post-cycle architecture review APPROVED), CampusOS will have shipped its first Wave 2 cycle and the complete behaviour management lifecycle:

- **Cycles 0–8** — Wave 1 core operational platform (SIS / Classroom / Communications / HR / Scheduling / Enrollment / Payments / Profile-Household / Tasks-Approvals / Service Tickets).
- **Cycle 9** — Wave 2 Student Services first cycle. M20 SIS Discipline (4 tables — categories / action types / incidents / actions) + M27 Behaviour Plans (3 tables — BIPs / goals / feedback). 28 endpoints, 4 Kafka emit topics, 1 Kafka consumer, 7 web routes (4 staff + 3 BIP + 1 parent), full row-level visibility model with `admin_notes` and `feedback[]` stripped at the service layer for non-managers.

Every domain module is connected via Kafka events. The Cycle 7 TaskWorker auto-discovers the new `beh.*` rules at boot. Every persona has a discipline surface scoped to their role. Every parent has a read-only behaviour view of their own children. Tagged `cycle9-complete` after this commit.

The next cycle in Wave 2 is TBD per the Wave 2 plan once authored — candidates include M30 Student Health, M70 Counselling, M50 Library, M60 Athletics & Clubs.

---

## Operational notes

- **Migration discipline.** Cycle 9 follows the splitter trap rule from Cycles 4–8: no `;` inside any string literal, default expression, COMMENT, or CHECK predicate. Block-comment header (no `--` line comments at file head — the splitter cuts the first statement otherwise). `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency.
- **Cycle 4 dependency.** The `sis_discipline_incidents.reported_by → hr_employees(id)` DB-enforced FK requires Step 0 of Cycle 4 to be in place (the bridge that re-pointed staff identity from `iam_person.id` to `hr_employees.id`). Cycles 0–8 are complete, so this is a settled dependency.
- **Cycle 7 dependency.** The Step 3 `beh.incident.reported` + `beh.bip.feedback_requested` auto-task rules feed the Cycle 7 Task Worker. The worker auto-discovers `tsk_auto_task_rules.trigger_event_type` at boot and subscribes to the matching env-prefixed Kafka topic. Adding new rules at runtime requires a worker restart (documented limitation from Cycle 7 Step 4) — we will run `seed:behaviour` then bounce the API in dev. Production deploys naturally restart the worker so this is not an ongoing concern.
- **Permission catalogue.** `BEH-001` ("Behaviour & Discipline") and `BEH-002` ("Behaviour Intervention Plans") both need to land in `packages/database/data/permissions.json` — TBD whether they're already present from earlier cycles or added in Step 3. The Step 3 seed will reconcile and rebuild the cache.
- **No new ADR.** Cycle 9 is implemented entirely under existing ADRs (ADR-001 / ADR-020 soft cross-schema FKs, ADR-010 immutable audit log discipline, ADR-011 sole-writer convention).

---

## Closing pre-conditions for the cycle

When all 10 steps are done, the closing handoff entry will record:

- **Build clean.** `pnpm --filter @campusos/api build` + `pnpm --filter @campusos/web build` + `pnpm format:check` all clean.
- **Tag.** `cycle9-complete` tag on the closeout commit.
- **Post-cycle architecture review.** A new `REVIEW-CYCLE9-CHATGPT.md` mirrors the prior cycle template; Round 1 + Round 2 verdicts inline. `cycle9-approved` tag after the final APPROVED verdict.
- **Wave 2 progress.** Cycle 9 is the first cycle of Wave 2 (Student Services). The closing CLAUDE.md update marks Cycle 9 done and queues Cycle 10 (Health & Counselling, sequencing TBD per the Wave 2 plan once authored).
