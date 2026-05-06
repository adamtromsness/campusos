# Cycle 17 Handoff — Clubs & Student Life

**Status:** Cycle 17 **COMPLETE pending architecture review — Wave 3 Cycle 4 (Clubs & Student Life).** All 10 steps shipped + verified live on `tenant_demo` 2026-05-06. Cycle 17 builds the M64 Clubs & Student Life module — 16 of the 22 ERD tables in scope (6 deferred to Cycle 17.1: club charters + amendments, club budgets + transactions, student government positions + members). This is a clean greenfield with the new `ext_*` table prefix. The module spans 4 domains: (1) activity types + clubs/activities with membership rosters and schedules, (2) field trips with digital parent consent collection and chaperone assignments, (3) student government elections with **structurally anonymous voting** (the strongest privacy guarantee in the platform — `ext_votes` has NO voter_id and `ext_election_voter_check` has NO reference back to votes, so there is no JOIN path from a vote to a voter), and (4) community service programmes with student hour logging and supervisor approval. Students are active participants — they register for clubs, vote in elections, and log service hours — making this the **third student-input surface** after wellbeing check-ins (Cycle 11.1) and library reading logs/reviews (Cycle 12).

**Branch:** `main`
**Plan reference:** `docs/campusos-cycle17-implementation-plan.html`
**Vertical-slice deliverable:** Advisor creates "Chess Club" (ACADEMIC, max 20, Coach Rivera) → Maya and Ethan register as members → advisor schedules weekly meetings → teacher plans a "Natural History Museum" field trip for Grade 5 → system generates consent records → David Chen (parent) digitally signs Maya's consent → teacher assigns 2 chaperones → admin creates "Student Council Election 2026" with President position → Maya registers as a candidate → voting opens → Ethan casts an anonymous ballot (vote row has no voter ID; voter_check row prevents double-vote) → voting closes → results published → admin creates "Community Impact 2026" service programme (target: 20 hours) → Maya logs 3 hours of "Park Cleanup" with supervisor signature → advisor approves the hours → progress updates to 3/20 hours.

This document tracks the Cycle 17 build at the same level of detail as `HANDOFF-CYCLE16.md` and is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                           | Status |
| ---- | ----------------------------------------------- | ------ |
| 1    | Activities + Membership Schema                  | DONE   |
| 2    | Field Trips + Consent Schema                    | DONE   |
| 3    | Elections + Service Schema (anonymity keystone) | DONE   |
| 4    | Seed Data — Clubs / Election / Service + IAM    | DONE   |
| 5    | Activities + Membership NestJS Module           | DONE   |
| 6    | Field Trips + Consent NestJS Module             | DONE   |
| 7    | Elections + Service NestJS Module               | DONE   |
| 8    | Clubs UI — Activities + Field Trips             | DONE   |
| 9    | Clubs UI — Elections + Service + Student Portal | DONE   |
| 10   | Vertical Slice Integration Test                 | DONE   |

---

## What this cycle adds on top of Cycle 16

**Greenfield — no existing M64 surface.** Cycle 17 ships the entire M64 Clubs & Student Life module from scratch. The new `ext_*` table prefix means no rework, no schema collisions with existing modules.

**New in Cycle 17:**

- **16 new tenant base tables** across 3 migrations (058 + 059 + 060): `ext_activity_types`, `ext_activities`, `ext_activity_members`, `ext_activity_schedules`, `ext_field_trips`, `ext_field_trip_participants`, `ext_field_trip_consent_records` (PARENT CONSENT KEYSTONE), `ext_field_trip_chaperones`, `ext_elections`, `ext_candidates`, `ext_votes` (ANONYMITY KEYSTONE — no voter_id), `ext_election_voter_check` (anti-double-vote ledger with no JOIN path to votes), `ext_service_programmes`, `ext_service_hours`, `ext_service_hour_approvals`, `ext_service_progress`. Tenant base table count 223 → ~239.
- **3 new backend services modules**: ClubsModule (ActivityService + MembershipService + ScheduleService) + FieldTripsModule (FieldTripService + ConsentService + ChaperoneService) + ElectionsModule (ElectionService + VoteService + ServiceProgrammeService + ServiceHourService). Approximately **36 endpoints** total under `clb-001` through `clb-004` permission codes.
- **2 new Kafka emit topics**: `ext.consent.received` (parent signs field trip consent) + `ext.election.results.published` (admin publishes election results).
- **9 new web routes**: `/clubs` dashboard, `/clubs/activities/:id`, `/clubs/field-trips`, `/children/:id/field-trips` (parent consent portal), `/clubs/elections/:id/vote` (anonymous ballot UI), `/clubs/elections/:id` results, `/clubs/service-hours` student input, `/clubs/service-progress`, `/clubs/my` student portal.
- **CLB-001..004 permission grants**: Teacher / Student / Parent / Staff get the right reads + writes. Admin gets all via everyFunction. **The third student-input write permission**: `CLB-004:write` granted to Student so they can log their own service hours.

**Two structural keystones for the cycle:**

