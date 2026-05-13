# HANDOFF — Phase 2 Cycle 24 (P2-24): Parent Engagement

**Status:** COMPLETE pending Round 2 peer review verdict. P2-24a
(schema + seed + services + workers — Steps 1–5, plus Step 8
score-weight configuration via `school_config`) shipped at `79cd0ac`.
P2-24b (UI + vertical-slice tests + handoff/review docs — Steps
6–7) shipped at `46fce5e`. REVIEW-P2C24 Round 1 returned **FAIL**
with 4 BLOCKING + 2 MAJOR; the Round 1 fix commit (this commit) lands
all 4 BLOCKING + the actionable MAJOR 1 + 17 new pinned regression
tests so the contracts cannot regress. **MAJOR 2** (engagement score
read authority for teachers — Teacher holds `eng-001:read` and sees
family component breakdowns including payment data) is a product-side
scope decision and stays on the Phase 2 backlog. Awaiting Round 2
verdict before tagging `p2c24-complete`.

## REVIEW-P2C24 Round 1 fix log (2026-05-13)

**BLOCKING 1 — Student school + guardian link validation on `book()`.**
The prior code validated `studentId` with `SELECT id FROM sis_students
WHERE id = $1::uuid` only. A parent in School A could book a slot for
a School B student UUID, or for another family's student in the same
school. Fix: new private `isConferenceAdmin(actor, schoolId)` helper
branches the validation. Admin / conference-admin path runs `SELECT id
FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid` so a
foreign-school student id returns 0 rows → 400. Parent path runs a
guardian-link JOIN through `sis_student_guardians + sis_guardians`
with `g.person_id = actor.personId` — unlinked students return 0 rows
→ 400 with the canonical "is not linked to your account" message.

**BLOCKING 2 — Teacher school validation on `generateSlots()`.** The
prior code validated `teacherId` with `SELECT id FROM hr_employees
WHERE id = $1::uuid` only. A multi-school tenant admin could mint
School A slots against a School B employee UUID. Fix: SQL rewrites
to `WHERE id = $1::uuid AND school_id = $2::uuid`. Defence-in-depth:
`slotSelectSql()` LEFT JOIN extended with `AND e.school_id =
s.school_id` so a historical row with a foreign-school `teacher_id`
resolves the teacher name to NULL rather than leaking the cross-school
employee's name into the slot DTO.

**BLOCKING 3 — Booking PATCH staff fields require `mtg-002:write`.**
The controller gates PATCH on `mtg-002:read` because parents reach
the endpoint to write their own feedback. The service prior version
checked `actor.personType === 'STAFF'` for staff-outcome fields
(`attended`, `conferenceNotes`, `followUpActions`), so any STAFF
actor with only `mtg-002:read` could mark attendance and write
conference notes. Fix: staff-outcome fields now require
`isConferenceAdmin(actor, schoolId)` (school admin OR holds
`mtg-002:write` / `mtg-002:admin`). The controller gate stays at
`mtg-002:read` so parents can reach the endpoint for the parent
feedback fields; field-level authority is the actual access
boundary. Parent feedback fields tightened: `parentFeedbackRating` +
`parentFeedbackComments` are now **owner-only** — staff cannot author
parent feedback on the parent's behalf. Pre-pilot a dedicated
correction workflow can land if schools request it.

**BLOCKING 4 — EngagementScoreWorker school-scopes all 5 sources.**
Worker loops through active schools and writes school-scoped rows,
but several source-component queries omitted current-school
predicates. In a multi-school tenant pool the same parent / family
could legitimately participate across both schools, leaking
engagement signal between them. Fix:

- `attendanceComponent` adds `ar.school_id = $schoolId` AND `s.school_id
= $schoolId` via JOIN through `sis_students`.
- `communicationComponent` adds `tp.school_id = $schoolId` + `mp.school_id
= tp.school_id`. The original SQL also referenced columns that do
  not exist (`tp.user_id`, `r.user_id`) — try/catch was swallowing
  the broken query so every family scored 0 on communication. Round 1
  fix corrects both: column names rewritten to `tp.platform_user_id`
  and `r.reader_id` per the Cycle 3 schema.
- `conferenceComponent` adds `school_id = $schoolId`.
- `volunteerComponent` JOINs through `evt_events e ON e.id = v.event_id`
  with `e.school_id = $schoolId` (the `evt_volunteers` table has no
  direct school_id column).
- `paymentComponent` adds `school_id = $schoolId` (pay_invoices has
  a direct school_id column).

