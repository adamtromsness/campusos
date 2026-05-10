# REVIEW-P2C7-CHATGPT — Phase 2 Cycle 7 Classroom Advanced

**Round 1 verdict: FAIL.** Reviewed against `aad2f2a`. 4 BLOCKING + 4 MAJOR.
**Round 1 fix commit:** `0c97fc6`. All 4 BLOCKING + 3 actionable MAJORs landed with 10 new pinned regression tests.

**Round 2 verdict: FAIL.** Reviewed against `0c97fc6`. 1 residual BLOCKING (multi-school isolation — base AI tutoring session loader was ID-only, school admins bypassed `assertCanReadSession`).
**Round 2 fix commit:** `8cc15fd`. School-scoped `loadSessionRowOrThrow` + 6 supporting query tightenings + 7 new pinned regression tests + 4 live cross-school 404 verifications on `tenant_demo`.

**Round 3 verdict: FAIL.** Reviewed against `8cc15fd`. 1 residual BLOCKING (`listSessions()` had no base school predicate for school admins — School A admin could enumerate School B sessions). Plus 3 CI lint failures (TS6133 unused locals).
**Round 3 fix commit:** `<this commit>`. School-scoped `listSessions` for ALL actors + 3 CI lint cleanups + 4 new pinned regression tests + live cross-school list smoke on `tenant_demo` (4 total sessions, 2 foreign-school → principal sees 2, foreign count 0).

**Awaiting Round 4 verdict before tagging `p2c7-complete`.**

## Round 3 fix — listSessions school-scope + CI cleanup

### Reviewer finding

`listSessions(actor)` built the WHERE clause only for non-admin actors. School admins ran the base query with NO `school_id` predicate, so a School A admin in a multi-school tenant pool could list School B AI tutoring sessions (subject, status, message counts, learning-signals-extracted flag). Same school-boundary issue as Round 2, just on the collection endpoint instead of direct UUID endpoints. Plus 3 CI failures from the original P2-7 commits — TS6133 unused locals (`principalEmpId`, `schoolId`, `class1Id`) flagged by `noUnusedLocals: true`.

### Fix shape

**BLOCKING — `listSessions` school-scope.** `s.school_id = $1::uuid` is now the BASE predicate for EVERY actor including school admin. Actor-specific predicates AND on top:

```ts
const tenant = getCurrentTenant();
const params: unknown[] = [tenant.schoolId];
let where = ' WHERE s.school_id = $1::uuid';
let i = 2;
if (!actor.isSchoolAdmin) {
  if (actor.personType === 'STUDENT') where += ' AND s.student_id = (...)';
  else if (actor.personType === 'STAFF' && actor.employeeId) where += ' AND s.student_id IN (...)';
  else return [];
}
```

