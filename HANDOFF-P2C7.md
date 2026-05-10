# HANDOFF — Phase 2 Cycle 7 (P2-7) Classroom Advanced

**Status:** **REVIEW-P2C7 ROUND 1 fixes applied — awaiting Round 2 verdict.** Round 1 against `aad2f2a` returned **FAIL** with 4 BLOCKING + 4 MAJOR. The Round 1 fix commit (this commit) lands all 4 BLOCKING + the 3 actionable MAJORs (6 + 7 + 8) with 10 new pinned regression tests + live verification. Vitest 377 → **387 passing across 22 spec files**. CI parity green: format:check + lint:logs (662 files clean) + API + web build + vitest 387/387.

P2-7a (Hall Passes + Rubrics + Class Moments — 8 tables, ~18 endpoints, 1 worker, 2 Kafka emits) shipped at `70d690e`. P2-7b (Standards Gradebook + Peer Review — 8 tables, ~18 endpoints) shipped at `fdc95be`. P2-7c (AI Tutoring + Lesson Video — 8 tables, ~16 endpoints, 2 Kafka consumers, 3 Kafka emits) shipped at `aad2f2a`. Plan: `docs/campusos-p2c7-classroom-advanced.html`. Review notes: `P2C7-REVIEW-NOTES.md`. Review fix log: `REVIEW-P2C7-CHATGPT.md`.

## REVIEW-P2C7 ROUND 1 fix log (2026-05-10)

Round 1 against `aad2f2a` (peer review verdict: FAIL) flagged 4 BLOCKING access / event-durability issues + 4 MAJOR follow-ups. The fix commit lands all 4 BLOCKING + 3 actionable MAJORs with new regression tests pinning each contract.

### BLOCKING 1 — `listSignalsForStudent` actor-scoped row scope

`AITutoringService.listSignalsForStudent` previously gated only on STAFF + admin and then queried all signals for the supplied studentId. Any STAFF actor with `tch-007:read` could enumerate sensitive AI inferences (misconceptions, struggles, confidence) for any student in the tenant. **Fix**: actor-scoped row scope — school admin sees all in current school; teacher (STAFF + employeeId) only when student is enrolled in an active class they teach via `sis_class_teachers + sis_enrollments status=ACTIVE`; counsellor only when student is on the counsellor's active caseload via Cycle 11 `svc_caseloads`; other staff with tch-007:read 403; STUDENT 403 (existing — students do not see own signals). Plus `school_id = tenant.schoolId` predicates on both the student-existence pre-check and the signals query (defence-in-depth). Spec test pins all three branches (STAFF without scope → 403, school admin always-allowed, STUDENT → 403).

### BLOCKING 2 — `extractSignals` runs `assertCanReadSession` before AI call

`extractSignals` previously gated only on `STAFF + admin`. Any STAFF actor could trigger AI analysis on any session UUID and consume the school's quota for students outside their scope. **Fix**: added `await this.assertCanReadSession(session, actor)` BEFORE the quota check + AI Gateway call. The session-row scope check (assigned teacher OR caseload-linked counsellor OR admin) is the load-bearing gate. Spec test pins: a STAFF actor not teaching the student → 404 (don't-leak-existence) and the AI Gateway is never reached. Also extended `assertCanReadSession` itself with the counsellor caseload-linked path so a counsellor can read a session for a caseload student (was teacher-only).

### BLOCKING 3 — `startSession` authorises BEFORE the INSERT

`startSession` previously validated only that the student existed in the tenant via an id-only query, then INSERTed before the post-create `getSession(...)` ran row scope. An unauthorised teacher could create an orphan tutoring session for any student. **Fix**: new private `assertCanCreateSessionForStudent(studentId, classId, actor)` that runs BEFORE the INSERT — admin always allowed; teacher requires assigned class via `sis_class_teachers + sis_enrollments status=ACTIVE` (and when classId is supplied additionally requires the student be enrolled in that specific class with the teacher teaching it); counsellor requires active caseload; other staff 403. Plus `school_id = tenant.schoolId` predicates on the `sis_students` validation in `resolveStudentForActor` and on the `sis_classes` validation in `startSession` (defence-in-depth). Spec tests pin: unauthorised teacher → ForbiddenException with NO INSERT executed, and school admin can create session for any student in the school.

### BLOCKING 4 — Durable outbox for `video.uploaded` + `lesson.summary.ready`

