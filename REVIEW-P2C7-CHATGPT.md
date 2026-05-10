# REVIEW-P2C7-CHATGPT — Phase 2 Cycle 7 Classroom Advanced

**Round 1 verdict: FAIL.** Reviewed against `aad2f2a`. 4 BLOCKING + 4 MAJOR.
**Round 1 fix commit:** `<this commit>`. All 4 BLOCKING + 3 actionable MAJORs landed with 10 new pinned regression tests.
**Awaiting Round 2 verdict before tagging `p2c7-complete`.**

## Round 1 triage

| #   | Severity | Reviewer finding                                                                                                                  | Triage   | Fix                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | BLOCKING | `listSignalsForStudent` allows any STAFF actor with `tch-007:read` to fetch sensitive AI inferences for any student in the tenant | VALID    | Service-layer actor scope: school admin school-wide; teacher only when student enrolled in their active class; counsellor only when student on active caseload; other staff 403; STUDENT 403. Plus school-scoped predicates on student-existence pre-check + signals query.                                                                                                                                  |
| 2   | BLOCKING | `extractSignals` checks STAFF/admin only, does not call `assertCanReadSession` before consuming AI quota                          | VALID    | Added `await this.assertCanReadSession(session, actor)` before quota check + AI Gateway call. Extended `assertCanReadSession` itself with counsellor caseload-linked path.                                                                                                                                                                                                                                   |
| 3   | BLOCKING | `startSession` validates student existence with id-only query then INSERTs; orphaned sessions for unauthorised teachers           | VALID    | New `assertCanCreateSessionForStudent` runs BEFORE INSERT — admin always; teacher requires assigned class via sis_class_teachers + sis_enrollments status=ACTIVE (and enrolled in supplied classId); counsellor requires active caseload; other staff 403. School-scoped predicates added on sis_students + sis_classes validation queries.                                                                  |
| 4   | BLOCKING | `video.uploaded` and `lesson.summary.ready` are best-effort emits after commit — Kafka outage drops the event silently            | VALID    | Swapped KafkaProducerService for OutboxService. `create()` enqueues video.uploaded INSIDE the same tenant tx as the recording INSERT. `applySummary()` enqueues lesson.summary.ready INSIDE the same tenant tx as the summary INSERT + status flip. New `deterministicVideoUploadedEventId` + `deterministicLessonSummaryReadyEventId` helpers (sha1(<id>:<topic>:v1) → v5-shape) so retries dedupe cleanly. |
| 5   | BLOCKING | Opt-out delete reuses `assertCanOptOut`, allowing students to opt themselves back in (under-13 COPPA risk)                        | VALID    | New `assertCanRevokeOptOut` for delete authority — STUDENT actors 403 with canonical message; linked guardian + school admin allowed. Create-side helper unchanged.                                                                                                                                                                                                                                          |
| 6   | MAJOR    | AI quota fail-open when Redis is down — runaway cost risk in production                                                           | VALID    | Added `AI_QUOTA_FAIL_CLOSED=1` env support. When set + Redis disconnected, `assertWithinQuota` throws 403 with canonical message. Default behaviour stays fail-OPEN for dev.                                                                                                                                                                                                                                 |
| 7   | MAJOR    | Recording reads use id-only WHERE clauses, rely on service-level filter                                                           | VALID    | Both `getById` and `listForLesson` now include `r.school_id = $tenant.schoolId` predicate. Defence-in-depth alongside `assertCanRead`.                                                                                                                                                                                                                                                                       |
| 8   | MAJOR    | `VideoTranscriptConsumer.markFailed` on transient errors — converts retryable into permanent FAILED                               | VALID    | Only call `markFailed` for permanent error classes (NotFoundException — invalid recordingId from upstream). Transient errors rethrow without marking FAILED so Kafka redelivery retries cleanly.                                                                                                                                                                                                             |
| 9   | MAJOR    | CAT live-output capture pattern for sensitive cycles                                                                              | DEFERRED | Recommendation-class polish per the broader Phase 2 backlog from REVIEW-CYCLE15. Carries to pre-pilot.                                                                                                                                                                                                                                                                                                       |

## Per-fix verification trail

### BLOCKING 1 — listSignalsForStudent row scope

