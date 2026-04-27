# Cycle 3 Handoff — Communications

**Status:** Cycle 3 IN PROGRESS — Step 0 (ADR-057 envelope) DONE; Steps 1–11 not started. (Cycles 0, 1, and 2 are COMPLETE; see `HANDOFF-CYCLE1.md` and `HANDOFF-CYCLE2.md` for the SIS + Attendance + Classroom foundation this cycle builds on.)
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle3-implementation-plan.html`
**Vertical-slice deliverable:** Teacher marks Maya tardy in Period 1 → Kafka event fires → notification consumer picks it up → in-app notification appears on David Chen's parent dashboard with a badge count → David clicks the notification → he sees the attendance detail. Separately: James Rivera sends David a direct message about Maya's progress → David sees it in his inbox → David replies → the reply goes through content moderation → James sees the reply in his inbox.

This document tracks the Cycle 3 build — the M40 Communications module — at the same level of detail as `HANDOFF-CYCLE1.md` and `HANDOFF-CYCLE2.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                         | Status                                                                                                                        |
| ---: | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
|    0 | ADR-057 Event Envelope (carry-over from Cycle 2)              | Done — canonical envelope in `KafkaProducerService`; env-prefixed topics; all Cycle 1+2 producers migrated; gradebook worker reads envelope with header fallback |
|    1 | Communications Schema — Messaging                             | Not started                                                                                                                   |
|    2 | Communications Schema — Notifications & Announcements         | Not started                                                                                                                   |
|    3 | Communications Schema — Moderation & Support                  | Not started                                                                                                                   |
|    4 | Seed Data — Messaging & Notifications                         | Not started                                                                                                                   |
|    5 | Notification Pipeline — Consumers & Queue                     | Not started                                                                                                                   |
|    6 | Messaging NestJS Module                                       | Not started                                                                                                                   |
|    7 | Announcements NestJS Module                                   | Not started                                                                                                                   |
|    8 | Notification Bell & Inbox UI                                  | Not started                                                                                                                   |
|    9 | Messaging UI                                                  | Not started                                                                                                                   |
|   10 | Announcements UI                                              | Not started                                                                                                                   |
|   11 | Vertical Slice Integration Test                               | Not started                                                                                                                   |

The Cycle 3 exit deliverable is the end-to-end vertical slice: tardy mark → Kafka event → notification consumer → parent in-app notification → click-through to attendance detail. Plus direct messaging with content moderation, and audience-targeted announcements with read tracking. The reproducible CAT script will land at `docs/cycle3-cat-script.md` as the Step 11 deliverable.

---

## What this cycle adds on top of Cycle 2

Cycle 2 delivered the M21 Classroom module and the first Kafka **consumer** in the system (GradebookSnapshotWorker). Cycle 3 adds the M40 Communications module — direct messaging, announcements, and a notification pipeline that closes the loop on every Kafka event from Cycles 1 and 2. After Cycle 3, CampusOS stops being a system you check and becomes a system that tells you.

**Key dependencies inherited from Cycles 1 and 2:**

- **Kafka producer + consumer infrastructure** (`KafkaProducerService`, `KafkaConsumerService`, `IdempotencyService`) — already proven by GradebookSnapshotWorker; Cycle 3 adds 5+ more consumers under the same pattern.
- **Row-level authorization pattern** from REVIEW-CYCLE1 — every Communications service uses `ActorContextService.resolveActor(...)` and applies the per-personType visibility predicate. Re-used verbatim for thread participation, announcement audiences, and notification-recipient resolution.
- **Tenant isolation discipline** — `executeInTenantContext` and `executeInTenantTransaction` both run inside `$transaction` with `SET LOCAL search_path` (REVIEW-CYCLE1 fix). Every messaging / notification service uses these helpers; the new consumers reuse the `runWithTenantContextAsync` + header-extracted `TenantInfo` pattern from GradebookSnapshotWorker.
- **`platform_event_consumer_idempotency`** — the same claim-after-success discipline (REVIEW-CYCLE2 BLOCKING 2) carries forward to every new consumer.
- **`sis_student_guardians`** — primary lookup table for "who should be notified" on attendance / grade events. Cycle 1's row-level pattern (parent → linked children) is the blueprint for fan-out filtering.

**Phase 1 closes here.** After Cycle 3, CampusOS handles three complete school workflows end-to-end: attendance, grading, and communication. The platform enters Phase 2 (Test & Refine) — persona walkthroughs, UI design review, edge case testing, and creation of the UI design guide (`docs/ui-design-guide.md`) before expanding with Cycles 4–8.

---