`LessonRecordingService.create()` previously committed the recording row and then emitted `video.uploaded` best-effort via `KafkaProducerService`. `applySummary()` had the same shape — committed the summary + flipped status to COMPLETE before the emit. A Kafka outage between the commit and the emit silently lost the event with no retry marker. **Fix**: swapped `KafkaProducerService` for `OutboxService` and call `outbox.enqueueInTx(tx, opts)` INSIDE the same tenant tx as the recording / summary INSERT. The outbox row commits with the domain write; the existing Cycle 31 OutboxPublisherWorker polls + publishes durably. New helpers `deterministicVideoUploadedEventId(recordingId)` and `deterministicLessonSummaryReadyEventId(recordingId)` produce v5-shaped UUIDs via `sha1(<id>:<topic>:v1)` (same pattern as P2-4a `deterministicPayrollEventId`, P2-6 `deterministicCreditNoteEventId`, P2-6 `deterministicReversalEventId`) so retries land the same envelope and downstream consumer idempotency catches the dup cleanly. The `applySummary` tx now also reads the `lesson_id`, `class_id`, `recorded_by` fields under the existing `FOR UPDATE` lock so the outbox payload is built from the locked snapshot, not a separate read after commit. Module no longer imports KafkaProducerService for LessonRecordingService — outbox-only. Spec tests pin: video.uploaded enqueued INSIDE the same tx with v5-shaped event_id; lesson.summary.ready enqueued INSIDE the same tx; deterministic event id is stable across re-runs and distinct between the two topics.

### BLOCKING 5 — Split opt-out CREATE vs DELETE authority

`AIOptOutService.delete()` previously called `assertCanOptOut()` (the same helper used by `create()`). For STUDENT actors that helper allowed self-action whenever `actor.personId` matched the student. So a student could opt themselves back in without parental confirmation — for under-13 students this would let a child silently undo a parental opt-out, contradicting both the COPPA framing and the documented "no admin override, parental right" keystone. **Fix**: new private `assertCanRevokeOptOut(studentId, actor)` enforces tighter delete authority — STUDENT actors are 403 with the canonical message ("Students cannot opt themselves back into AI tutoring once opted out. Contact a parent or school admin."); GUARDIAN actors must still be linked via `sis_student_guardians`; school admin allowed for emergency revocation. The opt-out is intentionally a sticky protection. `assertCanOptOut` (the create-side helper) stays as-is and continues to allow student-self opt-out subject to the production controller-level age-policy check. Spec tests pin all three branches: STUDENT delete → 403 with NO DELETE executed; linked guardian delete → DELETE executed; school admin delete → DELETE executed.

### MAJOR 6 — `AI_QUOTA_FAIL_CLOSED` env support

`AIUsageService.assertWithinQuota` was unconditionally fail-OPEN — when Redis was down the call returned 0 used and the AI call proceeded. **Fix**: when `AI_QUOTA_FAIL_CLOSED=1` and `RedisService.isConnected()` returns false, the assert throws 403 with a canonical "AI quota check unavailable (Redis offline) and AI_QUOTA_FAIL_CLOSED is set" message. Default behaviour stays fail-OPEN (acceptable for dev / demo where the Gateway is stubbed), but production schools concerned with cost controls can flip the env on.

### MAJOR 7 — School-scoped recording reads

`LessonRecordingService.getById` and `listForLesson` previously loaded recordings by id / lesson_id with id-only WHERE clauses then relied on the service-level `assertCanRead` row-scope filter. **Fix**: both queries now include `r.school_id = $tenant.schoolId` predicate so a leaked recording UUID from another tenant collapses to 404 don't-leak-existence at the query level (defence-in-depth alongside the service-layer row scope). Aligns with the Phase 2 hardening standard set across REVIEW-CYCLE26 / REVIEW-P2-5 / REVIEW-P2-6.

### MAJOR 8 — Consumer markFailed only on permanent errors

`VideoTranscriptConsumer.process` previously called `recordings.markFailed(...)` on any caught error then rethrew. A transient AI Gateway outage would mark the recording permanently FAILED even though the next Kafka redelivery would succeed. **Fix**: `markFailed` is now only called for permanent error classes (currently `NotFoundException` — recording does not exist, the upstream service published an invalid recordingId). Transient errors rethrow without marking FAILED so the consumer's claim-after-success path retries via Kafka redelivery and a successful retry finds the recording in the expected status, not a permanently FAILED row that operators would need to manually unpick.

### Test coverage delta

Vitest 377 → **387 passing across 22 spec files** (+10 new pinned regression tests in a dedicated `describe('REVIEW-P2C7 BLOCKING regressions')` block):

