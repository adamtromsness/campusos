# Cycle 11 Handoff — Counselling & Student Support

**Status:** Cycle 11 **COMPLETE pending Round 2 architecture review** — all 10 steps done + REVIEW-CYCLE11 fixes landed (Round 1 verdict against `cycle11-complete` at `a46d905` was REJECT pending 2 Cycle-11 BLOCKING + 4 MAJOR follow-ups). The closeout fix commit addresses every code-fixable finding with live verification on `tenant_demo` 2026-05-05: **BLOCKING 1** referral triage queue privacy leak fixed (`ReferralService.buildVisibility` now branches on `hasCounsellorScope` so non-counsellor STAFF see own-submitted only); **BLOCKING 2** session write row-scope fixed (`SessionService.create/patch/addParticipant/markAttendance` now require `counselor_id === actor.employeeId` for non-admins, with the lock-and-check inside the same tx as the UPDATE on `patch`); **MAJOR 4** MTSS tier caseload validation added (`assertActorOwnsStudent` in `MtssTierService`); **MAJOR 5** intervention caseload row-scope added (`assertActorOwnsTier` + `assertActorOwnsIntervention` in `InterventionService`); **MAJOR 6** mandated-reporter Swagger rewritten to spell out the locked product/security decision. **BLOCKING 3** (Cycle 10 medication administration history) was already fixed in `970a6b3` per REVIEW-CYCLE10 and re-verified live for completeness (parent / teacher / student all 403). **MAJOR 7** (Staff role split into Counsellor / Nurse / VP / General) joins the Wave 2 Phase 2 punch list as item 9 / 11 — architectural redesign that should land before pilot, not on this fix commit. See `REVIEW-CYCLE11-CHATGPT.md` for the triage table + before/after + verification trail. Original Round 1 cycle status preserved below: the vertical-slice CAT at `docs/cycle11-cat-script.md` was verified live on `tenant_demo` 2026-05-05; all 10 plan scenarios pass with both ADR-057 wire envelopes captured (`svc.referral.created` from S1, `svc.tier.changed` from S6). Cycle 11 ships **14 svc\_\* tables** (3 schema migrations) + 1 cross-cycle FK backfill on Cycle 9's `svc_behavior_plans.caseload_id`, **32 intra-tenant FKs**, **0 cross-schema FKs**, **48 endpoints** across 10 services, **2 Kafka emit topics**, **1 FERPA permission gate** (`student_counseling_record:read`), and **8 web routes + 47 React Query hooks**. IAM catalogue grew 447 → **450**. Tenant base table count grew 155 → **169**. The cross-cycle integration moment — converting Cycle 9's forward-compatible soft `caseload_id` ref into a real DB-enforced FK ON DELETE SET NULL — is verified live. Cycle 11 completes the M27 Student Services module that Cycle 9 began. Cycle 9 shipped 3 tables (`svc_behavior_plans`, `svc_behavior_plan_goals`, `svc_bip_teacher_feedback`). Cycle 11 ships the remaining 14 core M27 tables across 4 domains: (1) caseloads + referrals, (2) counselling sessions with FERPA-protected notes, (3) MTSS/RTI tier assignments with interventions and progress monitoring, and (4) coordinated care + mandatory reporting. The 6 wellbeing check-in tables (survey templates, questions, deployments, check-ins, responses, alerts) are scoped to the follow-up Cycle 11.1 since they form a self-contained student-facing surface. Cycle 11 is the **third cycle of Wave 2 (Student Services)** following Cycle 9 (Behaviour & Discipline) and Cycle 10 (Health & Wellness). It involves the **second-highest sensitivity data domain** after Health: `svc_session_notes` is FERPA-protected counselling content gated on a dedicated `student_counseling_record:read` permission. Teachers may not access session notes under any circumstance. Mandatory reports (`svc_mandatory_reports`) are immutable once past FILED status and retained permanently. Tagged `cycle11-complete` after CI green.

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle11-implementation-plan.html`
**Vertical-slice deliverable:** Teacher submits a referral for Maya: "Struggling with peer relationships and declining grades" under type "Social/Emotional" → counsellor (Hayes) sees the referral in the triage queue, accepts it, and assigns Maya to their caseload with primary concern SOCIAL_EMOTIONAL → counsellor schedules an individual session, logs a FERPA-protected session note with goals addressed → counsellor assigns Maya to MTSS Tier 2 BEHAVIORAL domain with a targeted intervention (Social Skills Group, 2x/week) → counsellor logs an intervention progress data point showing improvement → nurse and counsellor exchange a coordinated care note about Maya's health-related anxiety → admin views the MTSS dashboard showing tier distribution → teacher sees only that Maya has an active caseload and that their referral was accepted (no session notes visible).

This document tracks the Cycle 11 build at the same level of detail as `HANDOFF-CYCLE1.md` through `HANDOFF-CYCLE10.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                        | Status   |
| ---- | ------------------------------------------------------------ | -------- |
| 1    | Caseloads + Referrals Schema                                 | **DONE** |
| 2    | Sessions + Notes + MTSS Schema                               | **DONE** |
| 3    | Coordinated Care + Mandatory Reporting Schema                | **DONE** |
| 4    | Seed Data — Caseloads, Referral, Sessions, MTSS, Permissions | **DONE** |
| 5    | Caseload + Referral NestJS Module                            | **DONE** |
| 6    | Session + Notes NestJS Module                                | **DONE** |
| 7    | MTSS + Care + Reporting NestJS Modules                       | **DONE** |
| 8    | Counselling UI — Caseload + Referrals + Sessions             | **DONE** |
| 9    | MTSS + Care + Reporting UI                                   | **DONE** |
| 10   | Vertical Slice Integration Test                              | **DONE** |

---

## What this cycle adds on top of Cycles 0–10

Cycle 11 is the third cross-cutting cycle of Wave 2. It extends the existing `svc_*` namespace introduced in Cycle 9 (Behaviour Plans) and finally resolves the Cycle 9 soft `caseload_id` ref on `svc_behavior_plans` once `svc_caseloads` exists.

- **Counselling Caseloads + Referrals (M27, 4 tables in scope this step).** `svc_caseloads` is the master assignment of a counsellor to a student for an academic year, with two partial UNIQUE keystones: one primary counsellor per (student, year) and no duplicate active assignments per (counsellor, student, year). `svc_referral_types` is the per-school referral category catalogue with default priority and a parent-notification flag. `svc_referrals` is the lifecycle-bearing teacher-to-counsellor referral with a 7-state status enum (SUBMITTED → TRIAGED → ACCEPTED → IN_PROGRESS → COMPLETED, plus DECLINED and CANCELLED terminal states). `svc_referral_activity` is the IMMUTABLE per-ADR-010 audit log — every status transition writes a row through the Step 5 `ReferralActivityService.recordActivity()` helper.
- **Counselling Sessions + FERPA Notes (M27, 3 tables in Step 2).** `svc_sessions` is the per-counsellor session log with a 6-value type enum (INDIVIDUAL / GROUP / CRISIS / CHECK_IN / PARENT_MEETING / CONSULTATION). `svc_session_participants` links students to sessions (one row per student per session — required for GROUP, optional for INDIVIDUAL). `svc_session_notes` is the **FERPA-protected counselling record** with a multi-column `locked_chk` keystone keeping `is_locked` + `locked_at` + `locked_by` in lockstep — once locked, a note is irreversibly immutable.
- **MTSS/RTI tiered interventions (M27, 5 tables in Step 2).** `svc_mtss_tiers` is the per-(student, year, domain) tier assignment with a 3-value tier enum (TIER_1 / TIER_2 / TIER_3) and a 4-value domain enum (ACADEMIC / BEHAVIORAL / SOCIAL_EMOTIONAL / ATTENDANCE) — partial UNIQUE on `(student_id, academic_year_id, domain) WHERE status='ACTIVE'`. `svc_interventions` are the targeted supports under each tier with start/end dates and a 6-value type enum. `svc_intervention_progress` is append-only progress monitoring with measure_type + score + optional benchmark. `svc_mtss_team_meetings` records weekly RTI team review sessions; `svc_mtss_team_meeting_students` links the students reviewed at each meeting with a 5-value outcome enum.
- **Coordinated Care + Mandatory Reporting (M27, 2 tables in Step 3).** `svc_coordinated_care_notes` is the nurse + counsellor shared observation thread, gated on the **intersection** of `hlt-001:read` AND `cou-007:read` — neither permission alone unlocks it. `svc_mandatory_reports` is the CPS-filing log with **immutability after FILED**: description, report_type, reported_to_authority, and report_date cannot be changed once the report is filed. Only `cps_response` and `status` can be updated as the case evolves.
- **Cycle 9 BIP `caseload_id` FK backfill.** The Step 3 migration adds the DB-enforced FK from `svc_behavior_plans.caseload_id` to `svc_caseloads(id)` ON DELETE SET NULL — converting the Cycle 9 forward-compatible soft ref into a real FK now that the target table exists. This is the cross-cycle integration moment the Cycle 9 plan documented for Cycle 11.
- **Wave 1 + 2 integrations.** Cycle 4 HR provides `hr_employees(id)` for counsellor + provider + facilitator + reporter refs. Cycle 1 SIS provides `sis_students(id)` and `sis_academic_years(id)`. Cycle 9 BIPs gain a real FK to caseloads. Cycle 10 IEP plans coexist (a student may have both an IEP and a counsellor caseload). Cycle 3 Notifications gets a future surface (counsellor IN_APP on referral assignment + parent notification on referral when `requires_parent_notification=true`). Cycle 7 TaskWorker can react to `svc.referral.created` and `svc.tier.changed` once the rules are seeded in Step 4.
- **Wellbeing deferred (6 tables).** `svc_wellbeing_survey_templates`, `svc_wellbeing_questions`, `svc_wellbeing_deployments`, `svc_wellbeing_checkins`, `svc_wellbeing_responses` (RANGE-partitioned monthly), `svc_wellbeing_alerts` form a self-contained student-facing pulse-survey + auto-alert sub-system. Scoped to a follow-up Cycle 11.1.

What does not change: every existing module continues to function. Cycle 11 is purely additive on the request path apart from the one Cycle 9 FK backfill in Step 3 (which only tightens an already-soft column).

---

## Step 1 — Caseloads + Referrals Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-04. Idempotent re-provision verified (zero new applies on the second run; the IF NOT EXISTS guards on every CREATE TABLE / CREATE INDEX work as designed; tenant base table count stable). Splitter-clean — Python audit script (block-comment + line-comment + single-quoted-string aware with `''` escape handling) confirmed zero `;` outside legitimate statement terminators on the first attempt. Tenth migration in a row to clear the splitter trap on first try (Cycles 4–11 unbroken streak).

**Migration:** `packages/database/prisma/tenant/migrations/036_svc_caseloads_referrals.sql`.

**Tables (4):**

1. **`svc_caseloads`** — One row per (counsellor, student) assignment for an academic year. `school_id`, `counselor_id` NOT NULL FK to `hr_employees(id)` NO ACTION (refuses delete of a counsellor with active caseloads — admin must close them first), `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE (consistent with all other student-referencing tables — when a student is removed the assignment goes with them), `academic_year_id` NOT NULL FK to `sis_academic_years(id)` NO ACTION (refuses delete of an academic year with caseloads), `primary_concern TEXT NOT NULL` 7-value CHECK `ACADEMIC / BEHAVIORAL / SOCIAL_EMOTIONAL / ATTENDANCE / CRISIS / TRANSITION / GENERAL`, `is_primary_counselor BOOLEAN NOT NULL DEFAULT true` (a student may have multiple counsellors of which exactly one is primary — the partial UNIQUE keystone enforces this), `status TEXT NOT NULL DEFAULT 'ACTIVE'` 3-value CHECK `ACTIVE / CLOSED / TRANSFERRED`, `opened_at DATE NOT NULL`, `closed_at DATE` nullable, `closure_reason TEXT` nullable, `notes TEXT` nullable. **Partial UNIQUE INDEX `(student_id, academic_year_id) WHERE status='ACTIVE' AND is_primary_counselor=true`** — one primary counsellor per student per year. **Partial UNIQUE INDEX `(counselor_id, student_id, academic_year_id) WHERE status='ACTIVE'`** — no duplicate active assignments. INDEX `(counselor_id, status)` for the counsellor's caseload list hot path. INDEX `(student_id, academic_year_id)` for the student profile cross-cycle lookup.

2. **`svc_referral_types`** — Per-school referral category catalogue. `school_id`, `name TEXT NOT NULL`, `description TEXT` nullable, `default_priority TEXT NOT NULL` 4-value CHECK `LOW / MEDIUM / HIGH / URGENT`, `requires_parent_notification BOOLEAN NOT NULL DEFAULT false` flags types that fire the parent-notification path on referral submission, `is_active BOOLEAN NOT NULL DEFAULT true`. UNIQUE INDEX `(school_id, name)`. INDEX `(school_id, is_active)`. Examples once seeded in Step 4: "Social/Emotional" (default_priority=MEDIUM, requires_parent_notification=true) and "Academic Concern" (default_priority=LOW, requires_parent_notification=false). Schools layer their own catalogue on top.

3. **`svc_referrals`** — One row per teacher-to-counsellor referral. `school_id`, `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE, `referred_by` NOT NULL FK to `hr_employees(id)` NO ACTION (the referral has audit value beyond the teacher's tenure — admin must archive before the employee row is removed; Cycle 9 used SET NULL on `sis_discipline_incidents.reported_by` because it is nullable while this column is NOT NULL per the plan), `referral_type_id` NOT NULL FK to `svc_referral_types(id)` NO ACTION (refuses delete of a type with historical referrals — admin deactivates via `is_active=false`), `assigned_counselor_id` FK to `hr_employees(id)` ON DELETE SET NULL nullable (the row is unassigned on submission and is set during triage; if the assigned counsellor leaves the school the referral falls back to unassigned for re-triage), `priority TEXT NOT NULL` 4-value CHECK `LOW / MEDIUM / HIGH / URGENT` (defaults from the referral_type's `default_priority` at the Step 5 service layer), `status TEXT NOT NULL DEFAULT 'SUBMITTED'` 7-value CHECK `SUBMITTED / TRIAGED / ACCEPTED / IN_PROGRESS / COMPLETED / DECLINED / CANCELLED`, `reason TEXT NOT NULL`, `parent_notified BOOLEAN NOT NULL DEFAULT false`, `parent_notified_at TIMESTAMPTZ` nullable, `outcome TEXT` nullable (free-form summary on COMPLETED). INDEX `(school_id, status)` for the admin queue. INDEX `(assigned_counselor_id, status)` for the counsellor's queue. INDEX `(student_id)` for the student profile cross-cycle lookup. INDEX `(referred_by, status)` for the teacher's "my submitted referrals" view.

4. **`svc_referral_activity`** — IMMUTABLE per ADR-010. Service-side discipline. The Step 5 `ReferralActivityService.recordActivity()` is the only writer; no UPDATE method, no DELETE method exposed at the service layer. The DB-enforced FK on `referral_id` does CASCADE on parent referral delete — if a referral is hard-deleted (admin emergency action; the normal lifecycle stays in CANCELLED), the audit goes with it. This mirrors Cycle 8 `tkt_ticket_activity` and Cycle 10 `hlth_health_access_log` patterns. `referral_id` NOT NULL FK to `svc_referrals(id)` ON DELETE CASCADE, `actor_id UUID NOT NULL` (soft to `platform.platform_users(id)` per ADR-001 — captures the actor account id stamped from `actor.accountId`), `activity_type TEXT NOT NULL` 6-value CHECK `STATUS_CHANGE / ASSIGNMENT_CHANGE / NOTE_ADDED / PARENT_NOTIFIED / ESCALATED / EXTERNAL_CONTACT_MADE`, `notes TEXT` nullable, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. INDEX `(referral_id, created_at ASC)` for the chronological audit timeline.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `svc_caseloads.school_id → platform.schools(id)`
- `svc_referral_types.school_id → platform.schools(id)`
- `svc_referrals.school_id → platform.schools(id)`
- `svc_referral_activity.actor_id → platform.platform_users(id)` (soft per ADR-001 — captures the actor account id)

**FK summary — 8 new intra-tenant DB-enforced FKs:**

| FK                                                        | Action    |
| --------------------------------------------------------- | --------- |
| `svc_caseloads.counselor_id → hr_employees(id)`           | NO ACTION |
| `svc_caseloads.student_id → sis_students(id)`             | CASCADE   |
| `svc_caseloads.academic_year_id → sis_academic_years(id)` | NO ACTION |
| `svc_referrals.student_id → sis_students(id)`             | CASCADE   |
| `svc_referrals.referred_by → hr_employees(id)`            | NO ACTION |
| `svc_referrals.referral_type_id → svc_referral_types(id)` | NO ACTION |
| `svc_referrals.assigned_counselor_id → hr_employees(id)`  | SET NULL  |
| `svc_referral_activity.referral_id → svc_referrals(id)`   | CASCADE   |