## Step 0 — ADR-057 Event Envelope (Carry-Over from Cycle 2)

**Why this is Step 0.** The Cycle 2 architecture review (REVIEW-CYCLE2-CHATGPT) flagged the envelope as a major DEVIATION but accepted deferral because Cycle 2 had only one consumer reading three known transport headers (`event-id`, `tenant-id`, `tenant-subdomain`). Cycle 3 introduces 5+ new consumers from multiple producers — defining a single canonical envelope before adding consumers prevents drift.

### Envelope schema

Every Kafka message body is now a JSON object with the following fields. Producers wrap their domain payload; consumers read `event_id` + `tenant_id` + payload directly out of the envelope. The previous bare-payload contract is replaced.

| Field            | Type                          | Source                                                                                              |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `event_id`       | UUIDv7 string                 | Generated by `KafkaProducerService.emit()` per call.                                                |
| `event_type`     | string                        | Mirrors the un-prefixed topic (e.g. `att.student.marked_tardy`). Stable across env prefixing.       |
| `event_version`  | integer (starts at `1`)       | Bumped by the producer when the inner payload shape breaks compatibility.                           |
| `occurred_at`    | ISO-8601 timestamp            | Producer-supplied if the domain event has its own timestamp; defaults to "now" when omitted.        |
| `published_at`   | ISO-8601 timestamp            | Always set by the producer at emit time (post-tx).                                                  |
| `tenant_id`      | UUID string (school id)       | From `getCurrentTenant().schoolId` (or producer-supplied for worker-originated events).             |
| `source_module`  | string                        | Domain identifier (`attendance`, `classroom`, `communications`, …). Set per emit by the caller.     |
| `correlation_id` | UUIDv7 string                 | Propagated from request context if available; otherwise a fresh UUIDv7 (self-correlated emit).      |
| `payload`        | object (domain-specific JSON) | The previous bare payload — moved verbatim into this field so consumer code only needs to deref.    |

The producer also continues to set the three transport headers used by GradebookSnapshotWorker today (`event-id`, `tenant-id`, `tenant-subdomain`) so messages produced after Step 0 stay backward-compatible with any consumer that still reads headers. Step 0 migrates the only existing consumer (GradebookSnapshotWorker) to prefer envelope fields with a header fallback; once Cycles 3+ ship, the headers can be retired.

### Topic naming

Topics now follow `{env}.{domain}.{entity}.{verb}`. The env prefix is set via the `KAFKA_TOPIC_ENV` environment variable (default: `dev`). Producers and consumers use a shared helper (`prefixedTopic(name)`) so a misconfigured env doesn't quietly cross-pollinate environments.

| Layer        | Logical topic             | Wire topic (dev)              |
| ------------ | ------------------------- | ----------------------------- |
| `attendance` | `att.attendance.marked`   | `dev.att.attendance.marked`   |
| `attendance` | `att.attendance.confirmed`| `dev.att.attendance.confirmed`|
| `attendance` | `att.student.marked_tardy`| `dev.att.student.marked_tardy`|
| `attendance` | `att.student.marked_absent`| `dev.att.student.marked_absent`|
| `attendance` | `att.absence.requested`   | `dev.att.absence.requested`   |
| `attendance` | `att.absence.reviewed`    | `dev.att.absence.reviewed`    |
| `classroom`  | `cls.submission.submitted`| `dev.cls.submission.submitted`|
| `classroom`  | `cls.grade.published`     | `dev.cls.grade.published`     |
| `classroom`  | `cls.grade.unpublished`   | `dev.cls.grade.unpublished`   |
| `classroom`  | `cls.progress_note.published` | `dev.cls.progress_note.published` |

The `event_type` field inside the envelope stays unprefixed (`att.student.marked_tardy`) so consumer routing logic doesn't have to know the env. The wire topic carries the prefix only for broker-level isolation between environments sharing a Kafka cluster.

### Files