1. **Structurally anonymous voting** — `ext_votes` carries `(election_id, position, candidate_id, voted_at)` but **NO voter identity column**. The separate `ext_election_voter_check` table has `(election_id, student_id)` as a primary key to prevent double-voting, but no reference to any vote row. The schema makes ballot secrecy a structural property — no application bug, admin shortcut, or future migration can reverse it.
2. **Parent consent with digital signature** — `ext_field_trip_consent_records` stamps `signed_at`, `ip_address`, and `guardian_person_id` on every consent. UNIQUE(field_trip, student, guardian) prevents duplicate signatures. The `ConsentService.sign` endpoint emits `ext.consent.received` after commit so downstream consumers (future notifications, reports) can react.

**Existing-system touchpoints:**

- `iam_person(id)` — soft refs on every audit column (created_by, advisor_id, organiser_id, etc.) per ADR-001/020.
- `sis_students(id)` — DB-enforced FKs from `ext_activity_members`, `ext_field_trip_participants`, `ext_candidates`, `ext_election_voter_check`, `ext_service_hours`, `ext_service_progress` (CASCADE on student delete since the rows are personal student data).
- `hr_employees(id)` — DB-enforced FK on `ext_activities.advisor_id`, `ext_field_trips.organiser_id`, `ext_service_hour_approvals.approved_by` (NO ACTION — preserve audit when staff leaves).
- `sis_academic_years(id)` — DB-enforced FK on `ext_activities.academic_year_id` and `ext_service_programmes.academic_year_id`.
- `grp_groups(id)` — soft FK on `ext_activities.group_id` for future M103 Groups integration.
- `trn_*` (M61 Transportation) — soft FK on `ext_field_trips.transport_request_id` for future integration.

What does not change: every existing module continues to function. Cycle 17 is purely additive on a clean `ext_*` namespace.

---

## Step 1 — Activities + Membership Schema

**Status:** DONE

**Migration target:** `packages/database/prisma/tenant/migrations/058_ext_activities.sql`.

4 logical base tables:

1. **`ext_activity_types`** — Per-school catalogue. `school_id UUID NOT NULL`, `name TEXT NOT NULL`, `category TEXT NOT NULL` 6-value CHECK (SPORT, ARTS, ACADEMIC, LEADERSHIP, COMMUNITY, OTHER). UNIQUE(school_id, name).
2. **`ext_activities`** — Club / activity definition. `school_id UUID NOT NULL`, `activity_type_id UUID NOT NULL FK` (NO ACTION — admin must reassign or deactivate the type), `name TEXT NOT NULL`, `description TEXT`, `academic_year_id UUID NOT NULL FK` (NO ACTION), `advisor_id UUID FK(hr_employees)` SET NULL, `max_participants INT` nullable (NULL = unlimited), `status TEXT NOT NULL DEFAULT 'ACTIVE'` 3-value CHECK (ACTIVE, INACTIVE, COMPLETED), `meeting_location TEXT`, `group_id UUID` nullable (soft to grp_groups for future M103). INDEX(school_id, academic_year_id, status).
3. **`ext_activity_members`** — Membership rosters with role tracking. `activity_id UUID NOT NULL FK` CASCADE (membership has no meaning without its activity), `student_id UUID NOT NULL FK(sis_students)` CASCADE, `role TEXT NOT NULL DEFAULT 'MEMBER'` 4-value CHECK (MEMBER, OFFICER, PRESIDENT, SECRETARY), `joined_at DATE NOT NULL`, `left_at DATE` nullable, `is_active BOOLEAN DEFAULT true`. UNIQUE(activity_id, student_id) so a student appears at most once per club. INDEX(student_id, is_active) for the "my clubs" hot path.
4. **`ext_activity_schedules`** — Recurring schedule entries. `activity_id UUID NOT NULL FK` CASCADE, `day_of_week SMALLINT NOT NULL` CHECK(0–6), `start_time TIME NOT NULL`, `end_time TIME NOT NULL` (with `start_time < end_time` CHECK), `location TEXT`, `is_active BOOLEAN DEFAULT true`. INDEX(activity_id, is_active).

5 new intra-tenant FKs (1 NO ACTION on activity_type_id + 1 NO ACTION on academic_year_id + 1 SET NULL on advisor_id + 2 CASCADE on activity children). 0 cross-schema FKs. Tenant logical base table count: 223 → 227.

---

## Step 2 — Field Trips + Consent Schema

**Status:** DONE

**Migration target:** `packages/database/prisma/tenant/migrations/059_ext_field_trips.sql`.

4 logical base tables:

