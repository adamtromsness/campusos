# REVIEW NOTES — Phase 2 Cycle 24 (P2-24): Parent Engagement

**Status:** COMPLETE pending peer review. P2-24a (schema + seed +
services + workers — Steps 1–5 + Step 8) shipped at `79cd0ac`. P2-24b
(UI + vertical-slice integration tests + handoff/review docs — Steps
6–7) ships in this commit. Awaiting peer review verdict before tagging
`p2c24-complete`.

**Scope:** Full P2-24 cycle covering 5 new tenant tables, ~24 endpoints,
2 background workers, 2 Kafka emits, 4 web routes, 74 vitest cases
(50 P2-24a unit + 24 P2-24b vertical-slice).
**Plan:** `docs/campusos-p2c24-parent-engagement.html`
**Handoff:** `HANDOFF-P2C24.md`
**Dates:** 2026-05-13

This document is the peer-review scaffold for the full P2-24 cycle.
It enumerates the load-bearing structural decisions, the verification
trail, and the documented Phase 2 carry-overs so the reviewer can
move efficiently through the M100 Parent Engagement module.

---

## 1. Cycle deliverable summary

**Schema:**

| Migration                    | Tables                          |
| ---------------------------- | ------------------------------- |
| `162_eng_conferences.sql`    | `eng_conference_events`,        |
|                              | `eng_conference_slots`,         |
|                              | `eng_conference_bookings`       |
| `163_eng_scores_surveys.sql` | `eng_family_engagement_scores`, |
|                              | `eng_parent_surveys`            |

**Backend:** 5 services + 2 workers + 1 controller + 24 endpoints +
2 Kafka emit topics in `apps/api/src/engagement/`. EngagementModule
wired in `AppModule`.

**Web:** 4 routes under `/engagement/*`, 1 launchpad tile gated on
`mtg-002:read OR eng-001:read`, 24 React Query hooks, ~40 DTOs in
`apps/web/src/lib/types.ts` (with the `Eng*` prefix to dodge the
Cycle 15 Meetings `Conference*` collision).

**Tests:** 50 unit tests in `engagement.spec.ts` (P2-24a) + 24
vertical-slice integration tests in `engagement-vertical-slice.spec.ts`
(P2-24b). Total project: 1278 passing across 62 spec files.

---

## 2. Atomic slot booking — THE STRUCTURAL KEYSTONE

**The decision.** Conference slot booking is the highest-contention
write in the cycle: a popular teacher's 4 PM Tuesday slot will be
attempted by N parents simultaneously when the booking window opens.
The booking transition runs as a single locked-row UPDATE with the
canonical lock-free pattern, NOT a SELECT-then-INSERT.

**The pattern.** In `ConferenceBookingService.book`:

```sql
UPDATE eng_conference_slots
   SET current_bookings = current_bookings + 1,
       status = CASE
         WHEN current_bookings + 1 >= max_bookings THEN 'BOOKED'
         ELSE status
       END,
       updated_at = now()
 WHERE id = $1::uuid
   AND school_id = $2::uuid
   AND status = 'AVAILABLE'
   AND current_bookings < max_bookings
 RETURNING id::text
```

Zero rows returned ⇒ `ConflictException('Slot ${slotId} is already
booked or no longer available')`. Postgres serialises concurrent
UPDATEs on the same row — exactly one wins the AVAILABLE → BOOKED
transition. The booking INSERT runs in the same tenant tx; on
SQLSTATE 23505 (the partial UNIQUE on `(slot, parent, student)
WHERE cancelled_at IS NULL`) the tx aborts and the slot transition
rolls back.

**For group sessions** (`max_bookings > 1`), the UPDATE increments
`current_bookings + 1` on every winner and only flips `status =
'BOOKED'` when the counter reaches `max_bookings`. The same UPDATE
caps overbooking via the `current_bookings < max_bookings` predicate.

**Booking window enforcement** lives at the service layer as a
pre-flight 400 because the conference event row is rarely contended:
`if (now < opensAt) throw new BadRequestException(…)`. Admins bypass
via `actor.isSchoolAdmin`. The pre-flight reads `e.booking_opens_at`
and `e.booking_closes_at` from the conference event via the slot's
JOIN, so it's a single round-trip.

**Verification:** Round-trip race test in `engagement-vertical-slice.spec.ts`
S1 covers parent A wins, parent B's UPDATE returns 0 rows on the
same slot (409), parent B books slot 2 cleanly. The cancel keystone
test (S1.2) verifies `current_bookings - 1` UPDATE shape and slot
status revert. The window keystone tests (S2) cover all 3 paths
(before-open 400, after-close 400, admin bypass).

---

## 3. Cross-module engagement score — 5 source modules

**The decision.** Composite engagement = weighted average of 5
components computed from data already collected across the platform.
The Engagement module is a **consumer** of cross-module data, not
an owner of it — no double-bookkeeping.

**The 5 sources:**