- BLOCKING 1: 3 tests (STAFF actor without scope → 403; school admin school-scoped query verified; STUDENT → 403).
- BLOCKING 2: 1 test (STAFF actor not assigned to student → 404, AI Gateway never reached).
- BLOCKING 3: 2 tests (unauthorised teacher → 403 with NO INSERT; school admin → INSERT executes).
- BLOCKING 5: 3 tests (STUDENT delete → 403 with NO DELETE; linked guardian delete → DELETE executed; school admin delete → DELETE executed).
- BLOCKING 4 deterministic event id: 1 test (stable across re-runs; distinct between the two topics; v5-shape verified).

Existing `LessonRecordingService` tests rewritten to use the new `makeOutbox()` stub — `create` and `applySummary` now assert the outbox enqueue shape (topic + sourceModule + v5 event_id + payload) instead of the old kafka.emit shape.

### MAJOR carry-forwards (Phase 2 punch list, not blocking)

- **MAJOR 5 (CAT live-output capture pattern)** — recommendation-class polish for sensitive cycles, joins existing punch list item from REVIEW-CYCLE15.

CI parity green: format:check + lint:logs (662 files clean) + API build + web build + vitest 387/387. Awaiting Round 2 verdict before tagging `p2c7-complete`. See `REVIEW-P2C7-CHATGPT.md` for the full triage table + per-fix verification trail.

**Aggregate totals (P2-7a + P2-7b + P2-7c):**

- **24 new tenant base tables** across 3 migrations (127 + 128 + 129).
- **52 net new endpoints** across the M21 .1 surface — hall passes, rubrics, class moments, standards gradebook, peer review, observations, report card subjects, formative assessment, AI tutoring, AI usage, AI opt-out, lesson recordings.
- **5 Kafka emit topics**: `cls.hall_pass.issued`, `cls.hall_pass.overdue`, `video.uploaded`, `lesson.summary.ready`. P2-7a + P2-7c.
- **2 Kafka consumers**: VideoTranscriptConsumer (group `classroom-video-transcript-consumer`) on `dev.video.transcribed`; LessonSummaryConsumer (group `classroom-lesson-summary-consumer`) on `dev.lesson.summary.from_ai`.
- **1 background worker**: HallPassOverdueWorker (cron, once per minute).
- **Tenant logical base table count**: 581 → **605** (+24, includes the 48 partition leaves on the two RANGE-partitioned tables which the convention does NOT count as logical base tables).
- **Test coverage**: vitest 351 → **377 across 22 spec files** (+26 from the new `classroom-advanced-c.spec.ts` covering opt-out keystone, anonymisation contract, quota gate fires before AI Gateway, students cannot read own signals, controller permission metadata for all 4 P2-7c controllers, AI Gateway stub determinism, lesson recording emit, idempotent transcript chain).
- **CI parity green**: format:check + lint:logs (662 files clean) + API build + web build + vitest 377/377.

## Sub-cycle structure

The plan pre-split P2-7 into three independently shippable sub-cycles to fit Claude Code session budgets. Each sub-cycle has its own schema migration, seed script, services + controllers + tests, and ships under a separate commit. Dependencies flow forward: P2-7a has no external service dependencies, P2-7b extends the gradebook, P2-7c requires AI Inference + Video Processing extracted services (per ADR-004 + plan §05) which are STUBBED in dev so the pipeline ships end-to-end without those services deployed.

## P2-7a — Hall Passes + Rubrics + Class Moments

**Migration**: `127_cls_hall_rubric_moments.sql` (plan slot was 112 — taken by hr_pay_period_lockstep; used 127 per the established Cycle 4-onwards convention).

**8 tables**:

- `cls_hall_pass_settings` — UNIQUE(school_id) per-school config (max_concurrent_passes_per_class default 3, max_daily_passes_per_student default 5, default_duration_minutes default 10, destinations TEXT[] catalogue, require_teacher_approval flag).
- `cls_hall_passes` — 4-state lifecycle ACTIVE / RETURNED / OVERDUE / RECALLED with multi-column `returned_chk` lockstep (returned_at NULL on ACTIVE+OVERDUE, NOT NULL on terminal states). Partial INDEX on `(school_id, status) WHERE status='ACTIVE'` is the daily roster + overdue-scan hot path.
- `cls_rubrics` — Reusable rubric authored by a teacher. is_template flag distinguishes shared templates from assignment-specific rubrics. total_points denormalised from criteria.
- `cls_rubric_criteria` — Per-rubric criterion. weight is % contribution to total grade (SUM SHOULD equal 100 — validated app-side as a non-blocking warning per plan). performance_levels JSONB array of {level_name, description, points} shapes. CASCADE on parent rubric.
- `cls_rubric_scores` — Per-(submission, criterion, scorer) score row. UNIQUE(submission_id, criterion_id, scored_by) so each scorer holds at most one row per criterion per submission. scored_by intentionally NOT a hard FK because P2-7b peer review allows student scorers — for P2-7a only teachers write.
- `cls_class_moments` — Per-(class) photo feed entry. is_approved defaults to true for teacher-posted moments.
- `cls_class_moment_photos` — Per-moment photo with signed-URL pattern matching `hr_employee_documents`. CASCADE on parent moment.
- `cls_class_moment_reactions` — Per-(moment, reacting user) emoji. UNIQUE(moment_id, reacted_by) so each reader can react once with one of 3 reaction types LIKE/LOVE/CELEBRATE — re-reacting flips type via service-side ON CONFLICT DO UPDATE.