- `apps/api/src/kafka/event-envelope.ts` (new) — `EventEnvelope` interface, `EnvelopeOptions`, the `envelopeFromOptions(...)` builder, and the `prefixedTopic(name)` helper. Single import surface for both producer and consumer code.
- `apps/api/src/kafka/kafka-producer.service.ts` — `emit()` signature now takes `EmitOptions` (`topic`, `key`, `payload`, `sourceModule`, optional `eventVersion`, optional `occurredAt`, optional `tenantId`/`tenantSubdomain` for worker-originated emits, optional `correlationId`). Wraps payload in the envelope, applies the env prefix, sets the three legacy transport headers + a new `event-type` header, sends.
- `apps/api/src/classroom/grade.service.ts` — `emitPublished` / `emitUnpublished` now build `EmitOptions` with `sourceModule: 'classroom'`. The `tenantHeaders()` helper is removed (the envelope builder owns event-id + tenant fields now).
- `apps/api/src/classroom/submission.service.ts` — `cls.submission.submitted` migrated.
- `apps/api/src/classroom/progress-note.service.ts` — `cls.progress_note.published` migrated.
- `apps/api/src/attendance/attendance.service.ts` — all five emit sites migrated (`att.attendance.marked`, `att.attendance.confirmed`, `att.student.marked_tardy`, `att.student.marked_absent`).
- `apps/api/src/attendance/absence-request.service.ts` — `att.absence.requested`, `att.absence.reviewed` migrated.
- `apps/api/src/classroom/gradebook-snapshot-worker.service.ts` — subscribes to `prefixedTopic('cls.grade.published')` / `…unpublished`. `handle()` now reads `eventId` / `tenantId` / `subdomain` from `msg.payload` (envelope fields) when present; falls back to `msg.headers['event-id'] / 'tenant-id' / 'tenant-subdomain'` for any legacy in-flight messages. Validates the inner `payload` field shape.

### Architecture (envelope flow)

```
                  ┌─────────────────────────────────────────────┐
   Service code → │  KafkaProducerService.emit(EmitOptions)     │
                  │   1. envelopeFromOptions(opts)              │
                  │   2. body = JSON.stringify(envelope)        │
                  │   3. headers = { event-id, event-type,      │
                  │      tenant-id, tenant-subdomain }          │
                  │   4. producer.send(prefixedTopic(...))      │
                  └────────────────────────────┬────────────────┘
                                               │
                                               ▼ Kafka topic (env-prefixed)
                  ┌────────────────────────────────────────────┐
                  │  Consumer (e.g. GradebookSnapshotWorker)   │
                  │   1. Parse JSON → envelope                 │
                  │   2. Read envelope.event_id, .tenant_id,   │
                  │      .tenant_subdomain (or fall back to    │
                  │      transport headers)                    │
                  │   3. Process envelope.payload              │
                  └────────────────────────────────────────────┘
```

### Compatibility rules

- **`event_version` = 1** for every emit landing in Step 0. Future breaking payload changes bump this and add a consumer-side branch.
- **Transport headers stay in place** (`event-id`, `tenant-id`, `tenant-subdomain`). They're additionally set on every message in case a consumer prefers headers for low-cost dedup before parsing the body. Consumers added in Cycle 3 (Steps 5/7) read from the envelope by default.
- **`event_type` is intentionally redundant with the topic.** Consumers that subscribe to multiple topics (e.g. `AbsenceRequestNotificationConsumer` listens to both `att.absence.requested` and `att.absence.reviewed`) can branch on `envelope.event_type` instead of `msg.topic`, keeping handlers env-agnostic.
- **Worker-originated events** (e.g. an audience fan-out worker republishing internal events) supply `tenantId` + `tenantSubdomain` + `correlationId` directly in `EmitOptions`; they don't get them from `getCurrentTenant()` because workers run outside any HTTP request.
- **Producer-side `occurred_at`** defaults to "now" when omitted. Domain events with an authoritative timestamp (e.g. `att.attendance.marked.markedAt`) should be passed explicitly so downstream timelines reflect the correct order even under producer backpressure.

### Authorisation / tenant isolation

The envelope adds no new auth surface — `tenant_id` is **set** by the producer from the resolved tenant context, and consumers reconstruct a `TenantInfo` from `tenant_id` + `tenant_subdomain` exactly the way GradebookSnapshotWorker has done since Cycle 2 Step 6. `runWithTenantContextAsync` + `executeInTenantContext`'s `SET LOCAL search_path` discipline is unchanged.

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/api build      # nest build → exits 0
pnpm --filter @campusos/api start:prod # KafkaProducerService connects with topic-env=dev
                                       # GradebookSnapshotWorker subscribes to dev.cls.grade.{published,unpublished}
