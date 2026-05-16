# HANDOFF-P2C27 — Portfolio Advanced (M26 .1)

**Wave:** Phase 2 Wave D — Module Completion
**Plan:** `docs/campusos-p2c27-portfolio-advanced.html`
**Status:** Pending peer review

Cycle 27 ships the 8 deferred ERD tables from Cycle 24's M26 Portfolio
module. Cycle 24 built the core surface (portfolios, items, shares,
achievements). P2-27 adds the structural depth: section organisation,
student reflections, teacher/counsellor endorsements, post-secondary
readiness pathways with milestone tracking, college application
tracking, and a resume builder that synthesises cross-module data
into a shareable PDF.

## Cycle totals

- **8 new tenant base tables** across 3 migrations (168 + 169 + 170)
- **1 ALTER on Cycle 24 `pfl_portfolio_items`** adding `section_id` FK
  (SET NULL on parent section delete so unsectioned items survive)
- **9 new intra-tenant FKs** (CASCADE × 5 + SET NULL × 2 + NO ACTION × 2)
- **0 cross-schema FKs**
- **6 new services** + 1 new controller + 1 new Kafka consumer + **~26
  new endpoints** under `ACH-002` (sections, reflections, endorsements)
  and `ACH-003` (readiness pathways, college apps, resume)
- **1 new Kafka emit topic** — `pfl.pathway.milestone_completed`
- **2 new Kafka consumer subscriptions** in `MilestoneAutoCheckConsumer`
  (subscribes to `sis.service_learning.approved` + `sis.transcript.generated`)
- **3 new web routes** (`/portfolio/readiness`, `/portfolio/college`,
  `/portfolio/resume`) + 4 nav links added to the existing
  `/portfolio` landing page
- **Tenant base table count after P2-27**: previous + 8 (8 new pfl\_\* tables)
- **Vitest count**: 1413 → **1426** across 68 spec files (+13 new
  portfolio-advanced cases)

## Five structural keystones

1. **Section drag-reorder via UNIQUE(portfolio_id, sort_order)** — the
   Step 5 PortfolioSectionService.patch handles reorder via a
   negative-sort_order parking trick inside one tenant tx so the
   UNIQUE constraint never fires mid-flight on a swap.

2. **STUDENT-OWNED REFLECTIONS** — `pfl_reflections` carries
   `UNIQUE(portfolio_item_id, student_id)` so a student writes at most
   one reflection per item. The Step 5 ReflectionService enforces the
   student owns the reflection — teachers cannot author or edit a
   student reflection (admin-only override). Even on items at TEACHER+
   visibility, reflection authorship is the student's.

3. **STUDENTS CANNOT ENDORSE** — `pfl_endorsements` is the
   teacher / counsellor / mentor authorship surface. Service-layer 403
   refuses any caller with `personType === 'STUDENT'` or
   `personType === 'GUARDIAN'`. TEACHER endorser_role additionally
   requires an assigned-teacher relationship via
   `sis_class_teachers + sis_enrollments` (the admin bypasses).
   `UNIQUE(portfolio_id, endorsed_by)` caps endorsements at one per
   (portfolio, endorser); re-endorsing edits the existing row. The
   student controls `is_visible_on_share` via a dedicated PATCH
   endpoint that gates on student-owner only.

4. **MILESTONE JSONB PROGRESS + KAFKA EMIT** — `milestone_statuses` is
   a JSONB array on `pfl_student_pathway_assignments`. The Step 6
   ReadinessPathwayService.updateMilestoneStatus runs inside one
   tenant tx with `SELECT ... FOR UPDATE OF a`, mutates the JSONB
   entry, recomputes `overall_progress` from required-milestone count
   only, and emits `pfl.pathway.milestone_completed` per COMPLETED
   transition with `{assignmentId, pathwayId, studentId, schoolId,
milestoneId, milestoneName, completedAt, overallProgress}`.

5. **CROSS-MODULE AUTO-CHECK** — `MilestoneAutoCheckConsumer` subscribes
   to `sis.service_learning.approved` and `sis.transcript.generated`.
   Per inbound event, walks every active assignment whose pathway
   carries the matching `auto_check_source` for the student in the
   payload and flips the matching milestone to COMPLETED inside one
   tenant tx. Recomputes progress + emits
   `pfl.pathway.milestone_completed` per flipped milestone. Standard
   `processWithIdempotency` claim-after-success matches the Cycle 5
   CoverageConsumer + Cycle 10 IepAccommodationConsumer pattern.
   `auto_check_source` values are namespaced: `graduation_audit:
SERVICE_HOURS` for the service learning hook,
   `transcript:GENERATED` for the transcript hook.