**7 intra-tenant FKs** (CASCADE x 4 + NO ACTION x 3). 0 cross-schema FKs. All cross-module refs to `platform.iam_person` and `hr_employees` follow the soft FK convention per ADR-001/020 + ADR-055.

**~18 endpoints** under att-005 + tch-001 + tch-009 across HallPassService + RubricService + ClassMomentService + HallPassOverdueWorker.

**Three structural keystones**:

1. **Per-class advisory tx lock on hall pass issue** — `HallPassService.issue` takes `pg_advisory_xact_lock(hashtext('cls_hall_passes:' || $classId))` at the top of the issue tx so two simultaneous issues against the same class cannot both pass the concurrent-cap check (matches the Cycle 6 RoomBookingService precedent from REVIEW-CYCLE5 BLOCKING 1).
2. **Cron-driven overdue worker** — `HallPassOverdueWorker` ticks every 60s, walks every active school, flips ACTIVE rows past expected_return_at to OVERDUE in one tenant tx, emits `cls.hall_pass.overdue` per row. Idempotent because the next tick's UPDATE filters on `status='ACTIVE'` so an already-flipped row is excluded.
3. **Reaction UPSERT** — `ClassMomentService.react()` runs ON CONFLICT DO UPDATE on (moment_id, reacted_by) so re-reacting flips reaction_type without leaving stale rows.

## P2-7b — Standards Gradebook + Peer Review

**Migration**: `128_cls_standards_peer.sql` (plan slot 113 — taken by hr_employee_position_salary_scale; used 128).

**8 tables**:

- `cls_standard_grades` — Standards-based gradebook row, distinct from the Cycle 2 traditional `cls_grades`. UNIQUE(student_id, standard_id, class_id) caps each student at one proficiency rating per standard per class. proficiency_level 5-value CHECK EXCEEDING / MEETING / APPROACHING / BELOW / NOT_ASSESSED. `standard_id` is a soft polymorphic FK to either tenant `cur_standards` or platform `cur_standards_platform` per the Cycle 23 dual-resolution keystone.
- `cls_standard_grade_evidence` — Links proficiency ratings to demonstrating work. 4-value evidence_type CHECK SUBMISSION / OBSERVATION / ASSESSMENT / TEACHER_NOTE. Multi-column ref_chk requires evidence_ref_id when type is SUBMISSION or ASSESSMENT and accepts NULL for OBSERVATION + TEACHER_NOTE. CASCADE on parent grade.
- `cls_peer_review_assignments` — Per-(assignment) peer review config. UNIQUE(assignment_id) makes peer review opt-in once per assignment. review_type 2-value CHECK RANDOM / TEACHER_ASSIGNED. **`is_anonymous` is the load-bearing flag for the Step 4 anonymisation keystone** — when true, reviewer identity stripped from DTO returned to reviewee.
- `cls_peer_reviews` — Per-(peer_assignment, reviewer, reviewee_submission) review row. UNIQUE keystone. 3-state status CHECK ASSIGNED / SUBMITTED / REVIEWED_BY_TEACHER. Multi-column submitted_chk lockstep. Anonymisation enforced at the service layer not the schema (reviewer_student_id is always populated for teacher audit).
- `cls_student_observations` — Lighter than report cards — mid-term observations. **Plan name `cls_student_progress_notes` is already taken by Cycle 2** with a different shape (UNIQUE per term, summary-style). This new table is the observation log — multiple per term with note_type 3-value CHECK PROGRESS / CONCERN / COMMENDATION + is_shared_with_parent visibility flag. Both tables coexist per the deviation documented in P2C7-REVIEW-NOTES.md.
- `cls_report_card_subjects` — Snapshot per-(report_card, subject) row over the existing Cycle 2 `cls_report_card_entries`. Adds teacher_comments + effort_grade columns. course_id is a nullable soft FK to sis_courses so subject_label can be a free-text snapshot that survives course catalogue changes.
- `cls_formative_assessments` — Per-(class) quick check for understanding. assessment_type 4-value CHECK EXIT_TICKET / POLL / QUICK_CHECK / DO_NOW. questions JSONB. Multi-column active_chk keeps is_active + activated_at + closed_at consistent.
- `cls_formative_responses` — Per-(assessment, student) response. UNIQUE(assessment_id, student_id) caps each student at one response per assessment.