**CI lint cleanup.** Three unused locals from the original P2-7 commits removed (deletion was cleaner than `_` prefix because `noUnusedLocals` doesn't honour the prefix for locals):

- `seed-classroom-advanced.ts` — `principalEmpId` removed (resolved but never used after the post-bridge cleanup).
- `seed-classroom-advanced-b.ts` — `schoolId` removed (replaced by inline `school.id` in the JOIN-based gate).
- `seed-classroom-advanced-b.ts` — `class1Id` removed (forward-compat capture; the load-bearing class lookup is `mayaClass` below).

### Live verification on tenant_demo (2026-05-10)

Planted 2 foreign-school session rows in `tenant_demo.cls_ai_tutoring_sessions` with `school_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid`. Tenant-side: 4 total sessions, 2 belonging to the foreign school, 2 belonging to `tenant_demo`. Principal (school admin for `tenant_demo`) called `GET /classroom/ai-tutoring/sessions`:

```
S1: principal lists sessions
  total returned: 2
    - Photosynthesis review schoolId= 019e0cf8-bbb8-7556-8c81-f07b3369e584
    - Algebra — Quadratic Equations schoolId= 019e0cf8-bbb8-7556-8c81-f07b3369e584
  FOREIGN sessions in result: 0 (MUST be 0)
```

The `s.school_id` BASE predicate is the actual access boundary. Cleanup dropped the planted rows.

### Test coverage delta

Vitest 394 → **398 passing across 22 spec files** (+4 new in a dedicated `describe('REVIEW-P2C7 ROUND 3 — listSessions school-scope')` block):

- `school admin list query carries s.school_id predicate as base` — captures SQL + asserts `where s.school_id` present + `tenant.schoolId` bound as 1st arg.
- `teacher list query carries s.school_id predicate before AND clause` — verifies `where s.school_id` then `and s.student_id in` + arg order (school 1st, employeeId 2nd).
- `student list query carries s.school_id predicate before AND clause` — same shape with `and s.student_id =` for the student branch.
- `parent (no allowed branch) returns empty list — no query fired` — flag-based check that the early `return []` short-circuits before any DB query.

### CI parity

- `pnpm format:check` — clean.
- `pnpm lint:logs` — 662 files clean.
- `pnpm --filter @campusos/database exec tsc --noEmit` — clean (3 TS6133 errors fixed).
- `pnpm --filter @campusos/api build` — clean.
- `pnpm --filter @campusos/web build` — clean.
- `pnpm vitest run` (apps/api) — **398 passing across 22 spec files**.

## Round 2 fix — multi-school session isolation

### Reviewer finding

The reviewer confirmed all 4 Round 1 BLOCKING fixes plus the 3 MAJORs landed correctly, but flagged one residual issue: `AITutoringService.loadSessionRowOrThrow` was still loading sessions with `WHERE s.id = $1::uuid` (no school predicate). Combined with `assertCanReadSession` short-circuiting on `actor.isSchoolAdmin` BEFORE checking the loaded session belonged to the calling tenant, a School A admin who knew or guessed a School B session UUID could read / complete / extract signals / list signals on it. The same vulnerability extended through `getSession`, `getSessionWithMessages`, `completeSession`'s lock query, `postMessage`, `extractSignals`, and `listSignals` — all of which funnel through the loader.

### Fix shape

Tightened every direct-object reference query in `AITutoringService` to include `school_id = $tenant.schoolId` so the access boundary lives at the query layer, not at a downstream filter:

| Method                                                           | Change                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `loadSessionRowOrThrow`                                          | Added `s.school_id = $2::uuid` predicate. Cross-school UUIDs → 404 don't-leak-existence. **Keystone fix.**                            |
| `loadMessageOrThrow`                                             | JOIN to `cls_ai_tutoring_sessions s` + `s.school_id = $2::uuid` predicate. Foreign-school message UUIDs → 404.                        |
| `completeSession` lock query (`FOR UPDATE`)                      | Added `school_id = $2::uuid` predicate. Cross-school session UUIDs cannot be transitioned.                                            |
| `completeSession` final UPDATE                                   | Added `school_id = $2::uuid` to WHERE clause.                                                                                         |
| `postMessage` history fetch                                      | JOIN with `s.school_id = $2::uuid` predicate. AI Gateway prompt cannot include foreign-school messages.                               |
| `postMessage` total_messages bump UPDATE                         | Added `school_id = $2::uuid` to WHERE clause.                                                                                         |
| `getSessionWithMessages` messages fetch                          | JOIN with `s.school_id = $2::uuid` predicate.                                                                                         |
| `extractSignals` transcript fetch                                | JOIN with `s.school_id = $2::uuid` predicate.                                                                                         |
| `extractSignals` two `learning_signals_extracted = true` UPDATEs | Both add `school_id = $2::uuid` to WHERE clause.                                                                                      |
| `listSignals(sessionId)`                                         | JOIN with `s.school_id = $2::uuid` predicate (defence-in-depth — loader already 404s but JOIN locks the contract at the query layer). |

### Live verification on tenant_demo (2026-05-10)

Planted a foreign-school session row in `tenant_demo.cls_ai_tutoring_sessions` with `school_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid`. Verified principal (school admin for `tenant_demo`) hits 404 on every cross-school path:

```
S3: GET   /classroom/ai-tutoring/sessions/<foreign>             → HTTP 404 "Session ... not found"
S4: PATCH /classroom/ai-tutoring/sessions/<foreign>/complete    → HTTP 404
S5: POST  /classroom/ai-tutoring/sessions/<foreign>/extract-signals → HTTP 404
S6: GET   /classroom/ai-tutoring/sessions/<foreign>/signals     → HTTP 404
```

Same principal against the legitimate seeded session returns 200 with 8 messages + 3 signals. Cleanup dropped the planted row.

### Test coverage delta

Vitest 387 → **394 passing across 22 spec files** (+7 new in a dedicated `describe('REVIEW-P2C7 ROUND 2 — cross-school session isolation')` block):

- `loadSessionRowOrThrow runs school-scoped predicate` — captures SQL + asserts `s.school_id` predicate present + `tenant.schoolId` bound as 2nd arg.
- `cross-school admin gets 404 on session GET` — every query returns empty → NotFoundException.
- `cross-school admin completeSession lock query carries school predicate` — captures FOR UPDATE SQL + asserts `school_id` predicate present.
- `cross-school admin extractSignals → 404 (loader school-scoped)` — stubs gateway with `gatewayCalled` flag and asserts gateway NEVER reached.
- `cross-school admin listSignals → 404 + JOIN carries school predicate` — confirms loader rejects before the signals query fires.
- `same-school admin gets messages JOIN with school predicate` — captures messages SQL + asserts JOIN + school_id + tenant arg binding.
- `loadMessageOrThrow JOINs sessions with school_id predicate` — direct private-helper assertion via type-cast; foreign-school message UUID → 404 with JOIN + predicate verified.

### CI parity

- `pnpm format:check` — All files use Prettier code style.
- `pnpm lint:logs` — 662 files clean.
- `pnpm --filter @campusos/api build` — clean.
- `pnpm --filter @campusos/web build` — clean.
- `pnpm vitest run` (apps/api) — **394 passing across 22 spec files**.

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