## Cross-cycle integration

- **Cycle 24 pfl_portfolios + pfl_portfolio_items** — Step 1 ALTER
  adds `section_id` to `pfl_portfolio_items`. Cycle 24 items remain
  valid as unsectioned (NULL `section_id`). Reflections + endorsements
  are children of the Cycle 24 tables.
- **P2-13 sis_service_learning_hours** — Resume PDF generation pulls
  `SUM(hours_logged) WHERE status='APPROVED'` for the student
  (defensive against table absence). MilestoneAutoCheckConsumer
  auto-completes the `graduation_audit:SERVICE_HOURS` milestone when
  `sis.service_learning.approved` fires.
- **P2-13 sis_transcripts** — MilestoneAutoCheckConsumer auto-completes
  the `transcript:GENERATED` milestone when `sis.transcript.generated`
  fires. The Resume PDF generator does not currently link transcripts
  but the schema is ready.
- **Cycle 24 pfl_achievements** — Resume PDF generation aggregates
  achievement titles as awards (merged with manually-edited awards,
  existing wins on duplicate title).
- **Cycle 17 ext_activity_members** — Resume PDF generation enriches
  extracurriculars from `ext_activity_members` joined through
  `platform_students.person_id` (defensive — table may not be present
  in every tenant; falls back to manually-edited array).

## Migrations

| File                               | New tables                                                                        | Notes                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `168_pfl_sections_reflections.sql` | pfl_portfolio_sections + pfl_reflections + pfl_endorsements                       | ALTER pfl_portfolio_items ADD section_id (SET NULL on delete)    |
| `169_pfl_readiness_pathways.sql`   | pfl_readiness_pathways + pfl_pathway_milestones + pfl_student_pathway_assignments | milestone_statuses JSONB + overall_progress numeric(5,2) clamped |
| `170_pfl_college_resume.sql`       | pfl_college_applications + pfl_resume_profiles                                    | College apps with 7-status lifecycle; resume UNIQUE(student)     |

Plan-spec migration numbers were 156/157/158, but those slots are
taken by tech (P2-20). Used 168/169/170 per the established convention
from Cycles 9, 11, 22, 25, 26.

## API surface

`apps/api/src/portfolio/` extensions on top of Cycle 24:

- **section.service.ts** — PortfolioSectionService (CRUD + reorder via
  negative-slot parking + assign-item-to-section validation)
