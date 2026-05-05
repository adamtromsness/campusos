# Cycle 11.1 Handoff — Wellbeing Check-Ins

**Status:** Cycle 11.1 **COMPLETE — Round 2 review fixes landed.** REVIEW-CYCLE11.1-CHATGPT Round 2 against `b58e591` returned REJECT pending 2 BLOCKING + 4 MAJOR; all 6 fixes verified live on `tenant_demo` 2026-05-05 in the Round 2 closeout commit. See `REVIEW-CYCLE11.1-CHATGPT.md` for the triage table + per-fix verification trail. Open follow-up carried to Wave 2 Phase 2 backlog: dedicated aggregate-trend endpoint for teachers (`GET /counselling/wellbeing/trends`) returning pre-aggregated per-template completion counts + anonymised per-domain mean scores. All 8 steps done. **Schema + seed + backend + counsellor UI + the first student-input surface in CampusOS + vertical-slice CAT** all live on `tenant_demo`. Step 8 ships `docs/cycle11.1-cat-script.md` — the reproducible end-to-end vertical-slice walkthrough; 8-check schema preamble + 10 plan scenarios verified live on `tenant_demo` 2026-05-05 against the Step 7 build. Two ADR-057 wire envelopes captured live on `dev.svc.wellbeing.alert.created` (S4 — Maya's WANTS*TO_TALK with `autoEscalate=false` + S5 — Ethan's SELF_HARM_INDICATOR with `autoEscalate=true` — the unconditional auto-escalation keystone). Cleanup section anchors on `response_id` linking back to the CAT template (NOT a date filter — so the seeded WANTS_TO_TALK alert stays intact even when the CAT runs on the same day as the seed); restores `tenant_demo` to the post-Step-3 seed shape exactly (`templates=1 questions=5 deployments=1 checkins=2 responses=5 alerts=1`). Final Cycle 11.1 totals: \*\*6 svc_wellbeing*\* base tables** (tenant base table count 169 → **175**); **13 intra-tenant FKs**; **0 cross-schema FKs**; **20 endpoints** across 4 services + 4 controllers; **1 Kafka emit topic** (`svc.wellbeing.alert.created`); **1 new IAM grant on existing COU-004** function (catalogue stays at 450 — Cycle 11.1 reuses the COU-004 entry); **3 student-facing web routes** (the first student-input surface) + **4 counsellor web routes** + **18 React Query hooks**. Tagged `cycle11.1-complete` after CI green. Steps 1–2 land 6 wellbeing tables (13 intra-tenant FKs, 0 cross-schema FKs); tenant base table count grew 169 → **175**. Step 3 plants the seeded template + check-ins + alert; COU-004 grants extended (Teacher 47 / Student 20 / Staff 49 / Parent denied / Admin 450). Step 4 lands WellbeingModule (2 services + 13 endpoints under `/counselling/wellbeing/`) including the keystone deployment-activate endpoint that resolves target audiences and bulk-creates check-in rows. **Step 5 lands the student-facing surface — CheckinService + AlertService — adding 2 services + 2 controllers + 7 endpoints + the alert-evaluation logic + the `svc.wellbeing.alert.created` Kafka emit**. WellbeingModule now ships **4 services + 4 controllers + 20 endpoints + 1 Kafka emit topic**. Live verification on `tenant_demo` 2026-05-05 — 33 assertions across 7 scenarios all green including 3 ADR-057 envelopes captured live on `dev.svc.wellbeing.alert.created` (2× WANTS_TO_TALK with autoEscalate=false + 1× SELF_HARM_INDICATOR with **autoEscalate=true** — the auto-escalation keystone). Steps 6 (counsellor wellbeing UI), 7 (student wellbeing UI — first student-input surface), and 8 (vertical-slice integration test) remain. Cycle 11.1 ships the 6 wellbeing check-in tables deferred from Cycle 11 — the M27 Student Services Domain 5. The vertical slice involves the **first student-input surface in CampusOS**: a counsellor creates a "Weekly Emotional Check-In" template + deploys it to Maya's caseload + Maya completes the check-in via a dedicated student UI + the platform auto-flags concerning responses + creates an alert with a 5-type enum + the counsellor triages the alert. The 5 alert types are FEELS_UNSAFE, WANTS_TO_TALK, SIGNIFICANT_SCORE_DROP, PERSISTENT_LOW_SCORE, and SELF_HARM_INDICATOR. **SELF_HARM_INDICATOR auto-escalates to administrators\*\* via the `svc.wellbeing.alert.created` Kafka emit (the unconditional auto-escalation is not configurable by the school).

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle11.1-implementation-plan.html`
**Vertical-slice deliverable:** Hayes (counsellor) creates "Weekly Emotional Check-In" template with 5 questions across Emotional + Safety domains (3 SCALE_1_5, 1 YES_NO "Do you want to talk to someone?", 1 EMOJI_SCALE) → deploys it to Maya's caseload (CASELOAD targeting) → platform generates a PENDING check-in for Maya → Maya opens the student wellbeing page, sees the pending check-in, and submits responses (Safety score=2, "Do you want to talk?"=YES) → application logic flags the check-in for follow-up and creates a WANTS_TO_TALK alert → Hayes sees the alert in the alert queue, acknowledges it, and documents follow-up → admin views the school-wide wellbeing dashboard showing aggregated domain scores and alert counts → Maya sees her own responses on the student portal → Rivera (teacher) sees only "1 check-in completed this week" aggregated trend (no individual responses).

This document tracks the Cycle 11.1 build at the same level of detail as `HANDOFF-CYCLE9.md` through `HANDOFF-CYCLE11.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                         | Status   |
| ---- | ------------------------------------------------------------- | -------- |
| 1    | Wellbeing Survey Schema — Templates + Questions + Deployments | **DONE** |
| 2    | Check-In + Responses + Alerts Schema                          | **DONE** |
| 3    | Seed Data — Template, Deployment, Check-In, Responses, Alert  | **DONE** |
| 4    | Survey Template + Deployment NestJS Module                    | **DONE** |
| 5    | Check-In + Response + Alert NestJS Module                     | **DONE** |
| 6    | Counsellor Wellbeing UI — Templates + Deployments + Alerts    | **DONE** |
| 7    | Student Wellbeing UI — Check-In Completion                    | **DONE** |
| 8    | Vertical Slice Integration Test                               | **DONE** |

---

## What this cycle adds on top of Cycle 11

Cycle 11.1 is a tightly-scoped completion of the M27 Student Services module that Cycles 9 + 11 began. Cycle 9 shipped 3 BIP tables; Cycle 11 shipped 14 counselling / MTSS / care / mandatory-reporting tables; Cycle 11.1 ships the final 6 wellbeing check-in tables.