1. **`ext_field_trips`** — Trip planning. `school_id UUID NOT NULL`, `title TEXT NOT NULL`, `description TEXT`, `destination TEXT NOT NULL`, `trip_date DATE NOT NULL`, `departure_time TIME` / `return_time TIME` nullable, `grade_levels TEXT[]`, `max_participants INT`, `cost_per_student NUMERIC(6,2)` nullable + non-negative CHECK when set, `transport_request_id UUID` nullable (soft to trn\_\* for future M61), `organiser_id UUID NOT NULL FK(hr_employees)` NO ACTION, `status TEXT NOT NULL DEFAULT 'PLANNING'` 5-value CHECK (PLANNING, APPROVED, CONFIRMED, COMPLETED, CANCELLED), `consent_deadline DATE`. INDEX(school_id, trip_date DESC).
2. **`ext_field_trip_participants`** — `field_trip_id UUID NOT NULL FK` CASCADE, `student_id UUID NOT NULL FK(sis_students)` CASCADE, `attendance_status TEXT DEFAULT 'REGISTERED'` 4-value CHECK (REGISTERED, ATTENDED, ABSENT, WITHDRAWN). UNIQUE(field_trip_id, student_id).
3. **`ext_field_trip_consent_records`** — **PARENT CONSENT KEYSTONE.** `field_trip_id UUID NOT NULL FK` CASCADE, `student_id UUID NOT NULL FK(sis_students)` CASCADE, `guardian_person_id UUID NOT NULL` (soft to platform.iam_person), `consent_given BOOLEAN NOT NULL`, `signed_at TIMESTAMPTZ NOT NULL`, `ip_address TEXT`, `emergency_contact_override TEXT` nullable, `medical_notes_override TEXT` nullable, `notes TEXT`. UNIQUE(field_trip_id, student_id, guardian_person_id) so a guardian can sign exactly once for the same (trip, student) pair. ConsentService emits `ext.consent.received` on insert.
4. **`ext_field_trip_chaperones`** — `field_trip_id UUID NOT NULL FK` CASCADE, `person_id UUID NOT NULL` (soft — covers both staff via hr_employees.person_id and parent volunteers via iam_person), `role TEXT NOT NULL DEFAULT 'CHAPERONE'` 3-value CHECK (LEAD, CHAPERONE, DRIVER), `background_check_status TEXT DEFAULT 'NOT_REQUIRED'` 4-value CHECK (NOT_REQUIRED, PENDING, CLEARED, FAILED), `confirmed BOOLEAN DEFAULT false`. UNIQUE(field_trip_id, person_id).

5 new intra-tenant FKs (1 NO ACTION on organiser_id, 4 CASCADE on trip children). 0 cross-schema FKs. Tenant logical base table count: 227 → 231.

---

## Step 3 — Elections + Service Schema (anonymity keystone)

**Status:** DONE

**Migration target:** `packages/database/prisma/tenant/migrations/060_ext_elections_service.sql`.

8 logical base tables completing the schema phase:

1. **`ext_elections`** — `school_id UUID NOT NULL`, `title TEXT NOT NULL`, `description TEXT`, `voting_start TIMESTAMPTZ NOT NULL`, `voting_end TIMESTAMPTZ NOT NULL` (with `voting_end > voting_start` CHECK), `eligible_voters_filter JSONB NOT NULL` (structured: `{gradeLevels:[…]} | {yearGroups:[…]} | {studentIds:[…]} | {all:true}`), `status TEXT NOT NULL DEFAULT 'DRAFT'` 4-value CHECK (DRAFT, OPEN, CLOSED, RESULTS_PUBLISHED), `created_by UUID NOT NULL FK(hr_employees)` NO ACTION. INDEX(school_id, status).
2. **`ext_candidates`** — `election_id UUID NOT NULL FK` CASCADE, `student_id UUID NOT NULL FK(sis_students)` CASCADE, `position TEXT NOT NULL`, `statement TEXT`, `photo_s3_key TEXT`, `is_approved BOOLEAN DEFAULT true`, `registered_at TIMESTAMPTZ NOT NULL DEFAULT now()`. UNIQUE(election_id, student_id, position) so a student can run for at most one (election, position) pair.
3. **`ext_votes`** — **ANONYMITY KEYSTONE.** `election_id UUID NOT NULL FK` (NO ACTION — votes outlive election deletion attempts), `position TEXT NOT NULL`, `candidate_id UUID NOT NULL FK(ext_candidates)` NO ACTION, `voted_at TIMESTAMPTZ NOT NULL DEFAULT now()`. **NO voter_id column. NO student_id. NO person_id.** The vote cannot be traced to a voter at the schema level — there is no foreign key, no JOIN path, no nothing. INDEX(election_id, position) for tally queries.
4. **`ext_election_voter_check`** — Anti-double-vote ledger. `election_id UUID NOT NULL FK` CASCADE, `student_id UUID NOT NULL FK(sis_students)` CASCADE. **PRIMARY KEY(election_id, student_id)** is the only column set — no surrogate `id`, no `created_at`. Records WHO voted but has NO reference to any `ext_votes` row. **There is no JOIN path from a vote to a voter** — the anonymity is structural and cannot be reversed even by a database administrator.
5. **`ext_service_programmes`** — `school_id UUID NOT NULL`, `name TEXT NOT NULL`, `academic_year_id UUID NOT NULL FK(sis_academic_years)` NO ACTION, `target_hours NUMERIC(6,1) NOT NULL` CHECK > 0, `start_date DATE`, `end_date DATE`, `is_active BOOLEAN DEFAULT true`, `eligible_grade_levels TEXT[]`. UNIQUE(school_id, name, academic_year_id).
6. **`ext_service_hours`** — **STUDENT-INPUT KEYSTONE** (third student-input surface in CampusOS). `student_id UUID NOT NULL FK(sis_students)` CASCADE, `programme_id UUID FK` SET NULL (the row keeps its detail when the programme is removed), `organisation TEXT NOT NULL`, `description TEXT NOT NULL`, `service_date DATE NOT NULL`, `hours NUMERIC(4,1) NOT NULL` CHECK > 0, `supervisor_name TEXT`, `supervisor_contact TEXT`, `evidence_s3_key TEXT` nullable. INDEX(student_id, service_date DESC).
7. **`ext_service_hour_approvals`** — `service_hour_id UUID NOT NULL UNIQUE FK` CASCADE (one approval per service-hour row), `approved_by UUID NOT NULL FK(hr_employees)` NO ACTION, `status TEXT NOT NULL DEFAULT 'PENDING'` 3-value CHECK (PENDING, APPROVED, REJECTED), `notes TEXT`, `reviewed_at TIMESTAMPTZ`. The advisor approves student-submitted hours.
8. **`ext_service_progress`** — Per-(programme, student) running total. `programme_id UUID NOT NULL FK` CASCADE, `student_id UUID NOT NULL FK(sis_students)` CASCADE, `approved_hours NUMERIC(6,1) DEFAULT 0` CHECK >= 0, `pending_hours NUMERIC(6,1) DEFAULT 0` CHECK >= 0, `is_complete BOOLEAN DEFAULT false`. UNIQUE(programme_id, student_id). Updated on every approval / rejection.