- **reflection.service.ts** — ReflectionService (student-owned;
  cross-actor 404 don't-leak-existence; UNIQUE catch + PATCH)
- **endorsement.service.ts** — EndorsementService
  (students/guardians refused; TEACHER role requires assigned-teacher;
  UNIQUE catch; student-owner-only visibility toggle)
- **readiness.service.ts** — ReadinessPathwayService (pathway + milestone
  CRUD; counsellor-scope gate; assignment + JSONB progress recompute;
  Kafka emit; school-wide dashboard with at-risk filter;
  `autoCheckByCrossModuleEvent` helper for the consumer)
- **college-application.service.ts** — CollegeApplicationService
  (row-scope per student; auto-stamp decision_date on first terminal
  transition; counsellor-only school-wide deadlines)
- **resume.service.ts** — ResumeService (auto-init on first read;
  cross-module aggregation at generation time: endorsement skills
  UNION self-reported, service hours SUM, achievements → awards,
  ext_activity_members → extracurriculars)
- **milestone-auto-check.consumer.ts** — MilestoneAutoCheckConsumer
  (group `milestone-auto-check-worker`; standard `unwrapEnvelope` +
  `processWithIdempotency` claim-after-success)
- **portfolio-advanced.controller.ts** — 26 endpoints across the 6 new
  services under `/portfolio/*` URL prefix

`apps/api/src/portfolio/portfolio-access.ts` — shared helpers
(`isUniqueViolation`, `resolveStudentIdForActor`, `isAssignedTeacherOf`,
`isLinkedGuardianOf`, `isOwningStudent`) used by every new service to
keep the row-scope logic consistent across the cycle.

## Permissions

- **ACH-002 extended** (existing) — Sections + Reflections (student write
  own); Endorsements (teacher/counsellor write; student visibility
  toggle).
- **ACH-003 added** (existing in catalogue, granted in P2-27) —
  Pathway management (counsellor `:write` / admin `:admin`), milestone
  status updates (student own / counsellor any), college applications
  (student write own / counsellor read all), resume (student write own).
- IAM grants extended on Teacher (`ach-003:read`), Parent (`ach-003:
read`), Student (`ach-003:read+write`), Staff/Counsellor
  (`ach-003:read+write`). Admin reaches `ach-003:admin` via everyFunction.
- Catalogue total unchanged at 537 (ACH-003 was already in
  `permissions.json` from prior waves).

## Seed (Step 4)

`seed-portfolio-advanced.ts` (idempotent, gated on
`pfl_readiness_pathways`) wired as `seed:portfolio-advanced` and into
`seed-all.ts` after `seed-publications-advanced`:

- 4 sections on Maya's portfolio (Academic, Art, Community, Athletics)
  with sort_order
- 3 of Maya's seeded items reassigned to Academic section; 2 remain
  unsectioned (exercises the nullable path)
- 2 reflections with prompted questions (English essay + Cell
  Structure grade)
- 2 endorsements (Rivera TEACHER with [Critical Thinking, Written
  Communication, Perseverance]; Hayes COUNSELLOR with [Leadership,
  Self-Direction, Goal Setting])
- 2 pathways: **College Prep** (12 milestones — SAT/ACT, AP courses,
  service hours, college essay, recommendations, transcript, FAFSA,
  counsellor meeting, college shortlist, college visits, PSAT, resume)
  with 2 carrying `auto_check_source` (community service +
  transcript); **Career & Technical** (8 milestones)
- 2 pathway assignments: Maya on College Prep (6 COMPLETED + 2
  COMPLETED + 2 IN_PROGRESS + 2 NOT_STARTED → 67% progress, ACTIVE);
  Ethan on Career & Technical (3 COMPLETED + 2 IN_PROGRESS + 3
  NOT_STARTED → 38%, ACTIVE)
- 3 college applications for Maya: Stanford RESEARCHING (Jan 2),
  MIT EARLY_ACTION SUBMITTED, KSU ACCEPTED with `decision_date`
- 1 resume profile for Maya with objective, skills, work experience,
  extracurriculars, awards, service_hours_total=42.5, 1 reference

## Web surface

3 new routes — `apps/web/src/app/(app)/portfolio/`:

- `/portfolio/readiness` — branches on personType. STUDENT view: own
  pathway with progress bar + per-milestone status pills + Start /
  Mark-done buttons. STAFF view: school-wide dashboard with at-risk
  filter chip; rows sorted by progress ascending; at-risk students
  highlighted rose.
- `/portfolio/college` — STUDENT view: applications list grouped by
  status with inline status dropdown + Add-college form. STAFF view:
  upcoming deadlines table sorted by deadline.
- `/portfolio/resume` — STUDENT-only builder: objective + skills
  inputs, 3-stat panel (service hours / awards / activities count),
  Save + Generate-PDF buttons. Generated PDF S3 key surfaces with
  emerald confirmation banner.

The existing `/portfolio` page gains 3 quick-link buttons to the new
surfaces.

`apps/web/src/hooks/use-portfolio-advanced.ts` ships 30+ React Query
hooks covering every new endpoint.

`apps/web/src/lib/types.ts` extended with ~280 lines of P2-27 DTOs +
payload types.

## Tests

`apps/api/src/portfolio/__tests__/portfolio-advanced.spec.ts` —
**13 vitest cases** across 7 describe blocks covering the 7 plan
scenarios:

- **S1 Sections** — student cannot manage another student's portfolio
  sections; admin bypasses; AssignItemToSection refuses cross-portfolio
  section
- **S2 Reflections** — teacher cannot author (STUDENT-OWNED keystone);
  other student gets collapsed 404; owning student writes + UNIQUE
  catch on duplicate
- **S3 Endorsements** — STUDENT-CANNOT-ENDORSE explicit 403; GUARDIAN
  refused; teacher writes + UNIQUE catch; TEACHER role requires
  assigned-teacher relationship
- **S4 Readiness pathway** — counsellor updates milestone to COMPLETED
  → 50% progress recompute + `pfl.pathway.milestone_completed` emit;
  student cannot update non-own assignment;
  `autoCheckByCrossModuleEvent` walks matching milestones and emits
- **S5 College applications** — student create defaults to own studentId;
  PATCH to ACCEPTED auto-stamps decision_date; counsellor sees
  school-wide deadlines / students refused
- **S6 Resume** — skills UNION endorsements (3 unique); service hours
  from sis_service_learning_hours SUM (42.5); awards from
  pfl_achievements; extracurriculars from ext_activity_members;
  non-owner cannot generate
- **S7 Endorsement visibility** — teacher cannot toggle visibility of
  own endorsement; student owner can

Full suite: **1426 / 1426 passing** across 68 spec files.

## CI parity

- `pnpm format:check` ✓ clean
- `pnpm lint:logs` ✓ 967 files clean
- `pnpm --filter @campusos/api build` ✓ clean
- `pnpm --filter @campusos/web build` ✓ clean
- `pnpm --filter @campusos/api test` ✓ 1426 / 1426
- 3 new web routes ship statically:
  - `/portfolio/readiness` 2.33 kB
  - `/portfolio/college` 2.15 kB
  - `/portfolio/resume` 1.76 kB

## Reviewer attention items (Phase 2 punch list)

1. **AI-generated portfolio summary narrative** — out of scope this
   cycle; needs an AI Inference service integration before pilot.
2. **Common App / UCAS integration** — college applications surface is
   intentionally a tracker today; pre-pilot, the SUBMITTED transition
   wires into the Common App API.
3. **Real PDF rendering** — `ResumeService.generatePdf` stores a
   synthetic S3 key (`resumes/{studentId}/{timestamp}.pdf`) and updates
   the aggregated fields, but does NOT render an actual PDF. Pre-pilot
   wire to a server-side renderer (e.g. Puppeteer worker).
4. **Career aptitude assessment integration** — deferred per the plan.
5. **Employer portal for career-track students** — deferred.
6. **Portfolio analytics** (share-link view counts) — deferred.
7. **Cycle 24 portfolio.service.ts SELECT_ITEM** does NOT include
   `section_id` on the item DTO today. The Step 5 listForPortfolio
   endpoint returns sections + item counts as a separate surface;
   the existing portfolio detail endpoint continues to return all
   items in a flat list. UI joins on the frontend. A polish pass
   pre-pilot adds `sectionId` to PortfolioItemDto so the UI does not
   need to recompute the section grouping locally.
8. **`auto_check_source` value catalogue** — the format is documented
   as `<module>:<event-type>` (e.g. `graduation_audit:SERVICE_HOURS`,
   `transcript:GENERATED`) and the consumer subscribes to two topics
   today. Adding a new milestone-trigger event requires a worker code
   change (extending the topic subscription + the source mapping).
   Pre-pilot, schools may want a configurable catalogue of `auto_check_
source` strings.
9. **`pfl_endorsements.endorsed_by` nullable + SET NULL** — preserves
   audit when the endorsing teacher leaves. The plan said `NOT NULL`
   but the schema follows the Cycle 24 `pfl_achievements.awarded_by`
   convention (nullable + SET NULL). Service-layer asserts non-null at
   create time. Worth a reviewer pin.
10. **Resume PDF generation idempotency** — generating twice in the
    same second would land two different `pdf_s3_key` paths but the
    `last_generated_at` is overwritten with the most recent one. The
    previous PDF artefact would orphan in S3. Pre-pilot, the renderer
    should clean up the previous artefact.

## Tagging

- `p2c27-complete` — tagged at `10928a5` (the Round 1 fix commit that earned Round 2 PASS)
- `p2c27-approved` — tagged at the closeout commit (this commit) after the Round 2 PASS verdict
- **Round 2 verdict: PASS** — all 6 BLOCKING fixes confirmed in code by the reviewer; 3 MAJOR follow-ups correctly carried to Phase 2 / pre-pilot punch list

## REVIEW-P2C27 Round 1 fix log (2026-05-16)

Round 1 against the initial cycle ship returned **FAIL** with 6 BLOCKING + 3 MAJOR. Every finding was the same systemic gap: direct-object reads/writes on `pfl_readiness_pathways` / `pfl_pathway_milestones` / `pfl_student_pathway_assignments` / `pfl_college_applications` / `pfl_portfolio_sections` / `pfl_endorsements` / `pfl_resume_profiles` / `sis_service_learning_hours` / `pfl_achievements` / `ext_activity_members` were resolved by surrogate id alone with no school predicate joined through the parent `pfl_portfolios` row or through `sis_students.school_id`. Plus `pfl.pathway.milestone_completed` was emitting through best-effort Kafka post-tx instead of the durable outbox. The Round 1 fix commit lands all 6 BLOCKING + 26 new pinned regression tests in `apps/api/src/portfolio/__tests__/portfolio-advanced-review-p2c27.spec.ts`.

### BLOCKING 1 — durable outbox for `pfl.pathway.milestone_completed`

`ReadinessPathwayService` constructor flips from `KafkaProducerService` to `OutboxService`. Both `updateMilestoneStatus` and `autoCheckByCrossModuleEvent` now call `this.outbox.enqueueInTx(client, ...)` INSIDE the same tenant tx that flips the milestone status. New helper file `apps/api/src/portfolio/event-ids.ts` exports `deterministicMilestoneCompletedEventId(assignmentId, milestoneId)` — v5-shaped UUID via `sha256(<assignmentId>:<milestoneId>:pfl.pathway.milestone_completed:v1)`. Manual completion and auto-check completion of the same `(assignment, milestone)` pair produce the same envelope id so downstream consumers see one logical completion event regardless of which path fired it, and Kafka redelivery dedups cleanly through the outbox publisher. Verified by 4 pinned regression tests including a v5-shape regex assertion and an emit-shape capture for both the COMPLETED-transition and already-COMPLETED-no-emit paths.

### BLOCKING 2 — school-scope shared helpers in `portfolio-access.ts`

`resolveStudentIdForActor`, `isAssignedTeacherOf`, and `isLinkedGuardianOf` all gain `s.school_id = $tenant.schoolId` predicates so a cross-school identity in a shared multi-school tenant schema cannot satisfy owner / guardian / assigned-teacher checks. New `isStudentInCurrentSchool(tenantPrisma, studentId)` helper validates a supplied studentId against the calling school. Verified by 5 pinned regression tests covering each helper's SQL shape and the cross-school refusal path.

### BLOCKING 3 — school-scope readiness assignment / milestone paths

`SELECT_MILESTONE_BASE` and `SELECT_ASSIGNMENT_BASE` JOIN through `pfl_readiness_pathways` so every list / get / patch / delete read carries the parent pathway's school_id predicate. All UPDATE statements rewrite to `UPDATE pfl_pathway_milestones SET … FROM pfl_readiness_pathways p WHERE p.id = pfl_pathway_milestones.pathway_id AND … AND p.school_id = $N` (or the analogous shape for assignment UPDATEs). The auto-check sweep's locked SELECT joins through `pfl_readiness_pathways p` with `p.school_id` predicate. `assignToStudent` validates `input.studentId` via `isStudentInCurrentSchool` BEFORE the INSERT. Verified by 3 pinned regression tests: cross-school studentId on assignToStudent returns 400; SELECT_ASSIGNMENT_BASE carries the JOIN + school predicate; cross-school assignmentId on getAssignment returns 404 don't-leak-existence.

### BLOCKING 4 — school-scope college application paths

`SELECT_APP_BASE` JOINs through `sis_students s` with `s.school_id` predicate threaded on every list / get / patch / delete / counsellor-deadline query. All UPDATE / DELETE statements rewrite to `UPDATE pfl_college_applications AS upd SET … FROM sis_students s WHERE s.id = upd.student_id AND … AND s.school_id = $N`. `create` validates `studentId` via `isStudentInCurrentSchool` BEFORE the INSERT. The counsellor school-wide `listUpcomingDeadlines` carries the school predicate explicitly. Verified by 6 pinned regression tests including cross-school applicationId 404, cross-school studentId 400 on create, UPDATE SQL shape, counsellor deadline scope, and counsellor-scope refusal of TEACHER actor.

### BLOCKING 5 — section + endorsement update / delete / reload paths

`SELECT_SECTION_BASE` and `SELECT_ENDORSEMENT_BASE` JOIN through `pfl_portfolios p` with `p.school_id` predicate. All UPDATE / DELETE statements rewrite to the joined `UPDATE … FROM pfl_portfolios p WHERE p.id = … AND … AND p.school_id = $N` and `DELETE … USING pfl_portfolios p WHERE p.id = … AND … AND p.school_id = $N` shapes. The section reorder negative-slot parking and the assign-item-to-section UPDATE both carry the same school predicate. Verified by 4 pinned regression tests: section patch UPDATE + section remove DELETE + endorsement updateVisibility UPDATE + endorsement remove DELETE all carry the join + predicate.

### BLOCKING 6 — resume cross-module aggregation school-scope

`SELECT_RESUME_BASE` JOINs through `sis_students s` with `s.school_id` predicate. `getForStudent` / `patch` / `generatePdf` all validate the supplied `studentId` via `isStudentInCurrentSchool` BEFORE any read or aggregation fires. Every cross-module aggregation in `generatePdf` joins through `sis_students` with `s.school_id`:

- Endorsement skills: `FROM pfl_endorsements e JOIN pfl_portfolios p ON p.id = e.portfolio_id WHERE p.student_id = $1 AND p.school_id = $2`
- Service hours: `FROM sis_service_learning_hours slh JOIN sis_students s ON s.id = slh.student_id WHERE slh.student_id = $1 AND s.school_id = $2 AND slh.status = 'APPROVED'`
- Achievements: `FROM pfl_achievements a JOIN sis_students s ON s.id = a.student_id WHERE a.student_id = $1 AND s.school_id = $2`
- Extracurriculars: `FROM ext_activity_members em ... WHERE em.person_id IN (SELECT ps.person_id FROM sis_students s JOIN platform.platform_students ps WHERE s.id = $1 AND s.school_id = $2)`

The final UPDATE statement joins through `sis_students` so the school predicate is enforced on the write. Verified by 3 pinned regression tests: cross-school studentId on generatePdf returns 404; SELECT_RESUME_BASE join shape; every cross-module aggregation carries the JOIN + school predicate including the final UPDATE.

### MAJOR follow-ups carried to Phase 2 / pre-pilot

The reviewer flagged 3 MAJOR follow-ups; they're recorded as Phase 2 / pre-pilot punch list items (similar to prior cycles' recommendation-class items):

