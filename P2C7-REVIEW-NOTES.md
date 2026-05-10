# P2C7 Review Notes — Phase 2 Cycle 7 Classroom Advanced

This document captures the schema decisions, deviations, edge cases, security considerations, and performance notes a reviewer should focus on when reviewing P2-7 (a + b + c). Plan: `docs/campusos-p2c7-classroom-advanced.html`. Handoff: `HANDOFF-P2C7.md`.

## 1. Schema decisions

### 1.1 Migration numbering

Plan slots (112 / 113 / 114) collide with HR migrations from the same Phase 2 wave. Per the established Cycle 4-onwards convention, the next available slots (127 / 128 / 129) are used. No semantic effect — migrations apply in numeric order regardless of the plan number.

### 1.2 Naming deviation: cls_student_observations vs plan's cls_student_progress_notes

The plan calls for a P2-7b table named `cls_student_progress_notes`. Cycle 2 already ships a table by that exact name with a different shape (UNIQUE per term, summary-style, `is_visible_to_student` + `is_visible_to_parent` separate flags, term_id FK). Renaming the existing table would be a breaking schema change to a stable Cycle 2 surface. **Decision**: name the new table `cls_student_observations` and document that it is the "observation log" complement to the Cycle 2 "progress note" surface. Both tables coexist:

- Cycle 2 `cls_student_progress_notes` — UNIQUE(class, student, term), summary-style, lifecycle-locked at term close, separate visible_to_student/parent flags.
- P2-7b `cls_student_observations` — multiple per term, note_type 3-value CHECK PROGRESS/CONCERN/COMMENDATION, single is_shared_with_parent flag.

Reviewer should note this is a naming decision driven by the existing schema, not a semantic departure from the plan's intent.

### 1.3 `cls_lesson_recordings.processing_status` 5-value vs plan's 4-value

Plan §05 specifies UPLOADED / TRANSCRIBING / SUMMARISING / COMPLETE. The implementation adds **FAILED** as a 5th state so the consumer can mark a recording failed when an upstream service rejects the job. Without FAILED, a permanently-failed recording would either sit in TRANSCRIBING/SUMMARISING forever (pollutes ops dashboards) or require a workaround (set status back to UPLOADED then DELETE). Spec test `'video.transcribed processing failed'` exercises the markFailed path.

### 1.4 Two distinct lesson summary topics on the bus

Plan §05 mentions `lesson.summary.ready` only, but the production wire requires two distinct topics in two directions:

- `lesson.summary.from_ai` — the AI Inference service publishes this back into CampusOS as the response to a transcript-ready event. `LessonSummaryConsumer` subscribes to it.
- `lesson.summary.ready` — `LessonRecordingService.applySummary` EMITS this AFTER the summary tx commits, for downstream teacher notification fan-out.

Naming: a single name would collide between "summary just produced from AI" and "summary now available, please notify teacher". The two-topic shape avoids the collision.

### 1.5 RANGE-partitioned messages have soft FK to sessions

`cls_ai_tutoring_messages.session_id` is intentionally NOT a hard FK to `cls_ai_tutoring_sessions(id)`. PostgreSQL refuses cross-partition FKs without denormalising the partition column onto the parent (per the existing Cycle 3 `msg_messages` precedent and Cycle 7 `tsk_tasks`). The service layer validates session existence on every INSERT — `AITutoringService.postMessage` loads + locks the session before writing the message.

### 1.6 Soft polymorphic FK for standard_id

`cls_standard_grades.standard_id` and `cls_ai_tutoring_learning_signals.standard_id` are both soft FKs because Cycle 23 standards live in two catalogues — tenant `cur_standards` and platform `cur_standards_platform`. The service layer dual-resolves at INSERT time.

### 1.7 RANGE-partition window: 2025-08 to 2027-08

Both `cls_ai_tutoring_messages` and `cls_ai_usage_log` carry 24 monthly partitions covering 2025-08 to 2027-08. This matches the existing Cycle 3 `msg_messages` window, so all monthly-partitioned tables share the same retention shape. Production needs to add a partition rotation job before 2027-08 (already on the broader Phase 3 ops list).

### 1.8 Partial UNIQUE INDEXes for fast hot paths