`computeComponents` updated to pass `schoolId` to all 5 helper
methods.

**MAJOR 1 — Identified survey deduplication.** Anonymous surveys
allow multiple submissions by design (no respondent_id stored, no
way to dedup without compromising anonymity). Identified surveys
(`is_anonymous=false`) now enforce one response per `respondent_id`
— `ParentSurveyService.submitResponse` walks the existing `responses`
array and throws `ConflictException` on duplicate. The check runs
inside the FOR-UPDATE-locked tx so two concurrent submissions cannot
both pass.

**MAJOR 2 carried to Phase 2 punch list.** Teachers hold `eng-001:read`
and currently see family-level engagement scores with payment +
communication component breakdowns. Pre-pilot, schools may want to
restrict full component detail to admin / counsellor roles and show
teachers only the classroom-relevant conference component. The
service-layer `assertEngagementReader` helper is the load-bearing gate
and is straightforward to narrow; product-side scope decision.

**Test coverage:** vitest 1278 → **1295 passing across 62 spec
files** (+17 new pinned regression tests in
`engagement-vertical-slice.spec.ts` across 5 new describe blocks:
BLOCKING 1 × 4 (parent SQL shape, parent unlinked rejection, admin
SQL school predicate, admin foreign-school student rejection);
BLOCKING 2 × 3 (hr_employees SQL school predicate, foreign-school
teacher rejected, slotSelectSql LEFT JOIN defence-in-depth);
BLOCKING 3 × 6 (read-only staff cannot mark attended / write notes
/ add follow-up actions, staff WITH write can mark attended, staff
cannot author parent feedback, owner CAN submit own feedback);
BLOCKING 4 × 1 (all 5 source queries carry school predicate or
school-derived JOIN, with explicit args binding check); MAJOR 1 × 3
(identified-survey same respondent 409, different respondent allowed,
anonymous-survey same parent allowed)).

**CI parity green:** format:check + lint:logs (936 files clean) +
API build clean + web build clean + vitest **1295/1295 across 62
spec files**.

No schema migrations in Round 1 — every fix is service-layer.
Awaiting Round 2 verdict before tagging `p2c24-complete`.

## P2-24 — Original cycle build state preserved below for review trail.

**Wave D (Module Completion) continues — P2-24 ships the M100 Parent
Engagement surface.** The Engagement module is the school's
**relationship health dashboard** for families: parent-teacher
conference scheduling with atomic AVAILABLE → BOOKED transitions,
conference outcome documentation with follow-up action tracking,
composite family engagement scoring from 5 cross-module data sources,
and anonymous parent satisfaction surveys with aggregated-only
results.

## Cumulative P2-24 totals at the closeout commit

- **5 new tenant base tables** across 2 migrations
  (`162_eng_conferences.sql` + `163_eng_scores_surveys.sql`).
- **24 endpoints** across 5 services + 1 controller (`EngagementController`).
- **2 background workers** — `ConferenceStatusWorker` (DRAFT →
  BOOKING_OPEN auto-transition + `eng.conference.booking_open` emit)
  - `EngagementScoreWorker` (weekly composite re-materialisation).
- **2 Kafka emit topics** — `eng.conference.booking_open` +
  `eng.survey.opened`, both via the platform outbox with deterministic
  v5-shaped event_ids.
- **4 web routes** under `/engagement/*` (conferences list + detail,
  dashboard, surveys).
- **1 new launchpad tile** (`Engagement`, gated on `mtg-002:read OR
eng-001:read`).
- **74 vitest cases** across 2 spec files (50 P2-24a unit + 24 P2-24b
  vertical-slice). Total project: **1278 passing across 62 spec files.**
- **2 new permission codes** — `MTG-002` (Parent-Teacher Conferences)
  - `ENG-001` (Parent Engagement). Catalogue 179 → 181.

## Three structural keystones

**(1) ATOMIC SLOT BOOKING.** `ConferenceBookingService.book` is the
keystone of the cycle. The bookable transition runs as a single
locked-row `UPDATE … WHERE id = $1 AND school_id = $2 AND status =
'AVAILABLE' AND current_bookings < max_bookings RETURNING id`. Zero
rows returned ⇒ 409 Conflict — Postgres serialises concurrent UPDATEs
on the same row so exactly one wins the AVAILABLE → BOOKED
transition. The booking INSERT runs in the same tenant tx; on
SQLSTATE 23505 (the partial UNIQUE on `(slot, parent, student) WHERE
cancelled_at IS NULL`) the tx aborts and the slot transition rolls
back. For group sessions (max_bookings > 1), the UPDATE increments
`current_bookings + 1` and flips `status = 'BOOKED'` only when the
counter reaches `max_bookings`. Booking window enforcement (before
`booking_opens_at` or after `booking_closes_at`) is a pre-flight 400
at the service layer — admin bypasses via `actor.isSchoolAdmin`.