0 cross-schema FKs.

**Tenant logical base table count after Step 1:** 155 → **159** (4 new logical base tables).

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 23 assertions, all green):**

1. **T1 happy path** — `INSERT INTO svc_caseloads` (Hayes → Maya, primary, ACTIVE, SOCIAL_EMOTIONAL, opened 2025-09-15) succeeds.
2. **T2 concern_chk** — `svc_caseloads_concern_chk` rejects `primary_concern='BOGUS'`.
3. **T3 status_chk** — `svc_caseloads_status_chk` rejects `status='BOGUS'`.
4. **T4 partial UNIQUE primary keystone** — `svc_caseloads_primary_active_uq` rejects a second row with `(student_id=Maya, academic_year_id=AY1)` AND `is_primary_counselor=true` AND `status='ACTIVE'`.
5. **T5 partial UNIQUE allows consultant** — same `(student, year)` accepted with `is_primary_counselor=false` (consultant pattern); Maya now has 2 active caseloads in AY1.
6. **T6 partial UNIQUE active_assignment** — `svc_caseloads_active_assignment_uq` rejects a second row with the same `(counselor_id=Hayes, student_id=Maya, academic_year_id=AY1)` even with `is_primary_counselor=false` AND `status='ACTIVE'` — the second keystone catches the case the first one misses.
7. **T7 CLOSED status releases primary slot** — UPDATE Hayes's primary caseload to `status='CLOSED'` then INSERT a new primary Hayes caseload for Maya in AY1; final state `(active=2, closed=1)`.
8. **T8 caseload FK** — `svc_caseloads_counselor_id_fkey` rejects `counselor_id='00000000-…-0099'`.
9. **T9 caseload FK** — `svc_caseloads_academic_year_id_fkey` rejects `academic_year_id='00000000-…-0099'`.
10. **T10 referral_types happy path** — 2 inserts (Smoke-SocialEmotional MEDIUM with parent-notify=true, Smoke-Academic LOW).
11. **T11 priority_chk** — `svc_referral_types_priority_chk` rejects `default_priority='BOGUS'`.
12. **T12 referral_types UNIQUE(school_id, name)** — `svc_referral_types_school_name_uq` rejects duplicate `(school_id, name)`.
13. **T13 referral happy path** — `INSERT INTO svc_referrals` (Rivera → Maya, type=Smoke-SocialEmotional, MEDIUM, SUBMITTED, reason populated) succeeds.
14. **T14 referral status_chk** — `svc_referrals_status_chk` rejects `status='BOGUS'`.
15. **T15 referral priority_chk** — `svc_referrals_priority_chk` rejects `priority='BOGUS'`.
16. **T16 lifecycle UPDATE** — SUBMITTED → TRIAGED with `assigned_counselor_id=Hayes` → ACCEPTED accepted; final state `status=ACCEPTED, assigned=Hayes`.
17. **T17 referral FK** — `svc_referrals_referred_by_fkey` rejects bogus `referred_by`.
18. **T18 referral FK** — `svc_referrals_referral_type_id_fkey` rejects bogus `referral_type_id`.
19. **T19 referral_types NO ACTION** — DELETE on `svc_referral_types` row with referencing referral rejected by `svc_referrals_referral_type_id_fkey`.
20. **T20 referral_activity happy path** — 3 audit rows for the SUBMITTED → TRIAGED → ACCEPTED lifecycle (one STATUS_CHANGE + one ASSIGNMENT_CHANGE + one STATUS_CHANGE).
21. **T21 activity_type_chk** — `svc_referral_activity_type_chk` rejects `activity_type='BOGUS'`.
22. **T22 all 6 activity_type values accepted in one block** — STATUS_CHANGE / ASSIGNMENT_CHANGE / NOTE_ADDED / PARENT_NOTIFIED / ESCALATED / EXTERNAL_CONTACT_MADE all land cleanly; total activity rows for the smoke referral grow 3 → 9.
23. **T23 CASCADE on referral delete** — DELETE on the parent referral drops all 9 audit rows in one statement (`orphan_activity=0` after the delete, confirming the IMMUTABLE-but-CASCADE-on-parent shape mirrors Cycle 8 `tkt_ticket_activity` and Cycle 10 `hlth_health_access_log`).

Outer ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state — final SELECTs confirm `(caseloads_remaining=0, referral_types_remaining=0, referrals_remaining=0)` for the smoke names.

**FK action verification via `pg_constraint.confdeltype` (tenant_demo schema):**

```
svc_caseloads_academic_year_id_fkey       NO ACTION
svc_caseloads_counselor_id_fkey           NO ACTION
svc_caseloads_student_id_fkey             CASCADE
svc_referral_activity_referral_id_fkey    CASCADE
svc_referrals_assigned_counselor_id_fkey  SET NULL
svc_referrals_referral_type_id_fkey       NO ACTION
svc_referrals_referred_by_fkey            NO ACTION
svc_referrals_student_id_fkey             CASCADE
```

All 8 actions match the migration's declared intent. 5 NO ACTION + 2 CASCADE + 1 SET NULL.

**Sanity counts on `tenant_demo`:**

- 4 logical `svc_*` base tables added in Cycle 11 Step 1 (joining the 3 from Cycle 9).
- 8 rows in `pg_constraint` for the new FKs (one per logical FK; no partition replication since none of these tables are partitioned).
- 0 cross-schema FKs.
- Idempotent re-provision is a clean no-op on the SQL — both `tenant_demo` and `tenant_test` survived a second `provision` run with no new DDL applied.

**Splitter `;`-in-string trap not tripped** — Python state-machine audit (block-comment + line-comment + single-quoted-string aware with `''` escape handling) reports zero `;` outside legitimate statement terminators on the first attempt. The COMMENT strings on the partial UNIQUE keystones, the 7-state status enum, and the 6-value activity_type enum were drafted with periods, em-dashes, and "and" instead of semicolons from the start.

**Out of scope this step (deferred to Step 5):** the request-path API. The schema ships now; `CaseloadService`, `ReferralService`, `ReferralActivityService`, and `ReferralTypeService` land in Step 5 along with the referral lifecycle state machine + the `svc.referral.created` Kafka emit.

---

## Step 2 — Sessions + Notes + MTSS Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-04. Idempotent re-provision verified (zero new applies on the second run). Splitter-clean — Python audit script confirmed zero `;` outside legitimate statement terminators on the first attempt. Eleventh migration in a row to clear the splitter trap (Cycles 4–11 unbroken streak). The largest schema migration of Cycle 11 — 8 tables in one file completing the counselling-session and MTSS/RTI tier surface.

**Migration:** `packages/database/prisma/tenant/migrations/037_svc_sessions_mtss.sql`.

**Tables (8):**

1. **`svc_sessions`** — Per-counsellor session log. `school_id`, `counselor_id` NOT NULL FK to `hr_employees(id)` NO ACTION (refuses delete of a counsellor with sessions on the log — preserves audit value), `session_date DATE NOT NULL`, `duration_minutes INT` with CHECK `IS NULL OR > 0`, `session_type TEXT NOT NULL` 6-value CHECK `INDIVIDUAL / GROUP / CRISIS / CHECK_IN / PARENT_MEETING / CONSULTATION`, `primary_caseload_id UUID` FK to `svc_caseloads(id)` ON DELETE SET NULL nullable (identifies the student for INDIVIDUAL sessions; null for GROUP — the Step 6 service validates the shape at the application layer), `referral_id UUID` FK to `svc_referrals(id)` ON DELETE SET NULL nullable (set when a session follows from an accepted referral; SET NULL preserves the session log past referral cleanup), `status TEXT NOT NULL DEFAULT 'SCHEDULED'` 4-value CHECK `SCHEDULED / COMPLETED / NO_SHOW / CANCELLED`. INDEX `(counselor_id, session_date DESC)` for the counsellor's session log hot path. **Partial INDEX `(primary_caseload_id) WHERE primary_caseload_id IS NOT NULL`** for the per-caseload session history join.