**File:** `apps/api/src/classroom-advanced/ai-tutoring.service.ts::listSignalsForStudent`

**Before:** STAFF actor with `tch-007:read` could fetch signals for any student.

**After:**

- STUDENT → 403 (existing, moved to top of method).
- Non-staff non-admin → 403.
- Student validated against `sis_students WHERE id = $1::uuid AND school_id = $2::uuid`.
- For non-admin staff: requires either `sis_class_teachers + sis_enrollments status=ACTIVE` row OR `svc_caseloads counselor_id=actor + status=ACTIVE` row.
- Underlying signals query carries `s.school_id = $tenant.schoolId` predicate.

**Tests pinned (in `REVIEW-P2C7 BLOCKING regressions` describe block):**

- `'BLOCKING 1: STAFF actor with no teaching/caseload relationship → 403'` — verifies both teaching probe AND caseload probe ran, then ForbiddenException raised.
- `'BLOCKING 1: school admin sees signals for any student (school-scoped)'` — captures the SQL and asserts it contains `s.school_id` predicate.
- `'BLOCKING 1: STUDENT actor → 403 even on own student id'`.

### BLOCKING 2 — extractSignals row scope

**File:** `apps/api/src/classroom-advanced/ai-tutoring.service.ts::extractSignals`

**Before:** Only `STAFF + admin` permission check. Any teacher with the session UUID could trigger AI extraction and consume quota.

**After:**

- Existing STAFF/admin check.
- New `await this.assertCanReadSession(session, actor)` immediately after `loadSessionRowOrThrow` and BEFORE quota assertion / AI Gateway call.
- `assertCanReadSession` extended to include the counsellor caseload-linked path (was teacher-only).

**Tests pinned:**

- `'BLOCKING 2: extractSignals refuses STAFF actor not assigned to the student'` — stubs the gateway with a `gatewayCalled = true` flag and asserts the gateway is NEVER reached when the row scope check fails.

### BLOCKING 3 — startSession authorisation

**File:** `apps/api/src/classroom-advanced/ai-tutoring.service.ts::startSession + assertCanCreateSessionForStudent`

**Before:** `resolveStudentForActor` validated student existence with id-only query. `startSession` then INSERTed before the post-create `getSession(...)` ran row scope. Orphan sessions could land for unauthorised teachers.

**After:**

- `resolveStudentForActor` student-exists query carries `school_id = $tenant.schoolId`.
- `startSession` classId-exists query carries `school_id = $tenant.schoolId`.
- New `assertCanCreateSessionForStudent` runs BEFORE the INSERT — admin always; teacher requires `sis_class_teachers + sis_enrollments status=ACTIVE` (and when classId supplied additionally requires the (student, class) enrolment AND teacher-class assignment); counsellor requires `svc_caseloads status=ACTIVE`; other staff 403.

**Tests pinned:**

- `'BLOCKING 3: unauthorised teacher session creation does NOT INSERT'` — stubs the SQL handler with an `inserted = true` flag and asserts no INSERT executes when the auth gate fires.
- `'BLOCKING 3: school admin can create a session for any student in the school'` — admin path completes the INSERT.

### BLOCKING 4 — Durable outbox

**Files:** `apps/api/src/classroom-advanced/lesson-recording.service.ts` (constructor + `create` + `applySummary`); `apps/api/src/classroom-advanced/classroom-advanced.module.ts` (no change — KafkaModule already exports OutboxService).

**Before:** `create()` committed the recording row then `void this.kafka.emit(...)`. `applySummary()` committed summary + status flip then `void this.kafka.emit(...)`.

**After:**

- Constructor swaps `KafkaProducerService` for `OutboxService`.
- `create()` runs INSIDE one `executeInTenantTransaction` — INSERT cls_lesson_recordings then `outbox.enqueueInTx(tx, {topic: 'video.uploaded', eventId: deterministicVideoUploadedEventId(id), ...})`.
- `applySummary()` extends the existing `executeInTenantTransaction` — reads lesson_id + class_id + recorded_by under the FOR UPDATE lock, INSERTs cls_lesson_summaries, flips status to COMPLETE, then `outbox.enqueueInTx(tx, {topic: 'lesson.summary.ready', eventId: deterministicLessonSummaryReadyEventId(recordingId), ...})`.
- New helpers `deterministicVideoUploadedEventId` + `deterministicLessonSummaryReadyEventId` produce v5-shaped UUIDs via `sha1(<recordingId>:<topic>:v1)`. Same pattern as P2-4a payroll, P2-6 credit-note, P2-6 reversal helpers.
- Removed unused `loadRowOrThrow` helper.