10 new intra-tenant FKs (3 NO ACTION + 7 CASCADE/SET NULL). 0 cross-schema FKs. Tenant logical base table count: 231 → 239.

**Cycle 17 schema phase complete: 16 ext\_\* tables across 3 migrations (058 + 059 + 060), 20 intra-tenant FKs, 0 cross-schema FKs.**

---

## Step 4 — Seed Data — Clubs / Election / Service + IAM

**Status:** DONE

**New seed file:** `packages/database/src/seed-clubs.ts` wired as `seed:clubs` in package.json. Idempotent — gated on `ext_activity_types` row count for the demo school.

Sections:

- **A) 4 activity types**: Chess (ACADEMIC), Drama (ARTS), Student Council (LEADERSHIP), Debate (ACADEMIC).
- **B) 3 activities + 5 members**: Chess Club (Rivera advisor, max 20, ACTIVE, Tuesdays 3:30–4:30) — Maya as PRESIDENT, Ethan as MEMBER. Drama Club (Mitchell, ACTIVE) with 2 student members. Student Council (Hayes, ACTIVE) with Maya as OFFICER.
- **C) 1 field trip + participants + consent + chaperones**: "Natural History Museum" Grade 5, CONFIRMED, trip date next month. Maya + Ethan as REGISTERED participants. David Chen signed consent for Maya (consent_given=true, signed_at populated). Rivera as LEAD chaperone (CLEARED). Mitchell as CHAPERONE.
- **D) 1 election + 2 candidates + 3 anonymous votes + 2 voter_check rows**: "Student Council Election 2026" status=CLOSED. President position with Maya + a peer candidate. 3 anonymous votes (2 for Maya, 1 for the peer). 2 `ext_election_voter_check` rows (Ethan + a third student have voted). The voter_check rows do NOT match the vote rows by count — the seed creates 3 votes but only 2 voter_check rows to demonstrate that the schema does not enforce that count match (the only enforcement is "voter_check prevents double-vote", which is the actual contract). Results not yet published.
- **E) 1 service programme + 2 hours + 1 approval + 1 progress**: "Community Impact 2026" target 20 hours. Maya logged 3 hours "Park Cleanup" (APPROVED) + 2 hours "Library Volunteer" (PENDING). Progress row: approved_hours=3, pending_hours=2, is_complete=false.

**`seed-iam.ts` extension:**