| Component     | Source module      | Source data                                                    | Weight default |
| ------------- | ------------------ | -------------------------------------------------------------- | -------------- |
| Attendance    | Cycle 1 (SIS)      | `sis_attendance_records` for school events                     | 20             |
| Communication | Cycle 3 (Comms)    | `msg_message_reads` over messages addressed to parent          | 25             |
| Conference    | P2-24 (this cycle) | `eng_conference_bookings.attended = true` over total bookings  | 25             |
| Volunteer     | P2-12 (Events)     | `evt_volunteers` rows in CONFIRMED status, capped at 10 events | 15             |
| Payment       | Cycle 6 (Payments) | `pay_invoices` PAID/PARTIALLY_PAID rate over last 180 days     | 15             |

**Worker contract.** `EngagementScoreWorker` runs weekly per active
tenant. For each family in the school it opens a tenant tx,
queries each source under try/catch (graceful degradation when a
source table is missing in that tenant — e.g. P2-12 not enabled),
computes the composite, resolves the engagement level, and UPSERTs
into `eng_family_engagement_scores` keyed on `(family_account_id,
score_date)` so re-runs are idempotent.

**Configurable weights + thresholds.** The plan said
`platform_tenant_configs` but that table does not exist. P2-24 uses
the existing `school_config` JSONB key/value table from Cycle 0 —
the canonical per-tenant config home. Keys:

- `engagement_score_weights` — `{attendance, communication,
conference, volunteer, payment}` integers summing to 100.
- `engagement_level_thresholds` — `{highlyEngaged, engaged,
minimal}` integers, strictly decreasing, with `0 ≤ minimal` and
  `highlyEngaged ≤ 100`.

`updateConfig` validates both invariants on every PATCH. Defaults
match the plan exactly.

**The composite math.** `computeCompositeScore` runs:

```text
totalWeight = sum(weights)
weighted = sum(clamp(component) * weight)
composite = round(weighted / totalWeight)
```

`clamp` enforces [0, 100] on every component so a corrupt source
read can never inflate the score. `resolveEngagementLevel` returns
HIGHLY_ENGAGED (≥75), ENGAGED (≥50), MINIMAL (≥25), or AT_RISK
(<25) by default.

**Verification:** S3 vertical-slice tests cover HIGHLY_ENGAGED
shape, AT_RISK shape, exact weighted-formula match, configurable-
weights-change-the-score (volunteer-heavy school prioritises a
volunteer-strong family over a payment-strong family), and the
weights-sum-to-100 admin validator.

---

## 4. Anonymous survey contract — privacy keystone

**The decision.** `eng_parent_surveys.is_anonymous` flips the
response storage path. When true, `respondent_id` is **never**
written on the response row stored in the JSONB `responses`
column. The contract is enforced at the service layer in
`ParentSurveyService.submitResponse`.

**The code path:**

```typescript
const responseRow: Record<string, unknown> = {
  submitted_at: new Date().toISOString(),
  answers: cleanedAnswers,
};
if (!row.is_anonymous) {
  responseRow.respondent_id = actor.accountId;
}
```

**FREE_TEXT aggregation contract.** The aggregated rollup (stored
in `response_data_aggregated`) intentionally produces only a `count`
for FREE_TEXT questions — the raw text is **never** aggregated.
This prevents a future reviewer-built admin UI from accidentally
exposing identifying free-text content even on anonymous surveys.

**DTO surface contract.** The public `SurveyDto` and the
`getResults` admin endpoint **never** include the raw `responses`
array. Only `responseDataAggregated` ever leaves the API
boundary. The DTO mapping in `parent-survey.service.ts::toDto`
omits the `responses` field deliberately.

**Verification:** S4 vertical-slice tests cover:

- two anonymous responses both land, `respondent_id` absent on
  both rows
- identified survey: `respondent_id` IS stored on the row
- student persona refused outright (parent surface)
- admin results endpoint never exposes raw responses on the DTO

---

## 5. Conference outcome documentation — staff workflow

**The contract.** `ConferenceBookingService.patch` splits authority
between staff and parent based on the input fields:

- **Staff-only fields** (`attended`, `conferenceNotes`,
  `followUpActions`) — require `isStaff || isSchoolAdmin`.
- **Parent-only fields** (`parentFeedbackRating`,
  `parentFeedbackComments`) — require `isOwner || isStaff`.

