# P2C27 — Peer Review Scaffold (Portfolio Advanced)

This file is the scaffold reviewers should walk against the cycle.

## Vertical-slice contract

Student Maya organises her portfolio into 4 sections with drag
reorder → adds reflections to her best work with prompted questions
("What did you learn? What would you do differently?") → English
teacher Mrs Rivera endorses her portfolio with skills [Critical
Thinking, Written Communication, Perseverance] and a comment →
counsellor Hayes assigns Maya to the "College Prep" pathway (12
milestones spanning SAT, AP courses, community service 40h, college
essay, recommendations, transcript, FAFSA) → 8 milestones complete
(67% progress) — service-hours and transcript milestones auto-checked
from cross-module events → Maya tracks 3 college applications
(Stanford RESEARCHING, MIT SUBMITTED, KSU ACCEPTED) → Maya builds
resume from portfolio: endorsement skills auto-merge, service hours
auto-sum from Cycle P2-13, achievements auto-pull from
pfl_achievements, extracurriculars from ext_activity_members → PDF
exported for college applications → counsellor reads readiness
dashboard: Maya 67% on-track.

## Section drag-reorder pattern

`pfl_portfolio_sections` carries `UNIQUE(portfolio_id, sort_order)`.
A naive swap (UPDATE A SET sort_order=B; UPDATE B SET sort_order=A)
would fire the UNIQUE constraint mid-flight. The Step 5
PortfolioSectionService.patch handles reorder via a 3-step swap
inside one tenant tx:

1. Park the conflict section at `-conflict.sort_order` (negative,
   guaranteed not to collide because all sort_order values are >= 1).
2. UPDATE the requested section to its new sort_order.
3. Bring the parked section into the requested section's old slot.

The schema-side UNIQUE is the belt-and-braces against any code path
that doesn't use the helper.

## Student-owned reflection enforcement

`pfl_reflections.student_id` UNIQUE per `portfolio_item_id` so a
student writes at most one reflection per item. Two layers of
enforcement:

- Schema: `UNIQUE(portfolio_item_id, student_id)` — the canonical
  one-reflection-per-(item, student) gate.
- Service: `ReflectionService.create` refuses any non-STUDENT actor
  (admin override allowed); for STUDENT actors, the calling student's
  `sis_students.id` must match the parent portfolio's owning student.
  Mismatch returns 404 don't-leak-existence rather than 403 — a
  student attempting to write on another student's item should not
  learn the item exists.
- Service: `ReflectionService.patch` refuses any non-owner non-admin
  caller. Teachers cannot edit a student reflection even when the
  parent portfolio is at TEACHER+ visibility.

## Endorsement role restriction

`pfl_endorsements` is gated three ways:

- Schema: `endorser_role IN ('TEACHER', 'COUNSELLOR', 'MENTOR')` —
  CHECK constraint refuses any other value at the DB layer.
- Service: `EndorsementService.create` returns 403 for
  `actor.personType === 'STUDENT'` AND for
  `actor.personType === 'GUARDIAN'` with explicit error messages.
  Non-STAFF callers cannot endorse.
- Service: TEACHER endorser_role additionally requires the calling
  staff member to be an assigned teacher of the student (joined
  through `sis_class_teachers + sis_enrollments`). Counsellor /
  mentor roles are accepted without the teaching-tie check since
  formal teaching is not their relationship type.
- Schema: `UNIQUE(portfolio_id, endorsed_by)` — re-endorsing edits
  the existing row rather than landing a duplicate.

## Endorsement visibility — student-controlled

`is_visible_on_share BOOLEAN DEFAULT true` is the toggle. The student
controls who sees the endorsement on a shared portfolio. The
`PATCH /portfolio/endorsements/:id/visibility` endpoint refuses any
caller who is not the owning student or a school admin. Teachers
cannot retract visibility on their own endorsements — the student is
the gatekeeper for the share-link view.

## Milestone JSONB progress computation

`pfl_student_pathway_assignments.milestone_statuses` is a JSONB array
of `{milestone_id, status, completed_at, notes, progress_detail}`
entries. `overall_progress NUMERIC(5,2)` is computed from required
milestones only (`completed_required / total_required × 100`),
clamped to [0, 100] via the schema CHECK.

`ReadinessPathwayService.updateMilestoneStatus` runs inside one
`executeInTenantTransaction`:

1. `SELECT ... FOR UPDATE OF a` on the assignment row.
2. Authorisation check (admin OR counsellor scope OR owning student).
3. Status-lifecycle check (refuse non-ACTIVE for non-admin).
4. Validate milestone belongs to the assignment's pathway.
5. Normalise existing milestone_statuses array.
6. Detect COMPLETED transition (current status differs).
7. Replace / append the milestone entry.
8. Pull required milestone count for denominator.
9. UPDATE row with new JSONB + new overall_progress + updated_at.
10. Emit `pfl.pathway.milestone_completed` per COMPLETED transition
    AFTER the tx commits.

The emit payload carries `{assignmentId, pathwayId, studentId,
schoolId, milestoneId, milestoneName, completedAt, overallProgress}`.
Future cycles wiring a notification consumer will pick this up to
send the student / counsellor IN_APP nudges.

## Auto-check cross-module event subscription

`MilestoneAutoCheckConsumer` subscribes to two topics:

- `sis.service_learning.approved` → `auto_check_source =
graduation_audit:SERVICE_HOURS`
- `sis.transcript.generated` → `auto_check_source = transcript:GENERATED`

Per inbound event, the consumer walks every active assignment whose
pathway has a milestone matching the auto_check_source for the
student in the payload. For each match: flips the milestone to
COMPLETED, recomputes overall_progress, emits
`pfl.pathway.milestone_completed`. All inside one tenant tx with
locked rows.

Idempotency: standard `processWithIdempotency` claim-after-success.
A redelivery of the same Kafka event re-runs the walk and finds the
milestone already COMPLETED — the loop short-circuits.

## Resume cross-module auto-population

`ResumeService.generatePdf` assembles the resume by pulling from:

- **Skills**: UNION of self-reported `pfl_resume_profiles.skills` and
  the result of `SELECT DISTINCT unnest(e.skills) FROM pfl_endorsements
  e JOIN pfl_portfolios p ON p.id = e.portfolio_id WHERE p.student_id
= $1`. Endorsement skills are auto-merged at generation time.
- **Service hours**: `SUM(hours_logged) WHERE status='APPROVED'`
  against `sis_service_learning_hours`. Defensive against table
  absence — fallbacks preserve the manually-edited value.
- **Awards**: aggregated from `pfl_achievements` for the student.
  Existing manually-edited awards win on duplicate title.
- **Extracurriculars**: aggregated from `ext_activity_members` joined
  through `platform_students.person_id` to `sis_students.id`.
  Defensive against table absence.

The PDF S3 key uses a deterministic per-student path with a timestamp
(`resumes/{studentId}/{ms}.pdf`). The actual PDF rendering is a
deferred polish item — today the generator stores the path + the
aggregated counts; pre-pilot the renderer worker reads the resume
row + portfolio data and writes the file to S3.

## Reviewer scorecard

| Dimension                                                               | Pass criteria                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema integrity**                                                    | 8 tables created, ALTER on pfl_portfolio_items, splitter-safe, idempotent, FK delete actions match table.                                                                    |
| **Section reorder safety**                                              | UNIQUE never fires under concurrent reorders; negative-slot parking; tx-bounded.                                                                                             |
| **Reflection STUDENT-OWNED**                                            | UNIQUE(item, student); other students get 404 (not 403); teachers refused on create/edit; admin override works.                                                              |
| **Endorsement STUDENT-CANNOT**                                          | Students 403; guardians 403; TEACHER role requires assigned-teacher; UNIQUE(portfolio, endorsed_by); visibility toggle owner-only.                                           |
| **Pathway milestone progress**                                          | overall_progress recomputed atomically; emit fires only on COMPLETED transition (not on every PATCH); JSONB shape stable; required-only denominator.                         |
| **Auto-check consumer**                                                 | Subscribes to both topics; UnwrappedEvent + processWithIdempotency; matching milestones flipped + emitted; tenant tx atomic.                                                 |
| **Resume cross-module**                                                 | Skills UNION endorsements; service hours SUM; awards from achievements; extracurriculars from ext_activity_members; PDF path + last_generated_at updated atomically.         |
| **College applications row scope**                                      | Student sees own; counsellor sees school-wide deadlines; parent sees linked children; auto-stamp decision_date on first terminal transition.                                 |
| **Test coverage**                                                       | 13 new vitest cases across the 7 plan scenarios; all keystones exercised.                                                                                                    |

## Round 1 verification trail

(Reserved for Round 1 fix log if blocking findings surface.)