```

A live emit/consume smoke run was reproduced against the demo tenant by republishing Maya's P1 Algebra Linear Equations Quiz grade:

| #   | Scenario                                                                                | Expected                                                            | Got |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --- |
| 1   | Teacher unpublishes Maya's homework grade                                               | envelope on the wire with `event_type='cls.grade.unpublished'`      | ✅  |
| 2   | Worker logs show `Snapshot recomputed` ~30s later, single recompute                     | one log line, debounce respected                                    | ✅  |
| 3   | Worker reads tenant from envelope (tenant-id + tenant-subdomain), not transport headers | confirmed by adding a debug log on the envelope-vs-header branch    | ✅  |
| 4   | `platform_event_consumer_idempotency` row recorded post-flush                           | one row, group=`gradebook-snapshot-worker`, topic=`cls.grade.unpublished` | ✅  |
| 5   | Republish — second envelope, second recompute, snapshot back to seed values             | snapshot avg=90.50 graded=2/2                                       | ✅  |
| 6   | `att.attendance.marked` smoke: teacher marks Maya tardy → Kafka log shows envelope      | event_id present, payload nested under `payload`                    | ✅  |

Idempotency rows were cleared after the smoke run so the next reviewer starts from a clean slate.

### Out-of-scope decisions for Step 0

- **No schema registry yet.** Envelopes are validated structurally on the consumer side (presence of `event_id`, `tenant_id`, `payload`) — no Avro / JSON Schema registry. With ~10 emit sites and a single repo this is fine; Phase 2+ may revisit if cross-team producers emerge.
- **`event_version` is producer-asserted, not enforced.** Consumers should branch on it if they need to. Until any consumer cares, this is a forward-compat slot only.
- **Topic env prefix is per-environment, not per-tenant.** Multi-tenant routing happens via the `tenant_id` field inside the envelope; Kafka topic namespacing is for environment isolation only (dev / staging / prod).
- **Payload remains an `unknown` JSON object on the consumer side.** Each consumer narrows the shape itself (matching the GradebookSnapshotWorker pattern). No global TypeScript discriminated union of all event payloads — that would couple every consumer to every producer's payload definition.
- **Headers are not retired in Step 0.** Cycle 3 Step 5 (notification consumers) will read entirely from the envelope; once all in-flight workers have rolled, a follow-up step in Phase 2 can remove the legacy transport headers from the producer.
- **No correlation-id middleware.** Step 0 generates a fresh UUIDv7 per emit when no request-context correlation id exists. Wiring an `X-Correlation-Id` HTTP middleware that flows into the AsyncLocalStorage is a small follow-up but not blocking — every event is still individually traceable via `event_id`.

---

## Step 1 — Communications Schema — Messaging

Not started. The plan calls for `msg_thread_types`, `msg_threads` (HASH-partitioned 64 buckets per ADR-047), `msg_thread_participants`, `msg_messages` (RANGE monthly via pg_partman, 24-month retention), `msg_message_attachments`, `msg_message_reads`. Migration target: `007_msg_messaging.sql`.

---

## Step 2 — Communications Schema — Notifications & Announcements

Not started. Plan: `msg_notification_queue`, `msg_notification_preferences`, `msg_notification_log` (RANGE monthly), `msg_announcements`, `msg_announcement_audiences`, `msg_announcement_reads`, `msg_alert_types`. Migration target: `008_msg_notifications_and_announcements.sql`.

---

## Step 3 — Communications Schema — Moderation & Support

Not started. Plan: `msg_moderation_policies`, `msg_moderation_log` (RANGE monthly), `msg_tags`, `msg_user_tags`, `msg_user_blocks`, `msg_admin_access_log`, plus two **platform-schema** additions via Prisma migration: `platform_push_tokens`, `platform_dlq_messages`. Migration targets: `009_msg_moderation.sql` (tenant) + a new Prisma migration for platform additions.

---

## Step 4 — Seed Data — Messaging & Notifications

Not started. Plan: thread types, sample threads (Rivera ↔ Chen, P1 class discussion, admin), notification preferences, moderation policies (PLATFORM + BUILDING), sample announcements, three pre-seeded notification queue rows. Plus permission updates: COM-001 read/write to Teacher/Parent/Student; COM-002 read to all + write to Teacher/Admin; COM-003 read/write to Admin. Rebuild effective access cache.

---

## Step 5 — Notification Pipeline — Consumers & Queue

Not started. Plan:

- 5 Kafka consumers — AttendanceNotificationConsumer (`att.student.marked_tardy`, `att.student.marked_absent`), GradeNotificationConsumer (`cls.grade.published`), ProgressNoteNotificationConsumer (`cls.progress_note.published`), AbsenceRequestNotificationConsumer (`att.absence.requested`, `att.absence.reviewed`), MessageNotificationConsumer (`msg.message.posted`).
- `NotificationQueueService` — preference + quiet-hours check, Redis SET NX idempotency.
- `NotificationDeliveryWorker` — polls `msg_notification_queue`, in-app delivery via Redis sorted set, email/push stubbed, log to `msg_notification_log`.

Each consumer follows the GradebookSnapshotWorker pattern: read envelope → read-only `isClaimed()` check → process → claim-after-success.

---

## Step 6 — Messaging NestJS Module

Not started. Plan: `ThreadService`, `MessageService`, `UnreadCountService` (Redis-backed), `ContentModerationInterceptor` (PLATFORM → DISTRICT → BUILDING, most restrictive wins). ~8 endpoints under `com-001:read` / `com-001:write`. Block-list enforcement.

---

## Step 7 — Announcements NestJS Module

Not started. Plan: `AnnouncementService`, `AudienceFanOutWorker` (consumes `msg.announcement.published`, resolves audience by `audience_type`, populates `msg_announcement_audiences`, enqueues notifications). ~6 endpoints under `com-002:read` / `com-002:write`.

---

## Step 8 — Notification Bell & Inbox UI

Not started. Plan: `NotificationBell` (top-bar with badge, polls `/notifications/unread-count` every 30s), `NotificationDropdown` (last 10), `/notifications` page (full history, filter, mark all read), deep-links into source pages (attendance / grades / messages).

---

## Step 9 — Messaging UI

Not started. Plan: `/messages` inbox, `/messages/:threadId` thread view, `/messages/new` compose with role-aware recipient picker, moderation feedback ("This message was not sent because it contains content that violates school policy" — no keyword detail).

---

## Step 10 — Announcements UI

Not started. Plan: `/announcements` feed (audience-filtered), `/announcements/new` create form (admin/teacher only) with audience selector + schedule + expiry, per-announcement stats (admin only).

---

## Step 11 — Vertical Slice Integration Test

Not started. Plan: `docs/cycle3-cat-script.md` — 7 scenarios covering tardy → notification, grade → notification, direct message, moderation block, announcements, preference honouring, permission denials. Phase 1 exit criteria.

---

## Quick reference — running the stack from a fresh clone

(unchanged from Cycle 2; copy of the Cycle 2 quick-reference is still authoritative)

```bash
pnpm install
docker compose up -d
pnpm --filter @campusos/database migrate
pnpm --filter @campusos/database seed
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database seed:classroom
pnpm --filter @campusos/database exec tsx src/build-cache.ts
pnpm --filter @campusos/api dev
```

After Step 4 lands a dedicated `seed:messaging` script, this list grows by one entry. Until then the Cycle 2 seed pipeline is unchanged.

---

## Open items / known gaps (will be filled in as steps land)

- **ADR-057 envelope on every emit.** Done in Step 0. The transport headers (`event-id`, `tenant-id`, `tenant-subdomain`) are still set on every message for backward compatibility with any consumer that hasn't migrated; once Cycle 3 ships, a Phase 2 follow-up can retire them.
- **Communications tenant migrations (Steps 1–3).** ~21 of M40's 29 tables. 8 deferred: emergency alerts (requires dedicated always-on service), digest batching, translation, retention/archival jobs.
- **Platform schema additions.** `platform_push_tokens` + `platform_dlq_messages` will land via a Prisma migration in Step 3. First platform additions since Cycle 0; the Prisma schema gets a small bump.
- **Email / push provider integration is stubbed.** The queue + log + delivery worker are built; Sendgrid / Twilio / FCM wire-up is Phase 3 (post Test & Refine).
- **Emergency alerts service.** Per the Architecture Review, requires a dedicated always-on service. Out of scope for Cycle 3; only `msg_alert_types` ships for schema completeness.
- **Communication groups with dynamic membership.** Deferred — out of scope this cycle.
- **Translation requests (AI pipeline).** Deferred.

---

## Cycle 3 exit criteria (from the plan)

1. ADR-057 event envelope implemented. All producers migrated. Gradebook worker updated.
2. Tenant schema: ~21 new Communications tables. Platform schema: +2 (push_tokens, dlq_messages).
3. 5 Kafka consumers: attendance, grade, progress note, absence request, message notifications.
4. NotificationQueueService with preference checking, quiet hours, Redis idempotency.
5. Messaging: threads, messages, read tracking, Redis unread counters, content moderation interceptor.
6. Announcements: create, publish, audience fan-out, read tracking, stats.
7. Notification bell with badge count, dropdown, deep links to source.
8. Messaging UI: inbox, thread view, compose, moderation feedback.
9. Announcement UI: feed, create, stats.
10. Vertical slice test: all 7 scenarios pass.
11. HANDOFF-CYCLE3.md and CLAUDE.md updated. CI green.

---

## Post-cycle architecture review

Pending. Will land at `REVIEW-CYCLE3-CHATGPT.md` after Step 11.
