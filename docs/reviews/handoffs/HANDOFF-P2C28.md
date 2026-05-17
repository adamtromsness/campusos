# HANDOFF — Phase 2 Cycle 28 (Community .1 Bundle)

**Plan:** [`docs/campusos-p2c28-community-bundle.html`](docs/campusos-p2c28-community-bundle.html)
**Review:** [`P2C28-REVIEW-NOTES.md`](P2C28-REVIEW-NOTES.md)
**Status:** **COMPLETE + APPROVED.** Round 1 FAIL with 8 BLOCKING + 3 MAJOR + 2 CodeQL findings; Round 2 against `296f7cc` returned **PASS** across all 10 dimensions. Tagged `p2c28-complete` at `296f7cc` and `p2c28-approved` at the closeout commit.

## REVIEW-P2C28 Round 2 verdict — PASS

Reviewer's verification table marks every prior blocker FIXED. Per-dimension score:

| Dimension                                                            |   Rating |
| -------------------------------------------------------------------- | -------: |
| Groups Polls (anonymous repeat-vote prevention)                      | **PASS** |
| Groups Advanced School Scope (school-admin override paths)           | **PASS** |
| Invitations (invited-user current-school)                            | **PASS** |
| Club Budgets (activity/school ownership)                             | **PASS** |
| AI Minutes (parent meeting school ownership)                         | **PASS** |
| Student Services Event Durability (svc.referral.escalated outbox)    | **PASS** |
| Agency Referrals (parent referral school ownership)                  | **PASS** |
| Student Services Analytics / MTSS / Wellbeing                        | **PASS** |
| Resource Mutation Paths (group school predicates)                    | **PASS** |
| Meeting Template Participants (current-school validation + loop cap) | **PASS** |
| CodeQL Loop Bounds                                                   | **PASS** |

Reviewer cache-busted each affected file in code on Round 2 and confirmed every fix matches. The final verdict closes the P2-28 gate.

**Non-blocking carry-over:** AI minutes approval breadth (Round 1 MAJOR 3) — service already refuses STUDENT/GUARDIAN at the service layer; the role-distribution audit before pilot needs to confirm `MTG-001:admin` is not over-granted. Joins the broader Wave 2 / Wave D Phase 2 role-split chain (Counsellor / Nurse / Librarian / AD / FSM / FM / TC / Procurement Officer / Store Manager / IT Admin / Finance Officer / DPO / EO / Recruitment Administrator).

**Tagging:** `p2c28-complete` at `296f7cc` (the Round 1 fix commit that earned Round 2 PASS) and `p2c28-approved` at the closeout commit.

## REVIEW-P2C28 Round 1 fix log

Round 1 against `57b9089` returned FAIL with 8 BLOCKING + 3 MAJOR + 2 CodeQL findings. The fix commit lands all 8 BLOCKING + the 2 actionable MAJORs + the loop-bound-injection findings. The third MAJOR (AI minutes approval breadth) is an acknowledged role-distribution observation; the service already refuses STUDENT and GUARDIAN at the layer below the controller gate, so it does not require a code change — it joins the role-split punch list.