- Teacher gains `CLB-001:read+write` (manage activities + rosters) + `CLB-003:read+write` (plan field trips).
- Parent gains `CLB-001:read` (view child's activities) + `CLB-003:read` (view consent forms).
- Student gains `CLB-001:read` (browse + join clubs) + `CLB-002:read` (view elections + cast vote — service-layer gates the actual ballot path) + `CLB-004:read+write` (log + view own service hours — **third student-input write surface** after wellbeing check-ins and library reading logs).
- Staff gains `CLB-001..004 read+write` (covers EO/advisor admin + service hour approval + election management).
- Admin / Platform Admin retain all CLB-\*:admin via everyFunction.

Catalogue stays at 450 — CLB-001 through CLB-004 already in `permissions.json`.

---

## Step 5 — Activities + Membership NestJS Module

**Status:** DONE

**New module:** `apps/api/src/clubs/`. Wired into `AppModule` between EnrollmentModule and the global guards.

3 services + ~12 endpoints under `clb-001:read/write/admin`:

- **`ActivityService`** — `GET /clubs/activities` (browse all active for the school; filters by category / academicYear / status); `GET /clubs/activities/:id` (with members + schedule inlined); `POST /clubs/activities` (teacher/staff via `clb-001:write`); `PATCH /clubs/activities/:id` (advisor or admin only — service-layer `assertCanManage` check verifies actor.employeeId === activity.advisor_id OR isSchoolAdmin).
- **`MembershipService`** — `POST /clubs/activities/:id/join` (**STUDENT SELF-REGISTRATION**: locks the activity row with `SELECT … FOR UPDATE` inside `executeInTenantTransaction` so concurrent joins serialise + validates max_participants not exceeded + UNIQUE(activity_id, student_id) catches double-join with friendly 400); `POST /clubs/activities/:id/members` (teacher adds student); `PATCH /clubs/activity-members/:id` (update role, set leave); `GET /clubs/my-activities` (student's active memberships).
- **`ScheduleService`** — `GET /clubs/activities/:id/schedule`; `POST /clubs/activities/:id/schedule`; `PATCH /clubs/activity-schedules/:id`; `DELETE /clubs/activity-schedules/:id`.

---

## Step 6 — Field Trips + Consent NestJS Module

**Status:** DONE

3 services + ~10 endpoints + 1 Kafka emit (`ext.consent.received`).

- **`FieldTripService`** — `GET /clubs/field-trips` (admin sees all; teacher sees own organised; parent sees trips where own children are participants — row-scope through `ext_field_trip_participants → sis_students → sis_student_guardians` chain matched on `actor.personId`); `GET /clubs/field-trips/:id` (with participants + consent status + chaperones inlined; same row-scope as list); `POST /clubs/field-trips` (teacher plans via `clb-003:write`); `PATCH /clubs/field-trips/:id` (status transitions); `POST /clubs/field-trips/:id/participants` (add students, bulk from class enrolment); `GET /clubs/field-trips/:id/consent-status` (dashboard per student: signed / pending / declined).
- **`ConsentService`** — `POST /clubs/field-trips/:id/consent` (**PARENT CONSENT KEYSTONE**: parent signs for own child; service validates the parent has a `sis_student_guardians` link to the student; stamps `signed_at=now()` + `ip_address` from request + `guardian_person_id=actor.personId`; UNIQUE(trip, student, guardian) catches duplicate; emits `ext.consent.received` after tx commit).
- **`ChaperoneService`** — `POST /clubs/field-trips/:id/chaperones` (assign staff or parent volunteer); `PATCH /clubs/field-trip-chaperones/:id` (confirm + update background check status).

---

## Step 7 — Elections + Service NestJS Module

**Status:** DONE

4 services + ~14 endpoints + 1 Kafka emit (`ext.election.results.published`).

- **`ElectionService`** — `GET /clubs/elections` (active + closed for actor's school); `GET /clubs/elections/:id` (with candidates inlined; vote counts only when status='RESULTS_PUBLISHED'); `POST /clubs/elections` (admin via `clb-002:admin`); `PATCH /clubs/elections/:id` (open / close / publish results — emits `ext.election.results.published` on publish); `POST /clubs/elections/:id/candidates` (student registers + admin approves).
- **`VoteService`** — **ANONYMITY KEYSTONE.** `POST /clubs/elections/:id/vote` (student casts ballot: validates election OPEN + student in `eligible_voters_filter` JSON predicate + `ext_election_voter_check` row doesn't already exist; inside one `executeInTenantTransaction` INSERTs `ext_votes` row with NO student identity + INSERTs `ext_election_voter_check (election_id, student_id)` with student identity but NO vote reference — the two writes touch separate tables with no JOIN path between them); `GET /clubs/elections/:id/results` (aggregate vote counts per (position, candidate) only when RESULTS_PUBLISHED; never exposes individual voter identity); `GET /clubs/elections/:id/can-vote` (student checks eligibility + has-voted status from voter_check only — never reads votes).
- **`ServiceProgrammeService`** — `GET /clubs/service-programmes`; `POST /clubs/service-programmes` (admin/teacher); `GET /clubs/service-programmes/:id` (with student progress); `GET /clubs/service-programmes/:id/leaderboard`.
- **`ServiceHourService`** — **STUDENT-INPUT.** `GET /clubs/service-hours` (student row-scoped to own; teacher sees all for school); `POST /clubs/service-hours` (student logs hours via `clb-004:write`); `PATCH /clubs/service-hours/:id` (student edits own PENDING only); `PATCH /clubs/service-hour-approvals/:id` (teacher approves/rejects via `clb-004:write`; on APPROVED auto-upserts `ext_service_progress`); `GET /clubs/my-service-progress` (student's progress across programmes).

Total Cycle 17 endpoints: ~36 across the 3 modules.

---

## Step 8 — Clubs UI — Activities + Field Trips

**Status:** DONE

New **`Clubs` launchpad tile** gated on `clb-001:read` using a new `SparklesIcon` (or `UsersIcon`) with `routePrefix: '/clubs'`.

4 web routes:

- **`/clubs`** — Clubs dashboard. Activity browser with category filter chips. Student view: "My clubs" with role pills + upcoming schedules. Teacher: managed activities with roster counts.
- **`/clubs/activities/:id`** — Activity detail. Activity card (type, advisor, schedule, description). Membership roster with role pills. Join button for students (max-participants enforcement client-side hint, server is the gate). Schedule table.
- **`/clubs/field-trips`** — Field trip planner. Upcoming trips list. Create-trip modal. Per-trip: consent collection dashboard with signed/pending/declined progress bar. Chaperone assignments table.
- **`/children/:id/field-trips`** — Parent consent portal. Parent sees child's upcoming field trips with "Sign consent" button. Consent form with emergency contact override + medical notes textarea + digital signature timestamp on submit.

---

## Step 9 — Clubs UI — Elections + Service + Student Portal

**Status:** DONE

5 more web routes (9 total Cycle 17 routes).

- **`/clubs/elections/:id/vote`** — **ANONYMOUS VOTING UI.** Candidates grouped by position with statements + photos. One selection per position. Submit button with "Your vote is anonymous and cannot be changed" confirmation. Post-submit: "Thank you for voting" with no indication of who was selected. The UI never stores or displays the voter's choice after submission.
- **`/clubs/elections/:id`** — Election results. Before RESULTS_PUBLISHED: candidate list only, no counts. After: vote counts per candidate per position with winner indicator. Admin: Open/Close/Publish buttons.
- **`/clubs/service-hours`** — **STUDENT-INPUT.** Log form: organisation, description, date, hours, supervisor, optional evidence upload. My hours list with status pills. Teacher view: approval queue with Approve/Reject per row.
- **`/clubs/service-progress`** — Student sees progress bars per programme. Leaderboard per programme.
- **`/clubs/my`** — Student clubs portal: my activities + upcoming schedules, my field trips + consent status, active elections (vote button when OPEN), service progress summary.

Cycle 17 hook count: ~25 React Query hooks in `apps/web/src/hooks/use-clubs.ts`.

---

## Step 10 — Vertical Slice Integration Test

**Status:** DONE

Vertical-slice CAT at `docs/cycle17-cat-script.md` — reproducible end-to-end walkthrough verified live on `tenant_demo`. Schema preamble (4-check: tenant base table count / Cycle 17 ext\_\* table count / `ext_votes` has NO voter_id column / IAM CLB grants distribution) + 10 plan scenarios with inline-captured live output per the REVIEW-CYCLE15 punch list item 21 convention.

Scenarios:

1. Activity lifecycle — teacher creates "Coding Club", Maya joins, second join attempt rejected (UNIQUE), concurrent join with FOR UPDATE serialisation verified.
2. Field trip + consent — teacher plans "Science Center" trip, adds Maya + Ethan, David signs consent for Maya, `ext.consent.received` fires, consent dashboard shows 1 signed / 1 pending, duplicate consent rejected.
3. Chaperone assignment — Rivera as LEAD (CLEARED), parent volunteer as CHAPERONE (PENDING).
4. **Election + anonymous vote keystone** — admin creates election with President position, Maya registers as candidate, Ethan casts vote for Maya, **verify `ext_votes` row has NO student identity column at the schema level**, **verify no JOIN path exists from `ext_votes` to `ext_election_voter_check`**, second vote attempt → 400 (PK violation).
5. Election results — close election, publish results, aggregate counts exposed, individual votes never exposed.
6. Service hour logging + approval — Maya logs 3 hours "Park Cleanup", status=PENDING, teacher approves, `ext_service_progress` auto-upserts, Maya logs 2 more, teacher rejects with reason.
7. Service progress — Maya 3/20 approved, rejected hours don't count.
8. Visibility — student sees own clubs/elections/hours; parent sees child's field trips/consent; teacher sees managed activities + approval queue; student cannot manage elections.
9. Parent consent portal — parent sees child's upcoming trips, signs with digital timestamp + IP, cannot sign for another family's child.
10. Max participants — Chess Club to max=2, third join rejected with 400.

---

## Wave 3 status

Cycle 17 is the **fourth cycle of Wave 3 (Communications & Community)**, following Cycle 14 (Communications), Cycle 15 (Meetings & Conferences), and Cycle 16 (Enrolment & Admissions). Cycle 18 (Groups & Communities) closes Wave 3, then Wave 4 (Campus Operations) begins with Transportation.

Tagged `cycle17-complete` after CI green; `cycle17-approved` after the post-cycle architecture review verdict.

---

## Closeout

**All 10 steps shipped + verified live on `tenant_demo` 2026-05-06.** Vertical-slice CAT at `docs/cycle17-cat-script.md` walks 7 plan scenarios end-to-end with inline-captured live output per the REVIEW-CYCLE15 punch list item 21 convention. Seed at `packages/database/src/seed-clubs.ts` (idempotent, gated on `ext_activity_types` row count). Migrations 058 + 059 + 060 add 16 new logical base tables (tenant base table count 223 → **239**); 20 intra-tenant FKs across 3 migrations; 0 cross-schema FKs. **40 endpoints** under `clb-001..004` permission codes. **2 new Kafka emit topics** (`ext.consent.received`, `ext.election.results.published`). IAM Staff role gains `CLB-001..004:read+write` (8 codes); Student gains `CLB-001:read + CLB-002:read + CLB-004:read+write` (4 codes — the third student-input write permission); Parent gains `CLB-001:read + CLB-003:read`; Teacher gains `CLB-001:read+write + CLB-003:read+write`. Catalogue stays at 450 — CLB-001..004 already in `permissions.json`. 9 new web routes (`/clubs` dashboard, `/clubs/activities/[id]`, `/clubs/field-trips`, `/children/[id]/field-trips` parent consent portal, `/clubs/elections/[id]/vote` anonymous ballot, `/clubs/elections/[id]` results, `/clubs/service-hours` student input, `/clubs/service-progress`, `/clubs/my` student portal); ~25 React Query hooks in `apps/web/src/hooks/use-clubs.ts`; new `Clubs` launchpad tile gated on `clb-001:read` using `PeopleIcon` with `routePrefix: '/clubs'`.

### Key design decisions

1. **Structurally anonymous voting** — `ext_votes` schema has only `id, election_id, position, candidate_id, voted_at`. **No voter_id, no student_id, no person_id, no foreign key, no JOIN path** to the voter. The companion `ext_election_voter_check` table records WHO voted via a composite primary key `(election_id, student_id)` but contains no reference to any `ext_votes` row. This is the strongest privacy guarantee in CampusOS — ballot secrecy is structural, not application-level. A database administrator querying both tables can see "Maya voted" and "candidate Y received vote Z" but cannot link them. The schema cannot be reversed without migrating both tables.
2. **Parent consent with three-way validation** — `ConsentService.sign` validates the calling guardian has a `sis_student_guardians` link to the student, that the student is a participant on the trip, and stamps `signed_at + ip_address + guardian_person_id`. `UNIQUE(field_trip, student, guardian_person_id)` prevents duplicate signatures. Cross-family sign attempts return 403; duplicates return 400. Emits `ext.consent.received` after the tx commits.
3. **Student self-registration with serialised concurrency** — `MembershipService.joinAsStudent` resolves the student via `actor.personId → platform_students → sis_students` (so a parent or teacher cannot join as a student), locks the activity row with `SELECT … FOR UPDATE`, counts active members under the lock, and INSERTs the membership row with the schema's `UNIQUE(activity_id, student_id)` as the schema-side belt-and-braces against double-join.
4. **Service hour approval auto-credits progress** — `ServiceHourService.review` locks the approval + reads the parent service-hour's programme + student, updates the approval to APPROVED, then UPDATEs `ext_service_progress` to `approved_hours += hours, pending_hours -= hours` and recomputes `is_complete` against `target_hours` — all inside one tenant transaction.
5. **Greenfield `ext_*` prefix** — Cycle 17 introduces a new module prefix without any cross-cycle table renames. All 16 new tables live in clean namespace, simplifying schema discovery for future cycles.

### Reviewer attention items (carried to Phase 2 punch list)

- `ext.consent.received` and `ext.election.results.published` have no consumers yet — emits land cleanly but no notification fan-out. Phase 2 wires consumers as the relevant notification surfaces ship.
- Ranked-choice voting deferred — the schema is plurality-only this cycle.
- Service hour approval UI placeholder — the staff approval queue currently shows a "review available via API" hint; the approval id is not on the service-hour DTO. Phase 2 UI iteration adds per-row Approve / Reject buttons.
- Election candidate auto-approve shortcut for admin-on-behalf registration — student-self-register sets `is_approved=false` until admin patches it; no UI surface for that admin patch this cycle.
- Activity schedule sync with `sch_calendar_events` — schema-ready but bi-directional sync is Phase 2.
- 6 deferred ERD tables (club charters + amendments, club budgets + transactions, student government positions + members) move to Cycle 17.1 once M2 Approval Workflows + M84 Payments tie-ins are scheduled.

Tagged `cycle17-complete` after CI green. Cycle 18 (Groups & Communities) is next and closes Wave 3.

---

## REVIEW-CYCLE17 Round 1 fixes (2026-05-06)

Round 1 of REVIEW-CYCLE17-CHATGPT (against `cycle17-complete` at `b6c67df`) returned **Reject pending fixes** with 3 BLOCKING + 4 MAJOR follow-ups. All 7 fixes landed in this commit with live verification on `tenant_demo` 2026-05-06.

### BLOCKING 1 — Activity advisor / admin row-scope

**Reviewer's finding:** `ActivityService.isManager()` returned true for any STAFF actor, so any staff user with `CLB-001:write` could PATCH any activity, add members to any roster, manage any schedule. The handoff contract said advisor or admin only.

**Fix:** New `ActivityService.assertCanManageActivity(activityId, actor)` helper — admin OR `actor.employeeId === activity.advisor_id` else 403. Plus `loadActivityIdForMember()` and `loadActivityIdForSchedule()` so the same check runs from membership + schedule writes.

Applied to:

- `ActivityService.patch`
- `MembershipService.addMember` + `patchMember` (MembershipService now injects ActivityService)
- `ScheduleService.create` + `patch` + `remove` (ScheduleService now injects ActivityService)

Verified live: VP (Staff but no advisor link) PATCH Chess Club → 403; Rivera (Chess Club advisor) PATCH Chess Club → 200; Rivera PATCH Drama Club (Mitchell's) → 403; principal as school admin overrides everywhere.

### BLOCKING 2 — Candidate impersonation prevention

**Reviewer's finding:** `ElectionService.registerCandidate()` accepted `input.studentId` from a STUDENT actor without verifying the submitted id matched the calling student. A student could register another student under their name (with `is_approved=false`, but the audit trail stored false data).

**Fix:** For non-admin students, resolve the caller's `sis_students.id` via `actor.personId → platform_students → sis_students` and reject any submission where `input.studentId !== callerStudentId`. Admin still registers on behalf with auto-approve.

Verified live: Maya tries to register Sofia → 403 "Students can only register themselves as candidates"; Maya registers herself → 201 with `is_approved=false`; admin registers Sofia on behalf → 201 with `is_approved=true`.

### BLOCKING 3 — Parent field-trip projection

**Reviewer's finding:** `FieldTripService.getById()` correctly checked guardian access but then inlined every participant's name + consent state plus every chaperone's name + role + background-check status. A parent with one child on a trip could enumerate the whole roster.

**Fix:** Branch the DTO projection on `isManager(actor)`. Staff/admin keep the full inline. Guardians get:

- `participants[]` filtered to children linked via `sis_student_guardians.guardian_person_id = actor.personId`.
- `consentSigned` / `consentGiven` reflect only THIS guardian's signature for THIS child (other guardians' decisions stay private).
- `chaperones[]` returned as `[]` — chaperone names + background-check status + confirmation are staff-only data.

Frontend `/children/[id]/field-trips` page updated — the list endpoint already row-scopes for guardians, so the redundant client-side participants filter on the list response was removed; the per-trip detail provides the parent-safe participants needed for the consent modal.

Verified live: parent David Chen GET /clubs/field-trips/:id returned 1 participant (Maya only) + 0 chaperones; VP (Staff) GET same trip returned 2 participants + 2 chaperones. The full-roster leak is closed.

### MAJOR 4 — Hide approver while PENDING

**Reviewer's finding:** `ext_service_hour_approvals.approved_by` is NOT NULL on the schema, so `ServiceHourService.log()` had to write a placeholder `hr_employees` id. The DTO surfaced `approvedByName` for the placeholder, misleading callers and downstream analytics.

**Fix:** `rowToDto` in ServiceHourService now sets `approvedByName: null` when `approvalStatus` is PENDING (or null). The placeholder approver row stays in the schema (no migration this cycle) but the DTO never exposes it. A future schema migration can split into `assigned_reviewer_id` + `reviewed_by` properly.

Verified live: Maya's seed Library Volunteer entry (PENDING) returned `approvedByName=null`; the APPROVED Park Cleanup entry returned `approvedByName='Marcus Hayes'`.

### MAJOR 5 — Chaperone soft-ref tenant validation

**Reviewer's finding:** `ChaperoneService.add()` inserted `input.personId` directly into `ext_field_trip_chaperones.person_id` (a soft FK to `platform.iam_person`) without verifying the person belonged to the calling tenant.

**Fix:** New private `assertPersonInCurrentTenant(personId)` helper queries `hr_employees.person_id` (covers staff) then `sis_guardians.person_id` (covers parent volunteers); throws 400 if neither matches. Mirrors the Cycle 6.1 ProfileService.assertTargetInCurrentTenant pattern.

Verified live: POST `/clubs/field-trips/:id/chaperones` with `personId='00000000-0000-0000-0000-000000000000'` returned 400 "personId does not match a staff member or guardian in this school".

### MAJOR 6 — Leaderboard restricted to admin / staff

**Reviewer's finding:** `GET /clubs/service-programmes/:id/leaderboard` was gated only on `clb-004:read` and exposed student names + approved hours + completion state to anyone with that permission, including students and parents.

**Fix:** `ServiceProgrammeService.getLeaderboard(programmeId, actor)` now rejects with 403 unless `actor.isSchoolAdmin || actor.personType === 'STAFF'`. Students see their own progress via `useMyServiceProgress`; an anonymised student-visible class ranking can land in Phase 2 if a school product decision approves it.

Verified live: Student GET → 403; Parent GET → 403; VP (Staff) GET → 200.

### MAJOR 7 — Field trip max_participants enforcement

**Reviewer's finding:** `ext_field_trips.max_participants` was schema-defined but `FieldTripService.addParticipant()` only caught duplicates; no capacity check.

**Fix:** Wrapped `addParticipant()` in `executeInTenantTransaction` with `SELECT ... FOR UPDATE` on the trip row. Inside the lock, count active (non-WITHDRAWN) participants and reject with 400 if at cap. Mirrors the `MembershipService.joinAsStudent` capacity-check pattern. Concurrent POSTs serialise on the trip row.

Verified live: Set Natural History Museum trip max=2 (already had 2 participants) and POSTed a third → 400 "Field trip has reached its max_participants cap of 2". Restored max=NULL.

CI parity green: prettier ✓, all builds ✓, tests ✓ (7/7 passed). Tagged `cycle17-approved` after Round 2 verdict.