**11 intra-tenant FKs** (CASCADE x 9 + SET NULL x 1 + NO ACTION x 1). 0 cross-schema FKs.

**~18 endpoints** under tch-002 + tch-003 across StandardGradeService + PeerReviewService + ObservationService + ReportCardSubjectService + FormativeAssessmentService.

**Two structural keystones**:

1. **Anonymisation keystone** — `PeerReviewService.listForSubmission` reads parent assignment `is_anonymous`. When true AND the calling actor is the reviewee (resolved via `sis_students` lookup against actor.personId), reviewer_student_id and reviewer_student_name are stripped from the DTO + `isAnonymousView=true` flag returned. Teachers + admins always see the unredacted shape for audit. Spec test pins this contract.
2. **Standards dual-resolution** — `StandardGradeService.upsert` validates `standard_id` against BOTH tenant `cur_standards` AND platform `cur_standards_platform` before INSERT — Cycle 23 standards live in two catalogues and the column resolves either side at the application layer. Same shape as `cls_unit_standards` from Cycle 23.

## P2-7c — AI Tutoring + Lesson Video

**Migration**: `129_cls_ai_tutoring_video.sql` (plan slot 114 — taken by hr_recruitment; used 129).

**8 tables** (5 logical + 2 RANGE-partitioned with 24 monthly leaves each + 1 partition-aware messages parent):

- `cls_ai_tutoring_sessions` — Per-(student, class) tutoring session. status 3-value CHECK ACTIVE / COMPLETED / ABANDONED with multi-column ended_chk lockstep. total_messages denormalised on the session row so the list view doesn't join the partitioned messages table. learning_signals_extracted flag gates the extract-signals endpoint to fire-once.
- **`cls_ai_tutoring_messages`** — Per-(session) message in the conversation. role 2-value CHECK STUDENT / ASSISTANT. **RANGE-partitioned by created_at monthly across 24 partitions covering 2025-08 to 2027-08** matching the msg_messages window. Composite PK (id, created_at) per the precedent. tokens_used per message lets AIUsageService aggregate by session for the admin dashboard. session_id is a soft FK because PostgreSQL refuses cross-partition FKs without denormalising the partition column.
- `cls_ai_tutoring_learning_signals` — Per-(session) extracted learning signal. signal_type 5-value CHECK MISCONCEPTION / STRENGTH / STRUGGLE / INTEREST / ENGAGEMENT. confidence 0..1 NUMERIC(3,2). standard_id soft polymorphic FK to either cur_standards or platform.cur_standards_platform.
- `cls_lesson_recordings` — Per-(lesson) video recording. processing_status 5-state CHECK UPLOADED / TRANSCRIBING / SUMMARISING / COMPLETE / FAILED tracks the pipeline. s3_key signed-URL pattern. Emits `video.uploaded` after upload commits.
- `cls_lesson_transcripts` — Per-(recording) transcript. UNIQUE(recording_id) caps each recording at one transcript. Produced by the Video Processing service consuming `dev.video.transcribed`.
- `cls_lesson_summaries` — Per-(recording) AI-generated summary. UNIQUE(recording_id). key_topics + action_items as TEXT[] arrays. model_version stored for audit.
- **`cls_ai_usage_log`** — Per-(school, AI job) usage and cost log. job_type 4-value CHECK GRADING / SUMMARISATION / TUTORING / STUDENT_SUMMARY. **RANGE-partitioned by created_at monthly across 24 partitions** matching cls_ai_tutoring_messages. Composite PK (id, created_at). reference_id soft polymorphic FK pointing at the originating row (TUTORING → session_id, SUMMARISATION → recording_id).
- `cls_ai_tutoring_opt_outs` — Per-student opt-out record. UNIQUE(student_id) caps each student at one row. opted_out_by soft FK to platform.iam_person — parent for under-13s, student or parent for 13+ per COPPA + FERPA convention.

**8 intra-tenant FKs** (CASCADE x 7 + NO ACTION x 1 on `cls_lesson_recordings.lesson_id`). 0 cross-schema FKs.

**~16 endpoints** across 4 services + 4 controllers under tch-007 + tch-001:

- `AITutoringService` (8 endpoints) — startSession, listSessions, getSessionWithMessages, postMessage (THE KEYSTONE), completeSession, extractSignals, listSignals (per session), listSignalsForStudent.
- `LessonRecordingService` (3 endpoints) — create (emits `video.uploaded`), getById, listForLesson.
- `AIUsageService` (3 endpoints) — getSummary (admin-only), listUsage (admin-only), getQuota.
- `AIOptOutService` (3 endpoints) — create (parent / student-self / admin), getByStudent, delete.