2. **`svc_session_participants`** — Links students to sessions. `session_id` NOT NULL FK to `svc_sessions(id)` ON DELETE CASCADE (a participant has no meaning without its session), `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE, `caseload_id UUID` FK to `svc_caseloads(id)` ON DELETE SET NULL nullable, `attendance_status TEXT NOT NULL DEFAULT 'ATTENDED'` 3-value CHECK `ATTENDED / NO_SHOW / LATE`. **UNIQUE INDEX `(session_id, student_id)`** so a student appears at most once per session. INDEX `(student_id, session_id)` for the per-student session history join.

3. **`svc_session_notes`** — **FERPA-protected counselling record.** `session_id` NOT NULL FK CASCADE, `student_id` NOT NULL FK CASCADE, `notes_text TEXT NOT NULL`, `goals_addressed TEXT[]` nullable, `follow_up_required BOOLEAN NOT NULL DEFAULT false`, `follow_up_notes TEXT` nullable, `is_locked BOOLEAN NOT NULL DEFAULT false`, `locked_at TIMESTAMPTZ` nullable, `locked_by UUID` FK to `hr_employees(id)` ON DELETE SET NULL nullable. **UNIQUE INDEX `(session_id, student_id)`** so a GROUP session can carry one note per participant student. **Multi-column `svc_session_notes_locked_chk` keystone** pins the lock state to one of two shapes — unlocked requires `is_locked=false AND locked_at IS NULL AND locked_by IS NULL`; locked requires `is_locked=true AND locked_at IS NOT NULL AND locked_by IS NOT NULL`. Any other combination is rejected. The Step 6 `SessionNoteService` gates every read on the dedicated permission `student_counseling_record:read` granted only to Staff and Admin in the Step 4 IAM seed. Once locked the Step 6 PATCH endpoint refuses any update with 400. **There is no unlock endpoint by design.**

4. **`svc_mtss_tiers`** — Per-(student, year, domain) MTSS / RTI tier assignment. `school_id`, `student_id` NOT NULL FK CASCADE, `academic_year_id` NOT NULL FK to `sis_academic_years(id)` NO ACTION, `tier TEXT NOT NULL` 3-value CHECK `TIER_1 / TIER_2 / TIER_3`, `domain TEXT NOT NULL` 4-value CHECK `ACADEMIC / BEHAVIORAL / SOCIAL_EMOTIONAL / ATTENDANCE`, `assigned_by` NOT NULL FK to `hr_employees(id)` NO ACTION (audit value preserved), `assigned_at DATE NOT NULL`, `review_date DATE NOT NULL`, `exit_date DATE` nullable, `exit_reason TEXT` nullable, `status TEXT NOT NULL DEFAULT 'ACTIVE'` 4-value CHECK `ACTIVE / EXITED / PROMOTED / DEMOTED`. **Partial UNIQUE INDEX `svc_mtss_tiers_active_uq` on `(student_id, academic_year_id, domain) WHERE status='ACTIVE'`** pins exactly one active tier per (student, year, domain). When a tier is exited or promoted or demoted the row stays for history while the partial UNIQUE releases. INDEX `(school_id, tier, status)` for the Step 9 dashboard tier-distribution rollup. INDEX `(student_id, academic_year_id)` for the per-student profile cross-cycle lookup. The Step 7 `MtssTierService` emits `svc.tier.changed` on every status flip and tier value change.

5. **`svc_interventions`** — Per-tier targeted support. `tier_id` NOT NULL FK to `svc_mtss_tiers(id)` ON DELETE CASCADE, `intervention_name TEXT NOT NULL`, `intervention_type TEXT NOT NULL` 6-value CHECK `ACADEMIC_SUPPORT / BEHAVIORAL_SUPPORT / SOCIAL_EMOTIONAL_LEARNING / ATTENDANCE_SUPPORT / COUNSELING / EXTERNAL_SERVICE`, `frequency TEXT` nullable (free-form e.g. "2x per week, 30 minutes"), `start_date DATE NOT NULL`, `end_date DATE` nullable, `provider_id UUID` FK to `hr_employees(id)` ON DELETE SET NULL nullable, `status TEXT NOT NULL DEFAULT 'ACTIVE'` 3-value CHECK `ACTIVE / COMPLETED / DISCONTINUED`. **Multi-column `svc_interventions_dates_chk`** enforces `end_date >= start_date` only when both are set. INDEX `(tier_id, status)`.

6. **`svc_intervention_progress`** — Append-only progress monitoring. `intervention_id` NOT NULL FK CASCADE, `recorded_by` NOT NULL FK to `hr_employees(id)` NO ACTION (refuses delete of an employee with progress entries — append-only audit), `recorded_date DATE NOT NULL`, `measure_type TEXT NOT NULL` (free-form e.g. "Office Referrals per Week"), `score NUMERIC(8,2)` nullable, `benchmark NUMERIC(8,2)` nullable (target value if any), `notes TEXT` nullable. INDEX `(intervention_id, recorded_date DESC)` for the Step 9 time-series chart on the MTSS detail page. The Step 7 `InterventionService.logProgress` is the only writer; no UPDATE method, no DELETE method exposed at the service layer.

7. **`svc_mtss_team_meetings`** — RTI team review meeting. `school_id`, `meeting_id UUID` nullable (soft ref to the future `mtg_meetings` table — no DB FK because the target does not exist yet), `academic_year_id` NOT NULL FK NO ACTION, `facilitated_by` NOT NULL FK to `hr_employees(id)` NO ACTION (audit value preserved), `meeting_date DATE NOT NULL`, `notes TEXT` nullable. INDEX `(school_id, meeting_date DESC)` for the Step 9 admin meeting history.

8. **`svc_mtss_team_meeting_students`** — Students reviewed at a meeting. `team_meeting_id` NOT NULL FK CASCADE, `student_id` NOT NULL FK CASCADE, `tier_id UUID` FK to `svc_mtss_tiers(id)` ON DELETE SET NULL nullable (captures which tier the student was on at the time of the meeting; SET NULL preserves the historical record when the tier row is dropped), `outcome TEXT` nullable 5-value CHECK `outcome IS NULL OR outcome IN (NO_CHANGE, TIER_UP, TIER_DOWN, EXIT, CONTINUE_WITH_ADJUSTMENT)`, `outcome_notes TEXT` nullable. **UNIQUE INDEX `(team_meeting_id, student_id)`** so a student appears at most once per meeting agenda. NULL outcome is the in-progress meeting state where the student has been added to the agenda but the team has not yet decided.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `svc_sessions.school_id → platform.schools(id)`
- `svc_mtss_tiers.school_id → platform.schools(id)`
- `svc_mtss_team_meetings.school_id → platform.schools(id)`
- `svc_mtss_team_meetings.meeting_id → mtg_meetings(id)` (forward-compat soft, no DB FK because the target does not exist yet — will be tightened when the M68 Meetings module ships)

**FK summary — 21 new intra-tenant DB-enforced FKs:**

| FK                                                                            | Action    |
| ----------------------------------------------------------------------------- | --------- |
| `svc_sessions.counselor_id → hr_employees(id)`                                | NO ACTION |
| `svc_sessions.primary_caseload_id → svc_caseloads(id)`                        | SET NULL  |
| `svc_sessions.referral_id → svc_referrals(id)`                                | SET NULL  |
| `svc_session_participants.session_id → svc_sessions(id)`                      | CASCADE   |
| `svc_session_participants.student_id → sis_students(id)`                      | CASCADE   |
| `svc_session_participants.caseload_id → svc_caseloads(id)`                    | SET NULL  |
| `svc_session_notes.session_id → svc_sessions(id)`                             | CASCADE   |
| `svc_session_notes.student_id → sis_students(id)`                             | CASCADE   |
| `svc_session_notes.locked_by → hr_employees(id)`                              | SET NULL  |
| `svc_mtss_tiers.student_id → sis_students(id)`                                | CASCADE   |
| `svc_mtss_tiers.academic_year_id → sis_academic_years(id)`                    | NO ACTION |
| `svc_mtss_tiers.assigned_by → hr_employees(id)`                               | NO ACTION |
| `svc_interventions.tier_id → svc_mtss_tiers(id)`                              | CASCADE   |
| `svc_interventions.provider_id → hr_employees(id)`                            | SET NULL  |
| `svc_intervention_progress.intervention_id → svc_interventions(id)`           | CASCADE   |
| `svc_intervention_progress.recorded_by → hr_employees(id)`                    | NO ACTION |
| `svc_mtss_team_meetings.academic_year_id → sis_academic_years(id)`            | NO ACTION |
| `svc_mtss_team_meetings.facilitated_by → hr_employees(id)`                    | NO ACTION |
| `svc_mtss_team_meeting_students.team_meeting_id → svc_mtss_team_meetings(id)` | CASCADE   |
| `svc_mtss_team_meeting_students.student_id → sis_students(id)`                | CASCADE   |
| `svc_mtss_team_meeting_students.tier_id → svc_mtss_tiers(id)`                 | SET NULL  |

7 NO ACTION + 9 CASCADE + 5 SET NULL. 0 cross-schema FKs.

**Tenant logical base table count after Step 2:** 159 → **167** (8 new logical base tables). Cycle 11 running tally: 12 logical svc\_\* tables, 29 intra-tenant FKs (8 from Step 1 + 21 from Step 2), 0 cross-schema FKs.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 35 assertions, all green):**

1. **T1 session happy path** — INSERT `svc_sessions` (Hayes / 2026-04-15 / 45min / INDIVIDUAL / primary_caseload populated / COMPLETED) succeeds.
2. **T2 session_type CHECK** — `svc_sessions_type_chk` rejects `session_type='BOGUS'`.
3. **T3 session status CHECK** — `svc_sessions_status_chk` rejects `status='BOGUS'`.
4. **T4 duration_chk** — `svc_sessions_duration_chk` rejects `duration_minutes=0`.
5. **T5 FK reject** — `svc_sessions_counselor_id_fkey` rejects bogus counselor_id.
6. **T6 all 6 session_type + 4 status values accepted** — 5 inserts in one block (GROUP/SCHEDULED, CRISIS/COMPLETED, CHECK_IN/NO_SHOW, PARENT_MEETING/CANCELLED, CONSULTATION/SCHEDULED); total session count grows to 6.
7. **T7 participant happy path** — INSERT `svc_session_participants` for the GROUP session.
8. **T8 attendance CHECK** — `svc_session_participants_attendance_chk` rejects `attendance_status='BOGUS'`.
9. **T9 participant UNIQUE** — `svc_session_participants_session_student_uq` rejects duplicate `(session_id, student_id)`.
10. **T10 session_notes happy path unlocked** — INSERT `svc_session_notes` with `is_locked=false` succeeds; verifies `(is_locked=false, has_locked_at=false, has_locked_by=false)`.
11. **T11 locked_chk** — UPDATE `is_locked=true` with locked_at NULL rejected.
12. **T12 locked_chk** — UPDATE `is_locked=true, locked_at=now()` with locked_by NULL rejected.
13. **T13 locked_chk** — INSERT with `is_locked=false, locked_at=now()` rejected (false branch requires both NULL).
14. **T14 locked_chk happy path** — UPDATE all 3 lock columns together accepted; final state `(is_locked=true, has_locked_at=true, has_locked_by=true)`.
15. **T15 notes UNIQUE** — `svc_session_notes_session_student_uq` rejects 2nd note for same (session, student) pair.
16. **T16 mtss_tiers tier CHECK** — `svc_mtss_tiers_tier_chk` rejects `tier='BOGUS'`.
17. **T17 mtss_tiers domain CHECK** — `svc_mtss_tiers_domain_chk` rejects `domain='BOGUS'`.
18. **T18 mtss_tiers happy path** — TIER_2 BEHAVIORAL ACTIVE for Maya in AY1.
19. **T19 partial UNIQUE active_uq fires** — 2nd ACTIVE BEHAVIORAL tier for same (student, year) rejected by `svc_mtss_tiers_active_uq`.
20. **T20 partial UNIQUE allows different domain** — TIER_2 ACADEMIC for Maya in AY1 accepted (Maya now has 2 active tiers across domains).
21. **T21 EXITED status releases the BEHAVIORAL slot** — UPDATE BEHAVIORAL tier to EXITED then INSERT new TIER_3 BEHAVIORAL ACTIVE succeeds; final `(active=1, exited=1)`.
22. **T22 intervention happy path** — Social Skills Group BEHAVIORAL_SUPPORT ACTIVE under the new BEHAVIORAL tier.
23. **T23 intervention_type CHECK** — `svc_interventions_type_chk` rejects `intervention_type='BOGUS'`.
24. **T24 intervention dates_chk** — rejects `end_date < start_date`.
25. **T25 progress happy path** — INSERT `svc_intervention_progress` with measure_type='Office Referrals per Week', score=2.00, benchmark=1.00.
26. **T26 progress NO ACTION on recorded_by** — verified via `pg_constraint.confdeltype='a'` catalog readout.
27. **T27 team_meeting happy path** — Hayes facilitates 2026-04-15 RTI review.
28. **T28 team_meeting_students with outcome** — Maya CONTINUE_WITH_ADJUSTMENT linked to her ACTIVE BEHAVIORAL tier.
29. **T29 outcome CHECK** — `svc_mtss_team_meeting_students_outcome_chk` rejects `outcome='BOGUS'`.
30. **T30 outcome NULL accepted** — Ethan added to meeting agenda with NULL outcome (in-progress state).
31. **T31 team_meeting_students UNIQUE** — `svc_mtss_team_meeting_students_uq` rejects duplicate `(meeting, student)`.
32. **T32 CASCADE on session delete** — DELETE `svc_sessions` row drops both the linked `svc_session_notes` row and the `svc_session_participants` row in one statement (orphan_notes=0, orphan_participants=0).
33. **T33 CASCADE on tier delete** — DELETE `svc_mtss_tiers` row drops the linked `svc_interventions` row, which in turn cascades to drop the `svc_intervention_progress` rows (orphan_interventions=0).
34. **T34 SET NULL on caseload delete** — DELETE `svc_caseloads` row clears `svc_sessions.primary_caseload_id` (final value: NULL).
35. **T35 CASCADE on team_meeting delete** — DELETE `svc_mtss_team_meetings` drops both Maya + Ethan meeting-student rows in one statement (orphan_team_meeting_students=0).

Outer ROLLBACK at the end leaves `tenant_demo` in pristine state — final SELECTs confirm `(sessions_remaining=0, mtss_tiers_remaining=0, caseloads_remaining=0)`.

**FK action verification via `pg_constraint.confdeltype` (tenant_demo schema, 21 rows):** 7 NO ACTION ('a') + 9 CASCADE ('c') + 5 SET NULL ('n'). All match the migration's declared intent.

**Sanity counts on `tenant_demo`:**

- 8 logical `svc_*` base tables added in Cycle 11 Step 2 (joining 4 from Step 1 + 3 from Cycle 9).
- 21 rows in `pg_constraint` for the new FKs (one per logical FK; no partition replication).
- 0 cross-schema FKs.
- Idempotent re-provision is a clean no-op on the SQL — both `tenant_demo` and `tenant_test` survived a second `provision` run with no new DDL applied.

**Splitter `;`-in-string trap not tripped** — Python state-machine audit reports zero `;` outside legitimate statement terminators on the first attempt. The COMMENT strings on the FERPA contract, the multi-column `locked_chk` invariant, and the partial UNIQUE keystones were drafted with periods, em-dashes, and "and" instead of semicolons from the start.

**Iteration issue caught during smoke (test-data only, not a service-layer issue):** initial smoke script used `:RIVERA` (an `hr_employees.id`) as a `student_id` in T29/T30, which the FK rightly rejected. Rewrote the smoke to use a real second student (Ethan Rodriguez via `019dd544-7e07-…`) and re-ran cleanly.

**Out of scope this step (deferred to Step 6):** the request-path API. The schema ships now; `SessionService`, `SessionNoteService`, and the FERPA gate on `student_counseling_record:read` land in Step 6 alongside the irreversible note-locking endpoint and the GROUP-vs-INDIVIDUAL session shape validation.

---

## Step 3 — Coordinated Care + Mandatory Reporting Schema

**Status:** DONE. Migration applied cleanly to `tenant_demo` and `tenant_test` on 2026-05-04. Idempotent re-provision verified — the FK backfill uses the `DROP CONSTRAINT IF EXISTS` followed by `ADD CONSTRAINT` pattern from CLAUDE.md so a second `provision` run is a clean no-op. Splitter-clean — Python audit script confirmed zero `;` outside legitimate statement terminators on the first attempt. Twelfth migration in a row to clear the splitter trap (Cycles 4–11 unbroken streak). Cycle 11 schema phase complete with this migration.

**Migration:** `packages/database/prisma/tenant/migrations/038_svc_coordinated_care_mandatory.sql`.

**Tables (2) + 1 FK backfill on `svc_behavior_plans`:**

1. **`svc_coordinated_care_notes`** — Shared observation thread between the nurse and counsellor teams. `student_id` NOT NULL FK to `sis_students(id)` ON DELETE CASCADE (consistent with the student-referencing convention), `author_person_id UUID NOT NULL` (soft to `platform.iam_person(id)` per ADR-001 — captures the author person id stamped from `actor.personId`; the Step 7 service-layer write path never trusts caller input for this column), `author_role TEXT NOT NULL` 2-value CHECK `NURSE / COUNSELLOR`, `note_text TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. INDEX `(student_id, created_at DESC)` for the chronological thread query. The Step 7 `CoordinatedCareService` gates every read on the **intersection** of `hlt-001:read` AND `cou-007:read` — an actor missing either permission gets 403. Teachers and parents always 403. The 2-value `author_role` CHECK is also a service-side validator: the Step 7 service refuses an insert where the value does not match the actor's actual role.

2. **`svc_mandatory_reports`** — CPS-filing log. `student_id` NOT NULL FK to `sis_students(id)` **NO ACTION** (enforces retention — refuses delete of a student with mandatory reports and forces admin to archive the audit trail first; mirrors `hlth_health_access_log` from Cycle 10), `reporter_person_id UUID NOT NULL` (soft to `platform.iam_person(id)` per ADR-001), `report_type TEXT NOT NULL` 4-value CHECK `SUSPECTED_ABUSE / SUSPECTED_NEGLECT / IMMINENT_DANGER / OTHER`, `reported_to_authority TEXT NOT NULL`, `report_date TIMESTAMPTZ NOT NULL`, `description TEXT NOT NULL`, `supporting_docs_s3_keys TEXT[]` nullable (signed S3 keys for evidentiary documents), `cps_response TEXT` nullable, `status TEXT NOT NULL DEFAULT 'FILED'` 4-value CHECK `FILED / CPS_CONTACTED / INVESTIGATION_ACTIVE / CLOSED`. INDEX `(student_id, report_date DESC)` for the per-student history. INDEX `(status)` for the admin status-filtered queue. **IMMUTABLE once past FILED** — service-side discipline: the Step 7 `MandatoryReportService` PATCH endpoint refuses any change to `description` / `report_type` / `reported_to_authority` / `report_date` with 400 "Mandatory report core fields are immutable once filed." Only `cps_response` and `status` can be updated as the case evolves. Reports are retained permanently per the M27 ERD.

3. **FK backfill on `svc_behavior_plans`** — `ALTER TABLE svc_behavior_plans DROP CONSTRAINT IF EXISTS svc_behavior_plans_caseload_id_fkey; ALTER TABLE svc_behavior_plans ADD CONSTRAINT svc_behavior_plans_caseload_id_fkey FOREIGN KEY (caseload_id) REFERENCES svc_caseloads(id) ON DELETE SET NULL`. The Cycle 9 `caseload_id` column was forward-compatibly declared as a soft ref (UUID with no FK) because `svc_caseloads` did not exist yet. Cycle 11 Step 1 introduced `svc_caseloads`. Step 3 tightens the ref into a real DB-enforced FK with `ON DELETE SET NULL` so the BIP is preserved when its caseload is closed and cleaned up. The `DROP CONSTRAINT IF EXISTS` followed by `ADD CONSTRAINT` pattern is splitter-safe (no DO blocks with embedded semicolons) and idempotent. The Step 4 seed will populate Maya's BIP `caseload_id` to point at the seeded `svc_caseloads` row Hayes assigned to Maya — completing the cross-cycle integration.

**Soft cross-schema refs per ADR-001 / ADR-020:**

- `svc_coordinated_care_notes.author_person_id → platform.iam_person(id)` (soft per ADR-001)
- `svc_mandatory_reports.reporter_person_id → platform.iam_person(id)` (soft per ADR-001)

**FK summary — 3 new intra-tenant DB-enforced FKs:**

| FK                                                              | Action    |
| --------------------------------------------------------------- | --------- |
| `svc_coordinated_care_notes.student_id → sis_students(id)`      | CASCADE   |
| `svc_mandatory_reports.student_id → sis_students(id)`           | NO ACTION |
| `svc_behavior_plans.caseload_id → svc_caseloads(id)` (backfill) | SET NULL  |

0 cross-schema FKs.

**Tenant logical base table count after Step 3:** 167 → **169** (2 new logical base tables).

**Cycle 11 schema phase complete:** 14 new tables + 1 FK backfill across migrations 036 (4 tables), 037 (8 tables), 038 (2 tables + 1 FK backfill). Cycle 11 running tally: 14 logical svc\_\* tables, 32 intra-tenant FKs (8 + 21 + 3), 0 cross-schema FKs.

**Smoke results (live on `tenant_demo`, single BEGIN…ROLLBACK transaction with savepoints, 16 assertions, all green):**

1. **T1 coordinated_care happy path NURSE** — INSERT with author_role='NURSE' succeeds.
2. **T2 role_chk** — `svc_coordinated_care_notes_role_chk` rejects `author_role='BOGUS'`.
3. **T3 role_chk** — `svc_coordinated_care_notes_role_chk` rejects `author_role='TEACHER'` (teachers cannot be authors of coordinated care notes by schema design — the gate is COUNSELLOR or NURSE only).
4. **T4 coordinated_care happy path COUNSELLOR** — INSERT with author_role='COUNSELLOR' succeeds; both roles count grows to 2.
5. **T5 coordinated_care FK** — `svc_coordinated_care_notes_student_id_fkey` rejects bogus student_id.
6. **T6 mandatory_reports happy path FILED** — INSERT with default `status='FILED'` succeeds.
7. **T7 report_type CHECK** — `svc_mandatory_reports_type_chk` rejects `report_type='BOGUS'`.
8. **T8 report status CHECK** — `svc_mandatory_reports_status_chk` rejects `status='BOGUS'`.
9. **T9 all 4 report_type + 4 status values accepted** — single block with SUSPECTED_ABUSE/IMMINENT_DANGER/OTHER/SUSPECTED_NEGLECT × FILED/CPS_CONTACTED/INVESTIGATION_ACTIVE/CLOSED.
10. **T10 lifecycle UPDATE** — FILED → CPS_CONTACTED with `cps_response` populated; final state `(status=CPS_CONTACTED, has_response=true)`. Service-side immutability check on description / report_type / reported_to_authority / report_date is enforced by the Step 7 MandatoryReportService — schema permits the columns to be UPDATEd because retention enforcement and column-level immutability are separate concerns; the service is the only writer.
11. **T11 NO ACTION on student delete with mandatory reports** — verified via `pg_constraint.confdeltype='a'` catalog readout (a real DELETE on Maya would fail at the live DB because Maya has many other dependent rows from prior cycles; the catalog readout is the canonical verification for this kind of delete-action invariant).
12. **T12 supporting_docs_s3_keys array** — 2-element TEXT[] inserted and read back with `cardinality=2`.
13. **T13 BIP caseload_id FK backfill catalog** — `pg_constraint.confdeltype='n'` confirms SET NULL on `svc_behavior_plans_caseload_id_fkey`.
14. **T14 BIP caseload_id FK rejects bogus value** — INSERT BIP with caseload_id pointing at a non-existent UUID rejected by `svc_behavior_plans_caseload_id_fkey`.
15. **T15 BIP caseload_id SET NULL keystone** — INSERT real caseload + INSERT BIP with caseload_id populated → DELETE caseload → re-read BIP shows `caseload_id=NULL` (the SET NULL action fired correctly; the BIP row is preserved).
16. **T16 CASCADE on coordinated_care_notes via student delete** — verified via `pg_constraint.confdeltype='c'` catalog readout.

Outer ROLLBACK at the end of the smoke leaves `tenant_demo` in pristine state — final SELECTs confirm `(coord_care_remaining=0, reports_remaining=0, caseloads_remaining=0, bips_remaining=0)` for the smoke names.

**Sanity counts on `tenant_demo`:**

- 17 total `svc_*` base tables (3 from Cycle 9 + 4 from Cycle 11 Step 1 + 8 from Step 2 + 2 from Step 3).
- 32 intra-tenant FKs across the cycle (8 + 21 + 3).
- 0 cross-schema FKs.
- Idempotent re-provision is a clean no-op on the SQL — both `tenant_demo` and `tenant_test` survived a second `provision` run with no new DDL applied. The DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern on the FK backfill correctly drops then re-adds the FK on each run without erroring.

**Splitter `;`-in-string trap not tripped** — Python state-machine audit reports zero `;` outside legitimate statement terminators on the first attempt.