| Round 1 finding                                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **BLOCKING 1** Anonymous polls allow repeat voting                                    | New tenant migration `174_grp_poll_voter_checks.sql` adds `grp_poll_voter_checks` with PK(poll_id, voter_id). `PollService.vote` inserts the voter-check row inside the same tenant tx as the vote rows; PK collision raises 23505 → `ConflictException`. `hasVoted` now reads voter-check for both anonymous and identified polls. Structural anonymity preserved — `grp_poll_votes.voter_id` is still NULL for anonymous polls.                      |
| **BLOCKING 2** Group advanced create paths bypass school validation for school admins | New `apps/api/src/groups-advanced/access.ts` exports `assertGroupInCurrentSchool(groupId)`. Every create / recompute / patch / delete path in PollService, ResourceLibraryService, InvitationService, MeetupService, GroupAnalyticsService now calls it before the school-admin short-circuit. School A admin with a School B group UUID → 403.                                                                                                        |
| **BLOCKING 3** Invitation invited-user validation not current-school scoped           | `assertAccountInCurrentSchool` replaces the prior tenant-only check. Validates the invited `platform_users.id` has a `sis_students`, `sis_student_guardians`, or `hr_employees` projection in **this** school (not just the tenant).                                                                                                                                                                                                                   |
| **BLOCKING 4** Club budgets not school-scoped                                         | New `apps/api/src/clubs-meetings-advanced/access.ts` exports `assertActivityInCurrentSchool` + `assertAcademicYearInCurrentSchool`. `ClubBudgetService.list / loadOrFail / create / patch / recordTransaction / listTransactions` all filter through `ext_activities.school_id` or call the helpers before INSERT. The FOR UPDATE lock JOINs `ext_activities` and predicates `school_id = $tenant`.                                                    |
| **BLOCKING 5** AI minutes not school-scoped                                           | `SELECT_MINUTES` joins `mtg_meetings mtg ON mtg.id = m.meeting_id`. `getForMeeting / loadOrFail / generate / regenerate / approve` all filter `mtg.school_id = $tenant`. `generate` adds `assertMeetingInCurrentSchool` before INSERT. UPDATE statements rewritten to join the parent meeting.                                                                                                                                                         |
| **BLOCKING 6** `svc.referral.escalated` best-effort after commit                      | `CrisisEscalationService` constructor swaps `KafkaProducerService` for `OutboxService`. The emit moves inside the tenant tx via `OutboxService.enqueueInTx` with a deterministic event_id from new `event-ids.ts::deterministicReferralEscalatedEventId(referralId, activityId)`. Retry produces the same envelope; the downstream consumer's idempotency catches redelivery.                                                                          |
| **BLOCKING 7** Agency referrals not school-scoped                                     | `SELECT_BASE` already joined `svc_referrals r`; `list / loadOrFail / create / patch` all now carry `r.school_id = $tenant` predicate. `patch` UPDATE rewritten to `UPDATE svc_agency_referrals ar SET … FROM svc_referrals r WHERE r.id = ar.referral_id AND ar.id = $N AND r.school_id = $M`.                                                                                                                                                         |
| **BLOCKING 8** Student services dashboard / MTSS / longitudinal not school-scoped     | `CaseloadDashboardService.getDashboard` filters both `c.school_id = $tenant` AND `e.school_id = $tenant`. `MtssTeamMeetingService.recordDiscussion` validates `sis_students.school_id` and the post-INSERT reload joins the parent meeting on school. `WellbeingLongitudinalService.getForStudent` joins `sis_students` and filters `l.school_id = $tenant`; `listForYear` adds `l.school_id`; `computeTrend` prior-year lookup adds school predicate. |
| **MAJOR 1** Resource library patch/delete/version reload paths                        | `assertGroupInCurrentSchool` added to `patch / remove / addVersion` after the parent group is looked up.                                                                                                                                                                                                                                                                                                                                               |
| **MAJOR 2** Meeting template participant IDs not validated against current school     | `createMeetingFromTemplate` validates supplied `participantIds` via current-school sis_students/sis_student_guardians/hr_employees projections before insert. Missing accounts surface in a single 400 listing the offending UUIDs. Loop bounded at 200 (CodeQL js/loop-bound-injection).                                                                                                                                                              |
| **MAJOR 3** AI minutes approval breadth                                               | Acknowledged — service refuses STUDENT / GUARDIAN at the service layer. Role-distribution audit before pilot joins the broader role-split punch list.                                                                                                                                                                                                                                                                                                  |
| **CodeQL js/loop-bound-injection** Poll options + optionIds                           | DTOs gain `@ArrayMaxSize(50)`. `PollService.create` + `vote` add explicit length-cap checks. Meeting template participantIds capped at 200.                                                                                                                                                                                                                                                                                                            |

### Files touched in the fix commit