Mixed field input is allowed only for staff (who can also write
parent feedback if they're documenting it on behalf of a family).
The service rejects parent attempts at staff-only fields with
`ForbiddenException`.

**Follow-up actions JSONB shape.** `eng_conference_bookings.follow_up_actions`
is an array of `{description, due_date, status: 'PENDING' |
'COMPLETED'}`. The DTO contract is verified at the input layer via
`FollowUpActionInputDto` with class-validator decorators. Each
action is structured enough to feed downstream task creation but
flexible enough to capture any agreed action (homework cadence,
parent contact, intervention referral).

**Verification:** S5 vertical-slice tests verify a teacher posts 2
actions (1 PENDING + 1 COMPLETED) with the UPDATE SQL contract
shape, and parent attempts at `attended` / `conferenceNotes` are
refused 403.

---

## 6. Visibility matrix

The cycle gates two distinct surfaces:

**MTG-002 (Parent-Teacher Conferences)** — held by:

- Parent: `:read` + `:write` (book, cancel, document feedback)
- Teacher: `:read` + `:write` (publish slots, document outcomes)
- Staff/Admin: full

**ENG-001 (Parent Engagement)** — held by:

- Teacher: `:read` (engagement dashboard, view own class families)
- Staff: `:read` + `:write`
- School Admin / Platform Admin: `:admin` via `everyFunction`
- Parent + Student: **never** held

The service-layer access helpers in `engagement/access.ts` enforce
the contract:

- `assertConferenceAdmin` — refuses GUARDIAN + STUDENT outright,
  then checks `mtg-002:write` or `mtg-002:admin`.
- `assertEngagementAdmin` — admin tier only via
  `eng-001:admin`. School admin bypasses.
- `assertEngagementReader` — refuses GUARDIAN + STUDENT outright,
  then checks any `eng-001:*` tier.

**Conference booking row-scope:** `ConferenceBookingService.getById`
refuses non-owner non-admin GUARDIAN with 404 (don't-leak-existence),
and refuses STUDENT outright with 403.

**Verification:** S6 vertical-slice tests cover parent /bookings/my
row-scoped to actor.accountId, parent 404 on other-parent booking,
student 403 on every booking read, parents+students refused on
engagement scores, teacher with eng-001:read permitted, parent
refused on conference event creation, non-admin refused on score
config.

---

## 7. The 2 Kafka emits

Both emit via the platform outbox with deterministic v5-shaped
event_ids so retries are idempotent through the downstream consumer's
event_id claim.

- **`eng.conference.booking_open`** — fires when
  `ConferenceStatusWorker` flips a DRAFT conference event with
  `booking_opens_at <= now()` to BOOKING_OPEN. Idempotent via
  the outbox + the deterministic event_id derived from the event
  id. Future: Cycle 3 NotificationConsumer wires the parent IN_APP
  fan-out to alert "Booking is open for [Conference Title]".

- **`eng.survey.opened`** — fires when an admin PATCHes a survey
  from DRAFT to OPEN. The handler stamps `opened_at = COALESCE(opened_at,
now())` in the same UPDATE as the status flip so the outbox row
  commits atomically. Future: parent push notification.

Neither emit has a downstream consumer in repo today — the events
land cleanly and a future polish cycle wires fan-out.

---

## 8. Live verification trail

| What                                       | Where                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Schema smoke (5 tables + intra-tenant FKs) | P2-24a commit `79cd0ac`                                               |
| Seed shape                                 | `packages/database/src/seed-engagement.ts`                            |
| Unit tests (50)                            | `apps/api/src/engagement/__tests__/engagement.spec.ts`                |
| Vertical-slice tests (24)                  | `apps/api/src/engagement/__tests__/engagement-vertical-slice.spec.ts` |
| API build clean                            | `pnpm --filter @campusos/api build`                                   |
| Web build clean (4 routes)                 | `pnpm --filter @campusos/web build`                                   |
| All tests pass                             | `pnpm --filter @campusos/api test` → 1278/1278                        |
| format:check + lint:logs                   | clean                                                                 |

---

## 9. Reviewer attention items (Phase 2 punch list — non-blocking)

These are flagged in the plan's "What's Deferred" section and stay
on the broader Phase 2 / pre-pilot backlog:

1. Video conference integration (Zoom/Teams) — `meeting_url`
   schema-ready, API integration deferred.
2. Multi-child booking optimisation — combinatorial scheduler.
3. Conference outcome template library.
4. Engagement score AI prediction.
5. Cycle 3 NotificationConsumer wiring on
   `eng.conference.booking_open` + `eng.survey.opened` for parent
   IN_APP + push fan-out.
6. Survey branching logic.
7. Parent portal home screen engagement widget.
8. Real-time conference reschedule with parent + teacher
   notifications.
9. EngagementScoreWorker scheduling — currently exposed as a
   service helper; the production deployment runs it via a scheduled
   job (cron container or Kubernetes CronJob) since the codebase
   doesn't ship a Sundays-only worker dispatcher today.

---

## 10. Migration deviations from the plan

- **Migration numbers 162/163** instead of plan-text 151/152 — the
  Wave D bookings 151 + 152 slots were taken by P2-18 Facilities
  Advanced (Step 1 + Step 2). P2-24 uses the next available pair.
- **Config table** — plan referenced `platform_tenant_configs` which
  does not exist. P2-24 uses `school_config` (the canonical
  per-tenant key/value home from Cycle 0). Same lazy-load semantics
  as every other Cycle 0+ tenant config.
- **Type naming on the web layer** — Cycle 15 Meetings already
  ships `ConferenceEventDto`, `ConferenceStatus`,
  `CreateConferenceEventPayload`, `UpdateConferenceEventPayload`.
  P2-24 uses the `Eng*` prefix on the web side
  (`EngConferenceEventDto`, `EngConferenceEventStatus`, etc.) so
  the two surfaces stay independent and future Cycle 15 Meetings
  changes don't ripple into the P2-24 engagement surface.

Awaiting Round 1 verdict.