**Tests pinned:**

- `'create enqueues video.uploaded INSIDE the same tx (durable outbox)'` — captures outbox.enqueueInTx, asserts topic + sourceModule + v5-shape eventId regex + payload shape.
- `'applySummary enqueues lesson.summary.ready INSIDE the same tx (durable outbox)'` — same shape assertions.
- `'REVIEW-P2C7 BLOCKING 4 — deterministic event id is stable across re-runs'` — same recordingId produces same id; different recordingId produces different id; two topics produce distinct ids; v5-shape pattern verified.

### BLOCKING 5 — Split opt-out create vs delete

**File:** `apps/api/src/classroom-advanced/ai-opt-out.service.ts`

**Before:** `delete()` called `assertCanOptOut(...)` which allowed STUDENT self-action whenever the actor's personId matched the student.

**After:**

- New `assertCanRevokeOptOut(studentId, actor)` — admin always; GUARDIAN linked via `sis_student_guardians + sis_guardians`; STUDENT 403 with canonical message ("Students cannot opt themselves back into AI tutoring once opted out. Contact a parent or school admin."); other actors 403.
- `delete()` now calls `assertCanRevokeOptOut`, not `assertCanOptOut`.
- `assertCanOptOut` (create-side) unchanged — still allows student-self opt-OUT subject to controller-level age policy.
- `assertCanReadOptOut` continues to delegate to the create-side helper for the read path (parent/student-self can confirm their own opt-out status).

**Tests pinned:**

- `'BLOCKING 5: STUDENT cannot delete own opt-out — guardian/admin only'` — captures `delete from cls_ai_tutoring_opt_outs` SQL and asserts no DELETE executes when student attempts.
- `'BLOCKING 5: linked guardian CAN delete own child opt-out (opt back in)'` — DELETE executes.
- `'BLOCKING 5: school admin CAN delete any opt-out (emergency revocation)'` — DELETE executes.

### MAJOR 6 — AI quota fail-closed env

**File:** `apps/api/src/classroom-advanced/ai-usage.service.ts::assertWithinQuota`

When `process.env.AI_QUOTA_FAIL_CLOSED === '1'` AND `redis.isConnected() === false`, throw 403 with the canonical message before reading the counter. Default unchanged (fail-OPEN — appropriate for dev where Gateway is stubbed).

### MAJOR 7 — School-scoped recording reads

**File:** `apps/api/src/classroom-advanced/lesson-recording.service.ts::getById + listForLesson`

Both methods now read `getCurrentTenant()` and add `r.school_id = $2::uuid` to the WHERE clause. The service-layer `assertCanRead` row scope stays as defence-in-depth.

### MAJOR 8 — Consumer markFailed only on permanent errors

**File:** `apps/api/src/classroom-advanced/video-transcript.consumer.ts::process`

Catch block now checks `if (e instanceof NotFoundException)` before calling `markFailed`. Transient errors (DB blip, AI Gateway timeout, etc.) rethrow without marking FAILED — Kafka redelivery via the consumer's claim-after-success retries cleanly.

## CI parity verification

- `pnpm format:check` — All files use Prettier code style.
- `pnpm lint:logs` — 662 files clean.
- `pnpm --filter @campusos/api build` — clean.
- `pnpm --filter @campusos/web build` — clean.
- `pnpm vitest run` (apps/api) — **387 passing across 22 spec files** (+10 new from REVIEW-P2C7 BLOCKING regressions describe block).

## Awaiting Round 2 verdict

P2-7c is feature-complete with all 4 BLOCKING + 3 actionable MAJORs from Round 1 fixed and pinned by regression tests. MAJOR 5 (CAT live-output capture pattern) carries to the broader Phase 2 polish punch list per the reviewer's gate decision. Awaiting Round 2 review verdict before tagging `p2c7-complete` / `p2c7-approved`.