- **Wellbeing Survey Infrastructure (M27 Domain 5, 3 tables in Step 1).** `svc_wellbeing_survey_templates` is the counsellor-authored reusable survey definition — frequency_recommendation 4-value enum (DAILY / WEEKLY / MONTHLY / AS_NEEDED), `is_active` flag for soft deactivation, UNIQUE(school_id, name). `svc_wellbeing_questions` are the ordered questions per template — question_type 5-value enum (SCALE_1_5 / SCALE_1_10 / YES_NO / FREE_TEXT / EMOJI_SCALE), domain 5-value enum (ACADEMIC / SOCIAL / EMOTIONAL / PHYSICAL / SAFETY). The SAFETY domain is the trigger surface for the Step 5 alert evaluation. CASCADE on parent template delete since question rows are meaningless without their template; the safe path is template deactivation via `is_active=false` rather than hard delete. `svc_wellbeing_deployments` is the per-deployment instance targeting a student audience — target_type 5-value enum (CASELOAD / CLASS / YEAR_GROUP / SCHOOL / CUSTOM_LIST), `target_ids UUID[]` (null for CASELOAD which auto-resolves the deploying counsellor's active caseload at activation time, otherwise carries class / year-group / student ids per the target_type), status 4-value enum (SCHEDULED / ACTIVE / COMPLETED / CANCELLED). The Step 4 service generates `svc_wellbeing_checkins` rows for all targeted students on the SCHEDULED → ACTIVE transition.
- **Check-In + Responses + Alerts (M27 Domain 5, 3 tables in Step 2).** `svc_wellbeing_checkins` is the student-facing check-in instance with `flagged_for_follow_up` flag set by the Step 5 alert evaluation logic; `completed_at NULL` means PENDING — the Step 7 student UI renders these as the to-do list. `svc_wellbeing_responses` is the per-question response (numeric_response for SCALE / EMOJI / YES_NO mapped to 1/0; text_response for FREE_TEXT) with `response_shape_chk` requiring at least one of the two columns populated. `svc_wellbeing_alerts` is the 5-type alert system — FEELS_UNSAFE, WANTS_TO_TALK, SIGNIFICANT_SCORE_DROP, PERSISTENT_LOW_SCORE, SELF_HARM_INDICATOR — with NEW → ACKNOWLEDGED → IN_PROGRESS → RESOLVED lifecycle and a strict multi-column `acknowledged_chk` lockstep keystone (NEW requires both ack columns NULL; non-NEW requires both NOT NULL).
- **Permission gate.** New `COU-004` function (read + write + admin tiers). `:read` is granted to teachers (aggregated trends only — service strips individual data), counsellors / admin (full detail), and **students for own check-ins / own responses only**. Parents are NOT granted COU-004 — wellbeing data is student-counsellor confidential per the plan.
- **First student-input surface in CampusOS.** Cycle 11.1 ships the first surface where a student directly inputs data into the platform. The Step 7 student UI renders pending check-ins, runs the question-by-question completion flow, and submits responses to the Step 5 backend.
- **Cycle 3 NotificationConsumer wiring deferred.** Step 5 emits `svc.wellbeing.alert.created` on Kafka. The Cycle 3 NotificationConsumer wiring (so the SELF_HARM_INDICATOR auto-escalation actually delivers IN_APP + EMAIL to the school administrator) is documented but deferred — emit lands cleanly, no consumer subscribes yet.
- **Score-drop detection deferred.** SIGNIFICANT_SCORE_DROP and PERSISTENT_LOW_SCORE alerts require historical comparison across deployments. Cycle 11.1 implements FEELS_UNSAFE, WANTS_TO_TALK, and SELF_HARM_INDICATOR — the 3 alert types that fire on single-response evaluation. The 2 deferred types are scaffolded in the schema (the `alert_type` CHECK includes all 5) but no service generates them this cycle.
- **Response RANGE-partitioning by month deferred.** ERD v11 tags `svc_wellbeing_responses` for monthly partitioning. Cycle 11.1 ships it as a simple table; partitioning is a Phase 3 ops concern when data volume warrants it.
- **Scheduled deployment auto-activation deferred.** Manual activation only this cycle. A cron / worker that flips SCHEDULED → ACTIVE at `deploy_at` is a future enhancement.

What does not change: every existing module continues to function. Cycle 11.1 is purely additive on the request path.

---

## Step 1 — Wellbeing Survey Schema (Templates + Questions + Deployments)

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (zero new applies on the second run; tenant base table count stable at 172). Splitter-clean — Python state-machine audit (block-comment + line-comment + single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators. **Three stray semicolons caught + fixed pre-provision** (all inside `COMMENT ON ...IS '...'` strings in the first draft); rewritten with periods so the splitter never tripped. **Thirteenth migration in a row to clear the splitter trap on first attempt** (Cycles 4–11.1 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/039_svc_wellbeing_templates.sql`.

**Tables (3):**

1. **`svc_wellbeing_survey_templates`** — Counsellor-authored reusable survey definitions. `school_id UUID NOT NULL` (soft to `platform.schools(id)` per ADR-001/020), `name TEXT NOT NULL`, `description TEXT` nullable, `frequency_recommendation TEXT NOT NULL` 4-value CHECK `DAILY / WEEKLY / MONTHLY / AS_NEEDED`, `is_active BOOLEAN NOT NULL DEFAULT true`, `created_by UUID NOT NULL FK to hr_employees(id) NO ACTION` (templates carry audit value beyond the authoring counsellor leaving — admin must reassign or archive before the employee row can be removed). UNIQUE INDEX `(school_id, name)`. INDEX `(school_id, is_active)` for the counsellor list hot path. Templates are deactivated rather than hard-deleted once they have associated deployments — the `is_active` flag drives counsellor visibility while historical deployment rows retain their `template_id` FK.

2. **`svc_wellbeing_questions`** — Ordered questions belonging to a template. `template_id UUID NOT NULL FK to svc_wellbeing_survey_templates(id) ON DELETE CASCADE` (question rows are meaningless without their template; the safe path is template deactivation; hard-delete only happens when there are no responses against any of the template questions). `question_text TEXT NOT NULL`, `question_type TEXT NOT NULL` 5-value CHECK `SCALE_1_5 / SCALE_1_10 / YES_NO / FREE_TEXT / EMOJI_SCALE`, `domain TEXT NOT NULL` 5-value CHECK `ACADEMIC / SOCIAL / EMOTIONAL / PHYSICAL / SAFETY`, `sort_order INT NOT NULL >= 0` CHECK. INDEX `(template_id, sort_order)` for ordered render. **The SAFETY domain is the trigger surface for the Step 5 alert evaluation**: SAFETY+SCALE_1_5 with `numeric_response<=1` fires SELF_HARM_INDICATOR. SAFETY+YES_NO with `numeric_response=1` fires WANTS_TO_TALK. EMOTIONAL+YES_NO with `numeric_response=1` also fires WANTS_TO_TALK. ACADEMIC, SOCIAL, and PHYSICAL questions inform the dashboard rollup but do not trigger alerts on single-response evaluation.

3. **`svc_wellbeing_deployments`** — Per-deployment instance of a template targeted at a student audience. `school_id UUID NOT NULL` (soft), `template_id UUID NOT NULL FK to svc_wellbeing_survey_templates(id) NO ACTION` (refuses hard-delete of a template with historical deployments — the safe path is `is_active=false`), `deployed_by UUID NOT NULL FK to hr_employees(id) NO ACTION`, `deploy_at TIMESTAMPTZ NOT NULL`, `expires_at TIMESTAMPTZ` nullable, `target_type TEXT NOT NULL` 5-value CHECK `CASELOAD / CLASS / YEAR_GROUP / SCHOOL / CUSTOM_LIST`, `target_ids UUID[]` nullable (null for CASELOAD which auto-targets the deploying counsellor's active caseload at activation time, otherwise carries class / year-group / student ids per the target_type), `status TEXT NOT NULL DEFAULT 'SCHEDULED'` 4-value CHECK `SCHEDULED / ACTIVE / COMPLETED / CANCELLED`, `total_targeted INT >= 0` nullable, `total_completed INT >= 0` nullable, `window_chk` ensures `expires_at > deploy_at` when set. INDEX `(school_id, status)` for admin / counsellor active-deployments list. INDEX `(template_id)` for template usage lookups. INDEX `(deployed_by, status)` for the counsellor's "my deployments" view. **On the SCHEDULED → ACTIVE transition the Step 4 DeploymentService is the sole writer** that resolves the target audience into student ids and bulk-inserts `svc_wellbeing_checkins` rows with `completed_at=null`.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `svc_wellbeing_survey_templates.school_id → platform.schools(id)`
- `svc_wellbeing_deployments.school_id → platform.schools(id)`

**FK summary — 4 new intra-tenant DB-enforced FKs:**

| FK                                                                           | Action    |
| ---------------------------------------------------------------------------- | --------- |
| `svc_wellbeing_survey_templates.created_by → hr_employees(id)`               | NO ACTION |
| `svc_wellbeing_questions.template_id → svc_wellbeing_survey_templates(id)`   | CASCADE   |
| `svc_wellbeing_deployments.template_id → svc_wellbeing_survey_templates(id)` | NO ACTION |
| `svc_wellbeing_deployments.deployed_by → hr_employees(id)`                   | NO ACTION |

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 169 → **172** (3 new logical base tables).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 16 assertions, all green):**

1. **T1 happy path** — INSERT 1 template + 2 questions + 1 deployment all succeed.
2. **T2 frequency_recommendation_chk** — rejects `BOGUS`.
3. **T3 question_type_chk** — rejects `BOGUS`.
4. **T4 domain_chk** — rejects `BOGUS`.
5. **T5 sort_chk** — rejects `sort_order=-1`.
6. **T6 deployment target_type_chk** — rejects `BOGUS`.
7. **T7 deployment status_chk** — rejects `BOGUS`.
8. **T8 deployment window_chk** — rejects `expires_at < deploy_at`.
9. **T9 deployment targeted_chk** — rejects `total_targeted=-1`.
10. **T10 UNIQUE(school_id, name)** — rejects duplicate template name in same school.
11. **T11 FK rejection** on bogus `svc_wellbeing_questions.template_id`.
12. **T12 FK rejection** on bogus `svc_wellbeing_deployments.template_id`.
13. **T13 FK rejection** on bogus `svc_wellbeing_survey_templates.created_by`.
14. **T14 CASCADE** on template delete drops 2 questions in one statement (before=2, after=0).
15. **T15 NO ACTION** on `svc_wellbeing_deployments.template_id` — refuses template delete while a deployment row references it.
16. **T16 pg_constraint catalog readout** confirms all 4 FK delete actions exactly as documented (NO ACTION × 3, CASCADE × 1).

Idempotent re-provision verified on `tenant_demo` (zero new applies on second run; tenant base table count stable at 172). Both `tenant_demo` and `tenant_test` provisioned cleanly.

**Step 1 verified end-to-end. Ready for Step 2.**

---

## Step 2 — Check-In + Responses + Alerts Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-05. Idempotent re-provision verified (the tail `ALTER TABLE DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT` block correctly refreshes `svc_wellbeing_alerts_acknowledged_chk` on re-runs without erroring; tenant base table count stable at 175). Splitter-clean — Python state-machine audit confirmed zero `;` outside legitimate statement terminators on the first attempt. **Fourteenth migration in a row to clear the splitter trap on first try** (Cycles 4–11.1 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/040_svc_wellbeing_checkins.sql`.

**Tables (3):**

1. **`svc_wellbeing_checkins`** — One row per (student, deployment) check-in instance, or ad-hoc when `deployment_id` is null. `school_id UUID NOT NULL` (soft to `platform.schools(id)`), `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE`, `template_id UUID NOT NULL FK to svc_wellbeing_survey_templates(id) NO ACTION` (templates carry audit value beyond a check-in being archived; the safe path is template deactivation), `deployment_id UUID FK to svc_wellbeing_deployments(id) ON DELETE SET NULL` nullable (null for ad-hoc check-ins; SET NULL preserves the audit even when a deployment is hard-deleted), `completed_at TIMESTAMPTZ` nullable (NULL means PENDING — the Step 7 student UI renders these as the to-do list), `flagged_for_follow_up BOOLEAN NOT NULL DEFAULT false` (set by the Step 5 alert evaluation logic when responses match a trigger), `assigned_counselor_id UUID FK to hr_employees(id) ON DELETE SET NULL` nullable. **4 indexes:** `(student_id, completed_at DESC)` for own-history reads; partial INDEX `(flagged_for_follow_up, completed_at) WHERE flagged_for_follow_up=true` — the counsellor follow-up queue hot path; partial INDEX `(deployment_id, completed_at) WHERE deployment_id IS NOT NULL` — deployment progress reads; partial INDEX `(assigned_counselor_id, completed_at DESC) WHERE assigned_counselor_id IS NOT NULL` — counsellor's own-assigned check-ins.

2. **`svc_wellbeing_responses`** — Per-question response within a check-in. `checkin_id UUID NOT NULL FK to svc_wellbeing_checkins(id) ON DELETE CASCADE` (responses meaningless without check-in), `question_id UUID NOT NULL FK to svc_wellbeing_questions(id) NO ACTION` (the Step 4 service blocks question delete when any response references it; the schema-side NO ACTION is the safety net), `numeric_response SMALLINT` nullable (carries SCALE_1_5 1..5 / SCALE_1_10 1..10 / EMOJI_SCALE 1..5 / YES_NO mapped to 1 for YES and 0 for NO), `text_response TEXT` nullable (FREE_TEXT answers; max 500 chars enforced at the API layer), `response_shape_chk` requires at least one of `numeric_response` or `text_response` to be populated. **UNIQUE INDEX `(checkin_id, question_id)`** — one response per question per check-in. INDEX `(question_id)` for the future "most-flagged-question" rollup.

3. **`svc_wellbeing_alerts`** — 5-type alert system. `student_id UUID NOT NULL FK to sis_students(id) ON DELETE CASCADE`, `response_id UUID NOT NULL FK to svc_wellbeing_responses(id) ON DELETE CASCADE` (alert meaningless without the originating response — and CASCADE chains correctly when a check-in is deleted: response goes via checkin CASCADE → alert goes via response CASCADE), `alert_type TEXT NOT NULL` 5-value CHECK `FEELS_UNSAFE / WANTS_TO_TALK / SIGNIFICANT_SCORE_DROP / PERSISTENT_LOW_SCORE / SELF_HARM_INDICATOR`, `status TEXT NOT NULL DEFAULT 'NEW'` 4-value CHECK `NEW / ACKNOWLEDGED / IN_PROGRESS / RESOLVED`, `acknowledged_by UUID FK to hr_employees(id) ON DELETE SET NULL` nullable, `acknowledged_at TIMESTAMPTZ` nullable, `resolution_notes TEXT` nullable. **Multi-column `acknowledged_chk` keystone** strictly pins the lockstep: `NEW` requires both `acknowledged_by` AND `acknowledged_at` to be NULL; any non-NEW status (ACKNOWLEDGED / IN_PROGRESS / RESOLVED) requires both to be NOT NULL — the Step 5 service stamps both columns atomically on the NEW → ACKNOWLEDGED transition. **3 indexes:** `(student_id, status)`, partial `(status, created_at DESC) WHERE status IN ('NEW','ACKNOWLEDGED','IN_PROGRESS')` — the open-alerts queue, INDEX `(response_id)` for response → alert lookups. **SELF_HARM_INDICATOR auto-escalates** to administrators via the Step 5 `svc.wellbeing.alert.created` Kafka emit (the unconditional auto-escalation is not configurable by the school).

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `svc_wellbeing_checkins.school_id → platform.schools(id)`

**FK summary — 9 new intra-tenant DB-enforced FKs:**

| FK                                                                        | Action    |
| ------------------------------------------------------------------------- | --------- |
| `svc_wellbeing_checkins.student_id → sis_students(id)`                    | CASCADE   |
| `svc_wellbeing_checkins.template_id → svc_wellbeing_survey_templates(id)` | NO ACTION |
| `svc_wellbeing_checkins.deployment_id → svc_wellbeing_deployments(id)`    | SET NULL  |
| `svc_wellbeing_checkins.assigned_counselor_id → hr_employees(id)`         | SET NULL  |
| `svc_wellbeing_responses.checkin_id → svc_wellbeing_checkins(id)`         | CASCADE   |
| `svc_wellbeing_responses.question_id → svc_wellbeing_questions(id)`       | NO ACTION |
| `svc_wellbeing_alerts.student_id → sis_students(id)`                      | CASCADE   |
| `svc_wellbeing_alerts.response_id → svc_wellbeing_responses(id)`          | CASCADE   |
| `svc_wellbeing_alerts.acknowledged_by → hr_employees(id)`                 | SET NULL  |

0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 172 → **175** (3 new logical base tables). **Cycle 11.1 schema phase complete: 6 tables across migrations 039 + 040, 13 intra-tenant FKs (4 + 9), 0 cross-schema FKs.**

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 17 assertions, all green):**

1. **T1 happy path** — INSERT 1 template + 2 questions + 1 deployment + 1 check-in + 2 responses + 1 WANTS_TO_TALK alert all succeed.
2. **T2 response_shape_chk** — rejects empty response (numeric_response NULL AND text_response NULL).
3. **T3 response_shape_chk happy path** — accepts text-only response (FREE_TEXT shape).
4. **T4 alert_type_chk** — rejects `BOGUS`.
5. **T5 alert status_chk** — rejects `BOGUS`.
6. **T6 acknowledged_chk** — rejects NEW status with `acknowledged_by` populated (the looser version of this constraint slipped through; tightened to strict lockstep via tail `DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT` block).
7. **T7 acknowledged_chk** — rejects ACKNOWLEDGED without `acknowledged_by`.
8. **T8 acknowledged_chk happy path** — NEW → ACKNOWLEDGED with both fields stamped atomically.
9. **T9 UNIQUE(checkin_id, question_id)** — rejects duplicate response for the same (check-in, question) pair.
10. **T10 FK rejection** on bogus `svc_wellbeing_checkins.student_id`.
11. **T11 FK rejection** on bogus `svc_wellbeing_responses.checkin_id`.
12. **T12 FK rejection** on bogus `svc_wellbeing_responses.question_id`.
13. **T13 NO ACTION** on `svc_wellbeing_responses.question_id` — refuses question delete while a response exists.
14. **T14 NO ACTION** on `svc_wellbeing_checkins.template_id` — refuses template delete while a check-in exists.
15. **T15 CASCADE chain** — DELETE check-in drops 2 responses; the alert referencing the safety response also drops via the response CASCADE (responses before=2, after=0; alerts after=0 cleanly).
16. **T16 SET NULL on deployment delete** — DELETE deployment leaves check-in row intact with `deployment_id=NULL`.
17. **T17 pg_constraint catalog readout** confirms all 9 FK delete actions: CASCADE × 4 (`checkins.student_id`, `responses.checkin_id`, `alerts.student_id`, `alerts.response_id`); NO ACTION × 2 (`checkins.template_id`, `responses.question_id`); SET NULL × 3 (`checkins.deployment_id`, `checkins.assigned_counselor_id`, `alerts.acknowledged_by`).

**Iteration issue caught + fixed:** the first draft of `acknowledged_chk` was `(status='NEW') OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)` — which accepted NEW with `acknowledged_by` populated because the first branch passed. T6 caught it. Tightened to strict lockstep `(status='NEW' AND ack IS NULL AND at IS NULL) OR (status<>'NEW' AND ack IS NOT NULL AND at IS NOT NULL)` and added an idempotent `ALTER TABLE DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT` tail block so re-runs against an existing tenant pick up the tightened predicate without manual intervention. The DROP IF EXISTS + ADD pattern is splitter-safe and is a no-op on a fresh provision since `CREATE TABLE` already installed the tightened version.

Idempotent re-provision verified on both `tenant_demo` and `tenant_test` (the `ALTER` tail block correctly drops and re-adds the constraint without erroring; tenant base table count stable at 175).

**Step 2 verified end-to-end. Ready for Step 3.**

---

## Step 3 — Seed Data + COU-004 IAM Grants

**Status:** DONE. New `packages/database/src/seed-wellbeing.ts` (idempotent, gated on `svc_wellbeing_survey_templates` row count for the demo school) wired as `seed:wellbeing` in `package.json`. `seed-iam.ts` extended with COU-004 grants across Teacher / Student / Staff (Parent denied per the plan). Live verification on `tenant_demo` 2026-05-05 — seed planted cleanly, idempotent re-run is a no-op, IAM cache rebuilt with the new grants reflected.

**Seed sections (6):**

A. **1 survey template:** "Weekly Emotional Check-In" by Hayes (counsellor), `frequency_recommendation=WEEKLY`, `is_active=true`, description spelling out the WANTS_TO_TALK trigger semantics for Q3.

B. **5 questions** in `sort_order` (each row carries `template_id` + `question_text` + `question_type` + `domain` + `sort_order`):

- Q1 EMOTIONAL / SCALE_1_5 "How are you feeling today?"
- Q2 SOCIAL / SCALE_1_5 "Do you feel connected to your classmates?"
- Q3 SAFETY / YES_NO "Do you want to talk to someone about something?" — **the alert trigger** (Step 5 evaluation: SAFETY+YES_NO with `numeric_response=1` fires WANTS_TO_TALK)
- Q4 EMOTIONAL / EMOJI_SCALE "How was your week overall?"
- Q5 ACADEMIC / SCALE_1_5 "How confident do you feel about your schoolwork?"

C. **1 deployment:** `target_type='CUSTOM_LIST'` with `target_ids=[Maya, Ethan]` (the plan describes CASELOAD targeting which auto-resolves to Hayes's caseload; the seed uses CUSTOM_LIST so the deployment can carry both Maya and Ethan to exercise the multi-student deployment shape that the dashboard rollup needs), `status='ACTIVE'`, `deploy_at` last week, `total_targeted=2`, `total_completed=1`.

D. **2 check-ins** linked to the deployment:

- Maya: `completed_at` 5 days ago, `flagged_for_follow_up=true`, `assigned_counselor_id=Hayes` — represents the Q3 YES alert outcome.
- Ethan: `completed_at=NULL` (PENDING) — demonstrates the Step 7 student UI to-do list state. `assigned_counselor_id=Hayes`.

E. **5 responses** for Maya's completed check-in (one per question, all populating `numeric_response`):

- Q1=3 (mid-range emotional)
- Q2=4 (connected socially)
- Q3=1 (YES — wants to talk; the alert trigger response, captured to a variable so the alert row can FK it)
- Q4=3 (mid emoji)
- Q5=4 (confident academically)

F. **1 alert:** `alert_type='WANTS_TO_TALK'`, `student_id=Maya`, `response_id` linked to Maya's Q3 YES response, `status='ACKNOWLEDGED'`, `acknowledged_by=Hayes`, `acknowledged_at` 4 days ago, `resolution_notes` "Scheduled a 1:1 session with Maya to discuss what's on her mind. Will follow up after the session and update the alert status to RESOLVED.". The acknowledged-state lockstep `acknowledged_chk` is satisfied (status≠NEW + both ack columns populated).

**`seed-iam.ts` extensions (3 role updates):**

- **Teacher** (line 222 block): added `'COU-004': ['read']`. Comment explains teachers see aggregated trends only — the Step 5 service strips individual responses + alert details for non-counsellor readers.
- **Student** (Student role block): added `'COU-004': ['read']`. Comment explains this is the **first student-input permission** — students see own pending check-ins + own response history; row scope at the Step 5 service binds them to their own student_id; students never see alert status or `flagged_for_follow_up`.
- **Staff** (Staff role block, end of COU section): added `'COU-004': ['read', 'write']`. Comment explains counsellors create templates, deploy to audiences, view full check-in detail (responses + flagged status + alert lifecycle), and triage alerts. Admin tier reached via everyFunction.
- **Parent** — intentionally NOT granted any COU-004 tier per the plan ("wellbeing data is student-counsellor confidential").

**Live verification on `tenant_demo` 2026-05-05:**

- Seed run logs all 6 sections cleanly with row-by-row confirmation. Re-run logs `svc_wellbeing_survey_templates already populated for demo school — skipping` with no INSERTs.
- Idempotency gate confirmed (count check on `svc_wellbeing_survey_templates` for the demo school).
- `seed-iam.ts` re-run reports newly-added counts: Teacher +1, Student +1, Staff +2 (3 role-permission rows added; admin/principal already covered by everyFunction).
- IAM cache rebuilt: 7 account-scope pairs — admin/principal **450**, teacher **47** (+1), student **20** (+1), parent **23** (unchanged), vp/counsellor **49** (+2).
- COU-004 grant distribution verified via direct query against `iam_effective_access_cache`:

| persona                   | cou-004:read | cou-004:write | cou-004:admin |
| ------------------------- | ------------ | ------------- | ------------- |
| admin@ (Platform Admin)   | ✓            | ✓             | ✓             |
| principal@ (School Admin) | ✓            | ✓             | ✓             |
| vp@ (Staff)               | ✓            | ✓             | —             |
| counsellor@ (Staff)       | ✓            | ✓             | —             |
| teacher@                  | ✓            | —             | —             |
| student@                  | ✓            | —             | —             |
| **parent@ (denied)**      | —            | —             | —             |

- Final seed counts on `tenant_demo`: templates=1, questions=5, deployments=1, checkins=2 (1 completed + 1 pending), checkins_flagged=1, responses=5, alerts=1 (1 ACKNOWLEDGED).

**Step 3 verified end-to-end. Ready for Step 4 (Survey Template + Deployment NestJS module).**

---

## Step 4 — Survey Template + Deployment NestJS Module

**Status:** DONE. New module at `apps/api/src/wellbeing/` with 2 services + 2 controllers + DTO module + WellbeingModule wired into AppModule between CounsellingModule and the global guards. **13 endpoints** under the `/counselling/wellbeing/` URL prefix. Build clean (`pnpm --filter @campusos/api build` → `nest build` succeeds). Live verification on `tenant_demo` 2026-05-05 (24 assertions across 6 scenarios all green).

**Module structure:**

```
apps/api/src/wellbeing/
├── dto/wellbeing.dto.ts              # 5 enum const arrays + 8 DTO classes
├── survey-template.service.ts         # Template + question CRUD
├── survey-template.controller.ts      # 7 endpoints
├── deployment.service.ts              # Deployment lifecycle + the audience-resolve keystone
├── deployment.controller.ts           # 6 endpoints
└── wellbeing.module.ts                # Wires TenantModule + IamModule + KafkaModule
```

**13 endpoints (all under `/counselling/wellbeing/` prefix):**

| Verb   | Path                        | Permission      | Notes                                                                               |
| ------ | --------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| GET    | `/templates`                | `cou-004:read`  | Active templates only by default; `?includeInactive=true` returns deactivated rows. |
| GET    | `/templates/:id`            | `cou-004:read`  | With `questions[]` inlined ordered by `sort_order`.                                 |
| POST   | `/templates`                | `cou-004:write` | Counsellor or admin. UNIQUE(school, name) catch surfaces 400.                       |
| PATCH  | `/templates/:id`            | `cou-004:write` | Update name / description / frequency / `isActive`. Soft-deactivate path.           |
| POST   | `/templates/:id/questions`  | `cou-004:write` | Append a question.                                                                  |
| PATCH  | `/questions/:id`            | `cou-004:write` | Update question text / type / domain / sort.                                        |
| DELETE | `/questions/:id`            | `cou-004:write` | 400 when responses reference it; 204 on success.                                    |
| GET    | `/deployments`              | `cou-004:read`  | Counsellors see own (deployed_by=me); admins see all. Filters: status, templateId.  |
| GET    | `/deployments/:id`          | `cou-004:read`  | With completionRate inlined.                                                        |
| POST   | `/deployments`              | `cou-004:write` | Validates template + target shape. Defaults to SCHEDULED.                           |
| PATCH  | `/deployments/:id/activate` | `cou-004:write` | **KEYSTONE.** Resolves audience + bulk-creates check-in rows.                       |
| PATCH  | `/deployments/:id/complete` | `cou-004:write` | ACTIVE → COMPLETED.                                                                 |
| PATCH  | `/deployments/:id/cancel`   | `cou-004:write` | SCHEDULED or ACTIVE → CANCELLED.                                                    |

**Service contracts:**

- **`SurveyTemplateService`** — Counsellor scope = admin OR holds `cou-004:write` (the canonical counsellor signal — IAM seed grants `cou-004:write` only to Staff + Admin, not to Teacher/Student). `create` runs template INSERT + question fan-out in one tenant tx; UNIQUE(school_id, name) violation surfaces "A wellbeing survey template named '<name>' already exists in this school" with 400. `patch` locks the row inside `executeInTenantTransaction` per the convention. `addQuestion` uses single-statement context. `patchQuestion` does dynamic SET-clause builder. `deleteQuestion` runs a service-side pre-check counting `svc_wellbeing_responses` rows for the question — refuses with a friendly 400 carrying the response count when any reference exists; the schema-side NO ACTION FK is the safety net. Public helper `loadActiveOrFail(id)` throws on missing template / inactive / no questions — used by `DeploymentService.create` to validate the template at deployment time.

- **`DeploymentService`** — Visibility model: admin sees all; counsellor (STAFF + employeeId) sees own deployments (`deployed_by = me`); anyone else sees no rows. `create` validates the template via `SurveyTemplateService.loadActiveOrFail` + validates the target shape (CASELOAD / SCHOOL must omit targetIds; CLASS / YEAR_GROUP / CUSTOM_LIST require a non-empty UUID array) + validates the time window (`expiresAt > deployAt` if set). **`activate` is the keystone**: locks the deployment row with `SELECT … FOR UPDATE` inside `executeInTenantTransaction`, validates status=SCHEDULED, calls `resolveAudience(tx, schoolId, targetType, targetIds, deployedBy)` to materialise a flat distinct list of `sis_students.id` values, bulk-INSERTs `svc_wellbeing_checkins` rows (one per student, `completed_at=NULL` = PENDING, `assigned_counselor_id` = activator's `employeeId`), then UPDATEs the deployment to `status='ACTIVE'` + `total_targeted=<count>` in the same tx. Returns `{deployment, checkinsCreated}`. `complete` and `cancel` use a shared `transitionStatus` helper with the locked-row pattern + per-target allowed-from list.

- **`resolveAudience` audience resolution**:
  - **CASELOAD** → `SELECT DISTINCT student_id FROM svc_caseloads WHERE counselor_id = <deployer> AND status='ACTIVE'`. The CASELOAD shape is the canonical counsellor case.
  - **SCHOOL** → `SELECT DISTINCT id FROM sis_students WHERE status='ACTIVE'`.
  - **CLASS** → `SELECT DISTINCT student_id FROM sis_enrollments WHERE class_id = ANY(target_ids) AND status='ACTIVE'`.
  - **CUSTOM_LIST** → `SELECT DISTINCT id FROM sis_students WHERE id = ANY(target_ids)` (validates every supplied id exists in this tenant; missing ids silently drop out of the result).
  - **YEAR_GROUP** → 400 "deferred to a future cycle. Use CUSTOM_LIST with the resolved student ids for now." The schema column carries grade-level UUIDs but `sis_students` keys grade as a string; the resolution path needs a future helper.

**DTO module shapes** (per `apps/api/src/wellbeing/dto/wellbeing.dto.ts`):

- **5 enum const arrays** with `as const` typing: `FREQUENCY_RECOMMENDATIONS` (4), `QUESTION_TYPES` (5), `WELLBEING_DOMAINS` (5), `DEPLOYMENT_TARGET_TYPES` (5), `DEPLOYMENT_STATUSES` (4).
- **8 DTO classes**: `CreateQuestionInputDto` + `CreateSurveyTemplateDto` + `UpdateSurveyTemplateDto` + `AddQuestionDto` + `UpdateQuestionDto` + `WellbeingQuestionResponseDto` + `SurveyTemplateResponseDto` + `CreateDeploymentDto` + `ListDeploymentsQueryDto` + `DeploymentResponseDto` + `ActivateDeploymentResponseDto`. Validators use `class-validator` with `IsIn` arrays for the enums + `ValidateNested` + `Type` for the nested questions array on `CreateSurveyTemplateDto`.

**Live verification on `tenant_demo` 2026-05-05 (24 assertions across 6 scenarios all green):**

- **R1 reads.** Counsellor / admin / teacher / student all GET `/templates` 200 with the seeded template visible (count=1). Parent GET `/templates` 403 (gate; parent NOT granted COU-004 per Step 3). Counsellor GET `/templates/:id` returns name='Weekly Emotional Check-In', `qcount=5`, `createdByName='Marcus Hayes'`.
- **R2 POST template.** Teacher POST 403 (service-layer counsellor scope check — teacher holds `cou-004:read` but not `cou-004:write`). Parent POST 403 (gate). Counsellor POST returns 201 with `id` + 2 questions inlined. Counsellor POST duplicate name returns 400 with the friendly UNIQUE catch.
- **R3 PATCH + question CRUD.** Counsellor PATCH `isActive=false` round-trips. Counsellor POST `/templates/:id/questions` adds a question. Counsellor PATCH `/questions/:id` updates text + sort_order. Counsellor DELETE `/questions/:id` returns 204 when no responses reference it. Counsellor DELETE seeded Q3 (which has 1 response from Maya) returns 400 with the service-side refusal message.
- **R4 deployments.** Counsellor GET `/deployments` returns 1 (the seeded deployment, `deployed_by=Hayes`). VP GET `/deployments` returns 0 (counsellor row-scope filters out deployments VP didn't deploy). Admin GET `/deployments` returns 1 (admin sees all). Counsellor POST CASELOAD with targetIds → 400 (shape check). Counsellor POST CUSTOM_LIST without targetIds → 400. Counsellor POST window violation (expiresAt < deployAt) → 400. Counsellor POST CASELOAD deployment 201 with status=SCHEDULED.
- **R5 keystone — activate.** Counsellor PATCH `/deployments/:id/activate` returns `{deployment.status='ACTIVE', deployment.totalTargeted=1, checkinsCreated=1}`. The new check-in row is verified planted with `completed_at IS NULL` (PENDING) and `assigned_counselor_id=Hayes`. Re-activate returns 400 ("only SCHEDULED can activate" — terminal state guard).
- **R6 complete + cancel.** Counsellor PATCH `/complete` flips ACTIVE → COMPLETED. New SCHEDULED deployment + counsellor PATCH `/cancel` flips SCHEDULED → CANCELLED. Re-cancel returns 400 (terminal state guard).

**Iteration issue caught + fixed:** unused `schoolId` parameter on `DeploymentService.resolveAudience` triggered TS6133 strict-mode error. Renamed to `_schoolId` to satisfy the convention; the parameter remains in the signature so a future audience-resolution shape (e.g. `YEAR_GROUP` joining through `sis_students` keyed on `school_id`) can use it without a breaking change.

**Cleanup script** restores `tenant_demo` to the post-Step-3 seed shape exactly: drops the 2 smoke deployments + their check-ins, drops the smoke template + its questions. Final counts confirmed: tpls=1, qs=5, deps=1, ckins=2, resps=5, alerts=1.

**Step 4 verified end-to-end. Ready for Step 5 (CheckInService + AlertService — the student-facing submit path + alert evaluation logic + svc.wellbeing.alert.created Kafka emit).**

---

## Step 5 — Check-In + Response + Alert NestJS Module

**Status:** DONE. Two new services (`CheckinService`, `AlertService`) + two new controllers + DTO module extension + 7 new endpoints + 1 Kafka emit topic (`svc.wellbeing.alert.created`) + the per-response alert-evaluation logic. WellbeingModule now ships **4 services + 4 controllers + 20 endpoints**. Build clean. Live verification on `tenant_demo` 2026-05-05 (33 assertions across 7 scenarios all green; 3 ADR-057 envelopes captured live on `dev.svc.wellbeing.alert.created`).

**Module additions:**

```
apps/api/src/wellbeing/
├── checkin.service.ts                 # NEW — list / getById / submit (student-facing keystone)
├── checkin.controller.ts              # NEW — 3 endpoints
├── alert.service.ts                   # NEW — list / getById / acknowledge / resolve
├── alert.controller.ts                # NEW — 4 endpoints
├── dto/wellbeing.dto.ts                # extended with alert + check-in DTOs (5 enums + 7 classes)
└── wellbeing.module.ts                 # registers the 2 new services + 2 controllers
```

**7 new endpoints (cycle running total: 20):**

| Verb  | Path                                            | Permission      | Notes                                                                                 |
| ----- | ----------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| GET   | `/counselling/wellbeing/checkins`               | `cou-004:read`  | Admin all; counsellor caseload-linked; student own; teacher stripped (aggregated).    |
| GET   | `/counselling/wellbeing/checkins/:id`           | `cou-004:read`  | With responses inlined. Teacher 403 with redirect-to-trends message.                  |
| POST  | `/counselling/wellbeing/checkins/:id/submit`    | `cou-004:read`  | **STUDENT-FACING KEYSTONE** — bulk-INSERT responses + alert evaluation + Kafka emit.  |
| GET   | `/counselling/wellbeing/alerts`                 | `cou-004:read`  | Counsellor + admin only at the service layer. Severity-sorted, filters status / type. |
| GET   | `/counselling/wellbeing/alerts/:id`             | `cou-004:read`  | With response + question inlined for the queue UI.                                    |
| PATCH | `/counselling/wellbeing/alerts/:id/acknowledge` | `cou-004:write` | NEW → ACKNOWLEDGED. Stamps ack columns atomically per the lockstep CHECK.             |
| PATCH | `/counselling/wellbeing/alerts/:id/resolve`     | `cou-004:write` | Any non-RESOLVED → RESOLVED with required notes. Fast-path NEW→RESOLVED.              |

**Alert evaluation logic — per-response trigger** (`evaluateResponse(domain, questionType, numeric)` in `checkin.service.ts`). Precedence order — SELF_HARM_INDICATOR takes precedence over FEELS_UNSAFE on the same response so a single SAFETY+SCALE_1_5+numeric=1 row creates one alert, not two:

1. **SELF_HARM_INDICATOR** — SAFETY + SCALE_1_5 + `numeric=1` (the absolute-lowest rating on the 1–5 scale; **auto-escalates to admin** via `autoEscalate=true` in the Kafka payload).
2. **FEELS_UNSAFE** — SAFETY + (SCALE_1_5 with `numeric=2` OR SCALE_1_10 with `numeric≤2`). The "low but not critical" band — flag the response without firing the auto-escalate path.
3. **WANTS_TO_TALK** — SAFETY or EMOTIONAL + YES_NO + `numeric=1` (the YES branch).

SIGNIFICANT_SCORE_DROP and PERSISTENT_LOW_SCORE require historical comparison across deployments — the schema accepts them but no service generates them this cycle (deferred per the plan).

**Service contracts:**

- **`CheckinService`** — Counsellor scope check via the canonical `cou-004:write` test (admin OR Staff). `resolveCallerStudentId(actor)` resolves `actor.personId` → `platform_students` → `sis_students` for STUDENT personas. **`list` four-branch visibility model**: admin sees all; counsellor (non-admin Staff) sees check-ins where `assigned_counselor_id=me OR student_id IN (active caseloads)`; student sees own (`student_id=resolved-id`); non-counsellor STAFF (teacher) sees the same rows but **stripped** (`stripCheckinForTeacher` clears studentId / studentName / assignedCounselorId / assignedCounselorName / flaggedForFollowUp so teachers see "1 of 1 completed" trend without per-student detail). **`getById` fires the teacher 403 BEFORE `loadOrFail`** so teachers get the clear redirect message instead of a generic 404 from the row-scope filter. **`submit` is the keystone**: pre-tx validation loads the check-in + every template question, validates input shape (every question has a response, no foreign questionIds, response_shape numeric-or-text), then inside `executeInTenantTransaction` locks the check-in row with `SELECT FOR UPDATE`, bulk-INSERTs `svc_wellbeing_responses` (capturing `responseId` per question for the alert FK), runs `evaluateResponse(...)` per response and collects matching triggers, stamps `completed_at = now()` + `flagged_for_follow_up = (triggers.length > 0)` on the check-in, INSERTs alert rows for every trigger, and bumps the deployment's `total_completed` counter. Emits `svc.wellbeing.alert.created` per fired alert AFTER the tx commits (broker hiccup doesn't roll back the student's submission).

- **`AlertService`** — Counsellor + admin only at the service layer (the cou-004:read controller gate is permissive, but the service-layer `hasCounsellorScope` check 403s teachers and students with the redirect message "Wellbeing alerts are counsellor + admin only. Teachers see aggregated trends only."). **Visibility**: admin sees all in tenant; counsellor sees alerts where `student_id IN (counselor's ACTIVE caseloads)`. Severity-sorted via SQL `CASE` ordering — SELF_HARM_INDICATOR first, then FEELS_UNSAFE, WANTS_TO_TALK, SIGNIFICANT_SCORE_DROP, PERSISTENT_LOW_SCORE. **`acknowledge`** locks the row + checks `status='NEW'` + UPDATEs `status='ACKNOWLEDGED', acknowledged_by=actor.employeeId, acknowledged_at=now()` atomically (the multi-column `acknowledged_chk` lockstep is satisfied in the same UPDATE). **`resolve`** uses a single UPDATE with `COALESCE(acknowledged_by, actor.employeeId)` + `COALESCE(acknowledged_at, now())` so the fast-path NEW→RESOLVED stamps fresh ack values while the canonical NEW→ACKNOWLEDGED→RESOLVED path preserves the original ack timestamp.

**Kafka emit shape (ADR-057 envelope captured live):**

```json
{
  "event_type": "svc.wellbeing.alert.created",
  "source_module": "wellbeing",
  "tenant_id": "<schoolId>",
  "payload": {
    "alertType": "SELF_HARM_INDICATOR",
    "sourceRefId": "<responseId>",
    "schoolId": "<schoolId>",
    "studentId": "<sis_students.id>",
    "checkinId": "<svc_wellbeing_checkins.id>",
    "responseId": "<svc_wellbeing_responses.id>",
    "questionId": "<svc_wellbeing_questions.id>",
    "questionText": "<question text>",
    "autoEscalate": true,
    "submittedByAccountId": "<platform_users.id>"
  }
}
```

`autoEscalate` is `true` for SELF_HARM_INDICATOR and `false` for the other types. The future Cycle 3 NotificationConsumer wiring will read `autoEscalate=true` to fire the school-administrator IN_APP + EMAIL fan-out.

**Live verification on `tenant_demo` 2026-05-05 (33 assertions across 7 scenarios all green):**

- **R1 reads `/checkins`.** Counsellor / admin GET 200 with 2 rows; teacher GET 200 with 2 stripped rows (studentId='', studentName=null, flagged=false); student GET 200 with 1 own row (Maya); parent GET 403 (gate).
- **R2 reads `/checkins/:id`.** Counsellor GET Ethan's pending check-in returns full DTO (Ethan Rodriguez, pending=true, responseCount=0). **Teacher GET 403** with the redirect message (the pre-loadOrFail teacher check fires correctly). Parent GET 403 (gate).
- **R3 keystone — admin submits Ethan's check-in on his behalf** (`Q3=1` triggers WANTS_TO_TALK). Response shows `completedAt` populated + `flagged=true` + `responseCount=5`. Ethan WANTS_TO_TALK alert row created in DB. Deployment `total_completed` bumped 1 → 2.
- **R4 negative paths.** Resubmit completed check-in 400. Submit with missing question 400. Submit with foreign questionId 400. Maya tries to submit Ethan's check-in 403 ("You can only submit your own check-in").
- **R5 KEYSTONE — SELF_HARM_INDICATOR auto-escalate.** Plant a fresh single-question template (SAFETY + SCALE_1_5) + a PENDING check-in for Maya. Maya submits `numeric=1`. Response shows `flagged=true`. The SELF_HARM_INDICATOR alert row is created in DB with `status='NEW'`.
- **R6 alert lifecycle + visibility.** Counsellor GET /alerts returns 2 (Hayes sees only Maya's alerts; Ethan not on Hayes's caseload). Admin GET /alerts returns 3 (admin sees all). Teacher / student / parent GET /alerts → 403 (service-layer counsellor-only). Severity sort verified: admin's top alert is SELF_HARM_INDICATOR. Counsellor GET Ethan's alert → 404 (row-scope; not on caseload). **Admin acknowledges Ethan's WANTS_TO_TALK** → `status='ACKNOWLEDGED'` + `acknowledgedByName='Sarah Mitchell'`. **Counsellor resolves Maya's SHI** via the fast NEW→RESOLVED path → `status='RESOLVED'` + `resolutionNotes` populated + `acknowledgedByName='Marcus Hayes'` (COALESCE stamped fresh ack values). Re-resolve 400 (already RESOLVED). Admin re-ack 400 (only NEW can be acknowledged).
- **R7 Kafka envelope capture.** 3 envelopes captured live on `dev.svc.wellbeing.alert.created` with full ADR-057 shape: 2× WANTS_TO_TALK with `autoEscalate=false` (Ethan); 1× SELF_HARM_INDICATOR with **`autoEscalate=true`** (Maya). The auto-escalation flag is the keystone the future Cycle 3 NotificationConsumer will read to fire the school-administrator notification path.

**Iteration issues caught + fixed during smoke:**

1. **Teacher 404 instead of 403 on `/checkins/:id`.** First draft of `getById` called `loadOrFail` first (which threw 404 because teacher's persona branch returns no rows), so the explicit `ForbiddenException` in `getById` never fired. Reordered the service so the teacher check fires BEFORE `loadOrFail` — teachers now get the clear "Teachers see aggregated wellbeing trends only" 403 message.
2. **Counsellor row-scope in R6 expected too much.** Hayes only sees alerts for students on her ACTIVE caseload (just Maya); Ethan's alert is invisible. The smoke's initial assertion expected 3 alerts visible to Hayes. Fixed by: (a) adjusting the count assertion (counsellor sees 2, admin sees 3), (b) using admin to acknowledge Ethan's alert, (c) keeping the counsellor's row-scope test (404 on Ethan's alert id confirms the gate fires).

Cleanup script restores `tenant_demo` to the post-Step-3 seed shape exactly: drops the SHI smoke template + check-in + alert, drops the Maya smoke check-in, drops Ethan's responses + alert, resets Ethan's check-in to PENDING, restores deployment counter. Final counts confirmed: tpls=1, qs=5, deps=1, ckins=2, pending=1, resps=5, alerts=1.

**Step 5 verified end-to-end. Ready for Step 6 (counsellor wellbeing UI — dashboard, template builder, deployment manager, alert queue).**

---

## Step 6 — Counsellor Wellbeing UI

**Status:** DONE. Four new web routes under `apps/web/src/app/(app)/counselling/wellbeing/` extending the existing Counselling app tile (no new launchpad tile — the Counselling tile's `routePrefix: '/counselling'` already keeps it lit on every nested route). New `apps/web/src/lib/wellbeing-format.ts` (6 const arrays + 8 label maps + 7 pill-class maps + helpers `alertSeverityRank` / `isOpenAlert` / `formatRelative` / `formatDate`). New `apps/web/src/hooks/use-wellbeing.ts` (**18 React Query hooks** covering every Step 4 + 5 endpoint). DTO surface added to `apps/web/src/lib/types.ts` (~150 lines: 7 enum unions, 11 DTO interfaces, 5 payload interfaces). **No backend changes** — Step 6 sits entirely on the 20 endpoints from Steps 4 + 5. Build clean.

**Routes (4):**

1. **`/counselling/wellbeing`** — Counsellor dashboard with 4 panels: Active deployments with completion progress bars (animated emerald fill, `c / t completed` annotation, click-through to deployment detail); Open alerts queue (severity-sorted via `alertSeverityRank`, top 8, rose-tinted card; SHI rendered with the deepest-red `bg-rose-700 text-white` pill); Survey templates grid (per-template cards with frequency + creator); Recent completed check-ins with flagged/unflagged pills + relative timestamp.

2. **`/counselling/wellbeing/templates/[id]`** — Template builder. Header card with status pill + frequency dropdown (live PATCH) + Deactivate/Reactivate button (the canonical soft-delete path — schema NO ACTION FK refuses hard-delete while a deployment references the template). Questions list (sorted by `sort_order`) with per-row domain pill (warming-tone palette: ACADEMIC sky / SOCIAL violet / EMOTIONAL amber / PHYSICAL emerald / SAFETY rose) + question_type pill + Edit/Delete actions. **`QuestionEditorModal`** (shared between Add + Edit) with text + type + domain + sort inputs + an amber callout when `domain === 'SAFETY'` explaining the SHI / WANTS_TO_TALK trigger semantics so authors understand which questions auto-fire alerts.

3. **`/counselling/wellbeing/deployments/[id]`** — Deployment manager. Header card with status pill + target_type pill + 4-cell metadata grid (Deploy at, Expires, Targeted, Completed). Status-transition action bar: **Activate** button (SCHEDULED state — the keystone, kicks `useActivateWellbeingDeployment` which the Step 4 service uses to resolve the audience and bulk-create check-in rows; success toast carries the `checkinsCreated` count); **Mark complete** (ACTIVE state); **Cancel** (SCHEDULED or ACTIVE state, with `confirm()` guard). Check-ins list (per-row student name + completed/pending/flagged pill + relative timestamp + View action on completed rows). **`ResponseDetailModal`** opens on View — fetches `useWellbeingCheckin(id)` to get responses inlined + uses the parent template's questions array to label each response.

4. **`/counselling/wellbeing/alerts`** — Alert queue. 6 status filter chips (Open default + per-status + All). Severity-sorted list (SHI first via `alertSeverityRank`, then created_at DESC). Per-row card: alert_type pill (severity progression) + student name + status pill + relative timestamp + Q/A preview + resolution_notes (when present, emerald-tinted ring). **`Acknowledge` button** on NEW alerts (single-click, no modal). **`Resolve…` button** opens `ResolveModal` with required `resolutionNotes` textarea (5-char min) + an extra rose-tinted callout for `SELF_HARM_INDICATOR` alerts reminding the resolver to follow the safety-plan protocol before closing. SHI alerts render with a rose-300 left border to emphasize the auto-escalate keystone.

**`use-wellbeing.ts` — 18 hooks:**

| Hook                                     | Endpoint                          | Notes                                        |
| ---------------------------------------- | --------------------------------- | -------------------------------------------- |
| `useWellbeingTemplates(includeInactive)` | `GET /templates`                  | 60s stale                                    |
| `useWellbeingTemplate(id)`               | `GET /templates/:id`              | enabled-when-id                              |
| `useCreateWellbeingTemplate`             | `POST /templates`                 | invalidates list                             |
| `useUpdateWellbeingTemplate(id)`         | `PATCH /templates/:id`            | invalidates list + per-id                    |
| `useAddWellbeingQuestion(tplId)`         | `POST /templates/:id/questions`   | invalidates parent template                  |
| `useUpdateWellbeingQuestion(tplId)`      | `PATCH /questions/:id`            | invalidates parent template                  |
| `useDeleteWellbeingQuestion(tplId)`      | `DELETE /questions/:id`           | invalidates parent template                  |
| `useWellbeingDeployments(filters)`       | `GET /deployments`                | 30s stale + refetch on focus                 |
| `useWellbeingDeployment(id)`             | `GET /deployments/:id`            | 15s stale                                    |
| `useCreateWellbeingDeployment`           | `POST /deployments`               | invalidates list                             |
| `useActivateWellbeingDeployment`         | `PATCH /deployments/:id/activate` | invalidates deployments + check-ins          |
| `useCompleteWellbeingDeployment`         | `PATCH /deployments/:id/complete` | invalidates deployments                      |
| `useCancelWellbeingDeployment`           | `PATCH /deployments/:id/cancel`   | invalidates deployments                      |
| `useWellbeingCheckins(filters)`          | `GET /checkins`                   | 30s stale + refetch on focus                 |
| `useWellbeingCheckin(id)`                | `GET /checkins/:id`               | 15s stale                                    |
| `useSubmitWellbeingCheckin(id)`          | `POST /checkins/:id/submit`       | invalidates check-ins / alerts / deployments |
| `useWellbeingAlerts(filters)`            | `GET /alerts`                     | 30s stale + refetch on focus                 |
| `useAcknowledgeWellbeingAlert`           | `PATCH /alerts/:id/acknowledge`   | invalidates alerts                           |
| `useResolveWellbeingAlert`               | `PATCH /alerts/:id/resolve`       | invalidates alerts                           |

(19 hooks if `useWellbeingAlert(id)` is counted — the alert queue uses inline list data so the per-id hook ships but isn't called by Step 6's pages; reserved for Step 7 alert-detail polish.)

**`wellbeing-format.ts` highlights:**

- `DOMAIN_PILL` warming progression: ACADEMIC sky / SOCIAL violet / EMOTIONAL amber / PHYSICAL emerald / **SAFETY rose** (matches the schema's invariant — SAFETY is the trigger-surface domain).
- `ALERT_TYPE_PILL` severity progression: **SELF_HARM_INDICATOR `bg-rose-700 text-white`** (deepest red, white text), FEELS_UNSAFE rose-100, WANTS_TO_TALK amber, score-drop variants gray (deferred).
- `alertSeverityRank(t)` returns 0 for SHI, 1 for FEELS_UNSAFE, 2 for WANTS_TO_TALK, 3 for SCORE_DROP, 4 for PERSISTENT_LOW_SCORE — mirrors the SQL `CASE` ordering in `AlertService.list` so client-side resorts (after a refetch) preserve the same severity-first order the server returns.
- `formatRelative(iso)` returns "just now" / "Nm ago" / "Nh ago" / "Nd ago" / locale date past 30 days.

**Build sizes** (pages, after the `next build`):

- `/counselling/wellbeing` — 1.88 kB (113 kB First Load)
- `/counselling/wellbeing/alerts` — 3.0 kB (114 kB)
- `/counselling/wellbeing/deployments/[id]` — 3.26 kB (115 kB) [dynamic]
- `/counselling/wellbeing/templates/[id]` — 3.48 kB (115 kB) [dynamic]

**Live UI-driving API smoke (counsellor / admin / teacher / student / parent on `tenant_demo` 2026-05-05):**

- Counsellor `GET /templates` returns 1 row (the seeded "Weekly Emotional Check-In"). Admin same. Teacher 200 (cou-004:read held). Parent **403** (gate; not granted COU-004).
- Counsellor `GET /deployments?status=ACTIVE` returns 1 row (deployed_by=Hayes). Admin `GET /deployments` returns 1 (admin sees all). VP `GET /deployments` returns 0 (VP didn't deploy any; counsellor row-scope filters them).
- Counsellor `GET /alerts` returns 1 row. Admin same. Teacher / parent / student **403** at the service layer with the redirect message.
- Counsellor `GET /templates/:id` returns the template with all 5 questions inlined ordered by sort_order; Hayes shown as creator name.
- Counsellor `GET /deployments/:id` returns `totalTargeted=2 totalCompleted=1 completionRate=50` (the seeded shape after Step 3).

**Iteration issue caught + fixed during build:** `&apos;` escape required in `alerts/page.tsx` for the SHI safety-plan callout — fixed via `&apos;`. Format-check + format-write cleanup ran clean on first follow-up.

**No backend changes**, no database migrations, no new endpoints. Step 6 sits entirely on the 20 endpoints from Steps 4 + 5.

**Step 6 verified end-to-end. Ready for Step 7 (student wellbeing UI — the first student-input surface in CampusOS).**

---

## Step 7 — Student Wellbeing UI

**Status:** DONE. **Three new web routes under `apps/web/src/app/(app)/wellbeing/`** + a new `Wellbeing` student-only launchpad tile + 1 new `wellbeing` AppKey. **The first student-input surface in CampusOS.** No new backend or schema; Step 7 sits entirely on the 20 endpoints from Steps 4 + 5 (the existing `useWellbeingCheckins` / `useWellbeingCheckin` / `useWellbeingTemplate` / `useSubmitWellbeingCheckin` hooks already pull from the row-scoped student branch of `CheckinService`). Build clean (`pnpm --filter @campusos/web build`); 3 student wellbeing routes ship at small bundle sizes. Live verification on `tenant_demo` 2026-05-05 — 13 scenarios across R1-R6 all green including the keystone student-input flow.

**Tile + launchpad wiring:**

`apps/web/src/components/shell/apps.tsx` — adds `'wellbeing'` to the `AppKey` union and a new tile gated on `isStudent && hasAnyPermission(user, ['cou-004:read'])`. **Tile is intentionally student-only.** Other personas (counsellor / admin / teacher) reach the wellbeing surface through the existing **Counselling** tile + `/counselling/wellbeing` nested area shipped in Step 6, so a duplicate tile would be redundant. The student tile uses the existing `HeartIcon` (warm + caring vibe) and points at `/wellbeing` with `routePrefix: '/wellbeing'` so the tile stays lit on every nested route. The Counselling tile is NOT shown to students because they don't hold `cou-001:read`, so the two tiles never collide on the same dashboard.

**3 routes:**

1. **`/wellbeing`** — Student wellbeing landing page. Two sections: rose-tinted **Pending check-ins** card (lists `useWellbeingCheckins({pending:true})` rows with template name + "Sent {relative}" + "From {assignedCounselorName}" + a prominent rose-600 "Start check-in →" button per row), and a gray **My recent check-ins** card with `recent.slice(0,5)` + "See all →" link to /wellbeing/history. Privacy footnote at the bottom: "Your counsellor reads these so they can support you. Your responses are kept private from teachers and parents." Empty state when no pending: "All caught up — no pending check-ins right now."

2. **`/wellbeing/checkins/[id]`** — **THE STUDENT-INPUT KEYSTONE.** Question-by-question completion flow with appropriate input per `question_type`:
   - **SCALE_1_5** — 5 large rose-tinted radio buttons (1..5 grid) with anchor labels "1 = Not at all" and "5 = Very much" below.
   - **SCALE_1_10** — `<input type="range">` slider with rose accent + live numeric readout + "Move the slider to choose a number" hint until a value is set.
   - **YES_NO** — two large flex-1 toggle buttons (✓ Yes emerald-tinted when selected; ✕ No gray-tinted when selected). Maps to `numeric_response=1` for YES / `0` for NO.
   - **FREE_TEXT** — textarea with 500-char limit + a live "N / 500" counter.
   - **EMOJI_SCALE** — 5 emoji faces (😢 🙁 😐 🙂 😄) in a 5-col grid; each maps to numeric 1..5 by index. Selected emoji gets an amber-500 border.
     Per-question card carries `Question N of M` + a domain pill at the top right (warming-tone progression matching the counsellor surface). **Sticky footer** at the bottom shows `{N} of {M} answered` + a rose-600 **Submit check-in** button that's disabled until every template question has a response. Submit disabled state shows "Answer every question to enable submit. Take your time." Footnote: "Once you submit, you can't change your responses." On success: full-page warm thank-you screen with a 💚 emoji, a calming `font-display` headline ("Thank you for checking in."), a supportive paragraph that points the student to a counsellor or trusted adult if they need to talk before then, plus two CTAs (Back to wellbeing / See my history). The double-submit / already-submitted edge case is handled with a friendly "Already submitted" empty state. **Critically, the student NEVER sees `flaggedForFollowUp` or alert status** — even though the API returns these fields in the DTO, the UI explicitly does not render them. The counsellor follow-up conversation happens naturally without surfacing the technical flag.

3. **`/wellbeing/history`** — Read-only response history. Sorts `useWellbeingCheckins({pending:false})` newest-first by `completedAt`, renders each row as a collapsible button. Tap to expand → fetches the full check-in via `useWellbeingCheckin(id)` lazily and renders the responses inline (one card per response showing numeric or text answer). The `id` attribute on each row's `<li>` enables anchor navigation from the landing page's "View" links (e.g. `/wellbeing/history#<checkinId>`). Privacy footnote: "Your counsellor sees your responses to support you. Teachers and parents do not see wellbeing check-in content."

**Build sizes:**

| Route                      | First Load JS    | Notes                                 |
| -------------------------- | ---------------- | ------------------------------------- |
| `/wellbeing`               | 1.26 kB (113 kB) | static                                |
| `/wellbeing/checkins/[id]` | 3.30 kB (115 kB) | dynamic — the completion flow         |
| `/wellbeing/history`       | 1.31 kB (113 kB) | static; per-row detail fetched lazily |

**Live verification on `tenant_demo` 2026-05-05 (13 scenarios across 6 sections all green):**

- **R1 student lands at /wellbeing.** After resetting Maya's seed check-in to PENDING and clearing her seeded ACKNOWLEDGED alert, `useWellbeingCheckins({pending:true})` returns 1 row ("Weekly Emotional Check-In") for the calling student. Pending=false count returns 0 (Maya hasn't completed any yet). Maya's check-in id correctly resolved.
- **R2 student opens completion flow.** `GET /checkins/:id` returns the check-in DTO with `templateName='Weekly Emotional Check-In'` and `pending=true`. The follow-on `GET /templates/:id` returns 5 questions (the Step 3 seeded shape).
- **R3 STUDENT-INPUT KEYSTONE — Maya submits her own check-in.** POST `/checkins/:id/submit` with all 5 responses (Q1=4, Q2=3, Q3=1 YES → WANTS_TO_TALK trigger, Q4=4, Q5=4) returns the completed check-in DTO with `completedAt='2026-05-05T11:26:20+00'`, `flagged=true`, `responseCount=5`. Server-side: 5 response rows planted, 1 WANTS_TO_TALK alert row created, deployment.total_completed bumped, `svc.wellbeing.alert.created` envelope emitted on Kafka.
- **R4 history view post-submit.** `GET /checkins?pending=false` now returns 1 row (Maya's just-submitted check-in). `GET /checkins/:id` returns 5 responses inlined.
- **R5 resubmit refused.** A second POST to `/submit` returns `400` with the "already submitted" message — the schema invariant + service-side lock prevent state corruption.
- **R6 permission gates fully verified.** Parent `GET /checkins?pending=true` 403 (parent never holds COU-004:read). Teacher `GET /checkins` 200 with stripped DTOs (studentId='', studentName=null — the aggregated trends contract from Step 5). Teacher `GET /checkins/:id` 403 (service-layer redirect). **Maya `GET /checkins/<Ethan's-id>` 404 (row scope — students see own only).** Maya tries to POST `/submit` for Ethan's check-in → `403` ("You can only submit your own check-in").

**Cleanup script** restores `tenant_demo` to the post-Step-3 seed shape exactly via wholesale wellbeing-row delete + `seed:wellbeing` re-run.

**Iteration issues caught + fixed:** none — the student UI built and worked on first attempt because:

1. The hooks were already shipped + verified in Step 6
2. The row-scope was already enforced server-side in Step 5
3. The DTO shapes were already verified
4. ESLint/prettier issues from Step 6 (`&apos;`) were already pattern-known

**Step 7 verified end-to-end. The first student-input surface in CampusOS is live.** Ready for Step 8 (the vertical-slice CAT walking the full counsellor → deploy → student submit → alert → triage → admin escalate flow).

---

## Step 8 — Vertical Slice Integration Test

**Status:** DONE. CAT script lands at `docs/cycle11.1-cat-script.md` — 8-check schema preamble + 10 plan scenarios verified live on `tenant_demo` 2026-05-05 against the Step 7 build. Two ADR-057 wire envelopes captured live on `dev.svc.wellbeing.alert.created`. Cleanup restores tenant to the post-Step-3 seed shape exactly. Pre-conditions documented include the `dev.svc.wellbeing.alert.created` topic pre-creation step (per the auto-creation race documented across Cycles 3 + 5). API booted from `pnpm --filter @campusos/api build && node apps/api/dist/main.js`; the Kafka producer + consumer logs confirm 21 topic subscriptions on boot including `dev.svc.wellbeing.alert.created`.

### 8-check schema preamble — all green on `tenant_demo`

1. Tenant logical base table count: **175** (was 169 after Cycle 11; Step 1 added 3 + Step 2 added 3).
2. `svc_wellbeing_*` tables: **6** (templates / questions / deployments / checkins / responses / alerts).
3. Intra-tenant FKs across the 6 wellbeing tables: **13** (4 from Step 1 + 9 from Step 2).
4. Cross-schema FKs from wellbeing tables: **0** (per ADR-001/020 — soft refs only to `platform.schools` + `platform.iam_person`).
5. IAM catalogue size: **450** (Cycle 11.1 reuses the existing COU-004 catalogue entry; no catalogue edit required).
6. COU-004 grant distribution: `read=6` (admin + principal + vp + counsellor + teacher + student) + `write=4` (admin + principal + vp + counsellor).
7. Parent COU-004 grant: **0** rows in `iam_effective_access_cache` for `parent@demo.campusos.dev` carrying any `cou-004:*` code (parents intentionally locked out — wellbeing data is student-counsellor confidential per the plan).
8. Step 3 seed shape: `templates=1 questions=5 deployments=1 checkins=2 responses=5 alerts=1` (matches plan exactly).

### 10 plan scenarios — all green on `tenant_demo`

| Scenario                                                                      | Outcome                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** Hayes creates "S8 CAT — Daily Pulse" template (5 questions, 4 domains) | Template created with 5 questions in sort_order; UNIQUE(school_id, name) catches duplicate POST with 400 carrying the conflicting template name in the friendly error                                                                                                                                                                                                               | Template builder happy path + UNIQUE keystone                                                                                                                                             |
| **S2** Hayes deploys to CASELOAD + activate keystone                          | POST /deployments returns SCHEDULED; PATCH /:id/activate locks deployment row, resolves CASELOAD audience to Hayes's active caseload (Maya only), bulk-INSERTs check-in row with `completed_at=null`, stamps `total_targeted=1`, returns `checkinsCreated=1`; double-activate rejected with "Deployment is in status ACTIVE; only SCHEDULED can be activated"                       | Activate keystone — locks + resolves + bulk-inserts in one tx                                                                                                                             |
| **S3** Maya submits her check-in (Q3 SAFETY/YES_NO=YES)                       | Submit POST inside same tx: stamps `completed_at`, sets `flagged_for_follow_up=true`, INSERTs 5 response rows, bumps `deployment.total_completed` to 1, creates WANTS_TO_TALK alert linked to Q3 response, emits `svc.wellbeing.alert.created` outside the tx                                                                                                                       | **THE FIRST STUDENT-INPUT KEYSTONE** — Maya's account submits via row-scoped student API path                                                                                             |
| **S4** `svc.wellbeing.alert.created` envelope captured live                   | Wire envelope on `dev.svc.wellbeing.alert.created` with full ADR-057 shape: `event_type='svc.wellbeing.alert.created'`, `source_module='wellbeing'`, `tenant_id` populated, payload includes `alertType='WANTS_TO_TALK'`, `autoEscalate=false`, `studentId`, `checkinId`, `responseId`, `questionId`, `questionText='Do you want to talk to a counsellor?'`, `submittedByAccountId` | WANTS_TO_TALK is non-emergency; `autoEscalate=false` is correct — only SELF_HARM_INDICATOR carries `autoEscalate=true`                                                                    |
| **S5** SELF_HARM_INDICATOR keystone (`autoEscalate=true`)                     | Hayes deploys CUSTOM_LIST instance for Ethan; admin submits with Q4 SAFETY/SCALE_1_5=1; alert evaluator's precedence rule fires SELF_HARM_INDICATOR (winning over FEELS_UNSAFE on the same response — single SAFETY/SCALE_1_5+numeric=1 row creates exactly one alert, not two); wire envelope shows `autoEscalate=true` and `questionText='How safe do you feel at school?'`       | The auto-escalation keystone — verified live; future Cycle 3 NotificationConsumer wiring will fan out IN_APP + EMAIL to admin + assigned counsellor                                       |
| **S6** Alert triage NEW → ACKNOWLEDGED → RESOLVED                             | Hayes acknowledges Maya's WANTS_TO_TALK; AlertService stamps both `acknowledged_by` + `acknowledged_at` atomically per the multi-column `acknowledged_chk` lockstep CHECK; admin resolves with notes; re-resolve rejected with "Alert is already RESOLVED"                                                                                                                          | Lockstep keystone — schema rejects any half-state mid-flight                                                                                                                              |
| **S7** Maya student visibility (own-only row scope)                           | GET /checkins returns 2 rows, all `studentId=$MAYA`; GET /alerts → 403 (counsellor + admin only at service layer); GET /checkins/<Ethan-checkin-id> → 404 (don't-leak-existence row scope, NOT 403)                                                                                                                                                                                 | Student row scope at `actor.personId → platform_students → sis_students`; alerts surface intentionally invisible to students                                                              |
| **S8** Teacher visibility (aggregated trends, identity stripped)              | Rivera GET /checkins returns rows but `studentId=''`, `studentName=null`, `assignedCounselorId=null`, `flaggedForFollowUp=false` per the `stripCheckinForTeacher` server-side strip; GET /checkins/:id → 403; GET /alerts → 403; POST /templates → 403                                                                                                                              | Aggregated trend access only — the stripped DTO contract is server-side enforcement, not a UI convention                                                                                  |
| **S9** Parent denied at the gate (no `cou-004:*`)                             | David Chen GET /templates → 403; /deployments → 403; /checkins → 403; /checkins/:id → 403; /alerts → 403 — every wellbeing surface 403s at the PermissionGuard before reaching service-layer logic                                                                                                                                                                                  | Parents intentionally locked out — wellbeing data is student-counsellor confidential per the plan                                                                                         |
| **S10** Counsellor + admin full detail (caseload row scope vs school-wide)    | Hayes GET /checkins/:id full detail (`studentName`, `flaggedForFollowUp=true`, `responses=5`); Hayes GET /alerts shows 2 rows (Maya only — Ethan not on Hayes's caseload); admin GET /alerts shows 3 rows (school-wide) with `SELF_HARM_INDICATOR` first per the AlertService SQL CASE severity-sort                                                                                | Counsellor caseload row scope — Hayes does NOT see Ethan's SHI alert; only admin (or Ethan's assigned counsellor) sees it. The severity-sort puts SHI at the top regardless of created_at |

### Iteration issues caught + fixed during the CAT run

- **`Cleanup date filter caught the seeded alert`** — the original draft cleanup section anchored on `created_at > '2026-05-04'` to drop the new alerts while preserving the seeded one. Worked when the CAT runs on a different day from the seed; when both run the same day the seeded alert was caught too. Fixed by anchoring on `response_id IN (SELECT … WHERE template.name = 'S8 CAT — Daily Pulse')` so the cleanup walks the CAT graph from response_id back through checkin_id back through deployment_id back to the template — the seeded alert's `response_id` points at a different template's response and survives. Verified clean: re-running the cleanup script after the CAT and a fresh `seed:wellbeing` re-run produces `templates=1 questions=5 deployments=1 checkins=2 responses=5 alerts=1` exactly.

### Reviewer attention items (non-blocking, deferred)

1. **Cycle 3 NotificationConsumer wiring on `svc.wellbeing.alert.created`** — emit lands cleanly with full payload but no consumer fans it out to IN_APP / EMAIL today. SHI alerts in production should page the school administrator AND the assigned counsellor on top of the wire emit. Pattern matches Cycle 5 CoverageConsumer or Cycle 6 PaymentAccountWorker.
2. **Student-visible `flaggedForFollowUp` field on /checkins/:id** — the API today returns `flaggedForFollowUp=true` to the student who owns the check-in. The Step 7 student UI page intentionally does NOT render this field per the contract ("Students never see the flagged status or alert rows — the counsellor initiates any follow-up conversation naturally"). A custom client could still read it via the API; tightening the response shape to strip `flaggedForFollowUp` for STUDENT actors at the service layer is a small Phase 2 polish.
3. **SIGNIFICANT_SCORE_DROP and PERSISTENT_LOW_SCORE alerts** — schema accepts both values; no service generates them this cycle (longitudinal evaluation across deployments is deferred).
4. **YEAR_GROUP audience-resolution** — `DeploymentService.resolveAudience` has the `_schoolId` parameter retained for the future shape but the current path returns 400 deferred.
5. **Scheduled deployment auto-activation** — manual activation only this cycle; the cron / worker that flips SCHEDULED → ACTIVE at `deploy_at` is a future enhancement.
6. **Counsellor / Nurse / Lead-counsellor role split** — carries from Cycles 9 + 10 + 11; Staff role currently grants every COU code. Wave 2 Phase 2 backlog.

**Cycle 11.1 ships clean to the post-cycle architecture review. All 10 plan scenarios passed live on `tenant_demo` 2026-05-05 against the Step 7 build. Two ADR-057 wire envelopes captured live (WANTS_TO_TALK with `autoEscalate=false` + SELF_HARM_INDICATOR with `autoEscalate=true`).**

---

## Cycle 11.1 Completion Criteria

1. Tenant schema: 6 new tables (3 template/deployment + 3 checkin/response/alert). Tenant table count: 169 → **175** (172 after Step 1).
2. Wellbeing API: ~21 endpoints with per-persona visibility (counsellor full detail, student own-only, teacher aggregated, parent denied).
3. Student-facing check-in submission — the first student-input surface in CampusOS.
4. Alert auto-generation on concerning responses. SELF_HARM_INDICATOR auto-escalation via `svc.wellbeing.alert.created` Kafka emit.
5. Alert triage: NEW → ACKNOWLEDGED → RESOLVED lifecycle.
6. Deployment activation generates check-in rows for targeted students.
7. COU-004 permission grants across 7 personas (student gets read for own check-ins; parent denied).
8. HANDOFF-CYCLE11.1.md and CLAUDE.md updated. CI green.

---