**Iteration issues caught during smoke (test-data only, not service-layer):** initial T6 SQL mixed `count(*)` aggregate with non-aggregate `status` without GROUP BY (rewrote with two scalar subqueries); T14/T15 forgot the Cycle 9 `svc_behavior_plans.review_date NOT NULL` requirement (added `review_date='2026-12-01'` to both insert paths and re-ran cleanly).

**Out of scope this step (deferred to Step 4):** the seed data. The schema ships now with the `caseload_id` FK in place; Step 4 will INSERT the seed `svc_caseloads` row for Maya and **backfill** Cycle 9 Maya's BIP to point at the new caseload via `UPDATE svc_behavior_plans SET caseload_id = ... WHERE student_id = ...`.

---

## Step 4 — Seed Data — Caseloads, Referral, Sessions, MTSS, Permissions

**Status:** DONE. New `seed:counselling` script ran cleanly on `tenant_demo` 2026-05-04. All 7 sections seeded with the row counts the plan specified. Idempotent re-run logs `svc_referral_types already populated for demo school — skipping` and exits with no INSERTs. `tenant_test` stays empty by convention. The IAM catalogue grew from 447 → **450** permissions. The new FERPA gate `student_counseling_record:read` is correctly distributed: admin / principal / vp / counsellor (Staff + Admin) hold it; teacher / parent / student do not.

**New seed:** `packages/database/src/seed-counselling.ts` (idempotent, gated on `svc_referral_types` row count for the demo school) wired as `seed:counselling` in `packages/database/package.json`.

**`packages/database/data/permissions.json` updated:** new entry under "Counselling & Student Support":

```json
{
  "code": "student_counseling_record",
  "name": "Counselling Session Notes (FERPA)",
  "group": "Counselling & Student Support"
}
```

This is the **only** permission code in the catalogue that does not follow the `XXX-NNN` convention — it is a deliberate FERPA gate name that controllers will reference verbatim as `@RequirePermission('student_counseling_record:read')`. Catalogue total: 149 → **150 functions × 3 tiers = 450 permissions**.

**`packages/database/src/seed-iam.ts` updates:**

- **Teacher** gains `COU-002:read+write` (was just `write` — submit AND track own referrals; row scope at the Step 5 ReferralService limits non-counsellor reads to own submitted referrals) + `COU-005:read` (accommodation info — already covered by ADR-030 read model + accommodations panel; this code is the catalogue tag) + `COU-006:write` (every employee is a mandated reporter). Teachers do **not** receive `student_counseling_record:read`. Net: 42 → 45 permissions cached (+3).
- **Parent** gains `COU-001:read` (caseload assignment summary only — counsellor name and primary concern; no notes). Parents receive **no** other COU code. Net: 22 → 23 permissions cached (+1).
- **Staff** gains COU-001..003 read+write + COU-005..007 read+write + `student_counseling_record:read`. Covers counsellor + VP + admin assistant. Net: 34 → 47 permissions cached (+13: 6 codes × 2 tiers = 12, plus the 1 FERPA gate).
- **School Admin** + **Platform Admin** already hold every code via `everyFunction: ['read','write','admin']`. Net: 447 → 450 permissions cached (+3 from the new `student_counseling_record:read/write/admin` triplet).
- **Student** unchanged at 19 permissions cached.

After `tsx src/build-cache.ts`: 7 account-scope pairs — admin/principal **450**, teacher **45**, vp/counsellor **47**, student **19**, parent **23**.

**Live verification of FERPA gate distribution** on `tenant_demo` via `iam_effective_access_cache`:

```
admin@        student_counseling_record:read=true
principal@    student_counseling_record:read=true
counsellor@   student_counseling_record:read=true
vp@           student_counseling_record:read=true
teacher@      student_counseling_record:read=false
parent@       student_counseling_record:read=false
student@      student_counseling_record:read=false
```

Exactly the contract: 4 of 7 personas hold the FERPA gate (the 4 who are Staff or Admin); the other 3 (teacher / parent / student) do not.

**What gets seeded (7 sections):**

1. **2 referral types** — `Social/Emotional` (default_priority=MEDIUM, requires_parent_notification=true) and `Academic Concern` (default_priority=LOW, requires_parent_notification=false). Both for Lincoln Elementary.

2. **1 caseload + Cycle 9 BIP `caseload_id` backfill keystone** — Marcus Hayes (counsellor) assigned to Maya Chen for the 2025-2026 academic year, `is_primary_counselor=true`, `primary_concern=SOCIAL_EMOTIONAL`, `status=ACTIVE`, `opened_at=2025-09-15`. **The seed then runs `UPDATE svc_behavior_plans SET caseload_id = <new_caseload_id> WHERE student_id = Maya AND status='ACTIVE' AND caseload_id IS NULL`** — landing 1 row updated. This is the cross-cycle integration moment the Cycle 9 plan documented for Cycle 11: the previously-soft `svc_behavior_plans.caseload_id` ref now points at a real `svc_caseloads.id`, the Step 3 FK enforces it, and the Step 5 BIP UI will surface the linked caseload counsellor + concern on the BIP detail page.

3. **1 referral + 1 referral_activity** — James Rivera refers Maya for Social/Emotional with reason "Struggling with peer relationships and declining academic performance. Shows signs of social withdrawal during group activities. Has not initiated peer interactions in the last three group projects despite prompts." Priority=MEDIUM, status=ACCEPTED, `assigned_counselor_id=Hayes`, `parent_notified=true` with `parent_notified_at` populated. Activity row: `STATUS_CHANGE` captured at acceptance with notes from Hayes ("Reviewed and accepted. Caseload assignment already active for Maya. Will follow up via 1:1 sessions over the next month.").

4. **2 sessions + 2 session notes** —
   - **Session 1**: INDIVIDUAL, COMPLETED, 45 min, 3 weeks ago (today−21d), linked to Maya's caseload AND her referral. Note 1 with `notes_text` covering peer relationship strategies, `goals_addressed=['Peer relationship building','Social skills development']`, `follow_up_required=true`, `follow_up_notes` populated.
   - **Session 2**: CHECK_IN, COMPLETED, 15 min, 1 week ago (today−7d), linked to Maya's caseload. Note 2 brief follow-up reporting positive interaction during science lab. `goals_addressed=['Peer relationship building']`, `follow_up_required=false`.
   - Both notes ship `is_locked=false` so the Step 6 SessionNoteService can exercise the irreversible-lock path against fresh seed data.

5. **1 MTSS tier + 1 intervention + 1 progress** —
   - **Tier**: Maya `TIER_2 BEHAVIORAL ACTIVE`, assigned by Hayes 2025-10-01, `review_date=today+30d`.
   - **Intervention**: "Social Skills Group" `BEHAVIORAL_SUPPORT`, frequency "2x per week, 30 minutes", start_date=2025-10-15, ACTIVE, provider=Hayes.
   - **Progress entry**: recorded last week (today−7d), `measure_type='Office Referrals per Week'`, `score=2.00`, `benchmark=1.00`, notes "Down from 4 at baseline. Steady improvement over the last three review windows." Drives the Step 9 time-series chart on the MTSS detail page.

6. **1 coordinated care note** — Hayes (COUNSELLOR) writes about Maya's anxiety around health episodes that may be related to peer teasing about her inhaler use. Demonstrates the Step 7 nurse + counsellor intersection-gated thread (parents and teachers never see this note).

**Live counts on `tenant_demo` after seed:**

| Table                                                    | Rows |
| -------------------------------------------------------- | ---: |
| svc_referral_types                                       |    2 |
| svc_caseloads                                            |    1 |
| svc_behavior_plans (caseload_id linked, the Cycle 9 BIP) |    1 |
| svc_referrals                                            |    1 |
| svc_referral_activity                                    |    1 |
| svc_sessions                                             |    2 |
| svc_session_notes                                        |    2 |
| svc_mtss_tiers                                           |    1 |
| svc_interventions                                        |    1 |
| svc_intervention_progress                                |    1 |
| svc_coordinated_care_notes                               |    1 |

All match the plan exactly. **Idempotent re-run** logs `svc_referral_types already populated for demo school — skipping` and exits without INSERTs. `tenant_test` stays empty by convention.