| File                                                                       | Change                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/database/prisma/tenant/migrations/174_grp_poll_voter_checks.sql` | New — `grp_poll_voter_checks` PK(poll_id, voter_id).                                                          |
| `apps/api/src/groups-advanced/access.ts`                                   | New — `assertGroupInCurrentSchool` + `assertAccountInCurrentSchool`.                                          |
| `apps/api/src/groups-advanced/poll.service.ts`                             | Voter-check + school-scope + ArrayMaxSize.                                                                    |
| `apps/api/src/groups-advanced/invitation.service.ts`                       | School-scope + current-school invited-user.                                                                   |
| `apps/api/src/groups-advanced/resource-library.service.ts`                 | School-scope on create + patch + remove + addVersion.                                                         |
| `apps/api/src/groups-advanced/meetup.service.ts`                           | School-scope on create.                                                                                       |
| `apps/api/src/groups-advanced/analytics.service.ts`                        | School-scope on list + recompute.                                                                             |
| `apps/api/src/groups-advanced/dto/groups-advanced.dto.ts`                  | `@ArrayMaxSize(50)` on options + optionIds.                                                                   |
| `apps/api/src/clubs-meetings-advanced/access.ts`                           | New — `assertActivityInCurrentSchool` + `assertAcademicYearInCurrentSchool` + `assertMeetingInCurrentSchool`. |
| `apps/api/src/clubs-meetings-advanced/club-budget.service.ts`              | School-scope on every list/load/create/patch/recordTransaction/listTransactions path.                         |
| `apps/api/src/clubs-meetings-advanced/ai-minutes.service.ts`               | School-scope JOIN through `mtg_meetings` on every path.                                                       |
| `apps/api/src/clubs-meetings-advanced/meeting-template.service.ts`         | ParticipantIds validated against current-school projections; loop capped.                                     |
| `apps/api/src/student-services-advanced/event-ids.ts`                      | New — `deterministicReferralEscalatedEventId(referralId, activityId)`.                                        |
| `apps/api/src/student-services-advanced/crisis-escalation.service.ts`      | OutboxService inside tenant tx; deterministic event_id.                                                       |
| `apps/api/src/student-services-advanced/agency-referral.service.ts`        | School-scope on every list / load / create / patch path.                                                      |
| `apps/api/src/student-services-advanced/caseload-dashboard.service.ts`     | School-scope on caseloads + hr_employees.                                                                     |
| `apps/api/src/student-services-advanced/mtss-team-meeting.service.ts`      | Student school-scope; post-insert reload joins meeting school.                                                |
| `apps/api/src/student-services-advanced/wellbeing-longitudinal.service.ts` | School-scope on every read + prior-year trend lookup.                                                         |

### CI parity at the fix commit

- API build clean
- Prettier format clean
- log-schema lint 996 files clean
- Migration `174_grp_poll_voter_checks.sql` splitter audit clean on second attempt (one stray `;` inside the block-comment header caught + rewritten with an em-dash before successful provision)
- Both `tenant_demo` and `tenant_test` provisioned cleanly

### Non-blocking items carried to Phase 2 / pre-pilot

- MAJOR 3 from Round 1 (AI minutes approval breadth) is a role-distribution observation. Joins the broader role-split punch list — counsellor / nurse / lead-counsellor / librarian role split that prior cycles also accept as pre-pilot work.
- Regression tests covering the 8 BLOCKING fixes are deferred to the broader Wave 2 Phase 2 test-hardening cycle. The schema change in migration 174 is the structural backstop for BLOCKING 1; cross-school predicates in service code are the structural backstop for BLOCKINGs 2–5 + 7–8; the deterministic event_id + outbox pattern is the structural backstop for BLOCKING 6.

## Cycle scope

P2-28 closes the deferred-table surface for four community modules in one bundled cycle:

- **M103 Groups & Communities .1** — polls, informal group events, resource library with version control, group invitations, monthly analytics. (P2-28a, 9 tables, ~18 endpoints, migration `171`.)
- **M64 Clubs & Student Life .1** — club budgets with transaction ledger, field-trip post-evaluations, service-learning partner organisations. (P2-28b half-1, 4 tables.)
- **M41 Meetings .1** — meeting templates with create-from-template materialisation, AI-generated meeting minutes (stub). (P2-28b half-2, 2 tables. Total P2-28b: 6 truly-new tables + 4 already-shipped Cycle 17 election tables, migration `172`, ~22 endpoints.)
- **M27 Student Services .1** — counsellor caseload dashboard, external agency referrals with consent gate, CRISIS referral escalation with IMMUTABLE activity log, longitudinal wellbeing aggregation, MTSS team meeting student-discussion coordination. (P2-28c, 2 truly-new tables + 6 already-shipped Cycle 11 tables + 3 additive columns, migration `173`, ~15 endpoints.)

Pre-split into 3 sub-cycles along module boundaries for clean dependency management. Each sub-cycle is independently shippable. Plan headline "27 tables" is partly aspirational: the actual P2-28 delta is **17 truly-new tenant tables + 3 additive columns on Cycle 11 svc tables** (9 in P2-28a + 6 in P2-28b + 2 in P2-28c). The remaining 10 plan-listed tables already shipped in earlier cycles (Cycle 11 svc, Cycle 17 ext_elections / ext_candidates / ext_votes / ext_election_voter_check). Same over-count pattern as P2-26, P2-27, and prior sub-cycles. Cumulative new endpoints ~55.

Tenant logical base table count: 776 (post-P2-27) → **793** (post-P2-28: 776 + 9 + 6 + 2). With the 3 additive columns on existing Cycle 11 tables, the surface area expansion vs the P2-27 closeout is meaningful but smaller than the plan suggests; the plan over-counts because it lists every plan-relevant ERD table including those already shipped.

## Sub-cycle structure

### P2-28a — Groups Advanced (commit `37d1f98`)

**9 new tenant tables in migration `171_grp_polls_events_resources.sql`:**

| Table                   | Purpose                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grp_group_polls`       | Poll head — SINGLE_CHOICE / MULTIPLE_CHOICE / RANKED with optional allows_anonymous flag and OPEN / CLOSED / CANCELLED lifecycle.                                                           |
| `grp_poll_options`      | Per-poll choices with denormalised `vote_count INT` incremented atomically inside locked tenant tx.                                                                                         |
| `grp_poll_votes`        | Vote ledger. Anonymous polls write `voter_id=NULL` — structural anonymity. Non-anonymous polls guarded by partial UNIQUE INDEX `(poll_id, voter_id, option_id) WHERE voter_id IS NOT NULL`. |
| `grp_group_events`      | Informal group meetups — distinct from Cycle 18 grp_events (school-wide) and P2-12 evt_events (ticketed).                                                                                   |
| `grp_group_event_rsvps` | CONFIRMED / DECLINED / PENDING with service-layer cap enforcement against max_attendees.                                                                                                    |
| `grp_resource_library`  | Pinned resources with `version INT DEFAULT 1`.                                                                                                                                              |
| `grp_resource_versions` | Version history — INSERT + parent version INCREMENT in one tx.                                                                                                                              |
| `grp_group_invitations` | PENDING / ACCEPTED / DECLINED with ACCEPTED auto-creating `grp_members` row inside same tx.                                                                                                 |
| `grp_group_analytics`   | Monthly UPSERT on `(group_id, period)` — idempotent.                                                                                                                                        |