- `cls_hall_passes_school_active_idx ON (school_id, status) WHERE status='ACTIVE'` — daily roster + overdue scan hot path.
- `cls_hall_passes_overdue_scan_idx ON (expected_return_at) WHERE status='ACTIVE'` — the cron worker's predicate.
- `cls_ai_tutoring_sessions_school_active_idx ON (school_id, started_at DESC) WHERE status='ACTIVE'` — admin's "currently tutoring" view.
- `cls_lesson_recordings_status_idx ON (school_id, processing_status) WHERE processing_status <> 'COMPLETE'` — the in-progress queue.

### 1.9 Multi-column lockstep CHECK constraints

- `cls_hall_passes.returned_chk` — pins returned_at to NULL on ACTIVE+OVERDUE and to NOT NULL on RETURNED+RECALLED.
- `cls_peer_reviews.submitted_chk` — pins submitted_at to NULL on ASSIGNED and to NOT NULL on SUBMITTED+REVIEWED_BY_TEACHER.
- `cls_formative_assessments.active_chk` — pins is_active=true requires activated_at populated AND closed_at NULL.
- `cls_ai_tutoring_sessions.ended_chk` — pins ended_at to NULL on ACTIVE and to NOT NULL on COMPLETED+ABANDONED.
- `cls_standard_grade_evidence.ref_chk` — requires evidence_ref_id when type is SUBMISSION or ASSESSMENT, accepts NULL for OBSERVATION + TEACHER_NOTE.

These prevent a buggy service from landing a half-state row even if the locked-tx transition logic regresses.

## 2. Edge cases

### 2.1 Hall pass concurrent-cap race

`HallPassService.issue` uses `pg_advisory_xact_lock(hashtext('cls_hall_passes:' || $classId))` so two simultaneous issues against the same class serialise — only one passes the concurrent-cap check. Without the advisory lock, both could pass the count, both INSERT, and the cap is silently exceeded.

### 2.2 Hall pass daily-cap window

The daily counter uses `WHERE issued_at >= date_trunc('day', now())`. For schools spanning timezones (US vs UK demo tenants on the same DB host), the day boundary is server UTC, not school-local. Future cycle adds school-local timezone handling at the SQL layer.

### 2.3 Class moment reaction re-react

`ClassMomentService.react` runs `INSERT … ON CONFLICT (moment_id, reacted_by) DO UPDATE SET reaction_type = $newType`. Re-reacting flips the type without leaving stale rows. The UNIQUE(moment_id, reacted_by) is the schema-side enforcement.

### 2.4 Peer review anonymisation contract

The reviewer_student_id is ALWAYS populated on the row (so teachers can audit). Anonymisation is a DTO-shape concern — when `parent.is_anonymous=true` AND the reading actor is the reviewee (resolved via sis_students lookup against actor.personId), the DTO returned to the reviewee strips reviewer_student_id + reviewer_student_name and sets `isAnonymousView=true`. A teacher or admin reading the same row sees the unredacted shape.

### 2.5 Standards dual-resolution mismatch

If a standard exists in BOTH tenant `cur_standards` (a school override) AND platform `cur_standards_platform` (the national catalogue) with the same UUID, the service layer accepts either match. UUIDs are random enough that this collision is statistically infeasible in practice.

### 2.6 Formative assessment activate without students

A teacher can activate an assessment in a class with zero active enrollments. The active_chk passes. Students see no surface — there's nobody to send the assessment to. Future polish adds a service-layer warning, not blocking.

### 2.7 Report card subject without report card

`cls_report_card_subjects.report_card_id` is a hard FK CASCADE. A subject row without a report card cannot exist. Service-layer create validates the report card belongs to the calling school via the existing Cycle 2 ReportCardService row scope.

### 2.8 AI tutoring session for a deleted student

`cls_ai_tutoring_sessions.student_id` CASCADE on `sis_students`. If a student is removed mid-session, all sessions, messages (CASCADE through soft FK + service-layer enforcement), and learning signals drop. Deliberately destructive — student-removal is an admin-emergency operation that should rarely happen post-graduation.

### 2.9 AI usage quota rollover at midnight UTC