**Reusable lookup helpers** mirror the seed-behaviour.ts and seed-health.ts patterns: `findEmployeeId(email)` joins `hr_employees → iam_person → platform_users` for the four staff personas; `findStudentIdByName(first, last)` joins `sis_students → platform_students → iam_person`; `findEmployeePersonId(email)` resolves to `iam_person.id` (used for `author_person_id` on the coordinated care note since it's a soft ref to platform.iam_person, not to hr_employees); `findAccountId(email)` resolves to `platform_users.id` for the `actor_id` soft ref on the referral activity row.

**Out of scope this step (deferred to Step 5):** the request-path API. The schema and seed land now; `CaseloadService`, `ReferralService`, `ReferralActivityService`, and `ReferralTypeService` ship in Step 5 along with the referral lifecycle state machine and the `svc.referral.created` Kafka emit.

---

## Step 5 — Caseload + Referral NestJS Module

**Status:** DONE. CounsellingModule lands at `apps/api/src/counselling/` with 4 services + 4 controllers + DTO module + module wired into AppModule between HealthRecordsModule and the global guards. **17 endpoints total** (5 caseloads + 9 referrals including the explicit `/start` ACCEPTED → IN_PROGRESS transition + 3 referral-types). 1 Kafka emit topic (`svc.referral.created`). All routes mapped on boot. Live verification on `tenant_demo` 2026-05-04 covered 22 scenarios across 5 personas with the ADR-057 envelope captured live; tenant restored to post-Step-4 seed state.

**Services:**

1. **`CaseloadService`** — 5 endpoints under `cou-001:read` / `cou-001:write`:
   - `GET /counselling/caseloads` (list with row-scope: admin sees all; STAFF own assigned + class-scoped students; GUARDIAN own children's caseloads; STUDENT 403 at gate);
   - `GET /counselling/caseloads/:id` (with inlined `sessionCount` + `lastSessionDate` + `linkedBipId` — the keystone cross-cycle integration where the Cycle 9 BIP's `caseload_id` (backfilled in Step 4) surfaces in the caseload detail);
   - `POST /counselling/caseloads` (counsellor or admin only via the new `hasCounsellorScope(actor)` helper which checks `actor.isSchoolAdmin OR holds cou-001:write` — `cou-001:write` is the canonical counsellor signal in the IAM seed; pre-flights the partial UNIQUE keystone on `(student_id, academic_year_id) WHERE status='ACTIVE' AND is_primary_counselor=true` and surfaces the conflicting caseload id in a friendly 400; supports optional `fromReferralId` to link a freshly-opened caseload to its originating accepted referral);
   - `PATCH /counselling/caseloads/:id` (update concern + notes; admin OR the assigned counsellor only via `assertCanEdit`);
   - `PATCH /counselling/caseloads/:id/close` (locks the row inside `executeInTenantTransaction` with `SELECT ... FOR UPDATE`; stamps `closure_reason` + `closed_at = now()::date` + `status='CLOSED'` in one UPDATE so the partial UNIQUE keystone releases atomically).
   - **Per-row manager check** in `isRowManager(actor, counselor_id)`: admin sees notes on every row; STAFF sees notes only on rows where `counselor_id === actor.employeeId` (so a counsellor sees notes on their own caseloads but a teacher viewing a class-student's caseload sees the row stripped of notes); GUARDIAN/STUDENT never see notes.
   - Internal `createInternal()` helper used by `ReferralService.accept` when the caller asks to auto-open a caseload (`openCaseload=true`) — bypasses the counsellor-scope check (caller already passed cou-002 gate to accept) but preserves the partial UNIQUE pre-flight + concurrency-loser catch via `isUniqueViolation`.

2. **`ReferralService`** — 8 endpoints under `cou-002:read` / `cou-002:write`:
   - `GET /counselling/referrals` (list with row-scope: admin all; STAFF assigned + the unassigned-triage queue (`assigned_counselor_id IS NULL AND status='SUBMITTED'`) + own-submitted; GUARDIAN/STUDENT 403 at gate);
   - `GET /counselling/referrals/:id` (with inlined `activity[]` timeline);
   - `GET /counselling/referrals/:id/activity` (chronological audit timeline; calls `referrals.getById` first to enforce row-scope before returning audit rows);
   - `POST /counselling/referrals` (any STAFF with `employeeId` can submit; stamps `referred_by` from `actor.employeeId`; copies `default_priority` from `assertActive(referralTypeId)`; writes initial STATUS_CHANGE activity row inside the same `executeInTenantTransaction`; emits `svc.referral.created` outside the tx so a broker hiccup doesn't roll back the user's submission);
   - `PATCH /counselling/referrals/:id/triage` (counsellor or admin only via `hasCounsellorScope`; locks row, flips SUBMITTED→TRIAGED with `assigned_counselor_id` populated, writes ASSIGNMENT_CHANGE + STATUS_CHANGE activity rows in same tx);
   - `PATCH /counselling/referrals/:id/accept` (counsellor or admin only; locks row, flips TRIAGED→ACCEPTED, writes STATUS_CHANGE; when `openCaseload=true` calls `caseloads.createInternal` to auto-open a primary caseload AND writes a NOTE_ADDED activity row referencing the new caseload id);
   - `PATCH /counselling/referrals/:id/start` (counsellor or admin only; locks row, flips ACCEPTED→IN_PROGRESS, writes STATUS_CHANGE);
   - `PATCH /counselling/referrals/:id/complete` (counsellor or admin only; locks row, flips IN_PROGRESS or ACCEPTED → COMPLETED with `outcome` populated, writes STATUS_CHANGE);
   - `PATCH /counselling/referrals/:id/decline` (counsellor or admin only; locks row, flips any non-terminal state → DECLINED with `outcome=reason`, writes STATUS_CHANGE).
   - **`hasCounsellorScope(actor)`** mirrors the CaseloadService helper — checks `actor.isSchoolAdmin OR holds cou-001:write`. Teachers hold cou-002:write (so they can submit referrals) but NOT cou-001:write, so the lifecycle endpoints (triage / accept / start / complete / decline) all 403 for teachers at the service layer with the message "Only counsellors or admins can triage referrals" etc.
   - `inferConcern(typeName)` heuristic maps the referral_type name to a `primary_concern` enum value when `openCaseload=true` and the caller doesn't supply `caseloadConcern` — recognises Social/Emotional, Academic, Behavioural, Attendance, Crisis, Transition; falls through to GENERAL.

3. **`ReferralActivityService`** — IMMUTABLE per ADR-010. Sole writer is `recordActivity(tx, referralId, actorAccountId, activityType, notes)` called by every ReferralService status mutation inside the same locked transaction. No UPDATE method, no DELETE method exposed at the service layer. The DB-enforced FK on `referral_id` does CASCADE on parent referral so an emergency hard-delete takes the audit with it (mirrors Cycle 8 `tkt_ticket_activity` and Cycle 10 `hlth_health_access_log`). Read endpoint `GET /counselling/referrals/:id/activity` joins through `platform.platform_users → iam_person` to surface `actorName` on each row.

4. **`ReferralTypeService`** — 3 endpoints + `assertActive(id)` internal helper:
   - `GET /counselling/referral-types` (read on `cou-002:read` — drives the referral form dropdown; supports `?includeInactive=true` for admins);
   - `POST /counselling/referral-types` (admin only on `cou-002:admin` via `everyFunction`; UNIQUE(school_id, name) catch with friendly 400);
   - `PATCH /counselling/referral-types/:id` (admin only; sets is_active=false to soft-deactivate so historical referrals retain their FK while new submissions are blocked).
   - Used by `ReferralService.create` to copy `default_priority` and read the `requires_parent_notification` flag at submission time.

**Authorisation contract:**

- `cou-001:read` — list + read caseloads (Teacher / Parent / Staff / Admin per the IAM seed, with row-scope at the service layer).
- `cou-001:write` — open / patch / close caseloads. Counsellor (Staff) or admin only. **This is the canonical counsellor signal** that Step 5 service-layer checks rely on.
- `cou-002:read` — list + read referrals + activity. Teacher / Staff / Admin per the IAM seed.
- `cou-002:write` — submit referrals (any staff with employeeId, including teachers) + triage / accept / start / complete / decline (counsellor or admin only at the service layer via `hasCounsellorScope`).
- `cou-002:admin` — referral_types catalogue CRUD. Admin only via `everyFunction`.

**Kafka emit:** `svc.referral.created` with `source_module='counselling'`, full ADR-057 envelope shape (event_id, event_type, event_version=1, occurred_at, published_at, tenant_id, correlation_id, payload). Payload includes `referralId`, `sourceRefId` (= referralId, universal escape hatch for the future Cycle 7 TaskWorker fan-out), `schoolId`, `studentId`, `studentName`, `referralTypeId`, `referralTypeName`, `priority`, `requiresParentNotification`, `referredById` (employeeId), `referredByName`, `referredByAccountId`, `reason`, `status: 'SUBMITTED'`. Captured live during the smoke (see envelope detail below).

**Module wiring:** `apps/api/src/counselling/counselling.module.ts` imports `TenantModule` + `IamModule` + `KafkaModule`; registered at index 27 in `AppModule.imports` between `HealthRecordsModule` and the global guards. Build clean (`pnpm --filter @campusos/api build`) on first attempt — no TS errors.

**Routes mapped on boot (verified in `/tmp/api.log`):**

```
CaseloadController {/api/v1/counselling/caseloads}:
  GET  /api/v1/counselling/caseloads
  GET  /api/v1/counselling/caseloads/:id
  POST /api/v1/counselling/caseloads
  PATCH /api/v1/counselling/caseloads/:id
  PATCH /api/v1/counselling/caseloads/:id/close
ReferralController {/api/v1/counselling/referrals}:
  GET   /api/v1/counselling/referrals
  GET   /api/v1/counselling/referrals/:id
  GET   /api/v1/counselling/referrals/:id/activity
  POST  /api/v1/counselling/referrals
  PATCH /api/v1/counselling/referrals/:id/triage
  PATCH /api/v1/counselling/referrals/:id/accept
  PATCH /api/v1/counselling/referrals/:id/start
  PATCH /api/v1/counselling/referrals/:id/complete
  PATCH /api/v1/counselling/referrals/:id/decline
ReferralTypeController {/api/v1/counselling/referral-types}:
  GET   /api/v1/counselling/referral-types
  POST  /api/v1/counselling/referral-types
  PATCH /api/v1/counselling/referral-types/:id
```

**`seed-iam.ts` follow-on (caught during smoke):** Step 4's plan grant for Teacher omitted `COU-001:read`, but the Step 5 visibility contract calls for teachers to see class-scoped caseloads with notes stripped. Added `COU-001:read` to the Teacher role grant (45 → 46 perms cached). The other 6 personas unchanged. The fix is documented inline in `seed-iam.ts` alongside the COU-002/005/006 Teacher grants.

**Live verification on `tenant_demo` 2026-05-04 (22 scenarios across 5 personas, all green):**

- **S1 counsellor GET /caseloads**: count=1, Hayes → Maya SOCIAL_EMOTIONAL with `has_notes=true` (per-row manager check fires correctly because counselor_id === actor.employeeId).
- **S2 parent GET /caseloads**: count=1, Maya only, with `has_notes=false` (GUARDIAN row-scope + strip).
- **S3 teacher GET /caseloads**: count=1, Maya (her class student) with `has_notes=false` (STAFF non-counsellor strip — the per-row manager check returns false because Rivera is not the counsellor of record).
- **S4 admin GET /caseloads/:id**: full detail with `sessionCount=2`, `lastSessionDate=2026-04-27`, **`linkedBipId` populated** — the Cycle 9 BIP correctly resolves via the Step 4 backfill.
- **S5 student GET /caseloads** → 403 (gate; STUDENT does not hold cou-001:read).
- **S6 partial UNIQUE keystone**: counsellor POSTs 2nd primary for Maya → **400 with the conflicting caseload id in the friendly message** (the pre-flight fires; "Student already has a primary counsellor for this academic year (caseload <uuid>). Close that caseload before opening a new primary, or set is_primary_counselor=false to open as a consultant.").
- **S7 second partial UNIQUE keystone**: counsellor POSTs `isPrimaryCounselor=false` for the SAME (counselor, student, year) triple → **400 by `svc_caseloads_active_assignment_uq`**. Switching to a different counsellor (Mitchell as consultant) succeeds; Maya then has 2 active caseloads.
- **S8 PATCH /:id/close**: Mitchell consultant flipped to CLOSED with `closure_reason='Smoke cleanup'` populated; active count drops back to 1.
- **S9 GET /counselling/referral-types**: returns 2 (Academic Concern LOW notify=false, Social/Emotional MEDIUM notify=true).
- **S10 teacher submits referral**: `status=SUBMITTED`, `priority=LOW` (copied from Academic Concern's default), `assignedCounselorId=null` (sits unassigned in triage queue).
- **S11 teacher GET /counselling/referrals**: count=2 (own seeded ACCEPTED Maya/Social/Emotional + new SUBMITTED Ethan/Academic). The OR predicate `referred_by=me OR assigned_counselor_id=me OR (NULL+SUBMITTED)` correctly surfaces both rows.
- **S12 parent GET /counselling/referrals** → 403 (gate; parent does not hold cou-002:read per design — referrals are staff-side).
- **S13 student POST /counselling/referrals** → 403 (gate; cou-002:write not granted).
- **S14 counsellor triages**: SUBMITTED → TRIAGED with assigned_counselor_id=Hayes; ASSIGNMENT_CHANGE + STATUS_CHANGE activity rows written.
- **S15 counsellor accepts**: TRIAGED → ACCEPTED; STATUS_CHANGE activity row written.
- **S16 counsellor starts**: ACCEPTED → IN_PROGRESS.
- **S17 counsellor completes**: IN_PROGRESS → COMPLETED with outcome populated.
- **S18 GET /referrals/:id/activity** returns 6 rows in chronological order (the full lifecycle audit: Submitted → Triaged + ASSIGNMENT_CHANGE → Accepted → ACCEPTED → IN_PROGRESS → Completed).
- **S19 service-layer counsellor-scope check**: teacher submits a fresh referral (status=SUBMITTED), then attempts `PATCH /:id/triage` → **403 "Only counsellors or admins can triage referrals"**. The `hasCounsellorScope(actor)` helper correctly distinguishes counsellor (cou-001:write held) from teacher (cou-001:read only).
- **S20 teacher POST /counselling/caseloads** → 403 (gate fails on cou-001:write which Teacher does not hold).
- **S21 admin POST /counselling/referral-types** with name 'Smoke-Behavioural', priority HIGH, requires_parent_notification=true → 201.
- **S22 admin PATCH the new type with `isActive=false`** → soft-deactivated cleanly.

**ADR-057 envelope captured live on `dev.svc.referral.created`:**

```json
{
  "event_id": "019df4a6-122f-7eea-822e-731411ee7c1c",
  "event_type": "svc.referral.created",
  "event_version": 1,
  "occurred_at": "2026-05-04T20:20:17.583Z",
  "published_at": "2026-05-04T20:20:17.583Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "counselling",
  "correlation_id": "019df4a6-122f-7eea-822e-78deac853049",
  "payload": {
    "referralId": "019df4a6-121a-7eea-822e-6508803b8e46",
    "sourceRefId": "019df4a6-121a-7eea-822e-6508803b8e46",
    "schoolId": "019dc92b-ea59-7bb7-aa7f-929729562010",
    "studentId": "019dd544-7e07-777b-94e8-33de3952fed8",
    "studentName": "Ethan Rodriguez",
    "referralTypeId": "019df48a-1d3d-7ffd-bad5-3b88675c28be",
    "referralTypeName": "Social/Emotional",
    "priority": "MEDIUM",
    "requiresParentNotification": true,
    "referredById": "019dd544-85e6-7997-b89d-099bf973ba2b",
    "referredByName": "James Rivera",
    "referredByAccountId": "019dc92d-0882-7442-abf5-e33e03046357",
    "reason": "Smoke S10b. Ethan showing increased frustration during peer interactions over the past two weeks. Recommending check-in with the counsellor.",
    "status": "SUBMITTED"
  }
}
```

**Iteration issues caught during smoke (test-data only or service refinements):**

1. **CaseloadService.buildVisibility manager flag was query-level, not row-level.** Initial implementation set `isManager: false` for all STAFF, which stripped notes even from a counsellor viewing their own caseload. Fixed by introducing `isRowManager(actor, counselor_id)` that returns true when `actor.employeeId === counselor_id` per row, and using it in the `.map()` step instead of the query-level flag. Counsellors now see their own caseload notes; teachers see other counsellors' caseloads (via class scope) with notes stripped — exactly the Step 5 visibility contract.
2. **`isCounsellorOrAdmin(actor)` was too broad.** First pass used `actor.personType === 'STAFF' && !!actor.employeeId` which allowed teachers to triage / accept / etc. Replaced with `hasCounsellorScope(actor)` that calls `permissionCheckService.hasAnyPermissionInTenant(actor.accountId, schoolId, ['cou-001:write'])`. The IAM seed grants cou-001:write only to Staff (counsellor / VP / admin assistant) and Admin, NOT to Teacher — so this is the canonical counsellor signal at the service layer. Mirrors Cycle 9 BehaviorPlanService.hasCounsellorScope.
3. **`Step 4 plan omitted COU-001:read for Teacher** but Step 5 visibility expects teachers to see class-scoped caseloads. Added `COU-001:read` to Teacher's IAM grant in seed-iam.ts (45 → 46 perms cached). Documented inline.
4. **psql output parsing**: `psql -tA -c "SET …; SELECT …"` returns the SET command tag concatenated to the UUID (`SET\n019dd544-…`); switched to `psql … | tail -1` so only the final line (the UUID) is captured in shell variables. Same convention as Cycle 5 / 6 / 8 / 9 / 10 documented.

**Smoke residue cleaned**: 7 svc_referral_activity rows + 2 svc_referrals + 1 svc_caseloads (Mitchell consultant) + 1 svc_referral_types (Smoke-Behavioural) all dropped after the smoke. Tenant restored to post-Step-4 seed shape: referrals=1, activity=1, caseloads=1, referral_types=2. Final `Maya now has 1 active caseload` (Hayes, the seeded primary).

**Out of scope this step (deferred to Step 6):** Sessions + FERPA notes endpoints. The Step 6 SessionService + SessionNoteService land next, gated on `student_counseling_record:read` for the FERPA gate. The schema is in place from Step 2; the service-layer FERPA gate + irreversible note locking + session participants management land in Step 6.

---

## Step 6 — Session + Notes NestJS Module

**Status:** DONE. Lands the FERPA-keystone module on top of the Step 5 CounsellingModule. SessionService + SessionNoteService + matching controllers + DTO surface extended with 11 new types/classes. **11 new endpoints** (6 sessions + 5 notes — note: 5 includes both `GET /session-notes/:id` for single-note read and the `PATCH /:id/lock` keystone). Cycle 11 endpoint count: 17 → **28**. All routes mapped on boot. Live verification on `tenant_demo` 2026-05-04 covered 24 scenarios across 5 personas including the FERPA gate distribution + the irreversible lock keystone + the lock-prevents-update invariant + the no-unlock-endpoint design + UNIQUE(session, student) on notes + the participant-or-primary-caseload student validator + INDIVIDUAL/GROUP shape rules. Smoke residue cleaned, tenant restored to post-Step-4 seed shape.

**Services:**

1. **`SessionService`** — 6 endpoints under `cou-001:read` / `cou-001:write` (counsellor + admin only):
   - `GET /counselling/sessions` (list with row-scope: admin all; STAFF own (counselor_id=me); GUARDIAN/STUDENT/unknown 403 at gate; filters status / sessionType / caseloadId / counselorId / fromDate / toDate);
   - `GET /counselling/sessions/:id` (with inlined `participants[]` array);
   - `POST /counselling/sessions` (counsellor or admin only via `hasCounsellorScope`; **INDIVIDUAL/GROUP shape validators** — INDIVIDUAL requires `primaryCaseloadId` / GROUP must omit it; `CRISIS / CHECK_IN / PARENT_MEETING / CONSULTATION` accept either shape; validates the caseload + referral exist in the current tenant);
   - `PATCH /counselling/sessions/:id` (locks the row inside `executeInTenantTransaction` with `SELECT ... FOR UPDATE`; updates status / durationMinutes / sessionType / notes);
   - `POST /counselling/sessions/:id/participants` (add a student to the session; UNIQUE(session_id, student_id) caught with `isUniqueViolation` and surfaced as 400 "This student is already a participant on this session"; validates session + student exist);
   - `PATCH /counselling/session-participants/:id` (mark attendance ATTENDED / NO_SHOW / LATE; counsellor or admin only).
   - **Public helpers** exported for SessionNoteService: `loadOrFail(id, actor)` enforces row-scope on every note read so a counsellor can't read another counsellor's notes by guessing the note id; `studentBelongsToSession(sessionId, studentId)` checks the student is either a participant OR the primary_caseload's student before allowing a note INSERT.

2. **`SessionNoteService`** — **FERPA KEYSTONE**. 5 endpoints, every one gated on the dedicated `student_counseling_record:read` permission introduced in the Step 4 catalogue:
   - `GET /counselling/sessions/:sessionId/notes` (list notes for a session);
   - `GET /counselling/session-notes/:id` (single note);
   - `POST /counselling/sessions/:sessionId/notes` (create — validates studentBelongsToSession before insert; UNIQUE(session_id, student_id) catch surfaces 400 "A session note already exists for this (session, student) pair...");
   - `PATCH /counselling/session-notes/:id` (update — refuses any change when `is_locked=true` with 400 "Note is locked and immutable. Create a follow-up session for additional observations.");
   - `PATCH /counselling/session-notes/:id/lock` (**IRREVERSIBLE** — stamps `is_locked=true` + `locked_at=now()` + `locked_by=actor.employeeId` in one UPDATE so the multi-column `locked_chk` schema invariant is satisfied atomically; refuses callers without an `hr_employees` row — Platform Admin `admin@` cannot lock per the same convention as Cycle 10 medication administer; refuses double-lock with 400 "Note is already locked").
   - **`assertFerpaAccess(actor)`** is the canonical FERPA gate at the service layer. It short-circuits on `actor.isSchoolAdmin` and otherwise checks `permissionCheckService.hasAnyPermissionInTenant(actor.accountId, schoolId, ['student_counseling_record:read'])`. The IAM seed grants this permission to Staff (counsellor / VP / admin assistant) + School Admin / Platform Admin only. Teachers, parents, and students NEVER hold it. The service-side check is belt-and-braces — the controller layer's `@RequirePermission('student_counseling_record:read')` decorator already 403s any unauthorised caller at the gate.
   - **No unlock endpoint by design.** Once locked the note is immutable forever; correcting an observation requires opening a follow-up session and writing a new note.

**Authorisation contract (cumulative across Cycle 11 Steps 5 + 6):**

- `cou-001:read` — list + read caseloads + sessions. Teacher / Parent / Staff / Admin.
- `cou-001:write` — open / close caseloads + create / update sessions + manage session participants + mark attendance. **Counsellor (Staff) or admin only — the canonical counsellor signal.**
- `cou-002:read` — list + read referrals + activity. Teacher / Staff / Admin.
- `cou-002:write` — submit referrals (teacher OK) + triage / accept / start / complete / decline (counsellor or admin only at service layer via `hasCounsellorScope`).
- `cou-002:admin` — referral_types catalogue CRUD. Admin only.
- **`student_counseling_record:read` — FERPA gate on every session-note endpoint.** Staff + Admin only. Teachers, parents, students NEVER hold this code. The single permission code in the catalogue that does not follow the XXX-NNN convention by design.

**Schema invariants exercised:**

- Multi-column `locked_chk` on `svc_session_notes` (`(is_locked=false AND locked_at IS NULL AND locked_by IS NULL) OR (is_locked=true AND locked_at IS NOT NULL AND locked_by IS NOT NULL)`) — the `lock(id)` service-layer UPDATE atomically sets all three columns in one statement so the invariant holds.
- UNIQUE(session_id, student_id) on `svc_session_participants` (catches duplicate participant adds).
- UNIQUE(session_id, student_id) on `svc_session_notes` (one note per (session, student) pair — group sessions can carry one note per participant).

**Module wiring:** SessionService + SessionNoteService + SessionController + SessionNoteController added to CounsellingModule.providers / .controllers / .exports. Build clean (`pnpm --filter @campusos/api build`) on first attempt.

**Routes mapped on boot (verified in `/tmp/api.log`):**

```
SessionController {/api/v1/counselling}:
  GET   /api/v1/counselling/sessions
  GET   /api/v1/counselling/sessions/:id
  POST  /api/v1/counselling/sessions
  PATCH /api/v1/counselling/sessions/:id
  POST  /api/v1/counselling/sessions/:id/participants
  PATCH /api/v1/counselling/session-participants/:id
SessionNoteController {/api/v1/counselling}:
  GET   /api/v1/counselling/sessions/:sessionId/notes
  POST  /api/v1/counselling/sessions/:sessionId/notes
  GET   /api/v1/counselling/session-notes/:id
  PATCH /api/v1/counselling/session-notes/:id
  PATCH /api/v1/counselling/session-notes/:id/lock
```

**Live verification on `tenant_demo` 2026-05-04 (24 scenarios across 5 personas, all green):**

- **S1 counsellor GET /sessions**: returns 2 seeded sessions (CHECK_IN 2026-04-27 + INDIVIDUAL 2026-04-13, both linked to Maya's caseload).
- **S2 counsellor GET /sessions/:id**: returns the seeded INDIVIDUAL session with `primaryStudentName='Maya Chen'` resolved through the caseload join chain.
- **S3 admin GET /sessions/:id/notes**: returns the seeded note 1 with `goals_addressed=['Peer relationship building','Social skills development']`, `is_locked=false`.
- **S4 counsellor GET /sessions/:id/notes**: returns the same note (counsellor of record).
- **S5 teacher GET /sessions/:id/notes** → **403** (FERPA gate at the controller).
- **S6 parent GET /sessions/:id/notes** → **403** (FERPA gate).
- **S7 student GET /sessions/:id/notes** → **403** (FERPA gate).
- **S8 counsellor PATCH unlocked note**: text update succeeds; `is_locked=false` preserved.
- **S9 counsellor LOCKS the note**: `is_locked=true`, `lockedByName='Marcus Hayes'`, `lockedAt` populated.
- **S10 counsellor PATCH locked note** → **400 "Note is locked and immutable. Create a follow-up session for additional observations."** (the keystone immutability invariant).
- **S11 counsellor LOCK already-locked note** → 400 "Note is already locked".
- **S12 psql verify locked_chk lockstep**: `is_locked=true has_at=true has_by=true` — all three columns in sync per the schema invariant.
- **S13 counsellor POST 2nd note for same (session, student)** → 400 "A session note already exists for this (session, student) pair..." (UNIQUE catch via `isUniqueViolation`).
- **S14 counsellor POST note for non-participant student** → 400 "studentId is not a participant of this session and does not match the primary caseload student" (the `studentBelongsToSession` validator).
- **S15 INDIVIDUAL session without primaryCaseloadId** → 400 "INDIVIDUAL sessions require primaryCaseloadId to identify the student".
- **S16 GROUP session WITH primaryCaseloadId** → 400 "GROUP sessions must not set primaryCaseloadId — use the participants list".
- **S17 counsellor creates a GROUP session**: type=GROUP, status=COMPLETED.
- **S18 add Maya as participant (ATTENDED)**: succeeds.
- **S19 add Ethan as participant (LATE)**: succeeds with notes.
- **S20 duplicate participant rejected**: UNIQUE(session, student) → 400 "This student is already a participant on this session".
- **S21 PATCH /session-participants/:id mark NO_SHOW**: attendance flipped, notes appended.
- **S22 GET /sessions/:id with participants**: returns the GROUP session with both participants inlined (Maya NO_SHOW + Ethan LATE).
- **S23 counsellor POST GROUP session note for Maya (participant)**: succeeds with goals_addressed array intact.
- **S24 teacher POST session note** → **403** (FERPA gate; even on a GROUP session where the student attended).

**Smoke residue cleanup**: restored the seeded note 1 to its original `is_locked=false` state with the original notes_text via direct SQL UPDATE; deleted the smoke GROUP session + its 2 participants + 1 smoke note. Final counts: sessions=2, session_notes=2 (with `note1.is_locked=false` reset), session_participants=0 — exactly the post-Step-4 seed shape.

**Iteration issues caught:** none. Build clean on first attempt. Routes mapped correctly. FERPA gate distribution verified live matches the IAM catalogue (4 personas hold `student_counseling_record:read`: admin, principal, counsellor, vp; 3 do not: teacher, parent, student).

**Out of scope this step (deferred to Step 7):** MTSS tier service, intervention service, intervention progress, coordinated-care service (the nurse + counsellor intersection-gated thread requiring BOTH `hlt-001:read` AND `cou-007:read`), and mandatory reporting service (immutable core fields after FILED). The schema is in place from Steps 2 + 3; the request-path API ships in Step 7.

---

## Step 7 — MTSS + Care + Reporting NestJS Modules

**Status:** DONE. The largest backend step of Cycle 11. 4 new services (MtssTierService + InterventionService + CoordinatedCareService + MandatoryReportService) + 4 new controllers + 17 new DTO/enum exports + **20 new endpoints** added to CounsellingModule + 1 new Kafka emit topic (`svc.tier.changed`). Cycle 11 endpoint count: 28 → **48**. Cycle 11 Kafka surface: 2 emit topics. Build clean on first attempt; live verification on `tenant_demo` 2026-05-04 covered 18 scenarios across 5 personas with both `svc.tier.changed` envelopes (CREATED + TIER_CHANGED) captured live; tenant restored to post-Step-4 seed state.

**Services:**

1. **`MtssTierService`** — 9 endpoints under `cou-003:read` / `cou-003:write` / `cou-003:admin`:
   - `GET /counselling/mtss/tiers` (list with row-scope: admin sees school-wide; counsellor scope = STAFF + employeeId sees tiers for students linked to their own caseloads via `svc_caseloads.counselor_id = me`; everyone else 403 at gate; filters tier / domain / status / academicYearId / studentId);
   - `GET /counselling/mtss/dashboard` (admin-only — `cou-003:admin`; returns flat `cells[]` of `(tier, domain, count)` for ACTIVE rows + `totalActive` scalar);
   - `GET /counselling/mtss/tiers/:id` (single tier with row-scope);
   - `POST /counselling/mtss/tiers` (counsellor or admin only via `hasCounsellorScope`; pre-flights the partial UNIQUE keystone on `(student_id, academic_year_id, domain) WHERE status='ACTIVE'` and surfaces the conflicting tier id + tier value in a friendly 400; concurrency-loser race caught via `isUniqueViolation`; emits `svc.tier.changed` with `reason='CREATED'` + `oldTier=null`);
   - `PATCH /counselling/mtss/tiers/:id` (locks the row inside `executeInTenantTransaction` with `SELECT ... FOR UPDATE`; updates tier / status / reviewDate / exitDate / exitReason / notes; **re-emits `svc.tier.changed`** with `reason='TIER_CHANGED'` + `oldTier` populated when the tier value actually changes; emits `reason='STATUS_CHANGED'` when status flips ACTIVE → EXITED / PROMOTED / DEMOTED);
   - `GET /counselling/mtss/team-meetings` (counsellor + admin only; filters fromDate / toDate / academicYearId);
   - `GET /counselling/mtss/team-meetings/:id` (single meeting with inlined `students[]` array);
   - `POST /counselling/mtss/team-meetings` (records a meeting; facilitator stamped from `actor.employeeId`);
   - `POST /counselling/mtss/team-meetings/:id/students` (attach a student outcome to a meeting; UNIQUE(team_meeting_id, student_id) catch with friendly 400).

2. **`InterventionService`** — 5 endpoints under `cou-003:read` / `cou-003:write`:
   - `GET /counselling/mtss/tiers/:id/interventions` (list interventions for a tier with the **latest progress entry inlined** via `DISTINCT ON (intervention_id)` for a single round-trip);
   - `POST /counselling/mtss/tiers/:id/interventions` (counsellor or admin only; validates tier exists; pre-checks `endDate >= startDate` at app layer + the schema-side `dates_chk` is the belt-and-braces);
   - `PATCH /counselling/mtss/interventions/:id` (update status / frequency / endDate / description);
   - `POST /counselling/mtss/interventions/:id/progress` (**append-only** — no UPDATE / no DELETE methods exposed at the service layer, mirroring Cycle 8 `tkt_ticket_activity` + Cycle 11 `svc_referral_activity`; stamps `recorded_by` from `actor.employeeId`; refuses callers without an `hr_employees` row);
   - `GET /counselling/mtss/interventions/:id/progress` (time-series for the Step 9 chart, oldest-first).

3. **`CoordinatedCareService`** — **INTERSECTION-GATED**. 2 endpoints:
   - `GET /counselling/coordinated-care/:studentId` (read all care notes for a student, newest-first);
   - `POST /counselling/coordinated-care/:studentId` (add a care note with `authorRole=NURSE | COUNSELLOR`; stamps `author_person_id` from `actor.personId`; the role-vs-perm validator additionally requires NURSE notes from callers holding `hlt-001:write` and COUNSELLOR notes from callers holding `cou-001:write` or `cou-007:write` — admins bypass via the schoolAdmin short-circuit).
   - **The intersection gate.** The project's `PermissionGuard` uses OR semantics, so the controller decorator gates on the narrower of the two codes (`@RequirePermission('cou-007:read')` — held only by Staff + Admin in the IAM seed). The service additionally enforces the **intersection** via `assertIntersectionAccess(actor)` which calls `permissionCheckService.hasAnyPermissionInTenant` twice — once for `hlt-001:read` and once for `cou-007:read` — and 403s if either is missing. Effective behaviour matches the M27 ERD requirement: teachers and parents (who hold `hlt-001:read` for the student-summary surface but NOT `cou-007:read`) and students (who hold neither) all 403 at the controller gate; Staff (counsellor / VP / nurse — the IAM seed groups them under one role and grants both codes) + Admin pass both checks.

4. **`MandatoryReportService`** — **IMMUTABLE core fields after FILED**. 4 endpoints:
   - `GET /counselling/mandatory-reports` (list; lead-counsellor / admin (cou-006:admin) sees all in school; regular reporters (cou-006:write) see only own filed reports via `reporter_person_id = actor.personId`);
   - `GET /counselling/mandatory-reports/:id` (single report with the same row-scope);
   - `POST /counselling/mandatory-reports` (any STAFF or admin with cou-006:write — every employee is a mandated reporter; stamps `reporter_person_id` from `actor.personId`; status starts at FILED);
   - `PATCH /counselling/mandatory-reports/:id` (admin-tier only — gated on `cou-006:admin`; **only `status` and `cps_response` are mutable** as the case evolves through CPS_CONTACTED → INVESTIGATION_ACTIVE → CLOSED).
   - **Service-side immutability** is enforced two ways: (a) the `UpdateMandatoryReportDto` only declares `status` + `cpsResponse` so the global `ValidationPipe` with `forbidNonWhitelisted=true` rejects any unknown property at the request layer; (b) the service additionally walks an explicit `immutableFields` list (description, reportType, reportedToAuthority, reportDate, supportingDocsS3Keys, studentId, reporterPersonId) and throws 400 "Mandatory report core fields are immutable once filed" if any of them arrive via a future DTO refactor that drops the strict whitelist. Defence-in-depth.
   - **Permanent retention** — the schema's `student_id → sis_students(id) NO ACTION` FK on `svc_mandatory_reports` (Cycle 11 Step 3 migration) refuses to delete a student with mandatory reports, forcing admin to archive the audit trail first. Mirrors Cycle 10 `hlth_health_access_log`.

**Authorisation contract (cumulative across Cycle 11 Steps 5 + 6 + 7):**

| Code                             | Read                                          | Write                                  | Admin                               |
| -------------------------------- | --------------------------------------------- | -------------------------------------- | ----------------------------------- |
| `cou-001` (Caseloads + Sessions) | Teacher / Parent / Staff / Admin (row-scoped) | Counsellor / Admin (canonical signal)  | Admin                               |
| `cou-002` (Referrals)            | Teacher / Staff / Admin (row-scoped)          | Teacher submits + Counsellor lifecycle | Admin (catalogue)                   |
| `cou-003` (MTSS / RTI)           | Counsellor / Admin (row-scoped)               | Counsellor / Admin                     | Admin (dashboard)                   |
| `cou-006` (Mandatory Reports)    | Reporter own + Admin all                      | Any STAFF or Admin (file new)          | Admin (PATCH cps_response + status) |
| `cou-007` (Coordinated Care)     | Staff / Admin (intersection w/ hlt-001:read)  | Staff / Admin (role-validated)         | Admin                               |
| `student_counseling_record`      | Staff / Admin only — FERPA                    | n/a                                    | n/a                                 |

**Kafka emits (cumulative):**

- `svc.referral.created` (Step 5) — emitted on POST /counselling/referrals.
- `svc.tier.changed` (Step 7) — emitted on POST /mtss/tiers (`reason='CREATED'`, `oldTier=null`); on PATCH that changes the tier value (`reason='TIER_CHANGED'`, `oldTier=<previous>`); on PATCH that changes status only (`reason='STATUS_CHANGED'`, `oldTier=null`).

**Module wiring:** all 4 new services + 4 new controllers added to CounsellingModule. The MtssController combines tier + intervention + team-meeting endpoints under one `/counselling/mtss` prefix for clarity.

**Live verification on `tenant_demo` 2026-05-04 (18 scenarios across 5 personas, all green):**

- **M1 counsellor GET /mtss/tiers** returns 1 (the seeded BEHAVIORAL TIER_2 ACTIVE for Maya — counsellor scope = caseload-linked students fires correctly).
- **M2 admin GET /mtss/dashboard** returns `totalActive=1` with 1 cell (TIER_2 BEHAVIORAL).
- **M3 counsellor GET /mtss/dashboard** → 403 (admin-only via cou-003:admin).
- **M4 counsellor POSTs Maya TIER_2 ATTENDANCE** → 201; **`svc.tier.changed` envelope captured live** with `reason='CREATED'`, `oldTier=null`, `tier=TIER_2`, `domain=ATTENDANCE`, `studentName='Maya Chen'`, `source_module='counselling'`.
- **M5 partial UNIQUE keystone fires** — 2nd ACTIVE TIER for same (student, year, domain) rejected with friendly 400 carrying the conflicting tier id + tier value.
- **M6 PATCH promote TIER_2 → TIER_3** succeeds; **2nd `svc.tier.changed` envelope captured** with `reason='TIER_CHANGED'`, `oldTier='TIER_2'`, `tier='TIER_3'`.
- **M7 list interventions on the seeded BEHAVIORAL tier**: returns 1 (Social Skills Group BEHAVIORAL_SUPPORT) with `latestProgress.score=2` inlined from the seeded progress entry.
- **M8 counsellor logs new progress** (`recordedDate=2026-04-28, score=1.50, benchmark=1.00`) — append-only path.
- **M9 GET /interventions/:id/progress time-series** returns 2 rows oldest-first (seeded 2026-04-27 score=2, then smoke 2026-04-28 score=1.5).
- **C1 counsellor GET /coordinated-care/<maya>** returns the seeded note (1 row, COUNSELLOR / Marcus Hayes).
- **C2 admin GET** → 200 (admin holds intersection via everyFunction).
- **C3 teacher GET** → **403** (gate: missing cou-007:read).
- **C4 parent GET** → **403** (gate: missing cou-007:read).
- **C5 student GET** → **403** (gate: missing cou-007:read).
- **C6 counsellor POST authorRole=COUNSELLOR** → 201 (passes intersection + role-vs-perm check).
- **C7 counsellor POST authorRole=NURSE** → 201 (the demo Staff role grants both `hlt-001:write` AND `cou-001:write` per Cycle 10 — so the role-vs-perm check correctly accepts NURSE; this matches the **Wave 2 Phase 2 punch list** item that Nurse / Counsellor split is needed before pilot, where the IAM seed will narrow Nurse to HLT codes only).
- **R1 counsellor files mandatory report** (SUSPECTED_NEGLECT for Ethan) → status=FILED, reporter='Marcus Hayes' stamped from actor.personId.
- **R2 counsellor GET /mandatory-reports** returns 1 (own only — row-scope on reporter_person_id).
- **R3 counsellor PATCH** → 403 (cou-006:admin required; counsellor holds cou-006:read+write but not :admin).
- **R4 admin PATCH** {status: 'CPS_CONTACTED', cpsResponse: '...'} → 200 with mutable fields updated.
- **R5 admin PATCH {description: ...}** → **400 "property description should not exist"** (the global ValidationPipe whitelist enforcement).
- **R6 parent GET /mandatory-reports** → 403.
- **R7 student POST mandatory-report** → 403.
- **R8 teacher POST mandatory-report** → 201 (teacher holds cou-006:write per the Step 4 IAM grant — every employee is a mandated reporter).

**ADR-057 envelopes captured live on `dev.svc.tier.changed`:**

```
event_id=019df505-821b-7ee4... type=svc.tier.changed source=counselling
  tier=TIER_2 domain=ATTENDANCE status=ACTIVE reason=CREATED oldTier=None student=Maya Chen
event_id=019df505-8ed6-7ee4... type=svc.tier.changed source=counselling
  tier=TIER_3 domain=ATTENDANCE status=ACTIVE reason=TIER_CHANGED oldTier=TIER_2 student=Maya Chen
```

Both envelopes wrap the full payload (tierId, sourceRefId, schoolId, studentId, studentName, academicYearId, tier, domain, status, oldTier, reason, assignedById, assignedByName, assignedAt, reviewDate). The `oldTier` field on the second envelope carries the previous tier value so a future Step 9 dashboard or notification consumer can render "Maya promoted from Tier 2 to Tier 3" without a separate DB read.

**Smoke residue cleaned**: 1 smoke MTSS tier + 1 smoke progress entry + 2 smoke care notes (the COUNSELLOR + NURSE demo notes) + 0 smoke reports (no PATCH-fail-then-rollback path; the `Smoke%` reports were the FILED rows — 2 of them; the cleanup deleted both). Final state: mtss_tiers=1, interventions=1, progress=1, care_notes=1, reports=0 — exactly the post-Step-4 seed shape.

**Iteration issues caught:** none. Build clean on first attempt. The patterns from CaseloadService + ReferralService + the FERPA service transferred cleanly:

- Counsellor scope check → `hasCounsellorScope(actor)` calling `permissionCheckService.hasAnyPermissionInTenant` for cou-001:write.
- Locked-row state transitions → `executeInTenantTransaction` + `SELECT FOR UPDATE` per the convention.
- IMMUTABLE service-side discipline → DTO whitelist + service-side `immutableFields` defence-in-depth.
- Intersection gate → controller-level narrower-code gate + service-level explicit `assertIntersectionAccess(actor)`.

**Cycle 11 backend phase complete.** Counselling NestJS module ships with **10 services + 48 endpoints + 2 Kafka emits + 1 FERPA gate**.

**Out of scope this step (deferred to Step 8 + 9 UI):** every web surface for caseloads / referrals / sessions / FERPA notes / MTSS dashboard / coordinated care / mandatory reports. The ~48-endpoint API surface is now stable and ready for the parallel Step 8 + 9 UI builds.

---

## Step 8 — Counselling UI — Caseload + Referrals + Sessions

**Status:** DONE. The first batch of Cycle 11 web surfaces lands at `apps/web/src/app/(app)/counselling/` — 4 routes + a new `Counselling` launchpad tile gated on `cou-001:read` (every persona that reaches the cou-001 surface — Teacher / Parent / Staff / Admin) using a new `HeartHandIcon` in `apps/web/src/components/shell/icons.tsx`. Build clean (`pnpm --filter @campusos/web build`); routes ship at static-prerendered sizes 5.17 / 4.68 / 6.7 / 6.87 kB First Load JS.

**Web side additions:**

- **`apps/web/src/lib/types.ts`** — extended with the full Cycle 11 counselling DTO surface: 7-value `PrimaryConcern` + 3-value `CaseloadStatus` + 4-value `ReferralPriority` + 7-value `ReferralStatus` + 6-value `ReferralActivityType` + 6-value `SessionType` + 4-value `SessionStatus` + 3-value `SessionAttendanceStatus` (deliberately renamed from `AttendanceStatus` to avoid a name collision with the Cycle 1 attendance enum that already shipped at line 1 of types.ts) + `CaseloadDto`, `CreateCaseloadPayload`, `UpdateCaseloadPayload`, `CloseCaseloadPayload`, `ReferralTypeDto` + create/update payloads, `ReferralDto` + `ReferralActivityDto` + create/triage/accept/complete/decline payloads, `SessionDto` + `SessionParticipantDto` + create/update + add-participant + mark-attendance payloads, `SessionNoteDto` + create/update payloads. Total ~30 new types.
- **`apps/web/src/lib/counselling-format.ts`** (new file) — exports the 8 const arrays of enum values (in UI-driven order), 8 label maps + 8 pill class maps with consistent palettes (concern: 7-colour spread; status: rose-amber-emerald progression; priority: warming-tone Cycle-8-style), plus helpers `studentDisplay`, `todayIso`, `priorityRank`, `isTriageWorthy`, `formatDateOnly`, `formatDateTime`, `formatRelative`.
- **`apps/web/src/hooks/use-counselling.ts`** (new file) — 27 React Query hooks covering every endpoint of Steps 5 + 6: 5 caseload hooks (list + getById + create + update + close); 3 referral-type hooks (list + create + update); 8 referral hooks (list + getById + activity + create + triage + accept + start + complete + decline); 5 session hooks (list + getById + create + update + addParticipant + markAttendance); 5 session-note hooks (listForSession + getById not exposed yet + create + update + lock). Each mutation invalidates the matching list + detail query keys, and lifecycle mutations also invalidate the activity timeline. The session-notes hook accepts an optional `enabled` flag so callers without `student_counseling_record:read` can short-circuit and avoid a guaranteed 403 (the FERPA gate is enforced server-side anyway).
- **`apps/web/src/components/shell/icons.tsx`** — new `HeartHandIcon` (Heroicons "hand-raised" path, used as the welcoming "hold" gesture for student-support work).
- **`apps/web/src/components/shell/apps.tsx`** — registers the `Counselling` tile gated on `cou-001:read` with `routePrefix: '/counselling'` so all nested routes keep the tile lit; description copy switches on `personType=GUARDIAN` to "Your child's caseload assignment" vs the staff-side "Caseloads, referrals, sessions, and FERPA-protected notes".

**4 routes:**

1. **`/counselling`** — counsellor dashboard with 3 panels (responsive xl:grid-cols-3): (A) **My caseload** — active caseloads (counsellor sees own; admin sees all; parent sees own children with notes stripped server-side) rendered as compact cards with student name + grade + concern pill + counsellor name + opened-date; click-through to caseload detail. (B) **Triage queue** — gated on `cou-002:read`, sorted URGENT→HIGH→MEDIUM→LOW then oldest-first; renders priority + status pills + line-clamp-2 reason preview + relative timestamp; "See all →" link to /counselling/referrals. (C) **Today's sessions** — gated on `cou-001:read`, filters server-side by `fromDate=today&toDate=today`, sorted by date asc; renders type + status pills + duration + counsellor name. Parents see only their own caseload card and an empty-state for the other two panels.

2. **`/counselling/caseloads/[id]`** — caseload detail page. Header card shows student display name + grade-level subtitle. Status row carries the concern pill + status pill + Primary/Consultant pill (the schema's `is_primary_counselor` flag). 4-stat metadata grid (Counsellor / Academic year / Sessions / Last session — `sessionCount` and `lastSessionDate` come from the Step 5 inlined-stats getById endpoint). Counsellor notes block surfaces the (server-stripped-for-non-managers) `notes` field when present. **Linked BIP banner** in violet appears when `linkedBipId` is set — click-through to `/behavior-plans/<id>` (the keystone Cycle 9 cross-cycle integration where the Step 4 BIP `caseload_id` backfill surfaces in the UI). Session history table reads `useSessions({ caseloadId: id })`. Close-caseload button on ACTIVE rows opens a Modal with a required closure_reason textarea (1000-char max) — submit calls `useCloseCaseload(id)` and routes back to `/counselling`.

3. **`/counselling/referrals`** — referral queue. Filter chips: Triage queue (default; SUBMITTED + TRIAGED) / Submitted / Triaged / Accepted / In progress / Completed / Declined / All. Per-row: student name + grade + priority pill + status pill + referral type + referredBy + assignedCounsellorName (when set) + relative timestamp + line-clamp-2 reason preview. Click opens **ReferralDetailModal** (size=lg) which surfaces: header with student + priority + status; reason block; outcome banner (emerald, only when status=COMPLETED or DECLINED); **activity timeline** rendered with the 6-value activity_type label map and per-row actor + relative timestamp (the chronological audit from Step 5's IMMUTABLE `svc_referral_activity` table); for counsellors (cou-001:write held), an action panel renders the lifecycle buttons appropriate to current status — Triage / Accept / Start / Complete (with inline outcome input) / Decline (with inline reason input). All mutations invalidate referrals + activity + caseloads.

4. **`/counselling/sessions`** — session log + the FERPA-gated notes panel. Two filter rows: status chips (All / Scheduled / Completed / No-show / Cancelled) + type chips (Any type / 6 SessionType values). Per-row: date + type pill + status pill + duration + primary student name (or "GROUP / multiple participants" when no primary_caseload_id). Click opens **SessionDetailModal** (size=lg) with: header showing primaryStudent OR "Group session" + type + status pills + date/duration/counsellor; logistics-notes block (`session.notes` — non-FERPA); participants list with attendance pills (when GROUP); **FERPA-gated notes panel** in violet — when `student_counseling_record:read` held: renders each note with student name + Locked/Editable badge + Follow-up-required badge + goalsAddressed pill chain + `notesText` whitespace-pre-wrap + locked-by/locked-at footer when locked + "Lock note (irreversible)" button when unlocked (with `window.confirm` warning before the irreversible PATCH /lock); when permission missing: displays "Session notes are restricted to the counselling team. Teachers and parents see only that the session occurred — not its content." The hook short-circuits via the `enabled` flag so non-counsellor personas don't trigger a guaranteed 403.

**Live UI-driving API smoke (5 personas, all pass):**

- **Counsellor**: `/caseloads` 1 row Hayes→Maya SOCIAL_EMOTIONAL notes=True; `/referrals` 1 row ACCEPTED Social/Emotional Maya; `/sessions` 2 rows; `/sessions/:id/notes` 1 note is_locked=False (FERPA gate passes).
- **Parent**: `/caseloads` 1 row Hayes→Maya notes=None (notes stripped server-side per Step 5 row-scope); `/referrals` 403 (parents don't hold cou-002:read by design); `/sessions/:id/notes` 403 (FERPA gate fires).
- **Teacher**: `/caseloads` 1 row Hayes→Maya notes=None (per-row manager check fires correctly — Rivera is the assigned class teacher of Maya so the caseload surfaces but stripped); `/sessions/:id/notes` 403 (FERPA).

**Iteration issues caught + fixed:**

1. **EmptyState API mismatch.** First pass passed `action={{ label: ..., href: ... }}` per the plan but the existing component types `action?: ReactNode`. Fixed to pass a `<Link>` element directly.
2. **Modal API mismatch.** First pass used `primaryLabel` / `primaryVariant` / `primaryDisabled` / `onPrimaryClick` props which don't exist on the existing Modal component (it uses a `footer` ReactNode). Fixed by passing the close + submit buttons as a `footer` element with the project's standard rose-600 danger styling.
3. **`AttendanceStatus` name collision.** Cycle 1 already exports `AttendanceStatus = 'PRESENT' | 'TARDY' | 'ABSENT' | 'EXCUSED' | 'EARLY_DEPARTURE'` at line 1 of `types.ts`. The Cycle 11 definition `'ATTENDED' | 'NO_SHOW' | 'LATE'` collided silently — TypeScript used the first definition and rejected the new values as not assignable. Renamed the Cycle 11 type to `SessionAttendanceStatus` everywhere (types.ts + counselling-format.ts + use-counselling.ts + sessions page). One sed pass left a `SessionSessionAttendanceStatus` artifact in counselling-format.ts (because the `Session` prefix was already there) which I corrected. Documented for future cycle authors: search for an existing type before adding a domain-prefixed enum.

**Build sizes** (web, all 4 routes ship as static or dynamic):

- `/counselling` 5.17 kB / 115 kB First Load JS (static prerender)
- `/counselling/caseloads/[id]` 4.68 kB / 114 kB (dynamic, parameterised)
- `/counselling/referrals` 6.7 kB / 108 kB (static)
- `/counselling/sessions` 6.87 kB / 108 kB (static)

**No backend changes** — Step 8 sits entirely on the 28 endpoints from Steps 5 + 6. The Step 7 surfaces (MTSS + coordinated care + mandatory reports) ship in Step 9 alongside their UI.

**Out of scope this step (deferred to Step 9):** the create-session form (currently the session log surfaces existing rows but doesn't yet provide a "New session" button — counsellors create sessions either via API direct or via a Step 9 polish), the create-note + edit-note inline editor (the Step 8 modal renders existing notes + the lock button; Step 9 will add the create-note form for the FERPA surface), and the create-referral form (the dashboard triage queue lets counsellors triage but does not currently expose a "New referral" form for teachers to submit — Step 9 will surface this on `/counselling/referrals`).

---

## Step 9 — MTSS + Care + Reporting UI

**Status:** DONE. The second batch of Cycle 11 web surfaces lands at `apps/web/src/app/(app)/counselling/mtss/`, `/coordinated-care/[studentId]/`, and `/mandatory-reports/` — 4 new routes (1 dashboard + 1 detail + 1 thread + 1 reports list with detail + filing modals). Cycle 11 web surface count grows from 4 → **8 routes**. Build clean (`pnpm --filter @campusos/web build`); routes ship at static-prerendered or dynamic-parameterised sizes 5.94 / 8.14 / 6.44 / 3.75 kB First Load JS. **No backend changes** — Step 9 sits entirely on the 20 endpoints from Step 7.

**Web side additions:**

- **`apps/web/src/lib/types.ts`** — extended with the Step 7 DTO surface (~14 new types/enums): `MtssTier` / `MtssDomain` / `MtssTierStatus` / `InterventionType` / `InterventionStatus` / `MeetingOutcome` / `CareAuthorRole` / `ReportType` / `ReportStatus` enums, plus `MtssTierDto`, `CreateMtssTierPayload`, `UpdateMtssTierPayload`, `MtssDashboardCellDto`, `MtssDashboardDto`, `InterventionDto`, `InterventionProgressEntryDto`, `CreateInterventionPayload`, `UpdateInterventionPayload`, `LogProgressPayload`, `TeamMeetingDto`, `TeamMeetingStudentDto`, `CreateTeamMeetingPayload`, `AttachTeamMeetingStudentPayload`, `CoordinatedCareNoteDto`, `CreateCoordinatedCareNotePayload`, `MandatoryReportDto`, `CreateMandatoryReportPayload`, `UpdateMandatoryReportPayload`.
- **`apps/web/src/lib/counselling-format.ts`** extended with 9 new const arrays (MTSS_TIERS / MTSS_DOMAINS / MTSS_TIER_STATUSES / INTERVENTION_TYPES / INTERVENTION_STATUSES / MEETING_OUTCOMES / CARE_AUTHOR_ROLES / REPORT_TYPES / REPORT_STATUSES) + 9 label maps + 9 pill class maps. **Tier pills follow the warming-tone progression** (TIER_1 emerald universal support / TIER_2 amber targeted / TIER_3 rose intensive — echoes Cycle 8 ticket priority + Cycle 9 incident severity). **Coordinated care role pills**: NURSE teal / COUNSELLOR indigo per the plan §09. **Report status pills**: FILED rose / CPS_CONTACTED amber / INVESTIGATION_ACTIVE violet / CLOSED gray.
- **`apps/web/src/hooks/use-counselling.ts`** extended with **17 new hooks** for Step 7 endpoints: `useMtssTiers` + `useMtssTier` + `useMtssDashboard` (admin-gated with `retry: false` so a counsellor short-circuits cleanly) + `useCreateMtssTier` + `useUpdateMtssTier` + `useInterventions` + `useCreateIntervention` + `useUpdateIntervention` + `useInterventionProgress` + `useLogProgress` + `useTeamMeetings` + `useTeamMeeting` + `useCreateTeamMeeting` + `useAttachMeetingStudent` + `useCoordinatedCare` + `useCreateCoordinatedCareNote` + `useMandatoryReports` + `useMandatoryReport` + `useFileMandatoryReport` + `useUpdateMandatoryReport`. Total Cycle 11 hook count: 27 + 20 = **47 React Query hooks**. Mutation invalidations covered (a `useUpdateMtssTier` invalidates both the per-tier detail and the school-wide dashboard rollup since the count cell may flip).

**4 new routes:**

1. **`/counselling/mtss`** — MTSS dashboard. **For admins (cou-003:admin)**: school-wide tier-distribution rollup rendered as a 3×4 grid (Tier × Domain) with counts + the totalActive scalar. **For all cou-003:read holders**: tier list with 3 stacked filter rows (Tier 1/2/3 / 4 domain pills / 4 status pills, status defaults to ACTIVE), per-row link to detail showing tier + domain + status pills + assigned/review dates + assignedBy.

2. **`/counselling/mtss/tiers/[id]`** — tier detail. Tier card with tier + domain + status pills + 4-cell metadata grid (Assigned by / Academic year / Review date / Exit date) + notes block. **Interventions list** with type pill + status pill + frequency + provider + start/end dates + **`latestProgress` inlined** showing score / benchmark / measure-type. Click-through opens an **InterventionProgressModal** with a full progress-entries table (date / measure / score / benchmark / notes) + admin-or-counsellor-only **LogProgressForm** for appending a new data point. Plus an **AddInterventionModal** for counsellor-or-admin only — type dropdown, frequency text, start date, optional description.

3. **`/counselling/coordinated-care/[studentId]`** — **INTERSECTION-GATED** thread. Client-side mirror of the server intersection check (`hasAnyPermission(user, ['hlt-001:read']) && hasAnyPermission(user, ['cou-007:read'])`) so users without both perms see a friendly empty state ("Restricted to nurse + counsellor team — Coordinated care notes require both hlt-001:read AND cou-007:read") instead of a guaranteed 403. Thread renders chronologically (newest-first per the API contract) with each note showing **NURSE teal / COUNSELLOR indigo role pill** + author name + relative timestamp + note text. **Add-note form** at the bottom with role chips (NURSE / COUNSELLOR) + textarea (8000-char max). The server-side role-vs-perm validator enforces that NURSE notes require hlt-001:write and COUNSELLOR notes require cou-001:write or cou-007:write.

4. **`/counselling/mandatory-reports`** — list + filing surface. Top-of-page **rose-tinted reminder banner** ("every employee is a mandated reporter — files are kept permanently — once filed the description / type / authority / date / supporting docs are immutable, only status + CPS response can be updated"). 5 status filter chips. Per-row: student name + report-type pill (rose progression — SUSPECTED_ABUSE / SUSPECTED_NEGLECT / IMMINENT_DANGER deepest red / OTHER gray) + status pill + reportedToAuthority + reportDate + reporterName. **FileReportModal** with student picker (driven by useStudentsForReport from Cycle 9) + report_type dropdown + authority text + 6-row description textarea + amber pre-flight banner restating the immutability invariant. **ReportDetailModal** renders the immutable fields with a 🔒 immutable badge alongside each label (student / reporter / reported-to / report-date / description); admin-only "Case progression (mutable)" panel with status dropdown + cps_response textarea — for non-admin reporters, the form is rendered read-only with the message "Only the lead counsellor / school admin (cou-006:admin) can update status + CPS response."

**Counselling tile description copy** unchanged from Step 8 — `routePrefix: '/counselling'` keeps the tile lit across all 8 routes.

**Live UI-driving API smoke (4 personas, all green):**

- **M1 counsellor `/mtss/tiers`** returns 1 row (TIER_2 BEHAVIORAL ACTIVE / Maya — caseload-linked scope fires correctly).
- **M2 admin `/mtss/dashboard`** returns `totalActive=1` with cells `[('TIER_2','BEHAVIORAL',1)]`.
- **M3 counsellor `/mtss/dashboard`** → 403 (admin-only via cou-003:admin).
- **M4 counsellor `/mtss/tiers/:id/interventions`** returns 1 row (Social Skills Group BEHAVIORAL_SUPPORT) with `latestProgress.score=2` inlined.
- **C1 counsellor `/coordinated-care/<maya>`** returns the seeded note (1 row, COUNSELLOR / Marcus Hayes / 'Maya shows anxiety around health episodes...').
- **C2 teacher `/coordinated-care/<maya>`** → **403** (gate: missing cou-007:read).
- **C3 parent `/coordinated-care/<maya>`** → **403** (gate: missing cou-007:read).
- **R1 admin `/mandatory-reports`** returns 0 rows (consistent with the post-seed shape — no reports filed yet).
- **R2 parent `/mandatory-reports`** → **403** (gate: missing cou-006:read).

**Iteration issues caught + fixed:**

1. **Inline `import type` after non-imports.** Both `counselling-format.ts` and `use-counselling.ts` initially had the Step 7 `import type {...}` block appended at the bottom (after a heredoc-cat). ESLint's `import/first` rule + TypeScript both flag this. Fixed by hoisting all Step 7 type imports into the top-of-file `import type` block (alphabetically merged with the Step 8 imports).

**Build sizes** (web, all 4 new routes): `/counselling/mtss` 5.94 kB / 116 kB First Load JS (static); `/counselling/mtss/tiers/[id]` 8.14 kB / 118 kB (dynamic); `/counselling/coordinated-care/[studentId]` 6.44 kB / 108 kB (dynamic); `/counselling/mandatory-reports` 3.75 kB / 111 kB (static). Total Cycle 11 web surface: 8 routes.

**Out of scope this step (deferred to Step 10 CAT or future polish):** the "Student Counselling tab" (Support tab on the existing student profile that aggregates active caseload + MTSS tier + recent sessions + coordinated-care thread + linked BIP into one staff-only view) — the plan §09 lists this as a 5th surface but it is functionally a composition of the 4 routes that just shipped, so a polish pass after the CAT verifies the underlying pieces work; the team-meetings UI (the API supports it; the Step 8/9 routes don't yet expose it because the seed has no team meetings to surface — counsellors create one via API as part of the Step 10 CAT or later); a dedicated "All caseload students" picker on `/counselling/coordinated-care` (currently the route is parameterised by studentId; Step 10's CAT will demonstrate the navigation pattern).

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE. The reproducible end-to-end CAT lands at `docs/cycle11-cat-script.md`. Verified live against `tenant_demo` 2026-05-05 against the Step 9 build; all 10 plan scenarios pass; both ADR-057 wire envelopes captured live. No backend or web changes in Step 10 — the script is the deliverable.

**Schema preamble (8 checks all green on `tenant_demo`):**

1. Tenant logical base table count = **169** (4 from Step 1 + 8 from Step 2 + 2 from Step 3 = 14 new svc\_\* tables).
2. svc\_\* table count = **17** (14 from Cycle 11 + 3 from Cycle 9).
3. Cycle 9 BIP `caseload_id` is now a real DB FK with `ON DELETE SET NULL` to `svc_caseloads`.
4. **32 intra-tenant FKs** across the 14 Cycle 11 tables (8 Step 1 + 21 Step 2 + 3 Step 3).
5. **0 cross-schema FKs** across all Cycle 11 svc\_\* tables — every cross-schema ref is soft per ADR-001 / ADR-020.
6. IAM catalogue = **450 codes** (450 perms in `platform.permissions`).
7. **4 of 7 personas hold `student_counseling_record:read`** (admin / principal / vp / counsellor) — exactly the FERPA gate distribution the IAM seed targets.
8. Step 4 seed counts on tenant_demo match the post-seed shape exactly (caseloads=1 / BIP_with_caseload=1 / referrals=1 / activity=1 / types=2 / sessions=2 / notes=2 / tiers=1 / interventions=1 / progress=1 / care_notes=1 / reports=0).

**10 plan scenarios verified live on `tenant_demo` 2026-05-05:**

- **S1 — Rivera submits referral; `svc.referral.created` envelope fires.** Teacher Rivera POSTs `/counselling/referrals` for Maya under "Social/Emotional" type with reason populated. Response shows `status=SUBMITTED priority=MEDIUM reportedBy=James Rivera parentNotify=true`. The initial STATUS_CHANGE activity row was written inside the same tenant tx as the INSERT (activity_count=1). Rivera's own-submitted view includes the new row (row-scope on referred_by=me). **`svc.referral.created` envelope captured live** on `dev.svc.referral.created` with full ADR-057 shape (`event_type='svc.referral.created'`, `source_module='counselling'`, `tenant_id` populated, fresh UUIDv7 `event_id` + `correlation_id`, payload includes referralId/sourceRefId/schoolId/studentId/studentName='Maya Chen'/referralTypeId/referralTypeName='Social/Emotional'/priority=MEDIUM/requiresParentNotification=true/referredById/referredByName='James Rivera'/referredByAccountId/reason/status=SUBMITTED).

- **S2 — Hayes triages + accepts; activity timeline grows to 4 rows.** Counsellor Hayes triages with `assignedCounselorId` self-assigned: SUBMITTED → TRIAGED with `assigned_counselor` stamped. Then accepts: TRIAGED → ACCEPTED. 4 activity rows persist for the lifecycle in `svc_referral_activity` (1 STATUS_CHANGE on submit + 1 ASSIGNMENT_CHANGE on triage with the assignment note + 1 STATUS_CHANGE on triage status flip + 1 STATUS_CHANGE on accept), all chained inside their parent state-machine txs through the `ReferralActivityService.recordActivity()` helper. The IMMUTABLE-per-ADR-010 schema invariant is enforced by the absence of UPDATE / DELETE methods on the service layer (verified by code inspection in Step 5).

- **S3 — Caseload: Cycle 9 BIP linkage + partial UNIQUE keystone.** Maya's caseload (admin getById) surfaces the inlined `sessionCount=2 lastSessionDate=2026-04-27 linkedBipId=019df0f5-c5d9-7ffa-8a4e-7e990d5b86ac` — the Cycle 9 BIP id, visible via the Step 4 caseload_id backfill (Step 3 FK enforces it). 2nd primary caseload INSERT for Maya in same year is rejected by the partial UNIQUE keystone with **the conflicting caseload id in the friendly 400 message** ("Student already has a primary counsellor for this academic year (caseload <id>). Close that caseload before opening a new primary, or set is_primary_counselor=false to open as a consultant.").

- **S4 — INDIVIDUAL session + FERPA gate distribution across 5 personas.** Hayes logs new INDIVIDUAL COMPLETED 40-minute session linked to Maya's caseload. Hayes adds FERPA-protected note with `goalsAddressed=['Peer relationship building','Emotional regulation']` and `followUpRequired=true`. **FERPA gate distribution on `/sessions/:id/notes`** verified across all 5 personas: counsellor 200 / admin 200 / teacher 403 / parent 403 / student 403. Only the 4 personas who hold `student_counseling_record:read` pass the gate.

- **S5 — Lock keystone (irreversible immutability).** Hayes locks the S4 note via `PATCH /counselling/session-notes/:id/lock`. Response shows `is_locked=true lockedBy=Marcus Hayes lockedAt=2026-05-05T08:52:59+00`. psql verifies the multi-column `locked_chk` invariant — all 3 columns in lockstep: `is_locked=true has_at=true has_by=true`. Subsequent PATCH attempt → 400 "Note is locked and immutable. Create a follow-up session for additional observations." Double-lock attempt → 400 "Note is already locked". The schema invariant + service-side immutability + no unlock endpoint = irreversible by design.

- **S6 — MTSS tier assignment + `svc.tier.changed` envelope + intervention + progress.** Hayes assigns Maya to TIER_2 SOCIAL_EMOTIONAL (a domain different from the seeded BEHAVIORAL tier so the partial UNIQUE on `(student, year, domain) WHERE status='ACTIVE'` accepts the row). 2nd ACTIVE SOCIAL_EMOTIONAL tier same `(student, year)` rejected by the partial UNIQUE keystone with **the conflicting tier id in the friendly 400 message** ("Student already has an ACTIVE SOCIAL_EMOTIONAL tier (TIER_2, id <id>) for this academic year. Exit / promote / demote that tier first."). New Social Skills Group SOCIAL_EMOTIONAL_LEARNING intervention added under the tier with frequency "2x per week, 30 minutes". Progress data point logged (score=2.00, benchmark=1.00). **`svc.tier.changed` envelope captured live** on `dev.svc.tier.changed` with full ADR-057 shape and `payload.reason='CREATED'` (oldTier=null on initial assignment; the same emit fires on TIER_CHANGED transitions with oldTier populated).

- **S7 — Coordinated care intersection gate.** Hayes posts a COUNSELLOR-role coordinated-care note about Maya's health-related anxiety. The role-vs-perm validator runs server-side; Hayes holds cou-001:write so COUNSELLOR is accepted. **Intersection gate distribution** verified — only callers who hold BOTH `hlt-001:read` AND `cou-007:read` pass: counsellor 200 / admin 200 / teacher 403 / parent 403 / student 403. The IAM seed grants both codes only to admin / principal / vp / counsellor (Staff role); teachers hold hlt-001:read but NOT cou-007:read; parents the same; students hold neither. The intersection is the keystone of the coordinated care surface.

- **S8 — Mandatory report immutability (defence-in-depth).** Rivera files SUSPECTED_NEGLECT for Ethan with description populated. Status starts at FILED; reporter_person_id stamped server-side from `actor.personId`. Admin updates the MUTABLE fields cleanly (`status=CPS_CONTACTED`, `cpsResponse` populated). **Admin attempt to PATCH `description` (immutable core field) → 400 "property description should not exist"** from the global `ValidationPipe` whitelist (UpdateMandatoryReportDto only declares `status` + `cpsResponse`). This is the first line of defence; the service-layer `immutableFields` walk in `MandatoryReportService.update()` is the second.

- **S9 — Teacher visibility.** Rivera (teacher) sees own referral with status ACCEPTED + `assignedCounselorName='Marcus Hayes'`. GET `/sessions/:id/notes` → 403 (FERPA gate; teachers never hold student_counseling_record:read). GET `/caseloads` returns Maya's caseload row (her class student) with notes stripped server-side per the per-row manager check (Rivera is not the assigned counsellor of record so the row is non-manager; `notes` is stripped to null in the response DTO). GET `/coordinated-care` → 403 (intersection gate; teacher lacks cou-007:read). GET `/mandatory-reports` returns ONLY own filed reports (reporter row scope on `referred_by = me`).

- **S10 — Parent visibility (5 of 6 surfaces locked).** Parent sees Maya's caseload row with notes stripped (GUARDIAN row-scope at the service layer). Every other Cycle 11 surface is locked for parents: `/sessions/:id/notes` 403 / `/referrals` 403 / `/coordinated-care` 403 / `/mtss/tiers` 403 / `/mandatory-reports` 403. The parent's only Cycle 11 surface is the caseload assignment row (counsellor name + concern) — every other surface 403s at the gate. This matches the plan's parent-visibility contract exactly: parents see who is counselling their child but nothing about the content of that counselling.

**Cleanup section restores `tenant_demo` to post-Step-4 seed shape** exactly: deletes the S1 referral and its activity, the S4 session and its FERPA note, the S6 MTSS tier (CASCADE drops the intervention which CASCADEs to progress), the S7 coordinated care note, and the S8 mandatory report. Final SQL count query confirms `caseloads=1 BIP_with_caseload=1 referrals=1 activity=1 types=2 sessions=2 notes=2 tiers=1 interventions=1 progress=1 care_notes=1 reports=0` (post-Step-4 seed shape, note1 is_locked=false). The next CAT run starts on the same fresh ground.

**Reviewer attention items (non-blocking, deferred to post-cycle review or Wave 2 Phase 2):**

1. **Counsellor / Nurse / Lead-counsellor role split** (carried from REVIEW-CYCLE9 MAJOR 4 + REVIEW-CYCLE10 MAJOR 2). The demo Staff role currently grants every COU code + every HLT code. The intersection gate fires correctly today because admin + Staff both hold both codes, but **before pilot** the Staff role should split into a dedicated Counsellor (no HLT-001:write) and Nurse (no COU-007:write or COU-001:write) so the role-vs-perm validator path is exercised correctly. Joins the existing Cycle 9 + Cycle 10 punch list items in the Wave 2 Phase 2 backlog.
2. **Mandatory report retention policy at the audit layer.** `svc_mandatory_reports.student_id → sis_students(id) NO ACTION` enforces the schema-side "retained permanently" invariant; an admin trying to delete a student with mandatory reports gets a clean refuse. The full retention policy story (S3 archive bucket / 7-year minimum / state-by-state variation) is out of scope for the application layer and lives in the operational docs.
3. **Coordinated care notes — soft `author_person_id` ref.** Per ADR-001/020 the column is a soft ref to `platform.iam_person(id)` with no DB-enforced FK. The Step 7 service stamps it from `actor.personId` so caller input on that field is a no-op. A future-cycle `platform_reference_health` job would track these soft refs for orphan detection.
4. **Student Counselling tab composition view** (plan §09 5th surface). Aggregates active caseload + MTSS tier + recent sessions + coordinated-care thread + linked BIP into one staff-only view on the existing student profile. The 4 routes that just shipped each cover a piece individually; a polish-pass tab adding the composition is reasonable post-CAT.
5. **Wellbeing check-ins (6 tables) deferred to Cycle 11.1.** The M27 module ships a self-contained student-facing pulse-survey + auto-alert sub-system that is intentionally out of Cycle 11 scope.

---

## Cycle 11 Completion Criteria

1. Tenant schema: 14 new tables (4 caseload/referral + 8 session/MTSS + 2 care/reporting) + 1 FK backfill on `svc_behavior_plans.caseload_id`. Tenant table count: 155 → 169.
2. Counselling API: ~38 endpoints with FERPA session-note access control.
3. Session notes gated on `student_counseling_record:read` — teachers and parents NEVER see content.
4. Note locking: `is_locked=true` is irreversible; locked notes are immutable.
5. MTSS tiers with interventions + progress monitoring + team meetings. `svc.tier.changed` Kafka emit.
6. Referral pipeline: teacher submits → counsellor triages → accepts → caseload. `svc.referral.created` Kafka emit.
7. Coordinated care: nurse + counsellor intersection-gated shared notes.
8. Mandatory reporting: immutable core fields after FILED. Retained permanently.
9. Cycle 9 BIP `caseload_id` FK backfill resolves the soft ref.
10. HANDOFF-CYCLE11.md and CLAUDE.md updated. CI green.

---

Cycle 11 is the **third cycle of Wave 2 (Student Services)**; the next cycle (Cycle 11.1: Wellbeing Check-Ins) ships the 6 deferred wellbeing tables. Cycles 12–13 (Library + Athletics & Clubs) complete Wave 2.