**3 Kafka emit topics**: `video.uploaded` (LessonRecordingService.create), `lesson.summary.ready` (LessonRecordingService.applySummary AFTER tx commits, for downstream teacher notification fan-out). The existing Cycle 14 NotificationConsumer integration for these is a Phase 2 future-cycle wire when the AI Inference and Video Processing services deploy.

**2 Kafka consumers**:

- `VideoTranscriptConsumer` (group `classroom-video-transcript-consumer`) — subscribes to `dev.video.transcribed`. On each event, calls `LessonRecordingService.applyTranscript` (writes cls_lesson_transcripts + flips processing_status TRANSCRIBING → SUMMARISING in one tx) then chains to `AIGatewayService.summariseLesson` and `LessonRecordingService.applySummary`. Both apply\* helpers are idempotent so a redelivery is harmless.
- `LessonSummaryConsumer` (group `classroom-lesson-summary-consumer`) — subscribes to `dev.lesson.summary.from_ai` (the production AI Inference response wire). Chained inline in dev via VideoTranscriptConsumer; this consumer is the wire for production deployment.

**Three load-bearing AI safety rules** per ADR-004 enforced at the service layer (the schema cannot enforce them but the service spec pins them as regression tests):

1. **AI MUST NEVER write to cls_grades**. The AITutoringService reads context but never inserts or updates a grade row. Spec test `'Service must NEVER write to cls_grades — postMessage capture audit'` audits all SQL captured during postMessage and asserts no `INSERT INTO cls_grades` or `UPDATE cls_grades` fired.
2. **AI MUST NEVER receive student PII in prompts**. `AITutoringService.toAnonymousId(studentId, sessionId)` hashes via SHA-256 and returns the first 16 hex chars — deterministic but opaque. The AI Gateway sees only this token. Spec test pins determinism + 16-hex-pattern + non-determinism for different sessions.
3. **AI tutoring opt-out is hard-gated**. `AITutoringService.assertNotOptedOut` reads `cls_ai_tutoring_opt_outs` BEFORE every session start AND every message — opted-out students receive 403 even on admin override. Spec test `'startSession refuses an opted-out student with 403'` pins this. Per ADR-004 opt-out is a parental / student right, not subject to admin override.

**Per-tenant AI quota enforcement** via Redis daily counter at `ai:quota:{schoolId}:{YYYY-MM-DD}` with 25-hour TTL (long enough to survive a one-hour DST transition). Default daily limit is 100 000 tokens via `AI_QUOTA_DAILY_TOKENS` env. `AIUsageService.assertWithinQuota` is called BEFORE every chargeable AI call; `recordUsage` is called AFTER the call commits — so a failed AI call does NOT count against quota. Spec test `'Quota gate fires before any AI Gateway call when quota is exhausted'` verifies the call ordering by stubbing the AI Gateway and asserting it is never reached.

**AI Gateway stub** — `AIGatewayService` is the dev stub for the AI Inference extracted service per ADR-004. In production this is the thin client over the Gateway; for dev / demo / CAT scripts it returns deterministic placeholder responses so the rest of the pipeline (queue, opt-out gate, usage logging, message persistence) ships and can be exercised end-to-end. When the real service deploys, swap the implementation for an HTTP client without changing any caller. The stub is gated on `!process.env.AI_GATEWAY_URL || process.env.AI_GATEWAY_STUB === '1'`.

**Step 6 seed**: `seed-classroom-advanced-c.ts` (idempotent, gated on whether `cls_ai_tutoring_sessions` already has rows for the demo school) — 2 tutoring sessions (1 COMPLETED with 8 messages + 3 learning signals, 1 ACTIVE), 8 messages alternating STUDENT then ASSISTANT in the COMPLETED session, 3 learning signals (STRENGTH + INTEREST + MISCONCEPTION with confidence values), 1 lesson recording COMPLETE with transcript + summary, 3 cls_ai_usage_log entries across TUTORING + SUMMARISATION + STUDENT_SUMMARY job types, 1 cls_ai_tutoring_opt_outs (David Chen opts out Ethan — exercises the parent-opts-out keystone). Wired as `seed:classroom-advanced-c` in package.json.

## Cross-cycle dependencies