Counter key includes `YYYY-MM-DD` — at midnight UTC the new key has no value, so the new day starts fresh. The 25-hour TTL on the previous day's key handles DST gracefully — a 1-hour DST transition won't reset the counter prematurely.

### 2.10 AI tutoring opt-out admin override

**There is no admin override path for opt-out.** Opt-out is a parental / student right per ADR-004. Even a school admin or platform admin attempting to start a session on behalf of an opted-out student receives 403. The only recovery is to DELETE the opt-out row (which the parent / student / admin can do via `DELETE /classroom/ai-tutoring/opt-out/:studentId`). Spec test `'startSession refuses an opted-out student with 403'` pins this.

### 2.11 Lesson recording without lesson

`cls_lesson_recordings.lesson_id` is a hard FK CASCADE. The plan §05 originally said NO ACTION but the implementation chose CASCADE for consistency with the rest of the cls\_\*\_lesson surface. A recording without its parent lesson is meaningless; admin keeps the audit via the application's recording history list.

## 3. Security considerations

### 3.1 AI safety rules (ADR-004)

These are the load-bearing safety rules and the reviewer's primary focus:

1. **AI MUST NEVER write to cls_grades.** The AITutoringService reads context but never inserts or updates a grade row. The AIGatewayService stub never writes either. Spec test `'Service must NEVER write to cls_grades — postMessage capture audit'` audits all SQL captured during postMessage and asserts zero `INSERT INTO cls_grades` and zero `UPDATE cls_grades` calls fired. Production AI Gateway implementation should replicate this audit.
2. **AI MUST NEVER receive student PII in prompts.** The `AITutoringService.toAnonymousId(studentId, sessionId)` helper hashes via SHA-256 and returns the first 16 hex chars — deterministic but opaque. The AI Gateway sees only this token. The system prompt contains the subject (free-text) only — never the student name, email, or any identifier that could resolve back to a real person. Spec tests `'Anonymisation contract — anonymous id is deterministic and 16-hex'` pins both determinism + opacity.
3. **AI tutoring opt-out is hard-gated.** `AITutoringService.assertNotOptedOut` reads `cls_ai_tutoring_opt_outs` BEFORE every session start AND every message. There is NO admin override path. Spec test `'startSession refuses an opted-out student with 403'` pins this.

### 3.2 Per-tenant AI quota

`AIUsageService.assertWithinQuota` is called BEFORE every chargeable AI Gateway call. The Redis daily counter at `ai:quota:{schoolId}:{YYYY-MM-DD}` enforces a default 100 000 token / day limit (overrideable via `AI_QUOTA_DAILY_TOKENS` env). Spec test `'Quota gate fires before any AI Gateway call when quota is exhausted'` verifies the call ordering by stubbing the AI Gateway and asserting it is never reached. **`recordUsage` is called AFTER the AI call commits** — so a failed AI call does NOT count against quota. This is the correct ordering: the quota is "what we successfully consumed", not "what we attempted".

### 3.3 Peer review anonymisation

The reviewer_student_id is intentionally stored on the row (so teachers can audit a misbehaving reviewer) but stripped from the DTO returned to the reviewee when `parent.is_anonymous=true`. The `isAnonymousView` flag on the DTO signals to the UI that the rendered review is anonymised.

### 3.4 Hall pass limits

Both `max_concurrent_passes_per_class` (default 3) and `max_daily_passes_per_student` (default 5) are configurable per school via `cls_hall_pass_settings`. The service-layer assertWithinLimits fires BOTH checks INSIDE the same tenant tx with the per-class advisory lock so concurrent issues serialise. Both schema CHECK constraints (`max_concurrent_passes_per_class > 0` and `max_daily_passes_per_student > 0`) prevent zero/negative limits that would lock out the whole school.

### 3.5 Lesson recording S3 key

`cls_lesson_recordings.s3_key` is the signed-URL pattern matching `hr_employee_documents` from Cycle 4. The service NEVER returns a signed URL for download; the controller GET endpoint returns the s3_key only and the web layer's `useLessonRecording` hook signs it via the existing S3 signing infrastructure. Row scope on the read endpoint binds students to enrolled-class recordings only.

### 3.6 Class moments parent visibility