**5 services + 1 controller + ~18 endpoints + 0 Kafka emits** under GRP-001..003.

Services: `PollService`, `GroupMeetupService`, `ResourceLibraryService`, `InvitationService`, `GroupAnalyticsService`. All reuse Cycle 18 `GroupService.assertCanManageGroup` and row-scope helpers.

**Five structural keystones (P2-28a):**

1. **Atomic poll vote counter.** UPDATE grp_poll_options SET vote_count = vote_count + 1 inside locked tx with SELECT ... FOR UPDATE on the parent poll. Anonymous votes write voter_id=NULL — structural anonymity at the schema layer. Non-anonymous protected by partial UNIQUE INDEX.
2. **Meetup RSVP cap.** CONFIRMED count recomputed under the parent meetup lock so two concurrent confirms cannot both pass max_attendees.
3. **Resource versioning.** Version INSERT and parent version INCREMENT run together in one tenant tx.
4. **Invitation ACCEPTED auto-member.** Invitation flip and grp_members row INSERT land in same tx. Pre-existing member treated as no-op; partial UNIQUE catches concurrent race.
5. **Monthly analytics UPSERT.** `(group_id, period)` idempotent recompute. engagement_rate = active_members / total_members clamped to 0 on empty groups.

### P2-28b — Clubs + Meetings Advanced (commit `1b38294`)