- Cycle 2 — `cls_lessons` (recordings.lesson_id), `cls_assignments` (peer_review_assignments.assignment_id), `cls_submissions` (peer_reviews.reviewee_submission_id, rubric_scores.submission_id), `cls_grades` (NEVER written by P2-7c services per ADR-004 SAFETY RULE 1), `cls_report_cards` (report_card_subjects.report_card_id).
- Cycle 1 — `sis_students` (passes, sessions, opt-outs, peer_reviews.reviewer_student_id), `sis_classes` (passes, recordings, sessions, observations, formative), `sis_class_teachers` (row scope), `sis_enrollments` (row scope on student-visible recordings).
- Cycle 4 — `hr_employees` (rubrics.created_by, recordings.recorded_by, observations.teacher_id, peer_reviews.teacher_reviewed_by) all soft FK per ADR-055.
- Cycle 23 — `cur_standards` + `platform.cur_standards_platform` (standard_grades.standard_id, learning_signals.standard_id) via the dual-resolution keystone.

## Permission gates (P2-7 surface)

- `att-005:read+write` — Hall passes (Teacher write, Student read on own).
- `tch-001:read+write` — Rubrics + Lesson Recordings (teacher write, student read for viewing rubric on own submission and recording on enrolled class).
- `tch-002:read+write` — Peer review + formative assessment (Teacher write, Student read+write on own submitted reviews + responses).
- `tch-003:read+write` — Standards gradebook + observations + report card subjects.
- `tch-007:read+write` — AI tutoring (Student + Teacher + VP per existing seed grants).
- `tch-007:admin` — AI Usage admin dashboard (admin tier only via everyFunction).
- `tch-009:read+write` — Class moments (Teacher write, Parent read on enrolled-children's classes).

The IAM seed already grants TCH-007 read+write to Student + Teacher + Vice Principal from earlier sub-cycles, so no new IAM grants land in P2-7c. School Admin and Platform Admin pick up tch-007:admin via `everyFunction`.

## Deviations from the plan

1. **Migration numbers 127/128/129** instead of plan's 112/113/114 — the plan slots are occupied. Per the Cycle 4-onwards convention the next-available slot is used.
2. **`cls_student_observations` instead of plan's `cls_student_progress_notes`** in P2-7b — the plan name is already taken by Cycle 2 with a different shape (UNIQUE per term, summary-style). The new observation log is multiple-per-term with categorisation + share-with-parent flag. Both tables coexist and serve different surfaces.
3. **`cls_lesson_recordings.processing_status` 5-value CHECK** instead of the plan's 4-value (UPLOADED/TRANSCRIBING/SUMMARISING/COMPLETE) — added FAILED so the consumer can mark a recording failed if upstream services reject the job. The 4 plan values cover the happy path; FAILED is the operational requirement.
4. **`lesson.summary.from_ai` vs `lesson.summary.ready`** — two distinct topics in two directions on the bus. The AI Inference service publishes `lesson.summary.from_ai` (the response back into CampusOS); LessonRecordingService.applySummary EMITS `lesson.summary.ready` for teacher notification fan-out. Plan §05 only mentions `lesson.summary.ready` but the production wire requires both.

## Carry-forwards to Phase 2 / pre-pilot punch list

(None blocking — the pipeline ships end-to-end with the AI Gateway and Video Processing services stubbed.)

1. **Wire the production AI Inference service** — swap `AIGatewayService.tutoringReply / extractLearningSignals / summariseLesson` from stub to HTTP client when the service deploys.
2. **Wire the production Video Processing service** — the VideoTranscriptConsumer subscribes to `dev.video.transcribed` but no producer publishes today. The seed lands a placeholder transcript via SQL so the read path renders end-to-end. When the service deploys, kick off transcription on `video.uploaded` and publish `video.transcribed` per the documented payload contract.
3. **Cycle 14 NotificationConsumer wire on `lesson.summary.ready`** — currently the emit lands cleanly but no consumer fans out to teacher IN_APP notifications. A future Cycle 14-side consumer can reuse the existing pattern.
4. **AI usage cost rollup beyond per-school day** — current Redis counter is per-school per-day. A district-tier rollup is a future requirement when the platform onboards multi-school districts.
5. **Auto-task on hall_pass.overdue** — the emit lands cleanly but no auto-task rule exists for it today. A school admin notification (or task to the issuing teacher) is a natural Cycle 7 TaskWorker rule.
6. **Cycle 7 TaskWorker + Cycle 14 NotificationConsumer emits on student.acknowledgement.completed flow** — the existing infrastructure can light up additional surfaces around AI usage / opt-out / lesson summaries without further schema changes.
7. **GROUP_MEMBERSHIP audience targeting** for class_moments — currently parent visibility is gated by `sis_student_guardians + ACTIVE sis_enrollments`. A future Cycle 18 group-based audience could complement this for multi-class moments.

## Test coverage by sub-cycle

- P2-7a: 18 tests in `classroom-advanced.spec.ts` (concurrent + daily limit keystones + reactions + rubric weight warning + class moment row scope + permission metadata for all 3 controllers).
- P2-7b: 37 tests in `classroom-advanced-b.spec.ts` (anonymisation keystone in 7 directions + standard grade row scope + observation visibility + formative response uniqueness + permission metadata for all 5 controllers).
- P2-7c: 26 tests in `classroom-advanced-c.spec.ts` (opt-out keystone in 5 directions + opt-out gate before AI Gateway + STUDENT cannot start for someone else + quota gate fires before AI Gateway + anonymisation contract + STUDENT cannot read own signals + non-staff cannot extract signals + cls_grades audit + AI Usage quota counter + recordUsage writes log + LessonRecording emits video.uploaded + applyTranscript idempotent + applySummary emits lesson.summary.ready + AI Gateway stub determinism + permission metadata for all 4 controllers).

**Total cycle test count**: 81 spec cases across the 3 sub-cycles. Vitest 351 → 377 across 22 spec files.

## Operational notes

- The two RANGE-partitioned tables (`cls_ai_tutoring_messages`, `cls_ai_usage_log`) cover 24 monthly windows from 2025-08 to 2027-08. Production should add a partition rotation job before 2027-08 to extend the window forward and (optionally) detach + archive partitions older than the retention SLA.
- The `cls_ai_tutoring_messages.session_id` is a soft FK because PostgreSQL refuses cross-partition FKs without denormalising the partition column onto the parent. The service layer validates session existence on every INSERT.
- The Redis quota counter at `ai:quota:{schoolId}:{YYYY-MM-DD}` is best-effort. If Redis is down, `AIUsageService.assertWithinQuota` returns 0 used and the call proceeds — fail-open. Production should add an `AI_QUOTA_FAIL_CLOSED=1` env flag if the school operator wants strict enforcement at the cost of availability.
- The HallPassOverdueWorker tick interval defaults to 60s. Production can tune via `HALL_PASS_OVERDUE_INTERVAL_MS` env. The warmup delay is configurable via `HALL_PASS_OVERDUE_WARMUP_MS` (default 30s) so the worker doesn't fire on boot before the schema is fully loaded.

## Files added / modified across the 3 sub-cycles

**Schema + seed**:

- `packages/database/prisma/tenant/migrations/127_cls_hall_rubric_moments.sql` (P2-7a)
- `packages/database/prisma/tenant/migrations/128_cls_standards_peer.sql` (P2-7b)
- `packages/database/prisma/tenant/migrations/129_cls_ai_tutoring_video.sql` (P2-7c)
- `packages/database/src/seed-classroom-advanced.ts` (P2-7a)
- `packages/database/src/seed-classroom-advanced-b.ts` (P2-7b)
- `packages/database/src/seed-classroom-advanced-c.ts` (P2-7c)
- `packages/database/package.json` — three new `seed:classroom-advanced*` scripts.

**API services + controllers**:

- `apps/api/src/classroom-advanced/classroom-advanced.module.ts` — wires all 13 services + 12 controllers + 2 consumers + 1 worker.
- P2-7a: hall-pass.{service,controller}.ts, hall-pass-overdue.worker.ts, rubric.{service,controller}.ts, class-moment.{service,controller}.ts, dto/{hall-pass,rubric,class-moment}.dto.ts.
- P2-7b: standard-grade.{service,controller}.ts, peer-review.{service,controller}.ts, observation.{service,controller}.ts, report-card-subject.{service,controller}.ts, formative-assessment.{service,controller}.ts, dto/{standard-grade,peer-review,observation,report-card-subject,formative-assessment}.dto.ts.
- P2-7c: ai-tutoring.{service,controller}.ts, ai-gateway.service.ts (stub), ai-usage.{service,controller}.ts, ai-opt-out.{service,controller}.ts, lesson-recording.{service,controller}.ts, video-transcript.consumer.ts, lesson-summary.consumer.ts, dto/ai-tutoring.dto.ts.

**Tests**:

- `apps/api/src/classroom-advanced/classroom-advanced.spec.ts` (P2-7a — 18 tests).
- `apps/api/src/classroom-advanced/classroom-advanced-b.spec.ts` (P2-7b — 37 tests).
- `apps/api/src/classroom-advanced/classroom-advanced-c.spec.ts` (P2-7c — 26 tests).

**Redis service extension**:

- `apps/api/src/notifications/redis.service.ts` — adds `incrementCounter(key, delta, ttlSeconds)` and `readCounter(key)` for the per-tenant AI quota.

**Total surface change**: 24 tables + 52 endpoints + 2 consumers + 1 worker + 5 emit topics + 81 tests across the cycle.