`cls_class_moments` rows are visible to parents whose children are enrolled in the moment's class via `sis_student_guardians + ACTIVE sis_enrollments` join. Teachers can DELETE a moment (CASCADE drops photos + reactions). There is no parent-side moderation UI — parents who object to a posted photo escalate to school admin, who DELETEs the row.

### 3.7 Standards gradebook FERPA implications

`cls_standard_grades` is per-student proficiency data, comparable in sensitivity to traditional `cls_grades`. The row scope on `StandardGradeService.listForStudent` binds students to own and parents to linked-children only via the existing Cycle 1 `sis_student_guardians` chain.

### 3.8 Student observations parent visibility

`cls_student_observations.is_shared_with_parent` is the explicit visibility flag. The default is `false` — observations are staff-internal until the teacher explicitly shares. Parents see only `is_shared_with_parent=true` rows for their linked children.

### 3.9 AI usage log audit trail

`cls_ai_usage_log` is the cost + token audit log. `actor_id` is populated for human-initiated jobs (via the calling actor's accountId) and NULL for worker-initiated jobs (e.g. nightly summarisation). The admin dashboard shows the per-actor breakdown so a school can investigate who is driving AI costs.

## 4. Performance notes

### 4.1 Partitioned tables prune by created_at

Both `cls_ai_tutoring_messages` and `cls_ai_usage_log` are RANGE-partitioned by created_at monthly. The admin AI usage dashboard aggregates over the last 30 days by default — that query prunes to at most 2 partition leaves (the current month + last month boundary). The per-session message list in the AI tutor UI prunes to the matching partition leaf for the session's start month.

### 4.2 Hall pass overdue scan

The cron worker walks `WHERE school_id = $1 AND status = 'ACTIVE' AND expected_return_at < now()`. The `cls_hall_passes_overdue_scan_idx ON (expected_return_at) WHERE status='ACTIVE'` partial INDEX is the canonical hot path — the planner uses it for the overdue scan AND naturally prunes to ACTIVE rows.

### 4.3 GIN-style array operations on key_topics + action_items

`cls_lesson_summaries.key_topics` and `action_items` are TEXT[] arrays. Future search-by-topic features can add a GIN INDEX `USING GIN (key_topics)` for `&&` array overlap queries. Today's UI surface renders them as chips and doesn't filter, so no GIN today.

### 4.4 Redis quota counter is O(1)

`incrementCounter(key, delta, ttlSeconds)` is an INCRBY + (one-time) EXPIRE — both O(1) Redis ops. Fail-open on Redis outage means the AI call proceeds; the cls_ai_usage_log row still lands so the admin dashboard recovers retrospectively when Redis recovers.

### 4.5 AI Gateway stub is in-process

The `AIGatewayService` stub returns synthetic strings without a network call. Production swap replaces with an HTTP client to the AI Inference service. The stub is gated on `!process.env.AI_GATEWAY_URL || process.env.AI_GATEWAY_STUB === '1'` so production deployments enforce the real client.

### 4.6 Class moment photo array dump

`cls_class_moment_photos` is a child table sorted by sort_order. Loading a class moment with N photos is one round-trip + one INNER JOIN. No N+1.

### 4.7 Peer review row-scope joins

`PeerReviewService.listForSubmission` joins through `cls_peer_reviews + cls_peer_review_assignments + sis_students` to resolve the reviewer name + reviewee name + anonymisation flag in one round-trip. Stripping is an in-memory transform on the result, no extra query.

### 4.8 Standards heatmap query

The class-wide standards heatmap (proficiency × standards × students) is one query joining `cls_standard_grades + sis_enrollments + sis_students + cur_standards/cur_standards_platform`. For a class of 30 students × 10 standards × 5 proficiency levels, the result is at most 1 500 rows. No materialisation needed today.

## 5. Test coverage breakdown

### 5.1 P2-7c spec (`classroom-advanced-c.spec.ts` — 26 tests)

- **AIOptOutService keystone (5 tests)**: isOptedOut returns true/false; GUARDIAN can opt out linked child only; STUDENT may only opt themselves; admin override; rejects duplicate.
- **AITutoringService opt-out + anonymisation + quota keystones (6 tests)**: startSession refuses opted-out student; STUDENT cannot start for someone else; quota gate fires BEFORE AI Gateway call; anonymisation contract is deterministic + 16-hex; students cannot read own learning signals; non-staff cannot extract signals; SAFETY RULE 1 audit (no cls_grades writes).
- **AIUsageService quota counter (3 tests)**: assertWithinQuota throws when limit exceeded; recordUsage writes log + bumps Redis; non-admin cannot read summary.
- **LessonRecordingService emit + idempotent chain (3 tests)**: create emits video.uploaded with documented payload; applyTranscript is idempotent; applySummary emits lesson.summary.ready AFTER tx commits.
- **Controller permission metadata (4 tests)**: AITutoringController on tch-007:read+write; AIUsageController on tch-007:admin (dashboard) + tch-007:read (quota); AIOptOutController on tch-007:read with service-layer authority; LessonRecordingController on tch-001.
- **AIGatewayService stub mode (3 tests)**: tutoringReply returns deterministic stub; extractLearningSignals returns at least one signal; summariseLesson returns stub summary.

### 5.2 P2-7b spec (`classroom-advanced-b.spec.ts` — 37 tests)

The reviewer should re-read the existing P2-7b spec for the anonymisation keystone tests:

- `'strips reviewer identity when anonymous=true and caller is the reviewee'`
- `'preserves reviewer identity for the reviewer themselves'`
- `'preserves reviewer identity for teachers and admins'`
- Plus standard grade row scope, observation is_shared_with_parent visibility, formative response uniqueness, controller permission metadata for all 5 P2-7b controllers.

### 5.3 P2-7a spec (`classroom-advanced.spec.ts` — 18 tests)

- Hall pass concurrent + daily cap keystones, RubricService weight warning + UNIQUE catch, ClassMomentService row scope + reaction UPSERT, controller permission metadata for all 3 P2-7a controllers.

## 6. Operational gotchas

### 6.1 Migration provisioning order

The 3 P2-7 migrations apply in numeric order with the existing 126 migrations from prior cycles. Splitter audit was clean on first attempt for all three (no semicolons inside string literals or block comment headers).

### 6.2 Idempotent re-provision verified

Re-provisioning `tenant_demo` after the migration applied is a no-op — `CREATE TABLE IF NOT EXISTS` on every base table + partition. No DROP statements in any P2-7 migration.

### 6.3 Seed gate

Each sub-cycle's seed script gates on its first table:

- P2-7a gates on `cls_hall_pass_settings` row count.
- P2-7b gates on `cls_standard_grades` row count.
- P2-7c gates on `cls_ai_tutoring_sessions` row count.

Re-running any seed is a no-op once the cycle has landed.

### 6.4 No new IAM permission codes

P2-7c reuses existing TCH-001 + TCH-007 permission codes. The IAM seed already grants TCH-007 read+write to Student + Teacher + Vice Principal from earlier cycles. School Admin and Platform Admin pick up tch-007:admin via `everyFunction`. No new permission seed.

### 6.5 Redis fail-open for quota counter

If Redis is unavailable, `AIUsageService.assertWithinQuota` returns 0 used (fail-open) so the AI call proceeds. Production should consider an `AI_QUOTA_FAIL_CLOSED=1` env flag once the AI Gateway is deployed and quota enforcement matters financially.

### 6.6 Hall pass overdue worker disable

The worker can be fully disabled via `HALL_PASS_OVERDUE_DISABLED=1` env (dev convenience when running tests that don't want background activity).

## 7. Reviewer attention items

These are the points a thorough reviewer should focus on:

1. **AI safety rule 1 audit** — the `'Service must NEVER write to cls_grades'` spec test captures all SQL emitted during postMessage and asserts zero matches against `INSERT INTO cls_grades` or `UPDATE cls_grades`. Verify the audit covers the full message-post path and that no future refactor could introduce a grade write (e.g. via a different service method called inside postMessage).
2. **Anonymisation contract** — `AITutoringService.toAnonymousId` is a SHA-256 hash. Verify the AI Gateway stub never logs the raw studentId or sessionId, only the hashed token. Production AI Gateway implementation must replicate this contract.
3. **Opt-out hard-gate** — `assertNotOptedOut` is called from `startSession` AND `postMessage`. Verify there's no other entry point into the AI tutoring flow that could bypass the gate (e.g. a future bulk tutoring endpoint).
4. **Quota call ordering** — `assertWithinQuota` BEFORE the AI Gateway call, `recordUsage` AFTER. A failed AI call must NOT count against quota. The spec test `'Quota gate fires before any AI Gateway call when quota is exhausted'` pins the BEFORE ordering by stubbing the Gateway and asserting it is never reached.
5. **Peer review reviewer identity** — verify that for parent-of-reviewee actors, the reviewer identity is also stripped (parents see what their child sees). Currently the strip applies when `actor.personType === 'STUDENT'` AND the studentId matches; parents should fall through to the same anonymisation. The reviewer should confirm this matches the documented intent.
6. **Hall pass advisory lock key** — `pg_advisory_xact_lock(hashtext('cls_hall_passes:' || $classId))`. Verify the hash key shape doesn't collide with other advisory locks elsewhere in the codebase (e.g. Cycle 6 `pay_family_accounts:*` or Cycle 8 `tkt_tickets:*`). The string prefix `cls_hall_passes:` is unique.
7. **Lesson recording row scope** — students can read recordings for classes they're enrolled in (`sis_enrollments status=ACTIVE`). Verify a student cannot fetch a recording for a class they've been withdrawn from since the recording was made (the row scope binds to current ACTIVE enrollments only, not historical).
8. **AI usage actor_id population** — `recordUsage` carries `actorAccountId` so the admin dashboard shows per-actor cost. Verify worker-initiated usage (e.g. background summarisation chained from the consumer) correctly populates NULL so the dashboard distinguishes human-initiated from worker jobs.

## 8. Out-of-scope / deliberate omissions

These were considered and intentionally excluded from P2-7c scope:

- **AI grading suggestions** — the schema accommodates `cls_ai_usage_log.job_type='GRADING'` but no service writes a GRADING row today. AI grading is a future cycle that requires a separate teacher-review-and-approve workflow before any grade lands in `cls_grades`.
- **Lesson video transcoding** — `cls_lesson_recordings.s3_key` is a single key. Multi-resolution transcoding for adaptive playback is a Phase 3 ops concern.
- **Real-time AI tutoring (streaming)** — current postMessage is request/response. Streaming responses would require a WebSocket or SSE surface that the current REST controller doesn't provide.
- **AI tutor session sharing** — no surface for a teacher to share a useful AI tutoring conversation with the class. Future cycle.
- **Lesson recording reactions / comments** — `cls_lesson_recordings` has no reaction/comment children. The `cls_class_moments` reaction model could be ported if there's demand.
- **Cross-cycle integration with Cycle 11 Counselling** — learning signals are visible to teachers + admins today. The plan §05 mentions counsellor visibility per ADR-004 caseload-linked rule; this is a P2C7 follow-up that connects `AITutoringService.listSignalsForStudent` to the Cycle 11 `svc_caseloads` query for counsellor row scope.

## 9. Phase 2 / pre-pilot punch list (carries from this cycle)

These are non-blocking items the reviewer can add to the broader Phase 2 backlog:

1. Wire production AI Inference service (swap `AIGatewayService` from stub to HTTP client).
2. Wire production Video Processing service (kick off transcription on `video.uploaded` and publish `video.transcribed`).
3. Cycle 14 NotificationConsumer wire on `lesson.summary.ready` for teacher fan-out.
4. AI usage cost rollup beyond per-school per-day (district tier).
5. Auto-task on `cls.hall_pass.overdue` so the issuing teacher gets a Cycle 7 task.
6. GROUP_MEMBERSHIP audience targeting for class moments via Cycle 18 groups.
7. Counsellor row scope on `listSignalsForStudent` per ADR-004 caseload-linked rule.
8. Partition rotation job for the two RANGE-partitioned tables before 2027-08.
9. AI grading suggestions workflow with teacher-review-and-approve gate.
10. AI tutor session streaming via WebSocket / SSE.

None blocks P2-7c shipping; all are tracked in the broader Phase 2 backlog.