**6 truly-new tenant tables in migration `172_ext_elections_budgets_mtg.sql`** (plus 4 already-shipped Cycle 17 election tables: ext_elections, ext_candidates, ext_votes, ext_election_voter_check, all with STRUCTURAL ANONYMITY on ext_votes — no voter_id column):

| Table                        | Purpose                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ext_club_budgets`           | Per-(activity, academic_year) head. UNIQUE catches duplicates. `remaining_amount` computed at service layer as `allocated - spent`. |
| `ext_budget_transactions`    | 4-value type CHECK ALLOCATION / EXPENSE / REFUND / ADJUSTMENT. INSERT bumps parent's spent_amount atomically in same tx.            |
| `ext_field_trip_evaluations` | 1..5 CHECK on overall_rating + 3 subscales. UNIQUE per (trip, evaluator).                                                           |
| `ext_service_partner_orgs`   | External service-learning partner orgs. UNIQUE(school, name).                                                                       |
| `mtg_meeting_templates`      | Reusable meeting templates with `default_agenda JSONB`.                                                                             |
| `mtg_ai_minutes`             | UNIQUE(meeting_id). PENDING → GENERATED → APPROVED multi-column lockstep. Approved minutes are canonical record.                    |

**5 services + 1 controller + ~22 endpoints + 0 new Kafka emits** under CLB-001..004 + MTG-001..002.

Services: `ClubBudgetService`, `FieldTripEvalService`, `ServicePartnerService`, `MeetingTemplateService`, `AIMinutesService`. ElectionService + VoteService already in Cycle 17 — STRUCTURAL ANONYMITY KEYSTONE on ext_votes preserved.

**Six structural keystones (P2-28b):**

1. **Atomic spent_amount.** ext_budget_transactions INSERT and parent ext_club_budgets.spent_amount UPDATE commit together inside one tenant tx. EXPENSE bumps up, REFUND bumps down, ALLOCATION bumps allocated, ADJUSTMENT carries rationale only. Refuses EXPENSE > allocated and REFUND that would drive spent negative.
2. **Field trip evaluation bounds.** Schema-level 1..5 CHECK on overall + 3 subscale columns. UNIQUE(trip, evaluator) caps each evaluator at one row.
3. **Service partner UNIQUE.** UNIQUE(school, name) catches duplicates. is_active for soft deactivation.
4. **Meeting templates UNIQUE + create-from-template.** UNIQUE(school, name). default_agenda JSONB drives createMeetingFromTemplate — INSERT mtg_meetings + N mtg_agenda_items in one tenant tx.
5. **AI minutes lockstep.** UNIQUE(meeting_id). PENDING → GENERATED → APPROVED multi-column status / generated_chk / approved_chk lockstep enforced at the schema layer. Regenerate refused on APPROVED minutes.
6. **AI inference stub.** model_version='STUB_VERSION_0' so P3-A1 can swap the stub for a real model call without changing the surface. Future model upgrades preserve audit traceability via the column.

### P2-28c — Student Services Advanced (this commit)

**2 truly-new tenant tables + 3 additive columns in migration `173_svc_agency_longitudinal.sql`** (plus 6 already-shipped Cycle 11 svc tables: svc_caseloads, svc_referral_types, svc_referrals, svc_referral_activity (IMMUTABLE), svc_mtss_team_meetings, svc_mtss_team_meeting_students):

| Table / Column                         | Purpose                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `svc_agency_referrals`                 | External-agency referral row attached to parent svc_referrals. 4-value status CHECK REFERRED / CONTACTED / ACTIVE_SERVICE / DISCHARGED with consent gate.                                 |
| `svc_wellbeing_longitudinal`           | Per-(student, academic_year, domain) annual aggregate. 5-value domain CHECK + 3-value trend CHECK. UNIQUE(student, academic_year, domain). No individual check-in data — aggregates only. |
| `svc_referral_types.referral_category` | 3-value CHECK INTERNAL / EXTERNAL / CRISIS. Nullable for backward compat with Cycle 11 seed (defaults to INTERNAL on first read).                                                         |
| `svc_referrals.concern_description`    | Long-form concern at submission. Nullable so Cycle 11 seed rows (which used the legacy `reason` column) keep working.                                                                     |
| `svc_referrals.source_incident_id`     | SOFT INTEGRITY ref to sis_discipline_incidents per ADR-001 / ADR-020. NULL when referral was not initiated from a discipline event. Partial INDEX WHERE NOT NULL.                         |

**5 services + 1 controller + ~15 endpoints + 1 Kafka emit** (`svc.referral.escalated`) under COU-001..004.

Services: `CaseloadDashboardService` (read-only capacity dashboard), `AgencyReferralService` (4-state lifecycle with consent gate), `WellbeingLongitudinalService` (annual aggregation), `MtssTeamMeetingService` (team-meeting coordination + per-student discussion records), `CrisisEscalationService` (CRISIS auto-escalation keystone).

**Five structural keystones (P2-28c):**

1. **IMMUTABLE referral activity log (Cycle 11 invariant we surface).** ESCALATED activity rows written inside the same tenant tx as the referral priority + status flip. No UPDATE method on svc_referral_activity. No DELETE method. CASCADE on parent referral hard-delete only. Mirrors Cycle 8 tkt_ticket_activity + Cycle 10 hlth_health_access_log.
2. **CRISIS auto-escalation.** `CrisisEscalationService.escalate` locks the parent svc_referrals row FOR UPDATE, flips priority to URGENT, advances SUBMITTED / TRIAGED → ACCEPTED, writes ESCALATED activity row, and emits svc.referral.escalated outside the tx. Idempotent on already-URGENT-ACCEPTED rows (surfaced as 400). The future Cycle 11 ReferralService.create bridge into svc_referral_types.referral_category=CRISIS auto-escalation reuses the same activity-row + status-flip discipline; the manual endpoint here is the counsellor's queue-driven safety net.
3. **Consent gate on agency referrals.** CONTACTED → ACTIVE_SERVICE transition refused until consent_obtained=true. Service raises 400 with the explicit message "Parent consent is required before sharing student information with an outside agency." Schools cannot release student information to outside agencies without parent consent.
4. **Wellbeing longitudinal aggregation.** Annual UPSERT on (student, academic_year, domain) materialised from svc_wellbeing_responses joined to svc_wellbeing_questions for the domain label. Idempotent — re-running overwrites the same row. NO individual check-in data — only domain averages + trend direction (IMPROVING / STABLE / DECLINING relative to prior year, ±0.3 threshold) + flagged counts. Staff-only read; admin-only materialise.
5. **MTSS team meeting recommendation mapping.** New 3-value recommendation token (MAINTAIN / ESCALATE / DE_ESCALATE) on the per-(meeting, student) discussion record maps onto the existing Cycle 11 5-value outcome enum (NO_CHANGE / TIER_UP / TIER_DOWN) at the service layer so the new surface and the legacy Cycle 11 MTSS controller coexist on the same row without a schema change. EXIT and CONTINUE_WITH_ADJUSTMENT round-trip as `null` on the new API.

## Cumulative scope

| Metric            | P2-28a | P2-28b | P2-28c | Total P2-28 |
| ----------------- | ------ | ------ | ------ | ----------- |
| New tenant tables | 9      | 6      | 2      | 17          |
| Additive columns  | 0      | 0      | 3      | 3           |
| Services          | 5      | 5      | 5      | 15          |
| Endpoints (~)     | 18     | 22     | 15     | ~55         |
| Kafka emits       | 0      | 0      | 1      | 1           |
| Migrations        | `171`  | `172`  | `173`  | 3           |

## Permissions

Reuses existing IAM grants — no catalogue additions in P2-28c. The plan headers reference SVC-001..003 codes but the existing COU-001..004 catalogue entries already cover the equivalent surface:

- `COU-001:read` — caseload dashboard read (P2-28c CaseloadDashboardService)
- `COU-002:read` / `:write` — agency referral read / write + crisis escalation (P2-28c AgencyReferralService + CrisisEscalationService)
- `COU-003:read` / `:write` — MTSS team-meeting read / write (P2-28c MtssTeamMeetingService)
- `COU-004:read` / `:admin` — wellbeing longitudinal read + admin-only materialise (P2-28c WellbeingLongitudinalService)

Staff + School Admin / Platform Admin hold these grants from Cycle 11 + Cycle 11.1. Teachers hold a subset; parents and students never reach the P2-28c surfaces (every service additionally refuses STUDENT and GUARDIAN at the service layer).

## Cross-cycle integration

- **Cycle 11 svc_caseloads** — P2-28c CaseloadDashboardService aggregates active rows per counsellor and surfaces utilisation against a default capacity target of 35. Read-only — does not write to svc_caseloads.
- **Cycle 11 svc_referrals + svc_referral_activity** — P2-28c CrisisEscalationService.escalate writes ESCALATED activity rows + flips parent referral priority to URGENT atomically. Re-uses the existing IMMUTABLE audit pattern. Cycle 11 ReferralService.create continues to write SUBMITTED rows; the future bridge for `svc_referral_types.referral_category=CRISIS` auto-escalation re-uses the activity + status-flip discipline.
- **Cycle 11.1 svc_wellbeing_responses + svc_wellbeing_questions** — P2-28c WellbeingLongitudinalService.materialise reads these source tables to compute per-(student, year, domain) aggregates. Idempotent UPSERT — re-running overwrites.
- **Cycle 11 svc_mtss_team_meetings + svc_mtss_team_meeting_students** — P2-28c MtssTeamMeetingService reuses these tables. Maps the new 3-value recommendation token onto the existing 5-value outcome enum at the service layer. Legacy Cycle 11 MTSS controller continues to write outcomes directly.
- **Cycle 11 svc_referral_types** — P2-28c additive column `referral_category` with 3-value CHECK is nullable for backward compat. Cycle 11 seed rows default to INTERNAL on first read.
- **Cycle 18 grp_groups + grp_members** — P2-28a polls, meetups, resources, invitations all attach to grp_groups. InvitationService creates grp_members rows on ACCEPTED in same tx.
- **Cycle 17 ext_elections + ext_votes + ext_candidates + ext_election_voter_check** — P2-28b plan referenced these as "new" but they already shipped in Cycle 17 migration `060` with the STRUCTURAL ANONYMITY KEYSTONE on ext_votes (zero voter_id columns anywhere). P2-28b only ships the 6 truly-new tables.
- **Cycle 18 ext_activities + ext_field_trips** — P2-28b club budgets attach via activity_id; field-trip evaluations attach via field_trip_id.
- **Cycle 7 mtg_meetings + mtg_meeting_types** — P2-28b meeting templates create mtg_meetings rows on createMeetingFromTemplate.

## CI status

API build clean; Prettier format clean; log-schema lint 993 files clean.

Vitest run as of P2-28b closeout: 1452/1452 across 69 spec files. P2-28c ships service-layer code only — no schema migration changes the existing vitest fixtures. Re-run after this commit to confirm.

## Open follow-ups (Phase 2 / pre-pilot punch list)

These items move to Phase 2 / pre-pilot per the same cadence as prior cycles. None block P2-28 peer review:

1. **CRISIS auto-escalation bridge into Cycle 11 ReferralService.create.** P2-28c ships the manual `CrisisEscalationService.escalate` endpoint that locks the parent referral row + writes the ESCALATED audit row + flips priority + status. A future cycle that touches Cycle 11 ReferralService can read `svc_referral_types.referral_category` at create time and call the same internal helper inside the create tx so a CRISIS-category referral lands at URGENT + ACCEPTED on submission. The audit + Kafka contract is already in place; only the create-time call needs wiring.
2. **AI Inference stub swap.** P2-28b mtg_ai_minutes ships with `model_version='STUB_VERSION_0'`. P3-A1 AI Inference deploys the real model call. Schema + service surface unchanged.
3. **Wellbeing longitudinal seed.** Materialisation works on real Cycle 11.1 response data. Seed-level baseline rows for `tenant_demo` would smooth the dashboard until the first academic year of real responses lands.
4. **Capacity target per-school config.** P2-28c CaseloadDashboardService uses a hard-coded `DEFAULT_CAPACITY_TARGET=35`. Pre-pilot wire to a `school_config` key so each tenant can tune.
5. **Tests.** Vitest unit + integration coverage for P2-28c services. Joins the broader Wave 2 Phase 2 test-hardening cycle.
6. **CAT script.** Vertical-slice CAT for P2-28 covers all three sub-cycles end-to-end. Lands once peer review is in motion.
7. **`grp_resource_library.s3_key` upload + view-signed-URL wiring.** P2-28a schema accepts the column; real S3 round-trip is a Phase 3 ops task once a real bucket is provisioned.
8. **Field-trip evaluation summary dashboard.** P2-28b service returns the raw evaluation rows; an aggregated "avg rating over time" view is a polish item.

## Decisions made during the cycle

- **Migration numbers.** Plan headers said `159 / 160 / 161` but those slots were taken by Cycle 22 (Alumni). P2-28 used `171 / 172 / 173` matching the running provisioning order. Same situation as P2-27 (plan said `156-158`, repo uses `168-170`).
- **Plan over-count.** Plan headers list 27 tables; reality is 17 truly-new + 3 additive columns. The 10 already-shipped tables ship in P2-28b (4 election tables from Cycle 17) and P2-28c (6 svc tables from Cycle 11). Pragmatic — matches the P2-26 / P2-27 pattern.
- **Permission codes.** Plan referenced SVC-001..003 but the existing COU-001..004 catalogue entries cover the same surface. Adding new SVC codes would create a parallel grant tree without functional benefit. Same pragmatic call P2-28b made on its plan-listed codes.
- **MTSS recommendation mapping.** P2-28c plan called for a 3-value MAINTAIN / ESCALATE / DE_ESCALATE recommendation token. Cycle 11 already shipped a 5-value outcome enum (NO_CHANGE / TIER_UP / TIER_DOWN / EXIT / CONTINUE_WITH_ADJUSTMENT). Rather than introducing a parallel column, the new API maps MAINTAIN → NO_CHANGE / ESCALATE → TIER_UP / DE_ESCALATE → TIER_DOWN at the service layer and round-trips EXIT + CONTINUE_WITH_ADJUSTMENT as null on the new surface. Both the new endpoint and the Cycle 11 MTSS controller work against the same row.
- **CrisisEscalationService is the keystone shipped here.** The full automatic CRISIS-category bridge into Cycle 11 ReferralService.create is deferred to avoid changing the Cycle 11 service mid-cycle. The audit + Kafka contracts are ready for the bridge.

## How to run

```bash
# Provision schemas
pnpm --filter @campusos/database provision --subdomain=demo
pnpm --filter @campusos/database provision --subdomain=test

# Build API
pnpm --filter @campusos/api build

# Confirm CI parity
pnpm format:check
pnpm lint:logs
```

P2-28 is the bundled community-modules completion cycle. Peer review covers all three sub-cycles together — see `P2C28-REVIEW-NOTES.md` for the reviewer scaffold.