**(2) ANONYMOUS SURVEY CONTRACT.** `ParentSurveyService.submitResponse`
enforces the contract at the service layer: when `survey.is_anonymous
= true`, the response row written into the `eng_parent_surveys.responses`
JSONB column carries only `{submitted_at, answers}` — `respondent_id`
is **never** stored. Identified surveys (`is_anonymous = false`) do
record `respondent_id = actor.accountId`. Aggregated rollups are
recomputed on every submission and stored in
`response_data_aggregated` so the admin results dashboard never
walks the raw responses array. FREE_TEXT questions aggregate to a
count only — the raw text is never aggregated to preserve anonymity.
The `getResults` admin endpoint and the public `SurveyDto` DTO surface
intentionally omit the `responses` field; only `responseDataAggregated`
ever leaves the API boundary.

**(3) CROSS-MODULE ENGAGEMENT SCORE.** `EngagementScoreWorker` runs
weekly per tenant. Per active family it reads 5 cross-module sources
under a per-family tenant transaction:

- **Attendance** — `sis_attendance_records` joined through
  `pay_family_account_students` for the family's enrolled children
  (school events attended over total events).
- **Communication** — `msg_message_reads` joined through `msg_messages`
  addressed to the parent (read rate).
- **Conference** — `eng_conference_bookings.attended = true` over
  non-cancelled bookings.
- **Volunteer** — `evt_volunteers` rows in CONFIRMED status normalised
  against a 10-event ceiling.
- **Payment** — `pay_invoices` PAID/PARTIALLY_PAID over total in the
  last 180 days (on-time rate).