1. Stronger `studentId` validation on every endpoint that accepts one — current Round 1 fixes cover assignToStudent, college create, and resume access; the broader pattern should extend to every cross-student read.
2. School-id denormalisation on `pfl_college_applications` / `pfl_resume_profiles` (single-column predicate vs JOIN) as a performance polish.
3. `auto_check_source` value catalogue documented as configurable rather than hard-coded in the consumer.

### CI parity green at the Round 1 fix commit

- `pnpm format:check` ✓ all files Prettier-clean
- `pnpm lint:logs` ✓ 969 files clean
- `pnpm --filter @campusos/api build` ✓ nest build clean
- `pnpm --filter @campusos/web build` ✓ next build clean
- `pnpm --filter @campusos/api test` ✓ **1452 / 1452 passing** across 69 spec files (was 1426 — +26 new pinned regression tests in `portfolio-advanced-review-p2c27.spec.ts` plus 4 retrofitted existing tests that now use `makeOutbox()` instead of `makeKafka()` for the milestone-completed emit path)

No schema migrations in Round 1 — every fix is service-layer + new `event-ids.ts` helper file + module-wiring (constructor signature flip from `KafkaProducerService` to `OutboxService` on `ReadinessPathwayService`; `KafkaModule` already exports `OutboxService` from prior cycles so no module-wiring change needed).

**Round 2 verdict: PASS** (2026-05-16). Reviewer cache-busted each affected file and confirmed every BLOCKING fix matches: deterministic outbox event IDs for milestone-completed (via `deterministicMilestoneCompletedEventId(assignmentId, milestoneId)`); school-scoped helpers in `portfolio-access.ts`; readiness assignment/milestone paths joined through `pfl_readiness_pathways.school_id`; college application paths joined through `sis_students.school_id`; section + endorsement update/delete carry parent portfolio school predicate; resume cross-module aggregation school-scoped. Tagged `p2c27-complete` at `10928a5` (the Round 1 fix commit that earned PASS) and `p2c27-approved` at the closeout commit.