Each source read is try/catch-wrapped so a missing tenant table
(e.g. Cycle 17 evt_volunteers in a school that doesn't run Events)
degrades to a null component rather than failing the whole
materialisation. The composite is computed via
`computeCompositeScore` — a weighted average clamped to [0, 100] —
and the engagement level is resolved against the per-tenant
thresholds. `resolveEngagementLevel`: ≥75 → HIGHLY_ENGAGED, ≥50 →
ENGAGED, ≥25 → MINIMAL, else AT_RISK.

The component weights AND level thresholds are **configurable per
tenant** via the existing `school_config` JSONB key/value table (keys
`engagement_score_weights` and `engagement_level_thresholds`). The
plan referenced `platform_tenant_configs` but that table does not
exist — `school_config` is the canonical per-tenant key/value home
from Cycle 0, and the choice is documented in the P2-24a commit
message. Defaults match the plan exactly: `{attendance: 20,
communication: 25, conference: 25, volunteer: 15, payment: 15}` and
`{highlyEngaged: 75, engaged: 50, minimal: 25}`. `updateConfig`
refuses weights that do not sum to 100 (±0.5 tolerance) and
thresholds that are not strictly decreasing.

## Step status

| Step | Topic                                         | State     |
| ---- | --------------------------------------------- | --------- |
| 1    | Conference scheduling schema (3 tables)       | ✅ P2-24a |
| 2    | Engagement scores + surveys schema (2 tables) | ✅ P2-24a |
| 3    | Seed data                                     | ✅ P2-24a |
| 4    | Conference scheduling NestJS module           | ✅ P2-24a |
| 5    | Engagement scoring + survey NestJS module     | ✅ P2-24a |
| 6    | Parent Engagement UI                          | ✅ P2-24b |
| 7    | Vertical slice integration test               | ✅ P2-24b |
| 8    | Score weight configuration                    | ✅ P2-24a |

## P2-24b detail (this commit)

### Step 6 — UI

- `apps/web/src/app/(app)/engagement/conferences/page.tsx` —
  conference list with 4-stat header (Total / Booking open / In
  progress / My bookings or Completed), filter chips (All / Live /
  Completed), parent "My bookings" panel with Attended / Cancelled
  / Upcoming pills, admin Create-conference Modal with full
  DRAFT-shape form, and admin status-transition action bar
  (Open booking / Mark in progress / Mark completed with confirm).

- `apps/web/src/app/(app)/engagement/conferences/[id]/page.tsx` —
  conference detail with status pill strip, booking-window status
  banner (emerald when open, amber when not), teacher dropdown +
  available-only filter, slots grouped by teacher then by date, per-
  slot chip with status + (group session) `currentBookings/maxBookings`
  - atomic-keystone Book button (parent only when window open) + staff
    "Document outcome" button on BOOKED slots. The BookSlotModal uses
    `useMyChildren()` to render a child picker; the DocumentOutcomeModal
    carries attended checkbox + 5000-char notes textarea + follow-up
    actions editor with per-row description / due_date / PENDING|COMPLETED
    status + remove + Add-action button + Cancel-booking. The
    GenerateSlotsModal (canManage) auto-walks the time window in
    (duration + break) increments.

- `apps/web/src/app/(app)/engagement/dashboard/page.tsx` — admin/staff
  engagement command-centre. Headline stats: Families scored, average
  score, count per engagement level. Stacked distribution bar across
  the 4 levels (emerald → sky → amber → rose). Level filter chips +
  AT_RISK callout for outreach targeting. Family list sorted by
  composite score ascending (most at-risk first), each row expandable
  to show the 5-component breakdown (Attendance / Communication /
  Conference / Volunteer / Payment with per-component weight and score
  out of 100). Admin-only Configure-weights Modal: per-component
  weight inputs (0–100 each) with live sum validator + level threshold
  inputs with cross-validator (highlyEngaged > engaged > minimal ≥ 0,
  highlyEngaged ≤ 100). Submit calls
  `PATCH /api/v1/engagement/score-config`.

- `apps/web/src/app/(app)/engagement/surveys/page.tsx` — survey list
  with 4 status filter chips (admin sees Draft chip too), per-row
  status pill + Anonymous/Identified pill + question count + total
  responses, parent-only Respond button on OPEN surveys, staff-only
  View-results button, admin-only Open/Close lifecycle buttons. The
  CreateSurveyModal carries a question builder with the 5 question-type
  pills (RATING_1_5 / RATING_1_10 / YES_NO / FREE_TEXT /
  MULTIPLE_CHOICE) — MULTIPLE_CHOICE reveals an options textarea
  (one per line, ≥2). The SurveyResultsModal renders aggregated
  charts per question (horizontal bars for ratings + distribution,
  Yes/No counts for YES_NO, distribution bars for MULTIPLE_CHOICE,
  count-only for FREE_TEXT with a privacy note). The
  RespondSurveyModal renders persona-appropriate input per question
  type (5-button rating, range-style buttons, Yes/No, radio for MC,
  free-text textarea) with required-answer validation; on success
  flips to a 🎉 thank-you screen with the running total.

- `apps/web/src/components/shell/apps.tsx` — new `Engagement`
  launchpad tile gated on `mtg-002:read OR eng-001:read`, using the
  existing `HeartHandIcon`. Tile routes to
  `/engagement/conferences` with `routePrefix: '/engagement'` so all
  nested routes keep it lit. The description copy switches on
  persona (Staff: "Conferences, family engagement dashboard, and
  parent surveys"; Guardian: "Book parent-teacher conferences and
  respond to surveys").

- `apps/web/src/lib/engagement-format.ts` — label maps + pill class
  maps for conference event status / slot status / engagement level /
  survey status / survey question type; warming-tone progression
  (emerald → sky → amber → rose) for engagement levels; helper
  functions `engagementScoreTone`, `engagementScoreToneText`,
  `engagementScoreToneBar`, `formatDateOnly`, `formatDateTime`,
  `formatTime`, `formatTimeRange`, `daysUntil`,
  `isBookingWindowOpen`, `buildComponentRows`.

- `apps/web/src/hooks/use-engagement.ts` — 24 React Query hooks:
  `useConferenceEvents`, `useConferenceEvent`,
  `useCreateConferenceEvent`, `useUpdateConferenceEvent`,
  `useConferenceSlots`, `useGenerateSlots`, `useUpdateSlot`,
  `useMyBookings`, `useBookings`, `useBookSlot`, `useCancelBooking`,
  `useUpdateBooking`, `useEngagementScores`, `useEngagementSummary`,
  `useFamilyEngagement`, `useScoreConfig`, `useUpdateScoreConfig`,
  `useSurveys`, `useSurvey`, `useSurveyResults`, `useCreateSurvey`,
  `useUpdateSurvey`, `useSubmitSurveyResponse`. All mutations
  invalidate the matching query keys.

- DTOs added to `apps/web/src/lib/types.ts` with the `Eng` prefix
  (`EngConferenceEventDto`, `EngConferenceEventStatus`,
  `EngConferenceSlotDto`, `EngConferenceBookingDto`,
  `EngConferenceFollowUpAction`, etc.) to avoid the
  pre-existing `ConferenceEventDto` / `ConferenceStatus` collision
  with Cycle 15 Meetings.

### Step 7 — Vertical slice integration test

`apps/api/src/engagement/__tests__/engagement-vertical-slice.spec.ts`
ships **24 new vitest cases** across 7 describe blocks covering the
6 plan scenarios end-to-end at the service layer:

- **S1 Conference lifecycle** — 2 tests covering the atomic booking
  race (parent A wins slot 1, parent B's UPDATE returns 0 rows on
  the same slot → 409, parent B books slot 2 cleanly) and the
  cancel-reverts-to-AVAILABLE contract verifying the
  `current_bookings - 1` UPDATE shape.
- **S2 Booking window enforcement** — 3 tests covering pre-window
  400, post-window 400, and admin bypass.
- **S3 Engagement scoring** — 4 tests covering high-component →
  HIGHLY_ENGAGED, zero-activity → AT_RISK, component-sum-matches-
  composite under the weighted formula (within rounding), and
  volunteer-heavy school re-prioritising a different family.
  Includes the weights-sum-to-100 admin validator regression.
- **S4 Anonymous survey** — 4 tests covering the **anonymity
  keystone** (two responses both land with `answers` only, no
  `respondent_id` on either row), identified-survey contract
  (`respondent_id` IS stored), student persona refused 403, admin
  results endpoint never exposes raw responses on the DTO surface.
- **S5 Follow-up actions** — 2 tests covering staff documenting 2
  actions (1 PENDING + 1 COMPLETED) with the UPDATE SQL contract
  pinned, and parent-cannot-mark-attended 403.
- **S6 Visibility matrix** — 6 tests covering `/bookings/my`
  row-scoped to `actor.accountId`, parent → 404 don't-leak-existence
  on another parent's booking, student → 403 on every booking read,
  parents/students refused on engagement scores, teacher with
  `eng-001:read` permitted, and parent refused on conference event
  creation.
- **S7 Slot generation idempotency** — 1 test verifying the
  generation walks the time window in (duration + break) increments
  and the INSERT carries `ON CONFLICT` for the (event, teacher,
  date, start_time) UNIQUE.

## CI parity

- format:check + lint:logs clean across all changed files.
- API build clean.
- Web build clean — 4 new engagement routes ship at modest sizes:
  `/engagement/conferences` 3.38 kB / `/engagement/conferences/[id]`
  5.29 kB / `/engagement/dashboard` 3.95 kB / `/engagement/surveys`
  4.76 kB (118-120 kB First Load JS each).
- vitest **1278/1278** across 62 spec files (was 1254 — +24 new
  vertical-slice tests).

## Phase 2 punch list — non-blocking carry-overs

These are flagged in the plan's "What's Deferred" section and stay
on the broader Phase 2 / pre-pilot backlog:

1. **Video conference integration** — `meeting_url` field on
   `eng_conference_slots` ships ready; Zoom/Teams API integration
   defers to a dedicated cycle.
2. **Multi-child booking optimisation** — a parent with 3 children
   booking 3 different teachers in non-overlapping windows is a
   combinatorial scheduler; the current UI requires the parent to
   book each slot individually.
3. **Conference outcome template library** — schools want canned
   follow-up action templates (e.g. "Nightly journaling 20 min" or
   "Reading log over 4 weeks"). Schema-ready; future polish.
4. **Engagement score AI prediction** — predict which families will
   disengage in the next 4 weeks before they actually do.
5. **Parent engagement push notifications** — Cycle 3
   NotificationConsumer wiring on `eng.conference.booking_open` for
   parent IN_APP + push fan-out.
6. **Survey branching logic** — conditional question display based
   on prior answers. Schema-ready via JSONB; UI builder defers.
7. **Parent portal home screen engagement widget** — surface "Your
   family is HIGHLY_ENGAGED" or "We'd love to see more participation"
   on the parent dashboard. Defers.

## Awaiting peer review

P2C24-REVIEW-NOTES.md scaffolds the review surface — atomic booking
pattern + concurrency contract, cross-module engagement score with
configurable weights, anonymous survey privacy enforcement, conference
outcome documentation, and the 6 vertical-slice scenarios end-to-end.
