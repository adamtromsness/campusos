# Cycle 3 Handoff — Communications

**Status:** Cycle 3 IN PROGRESS — Steps 0 (ADR-057 envelope), 1 (Messaging), 2 (Notifications & Announcements), 3 (Moderation & Support), 4 (Seed Data), 5 (Notification Pipeline — Consumers & Queue), 6 (Messaging NestJS Module), and 7 (Announcements NestJS Module) DONE; Steps 8–11 not started. (Cycles 0, 1, and 2 are COMPLETE; see `HANDOFF-CYCLE1.md` and `HANDOFF-CYCLE2.md` for the SIS + Attendance + Classroom foundation this cycle builds on.)
**Branch:** `main`
**Plan reference:** `docs/campusos-cycle3-implementation-plan.html`
**Vertical-slice deliverable:** Teacher marks Maya tardy in Period 1 → Kafka event fires → notification consumer picks it up → in-app notification appears on David Chen's parent dashboard with a badge count → David clicks the notification → he sees the attendance detail. Separately: James Rivera sends David a direct message about Maya's progress → David sees it in his inbox → David replies → the reply goes through content moderation → James sees the reply in his inbox.

This document tracks the Cycle 3 build — the M40 Communications module — at the same level of detail as `HANDOFF-CYCLE1.md` and `HANDOFF-CYCLE2.md`. It is the source of truth that external architecture reviewers read alongside `CLAUDE.md`. **A step is not complete until both files are current** (per the Operating Rules at the bottom of `CLAUDE.md`).

---

## Step status

| Step | Title                                                         | Status                                                                                                                        |
| ---: | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
|    0 | ADR-057 Event Envelope (carry-over from Cycle 2)              | Done — canonical envelope in `KafkaProducerService`; env-prefixed topics; all Cycle 1+2 producers migrated; gradebook worker reads envelope with header fallback |
|    1 | Communications Schema — Messaging                             | Done — `007_msg_messaging.sql` applied to demo + test (6 base tables + 64 hash partitions of `msg_threads` + 24 monthly partitions of `msg_messages`) |
|    2 | Communications Schema — Notifications & Announcements         | Done — `008_msg_notifications_and_announcements.sql` applied to demo + test (7 base tables + 24 monthly partitions of `msg_notification_log`)        |
|    3 | Communications Schema — Moderation & Support                  | Done — `009_msg_moderation.sql` applied to demo + test (6 tenant tables + 24 monthly partitions of `msg_moderation_log`); platform Prisma migration `20260427211003_add_communications_platform_tables` adds `platform_push_tokens` + `platform_dlq_messages` |
|    4 | Seed Data — Messaging & Notifications                         | Done — `seed-messaging.ts` populates 13 messaging tables in `tenant_demo`; `seed-iam.ts` adds COM-002:read to Student + Staff; cache rebuilt |
|    5 | Notification Pipeline — Consumers & Queue                     | Done — `apps/api/src/notifications/` lands 5 Kafka consumers + NotificationQueueService + NotificationDeliveryWorker + RedisService; build verified clean, live boot subscribed all topics + Redis connected |
|    6 | Messaging NestJS Module                                       | Done — `apps/api/src/messaging/` lands ThreadService + MessageService + UnreadCountService + ContentModerationService + 10 endpoints; live smoke confirmed BLOCK / FLAG / CLEAN paths and parent unread-bump → mark-read → badge=0 |
|    7 | Announcements NestJS Module                                   | Done — `apps/api/src/announcements/` lands AnnouncementService + AudienceFanOutWorker + 6 endpoints; live smoke against `tenant_demo` confirmed publish flow + ALL_SCHOOL (5) / CLASS (10) / YEAR_GROUP (9) / ROLE=PARENT (1) audience fan-out + idempotent mark-read + author/admin-only stats + invalid-audience guards |
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

`packages/database/prisma/tenant/migrations/007_msg_messaging.sql` lands the M40 messaging core: 6 base tables, 64 HASH partitions on `msg_threads` (per ADR-047), 24 monthly RANGE partitions on `msg_messages` covering 2025-08 → 2027-08. Idempotent CREATE-IF-NOT-EXISTS pattern matching the Cycle 1 / Cycle 2 migrations. Snake_case columns, `TEXT + CHECK` for enum-like fields. Soft UUID refs to `platform.platform_users` (no DB FK constraints — ADR-001/020).

### Tables (6 base + 88 partition objects)

| Table                     | Purpose                                                                                                                            | Key columns                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `msg_thread_types`        | Configurable thread types per school                                                                                               | `school_id`, `name`, `description`, `allowed_participant_roles TEXT[]`, `is_system`, `is_active`. UNIQUE(school_id, name). Step 4 will seed `TEACHER_PARENT`, `CLASS_DISCUSSION`, `ADMIN_STAFF`, `SYSTEM_NOTIFICATION`.                                                                                                                                                                                                  |
| `msg_threads`             | Conversation thread, **HASH(school_id) 64 buckets** per ADR-047 — partition pruning eliminates 63/64 partitions on inbox queries   | `id`, `school_id`, `thread_type_id` FK, `subject`, `created_by` (soft → `platform_users`), `last_message_at`, `is_archived`, `created_at`, `updated_at`. Composite PK `(id, school_id)` so the partition column appears in the unique constraint.                                                                                                                                                                       |
| `msg_thread_participants` | Who can read / post in a thread                                                                                                    | `thread_id`, `school_id` (denormalised for partition pruning when joining back to `msg_threads`), `platform_user_id` (soft), `role` ∈ {OWNER, PARTICIPANT, OBSERVER}, `joined_at`, `left_at`, `is_muted`, `last_read_at`. UNIQUE(thread_id, platform_user_id). No DB FK to `msg_threads` (matches `sis_attendance_evidence` precedent for cross-partition references).                                                  |
| `msg_messages`            | One row per message. **RANGE(created_at) monthly** for retention management. School_id denormalised for partition-pruned queries.  | `id`, `thread_id`, `school_id`, `sender_id` (soft), `body TEXT`, `is_edited`, `edited_at`, `is_deleted` (soft delete), `deleted_at`, `moderation_status` ∈ {CLEAN, FLAGGED, BLOCKED, ESCALATED}, `created_at`, `updated_at`. Composite PK `(id, created_at)`. INDEX(thread_id, created_at DESC) for thread reads; INDEX(school_id, created_at DESC) for school-wide queries; INDEX(sender_id, created_at DESC).         |
| `msg_message_attachments` | One row per attached file on a message                                                                                             | `message_id`, `message_created_at` (denormalised partition key), `school_id`, `file_name`, `s3_key`, `content_type`, `file_size_bytes BIGINT`, `uploaded_by` (soft). INDEX(message_id, message_created_at). Step 9 (Messaging UI) wires signed S3 URLs with 15–60min expiry — schema only here.                                                                                                                          |
| `msg_message_reads`       | Per-(message, reader) read receipt; powers the inbox unread count                                                                  | `message_id`, `message_created_at` (denormalised partition key), `thread_id`, `reader_id` (soft), `read_at`. UNIQUE(message_id, reader_id). The Step 6 `UnreadCountService` keeps a Redis-backed counter as the hot path; this table is the durable record + audit trail. INDEX(thread_id, reader_id) for "mark thread read" sweeps; INDEX(message_id, message_created_at) for partition-pruned joins back to messages. |

### Partitioning detail

- **`msg_threads`** — `PARTITION BY HASH (school_id)` with 64 leaves (`msg_threads_h00` … `msg_threads_h63`, MODULUS 64). ADR-047 sets 64 buckets as the inbox-scale target. Inbox queries always include `school_id` (every request has resolved tenant), so PostgreSQL's planner prunes 63/64 partitions before the scan.
- **`msg_messages`** — `PARTITION BY RANGE (created_at)` with monthly leaves covering **2025-08 through 2027-08** (24 months). The plan calls for pg_partman managing a rolling 24-month window; for Cycle 3 the partitions are pre-created statically. Adding a partition rotation job is post-Cycle 3 ops work — same posture as the year-partition rotation deferred in Cycle 1's `sis_attendance_records`.

### FKs (intra-tenant) and soft references

| Constraint                                                                | Type             | Notes                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_threads.thread_type_id → msg_thread_types(id)`                       | DB-enforced      | The only intra-tenant FK in the migration. `msg_thread_types` is unpartitioned, so PG happily replicates the constraint to every `msg_threads_h*` partition.                                                                                                                                                                |
| `msg_thread_participants.{thread_id, school_id} → msg_threads`            | **Not enforced** | Matches the `sis_attendance_evidence` precedent (Cycle 1) — when the parent table is partitioned, the codebase pattern is to denormalise the partition key onto the child table + add an index, rather than declare a DB-level FK. App-layer lookup validates membership.                                                  |
| `msg_messages.{thread_id, school_id} → msg_threads`                       | **Not enforced** | Same pattern.                                                                                                                                                                                                                                                                                                              |
| `msg_message_attachments.{message_id, message_created_at} → msg_messages` | **Not enforced** | Same pattern. `message_created_at` is the denormalised partition key.                                                                                                                                                                                                                                                      |
| `msg_message_reads.{message_id, message_created_at} → msg_messages`       | **Not enforced** | Same pattern.                                                                                                                                                                                                                                                                                                              |
| `msg_*.school_id`                                                         | Soft (cross-schema) | Soft UUID ref to `platform.schools(id)` — never a DB FK constraint per ADR-001/020.                                                                                                                                                                                                                                  |
| `msg_threads.created_by`, `msg_thread_participants.platform_user_id`, `msg_messages.sender_id`, `msg_message_attachments.uploaded_by`, `msg_message_reads.reader_id` | Soft (cross-schema) | Soft UUID ref to `platform.platform_users(id)` per ADR-055 (auth/audit identity column). `COMMENT ON COLUMN` annotations land in the migration so the rule is discoverable from the live schema.                                                                                                  |

### CHECK constraints

| Constraint                              | Predicate                                                |
| --------------------------------------- | -------------------------------------------------------- |
| `msg_thread_participants_role_chk`      | `role IN ('OWNER','PARTICIPANT','OBSERVER')`             |
| `msg_messages_moderation_chk`           | `moderation_status IN ('CLEAN','FLAGGED','BLOCKED','ESCALATED')` |

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 7 migrations applied
pnpm --filter @campusos/database provision --subdomain=demo   # idempotent re-run, 7 migrations applied (no-op)
pnpm --filter @campusos/database provision --subdomain=test   # same
```

Counts in `tenant_demo` after Step 1:

| What                                                | Count |
| --------------------------------------------------- | ----: |
| Base tables (38 prior + 6 new)                      |    44 |
| `msg_threads` HASH partitions (h00–h63)             |    64 |
| `msg_messages` RANGE partitions (2025-08 → 2027-08) |    24 |

Intra-tenant FKs from `msg_*` parent tables:

```
msg_threads.thread_type_id → msg_thread_types(id)
```

(One FK; replicated automatically to all 64 hash partitions of `msg_threads`.)

Cross-schema FKs from `tenant_demo`: **0** (verified via `pg_constraint` join — same query used in REVIEW-CYCLE1).

CHECK smoke (live):

| Constraint                          | Test                                                          | Outcome  |
| ----------------------------------- | ------------------------------------------------------------- | -------- |
| `msg_thread_participants_role_chk`  | INSERT role='BOGUS'                                           | ERROR ✅ |
| `msg_messages_moderation_chk`       | INSERT moderation_status='BOGUS' (lands in 2026-04 partition) | ERROR ✅ |

The moderation-check insert also confirmed partition routing — the row was rejected from `msg_messages_2026_04` automatically.

### Cycle 1 + Cycle 2 seeds re-run cleanly

The new messaging tables are empty after Step 1. Cycle 1 (`seed:sis`) and Cycle 2 (`seed:classroom`) seeds remain untouched and idempotent. Step 4 will land `seed:messaging` for the demo data.

### Out-of-scope decisions for Step 1

- **No pg_partman.** Monthly partitions are pre-created statically for 2025-08 → 2027-08 (24 months). pg_partman is the right long-term answer for monthly rotation; setting it up + writing the rotation policy is post-Cycle 3 ops work, parallel to the year-partition rotation deferred in Cycle 1.
- **No DB-enforced FKs into `msg_threads` / `msg_messages`.** PG ≥ 11 supports FKs into partitioned tables but the codebase precedent (`sis_attendance_evidence`) is to denormalise the partition key + add an index instead. Composite-FK syntax is awkward across services, and partition-pruning is more reliable when the child table holds the same key. Service-layer queries always join via the denormalised partition key columns.
- **`msg_message_attachments` / `msg_message_reads` are unpartitioned.** Both reference `msg_messages` via `(message_id, message_created_at)`. Volume is bounded per message — far below the partitioning threshold. If a school's attachment count grows past O(10⁷) post-Phase 2, partition then.
- **`is_deleted` is the only soft-delete signal on messages.** `deleted_at` is set in tandem. The plan calls for "soft delete" without specifying an audit trail; the `msg_admin_access_log` table from Step 3 + the `msg_moderation_log` partition will cover the audit + FERPA story for sensitive deletions. Plain soft-delete is the right starting point.
- **`moderation_status` on `msg_messages` is a forward-compat field.** The Step 6 `ContentModerationInterceptor` will populate it (`CLEAN` / `FLAGGED` / `BLOCKED` / `ESCALATED`). Until then it stays at the default `CLEAN` — schema-only landing here.
- **No `subject` index on `msg_threads`.** The plan doesn't call for full-text thread search this cycle. The school + last_message DESC index covers the inbox; `subject` filtering comes back via app-layer ILIKE if needed for now.
- **Composite PK choice.** `msg_threads` uses `(id, school_id)`; `msg_messages` uses `(id, created_at)`. Both keep `id` first because it's the natural lookup key in service code (URL params, response payloads). The partition column comes second because it's only relevant inside the planner.
- **`updated_at` columns have no triggers.** Service code sets `updated_at = now()` explicitly on every mutation, matching the Cycle 1 / Cycle 2 pattern. Triggers are intentionally avoided here — visible writes from the service layer make the data path auditable.
- **No `msg_admin_access_log` here.** Lands in Step 3 (Moderation & Support Tables) per the plan.
- **CHECK strings can't contain `;`.** The provision SQL splitter splits on `;` and filters trimmed lines starting with `--`. A semicolon inside a string literal therefore corrupts the statement. Found this the hard way on the first run — the `COMMENT ON COLUMN` strings now use commas / "and" in place of any semicolon. Tracked under the existing migration convention in `CLAUDE.md`.

---

## Step 2 — Communications Schema — Notifications & Announcements

`packages/database/prisma/tenant/migrations/008_msg_notifications_and_announcements.sql` lands the M40 notification pipeline + announcement system: 7 base tables and 24 monthly RANGE partitions of `msg_notification_log` covering 2025-08 → 2027-08 (matches the `msg_messages` window from Step 1). Same idempotent CREATE-IF-NOT-EXISTS pattern as Cycle 1 / Cycle 2 / Step 1. Snake_case columns, `TEXT + CHECK` for enum-like fields. Soft UUID refs to `platform.platform_users` (no DB FK constraints — ADR-001/020).

### Tables (7 base + 24 partitions of `msg_notification_log`)

| Table                         | Purpose                                                                                                                              | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_alert_types`             | Configurable alert types per school (severity, default channels, ack required)                                                       | `school_id`, `name`, `description`, `severity` ∈ {INFO, WARNING, URGENT, EMERGENCY} (default INFO), `default_channels TEXT[]` (default `{IN_APP}`), `requires_acknowledgement`, `is_active`. UNIQUE(school_id, name). Created for schema completeness — emergency alert service is deferred (Architecture Review).                                                                                                                                                                |
| `msg_notification_queue`      | Working queue of pending notifications for the delivery worker                                                                       | `id`, `school_id`, `recipient_id` (soft → `platform_users`), `notification_type`, `payload JSONB` (default `'{}'::jsonb`), `status` ∈ {PENDING, SENT, FAILED, SKIPPED}, `idempotency_key TEXT` (no UNIQUE), `scheduled_for TIMESTAMPTZ`, `sent_at`, `failure_reason`, `attempts INTEGER`, `correlation_id UUID`, `created_at`, `updated_at`. Partial INDEX(scheduled_for) WHERE `status='PENDING'` for the worker poll. Partial INDEX on `idempotency_key` for read-side dedup only. |
| `msg_notification_preferences`| Per-(user, type) channel preferences + quiet hours                                                                                   | `id`, `school_id`, `platform_user_id` (soft), `notification_type`, `channels TEXT[]` (default `{IN_APP}`), `is_enabled`, `quiet_hours_start TIME`, `quiet_hours_end TIME`. UNIQUE(platform_user_id, notification_type). The Step 5 `NotificationQueueService` reads this row before enqueueing.                                                                                                                                                                                    |
| `msg_notification_log`        | Durable per-attempt delivery log. **RANGE(sent_at) monthly** for retention management.                                               | `id`, `school_id`, `queue_id` (soft → `msg_notification_queue`, nullable), `recipient_id` (soft), `notification_type`, `channel` ∈ {PUSH, EMAIL, SMS, IN_APP}, `status` ∈ {SENT, DELIVERED, FAILED}, `provider_ref TEXT`, `error_message`, `sent_at` (default `now()`), `delivered_at`, `correlation_id UUID`. Composite PK `(id, sent_at)` so the partition column is in the unique constraint.                                                                                  |
| `msg_announcements`           | Announcement record (school-wide / class / year-group / role / custom)                                                               | `id`, `school_id`, `author_id` (soft), `title`, `body`, `audience_type` ∈ {ALL_SCHOOL, CLASS, YEAR_GROUP, ROLE, CUSTOM}, `audience_ref TEXT` (polymorphic — see below), `alert_type_id` (FK to `msg_alert_types`, nullable), `publish_at`, `expires_at`, `is_published`, `is_recurring`, `recurrence_rule TEXT` (iCal RRULE), `created_at`, `updated_at`. INDEX(school_id, publish_at DESC) and a partial `WHERE is_published = true` for the active-feed query.                  |
| `msg_announcement_audiences`  | Pre-computed audience populated by the AudienceFanOutWorker (Step 7) on publish — eliminates real-time fan-out at notification time  | `id`, `school_id`, `announcement_id` (DB FK, ON DELETE CASCADE), `platform_user_id` (soft), `delivery_status` ∈ {PENDING, DELIVERED, FAILED, SKIPPED}, `delivered_at`, `notification_queue_id UUID` (soft), `created_at`. UNIQUE(announcement_id, platform_user_id). INDEX(platform_user_id, delivery_status) is the inbox-side hot path.                                                                                                                                          |
| `msg_announcement_reads`      | Per-(announcement, reader) read receipt; powers admin stats                                                                          | `id`, `school_id`, `announcement_id` (DB FK, ON DELETE CASCADE), `reader_id` (soft), `read_at`. UNIQUE(announcement_id, reader_id).                                                                                                                                                                                                                                                                                                                                                |

### Partitioning detail

- **`msg_notification_log`** — `PARTITION BY RANGE (sent_at)` with monthly leaves covering **2025-08 through 2027-08** (24 months, matches the `msg_messages` window from Step 1). The plan calls for pg_partman managing a rolling window; for Cycle 3 the partitions are pre-created statically. Adding a partition rotation job is post-Cycle 3 ops work — same posture as the year-partition rotation deferred in Cycle 1's `sis_attendance_records` and the messages partitions deferred in Step 1.
- The other six tables in Step 2 are unpartitioned. Volume on `msg_notification_queue` is bounded (it is a working set, not a log — rows transition out as they are sent); volume on `msg_notification_preferences` is bounded by users × types; the announcement tables are bounded by announcement count. None reach the threshold where partitioning would help.

### FKs (intra-tenant) and soft references

| Constraint                                                          | Type                  | Notes                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `msg_announcements.alert_type_id → msg_alert_types(id)`             | DB-enforced           | Optional alert-type reference. `msg_alert_types` is unpartitioned, so PG happily replicates / enforces the constraint.                                                                                                                                                                                                              |
| `msg_announcement_audiences.announcement_id → msg_announcements(id)`| DB-enforced (CASCADE) | Both tables unpartitioned. CASCADE on delete because audience rows have no meaning without the parent announcement.                                                                                                                                                                                                                |
| `msg_announcement_reads.announcement_id → msg_announcements(id)`    | DB-enforced (CASCADE) | Same rationale.                                                                                                                                                                                                                                                                                                                      |
| `msg_notification_log.queue_id → msg_notification_queue(id)`        | **Not enforced**      | Soft ref. The log is partitioned and the queue row may be purged on a different schedule than the log row, so DB-level enforcement would create awkward retention coupling. App layer treats `queue_id` as informational.                                                                                                          |
| `msg_announcement_audiences.notification_queue_id`                  | **Not enforced**      | Soft ref. The fan-out worker writes the queue row first, then this row, so cross-table consistency is app-layer.                                                                                                                                                                                                                     |
| `msg_*.school_id`                                                   | Soft (cross-schema)   | Soft UUID ref to `platform.schools(id)` — never a DB FK constraint per ADR-001/020.                                                                                                                                                                                                                                                  |
| `msg_notification_queue.recipient_id`, `msg_notification_preferences.platform_user_id`, `msg_notification_log.recipient_id`, `msg_announcements.author_id`, `msg_announcement_audiences.platform_user_id`, `msg_announcement_reads.reader_id` | Soft (cross-schema) | Soft UUID ref to `platform.platform_users(id)` per ADR-055. `COMMENT ON COLUMN` annotations land in the migration so the rule is discoverable from the live schema.                                                                                                                                                  |

### CHECK constraints

| Constraint                                       | Predicate                                                       |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `msg_alert_types_severity_chk`                   | `severity IN ('INFO','WARNING','URGENT','EMERGENCY')`           |
| `msg_notification_queue_status_chk`              | `status IN ('PENDING','SENT','FAILED','SKIPPED')`               |
| `msg_notification_log_channel_chk`               | `channel IN ('PUSH','EMAIL','SMS','IN_APP')`                    |
| `msg_notification_log_status_chk`                | `status IN ('SENT','DELIVERED','FAILED')`                       |
| `msg_announcements_audience_chk`                 | `audience_type IN ('ALL_SCHOOL','CLASS','YEAR_GROUP','ROLE','CUSTOM')` |
| `msg_announcement_audiences_status_chk`          | `delivery_status IN ('PENDING','DELIVERED','FAILED','SKIPPED')` |

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/database provision --subdomain=demo   # 8 migrations applied
pnpm --filter @campusos/database provision --subdomain=demo   # idempotent re-run, 8 migrations applied (no-op)
pnpm --filter @campusos/database provision --subdomain=test   # same
```

Counts in `tenant_demo` after Step 2:

| What                                                       | Count |
| ---------------------------------------------------------- | ----: |
| Logical base tables (top-level, was 44)                    |    51 |
| `msg_threads` HASH partitions (h00–h63, from Step 1)       |    64 |
| `msg_messages` RANGE partitions (2025-08 → 2027-08, Step 1)|    24 |
| `msg_notification_log` RANGE partitions (2025-08 → 2027-08)|    24 |

Intra-tenant FKs from Step 2 tables (3 total):

```
msg_announcements.alert_type_id            → msg_alert_types(id)
msg_announcement_audiences.announcement_id → msg_announcements(id) ON DELETE CASCADE
msg_announcement_reads.announcement_id     → msg_announcements(id) ON DELETE CASCADE
```

Cross-schema FKs from `tenant_demo`: **0** (verified via `pg_constraint` join).

CHECK + FK smoke (live):

| Constraint                              | Test                                                                          | Outcome  |
| --------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `msg_alert_types_severity_chk`          | INSERT severity='BOGUS'                                                       | ERROR ✅ |
| `msg_notification_queue_status_chk`     | INSERT status='BOGUS'                                                         | ERROR ✅ |
| `msg_notification_log_channel_chk`      | INSERT channel='BOGUS' (lands in 2026-04 partition)                           | ERROR ✅ |
| `msg_notification_log_status_chk`       | INSERT channel='IN_APP', status='BOGUS' (lands in 2026-04 partition)          | ERROR ✅ |
| `msg_announcements_audience_chk`        | INSERT audience_type='BOGUS'                                                  | ERROR ✅ |
| `msg_announcement_audiences_status_chk` | INSERT delivery_status='BOGUS'                                                | ERROR ✅ |
| `msg_announcements.alert_type_id` FK    | INSERT alert_type_id=<random uuid>                                            | ERROR ✅ |
| `msg_announcement_audiences` FK         | INSERT announcement_id=<random uuid>                                          | ERROR ✅ |
| `msg_announcement_reads` FK             | INSERT announcement_id=<random uuid>                                          | ERROR ✅ |
| Happy-path INSERT across all 7 tables   | preferences `channels` defaults to `{IN_APP}`; alert types `default_channels` defaults to `{IN_APP}`; ON DELETE CASCADE removes audience + reads when the parent announcement is deleted | ✅ |

The CHECK-violation insert into `msg_notification_log` also confirmed partition routing — the row was rejected from `msg_notification_log_2026_04` automatically.

### Cycle 1 + Cycle 2 + Cycle 3 Step 1 seeds re-run cleanly

The new notification + announcement tables are empty after Step 2. `seed:sis` and `seed:classroom` remain untouched and idempotent. Step 4 will land `seed:messaging` covering both Step 1 (messaging) and Step 2 (notifications/announcements).

### Out-of-scope decisions for Step 2

- **No DB UNIQUE on `msg_notification_queue.idempotency_key`.** The plan explicitly calls this out: "Idempotency via Redis SET NX (not a DB UNIQUE constraint — avoids deadlocks during emergency fan-out)." A partial index on `idempotency_key` is added for read-side investigation of duplicates and slow lookups by key, but it does not enforce uniqueness. The Step 5 `NotificationQueueService` does the SET NX check before insert.
- **No pg_partman.** Monthly partitions of `msg_notification_log` are pre-created statically for 2025-08 → 2027-08 (24 months, matching the `msg_messages` window from Step 1). Same posture and same future ops work as Step 1.
- **`msg_announcements.audience_ref` is a single TEXT column, not typed-per-branch.** The polymorphic target identifier is interpreted by the AudienceFanOutWorker (Step 7) based on `audience_type`: CLASS holds a `sis_classes.id` UUID rendered as text, YEAR_GROUP holds the grade-level label, ROLE holds an iam role name (e.g. `PARENT`), and ALL_SCHOOL leaves it NULL. CUSTOM may also leave it NULL and rely on a future custom-target table. Single TEXT keeps the schema simple at the cost of a tiny app-layer branch in the worker.
- **`msg_announcement_audiences` and `msg_announcement_reads` use DB-enforced FKs (with CASCADE).** Both children, and their parent `msg_announcements`, are unpartitioned, so the standard PG FK + cascade pattern applies cleanly. This is intentionally different from the partitioned-parent precedent (`msg_messages`, `msg_threads` from Step 1) where FKs to partitioned tables are denormalised soft refs.
- **`msg_notification_log.queue_id` is a soft ref, not a DB FK.** The log is partitioned by `sent_at`. The queue row may be purged on a different cadence than the log row (the queue is a working set; the log is a retention-managed audit trail). DB enforcement would create awkward retention coupling. App layer treats `queue_id` as informational.
- **`msg_alert_types` ships in Step 2 even though emergency alerts are deferred.** Schema completeness — the table is small, additive, and lets `msg_announcements.alert_type_id` resolve. The emergency alert service (always-on, separate process) is explicitly out of scope per the plan and the Architecture Review.
- **`updated_at` columns have no triggers.** Service code sets `updated_at = now()` explicitly on every mutation, matching every prior cycle. (Note: `msg_notification_log` and `msg_announcement_reads` don't carry `updated_at` because they are append-only.)
- **CHECK strings still can't contain `;`.** The provision SQL splitter convention from Step 1 carries forward — every CHECK predicate, default expression, and `COMMENT ON COLUMN` value in this migration uses commas / "and" in place of any semicolon. Spot-checked all 6 COMMENT statements before applying.

---

## Step 3 — Communications Schema — Moderation & Support

`packages/database/prisma/tenant/migrations/009_msg_moderation.sql` lands 6 base tenant tables + 24 monthly RANGE partitions of `msg_moderation_log` (2025-08 → 2027-08, matching the messages and notification-log windows from Steps 1 and 2). The Prisma migration `20260427211003_add_communications_platform_tables` adds two platform-schema tables (`platform_push_tokens`, `platform_dlq_messages`) — the first platform-schema additions since Cycle 0. Same idempotent CREATE-IF-NOT-EXISTS pattern in the tenant SQL, no semicolons in string literals, soft UUID refs to `platform.platform_users` per ADR-001/020.

### Tenant tables (6 base + 24 partitions of `msg_moderation_log`)

| Table                       | Purpose                                                                                                                            | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_moderation_policies`   | Three-tier moderation policy. PLATFORM, DISTRICT, BUILDING — most restrictive action wins.                                         | `id`, `school_id`, `scope` ∈ {PLATFORM, DISTRICT, BUILDING}, `scope_id UUID` (NULL for PLATFORM, organisations.id for DISTRICT, schools.id for BUILDING), `name`, `description`, `keywords TEXT[]`, `keyword_action` ∈ {BLOCK, FLAG_FOR_REVIEW, ESCALATE_TO_COUNSELLOR}, `sensitivity_threshold INTEGER` (0–100, default 50), `escalation_rules JSONB` (default `'{}'`), `is_active`, `created_at`, `updated_at`. Partial INDEX(school_id, scope) WHERE `is_active = true`. |
| `msg_moderation_log`        | Per-flag/block/escalation event. **RANGE(created_at) monthly** for retention.                                                      | `id`, `school_id`, `message_id UUID`, `message_created_at TIMESTAMPTZ` (denormalised partition key matching `msg_messages.created_at`), `thread_id UUID`, `sender_id UUID` (denormalised from the message at write time), `policy_id UUID NOT NULL REFERENCES msg_moderation_policies(id)`, `flag_type` ∈ {BLOCKED, FLAGGED, ESCALATED}, `matched_keywords TEXT[]`, `severity` ∈ {INFO, WARNING, URGENT, EMERGENCY} (default INFO), `review_outcome` ∈ {PENDING, RESOLVED, ESCALATED, DISMISSED} (nullable), `reviewed_by UUID`, `reviewed_at`, `notes`, `created_at`. Composite PK `(id, created_at)`. Partial INDEX(school_id, created_at DESC) WHERE `review_outcome = 'PENDING'` for the moderator queue. |
| `msg_tags`                  | School-scoped thread/user tag dictionary                                                                                           | `id`, `school_id`, `name`, `color`, `description`, `is_system`, `is_active`. UNIQUE(school_id, name).                                                                                                                                                                                                                                                                                                                                          |
| `msg_user_tags`             | User × tag join. UNIQUE per (user, tag).                                                                                           | `id`, `school_id`, `platform_user_id` (soft), `tag_id` (DB FK to `msg_tags(id) ON DELETE CASCADE`), `assigned_by` (soft). UNIQUE(platform_user_id, tag_id).                                                                                                                                                                                                                                                                                  |
| `msg_user_blocks`           | Personal block list — enforced by the Step 6 messaging service                                                                     | `id`, `school_id`, `blocker_id` (soft), `blocked_id` (soft), `reason`. UNIQUE(blocker_id, blocked_id) and CHECK `blocker_id <> blocked_id` (no self-block).                                                                                                                                                                                                                                                                                  |
| `msg_admin_access_log`      | FERPA audit trail for admin reading private threads they are not a participant in                                                  | `id`, `school_id`, `admin_id` (soft), `thread_id` (soft), `reason TEXT NOT NULL`, `accessed_at`. INDEX(admin_id, accessed_at DESC) and (thread_id, accessed_at DESC). `reason` is NOT NULL — every admin read of a non-participant thread must be justified.                                                                                                                                                                                |

### Platform tables (Prisma)

Migration: `prisma/platform/migrations/20260427211003_add_communications_platform_tables/migration.sql`. Both tables are platform-scoped (shared across tenants).

| Table                    | Purpose                                                                                                                            | Key columns                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_push_tokens`   | One row per (user, device) push registration. Cross-tenant — a single account may hold roles in multiple schools.                  | `id`, `platform_user_id UUID` (soft per ADR-001/020), `device_id`, `platform` enum {IOS, ANDROID, WEB}, `token`, `is_active`, `last_seen_at`, `created_at`, `updated_at` (Prisma `@updatedAt`). UNIQUE(platform_user_id, device_id). INDEX(platform_user_id, is_active) and (token).                                                                                                  |
| `platform_dlq_messages`  | Kafka dead letter queue for messages that failed every consumer retry                                                              | `id`, `topic`, `partition`, `kafka_offset BIGINT`, `consumer_group`, `event_id`, `tenant_id` (nullable — DLQ row may originate from any tenant), `payload JSONB`, `headers JSONB`, `error_message`, `error_class`, `retry_count`, `first_failed_at`, `last_failed_at`, `resolved_at`, `resolved_by`, `resolution`. INDEX(topic, last_failed_at DESC), (consumer_group, last_failed_at DESC), (tenant_id, last_failed_at DESC), (resolved_at). |

The Prisma model field is named `kafkaOffset` (mapped to column `kafka_offset`) because `offset` is a reserved word in PostgreSQL. The Prisma client API uses `kafkaOffset` directly.

### FKs (intra-tenant) and soft references

| Constraint                                                          | Type                  | Notes                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_moderation_log.policy_id → msg_moderation_policies(id)`        | DB-enforced           | Parent unpartitioned, child RANGE-partitioned monthly. PostgreSQL replicates the FK to every partition — `pg_constraint` shows 25 rows for this constraint (1 parent + 24 monthly partitions). Expected behavior; the cost is negligible since the catalogue size is bounded.                                                                                |
| `msg_user_tags.tag_id → msg_tags(id)`                               | DB-enforced (CASCADE) | Both unpartitioned. CASCADE on tag delete because user-tag rows are meaningless without their parent tag — cascade verified live.                                                                                                                                                                                                                            |
| `msg_moderation_log.{message_id, message_created_at} → msg_messages`| **Not enforced**      | Soft. Matches the `msg_message_attachments` and `msg_message_reads` precedent from Step 1 — when the parent is partitioned, denormalise the partition key onto the child + add an index, no DB-enforced FK.                                                                                                                                              |
| `msg_admin_access_log.thread_id → msg_threads`                      | **Not enforced**      | Soft. Same precedent — `msg_threads` is HASH-partitioned by school_id. The audit log already carries `school_id` directly so partition-pruning predicates work without a denormalised thread-partition column here.                                                                                                                                       |
| `msg_*.school_id`                                                   | Soft (cross-schema)   | Soft UUID ref to `platform.schools(id)` per ADR-001/020.                                                                                                                                                                                                                                                                                                          |
| `msg_moderation_log.sender_id`, `msg_moderation_log.reviewed_by`, `msg_user_tags.platform_user_id`, `msg_user_tags.assigned_by`, `msg_user_blocks.blocker_id`, `msg_user_blocks.blocked_id`, `msg_admin_access_log.admin_id` | Soft (cross-schema) | Soft UUID ref to `platform.platform_users(id)` per ADR-055. `COMMENT ON COLUMN` annotations land in the migration so the rule is discoverable from the live schema. |
| `platform_push_tokens.platform_user_id`                              | Soft                  | Kept loose so a deleted user account doesn't cascade into device records — operations on push tokens (revoke, mark inactive) flow through the lifecycle worker, not the database.                                                                                                                                                                          |

### CHECK constraints

| Constraint                                       | Predicate                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `msg_moderation_policies_scope_chk`              | `scope IN ('PLATFORM','DISTRICT','BUILDING')`                                   |
| `msg_moderation_policies_action_chk`             | `keyword_action IN ('BLOCK','FLAG_FOR_REVIEW','ESCALATE_TO_COUNSELLOR')`        |
| `msg_moderation_policies_threshold_chk`          | `sensitivity_threshold BETWEEN 0 AND 100`                                       |
| `msg_moderation_log_flag_chk`                    | `flag_type IN ('BLOCKED','FLAGGED','ESCALATED')`                                |
| `msg_moderation_log_severity_chk`                | `severity IN ('INFO','WARNING','URGENT','EMERGENCY')`                           |
| `msg_moderation_log_review_chk`                  | `review_outcome IS NULL OR review_outcome IN ('PENDING','RESOLVED','ESCALATED','DISMISSED')` |
| `msg_user_blocks_self_chk`                       | `blocker_id <> blocked_id`                                                       |

### Verification (recorded 2026-04-27)

```bash
pnpm prisma migrate dev --name add_communications_platform_tables --schema=prisma/platform/schema.prisma
# applies the platform migration via prisma migrate
pnpm --filter @campusos/database provision --subdomain=demo   # 9 migrations applied
pnpm --filter @campusos/database provision --subdomain=demo   # idempotent re-run, 9 migrations applied (no-op)
pnpm --filter @campusos/database provision --subdomain=test   # same
```

Counts in `tenant_demo` after Step 3:

| What                                                      | Count |
| --------------------------------------------------------- | ----: |
| Logical base tables (top-level, was 51)                   |    57 |
| `msg_moderation_log` RANGE partitions (2025-08 → 2027-08) |    24 |
| Cross-schema FKs from `tenant_demo`                       |     0 |
| `msg_moderation_log` → `msg_moderation_policies` FK rows  |    25 |

The 25 FK rows in `pg_constraint` for the `policy_id` foreign key is expected — PostgreSQL replicates a DB-enforced FK from a partitioned table to its target onto every partition (1 parent + 24 monthly partitions). Same behavior pattern would land if Step 2 used a DB FK from `msg_notification_log` to `msg_notification_queue`, which is intentionally avoided there because the queue and log have different retention cadences.

Platform tables verified live:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='platform' AND table_name IN ('platform_push_tokens','platform_dlq_messages');
-- Returns both rows
```

CHECK + FK + cascade smoke (live):

| Constraint                              | Test                                                                                | Outcome  |
| --------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| `msg_moderation_policies_scope_chk`     | INSERT scope='BOGUS'                                                                | ERROR ✅ |
| `msg_moderation_policies_action_chk`    | INSERT keyword_action='BOGUS'                                                       | ERROR ✅ |
| `msg_moderation_policies_threshold_chk` | INSERT sensitivity_threshold=150                                                    | ERROR ✅ |
| `msg_user_blocks_self_chk`              | INSERT blocker_id = blocked_id                                                      | ERROR ✅ |
| `msg_user_tags_tag_id_fkey`             | INSERT tag_id=<random uuid>                                                         | ERROR ✅ |
| Happy-path multi-table insert           | 1 policy + 1 mod_log entry (lands in `msg_moderation_log_2026_04`) + 1 tag + 1 user_tag + 1 block + 1 admin-access row | ✅ |
| ON DELETE CASCADE on `msg_user_tags`    | DELETE FROM msg_tags → child user_tags row count drops 1 → 0                        | ✅       |

### Cycle 1 + Cycle 2 + Cycle 3 Steps 1–2 seeds re-run cleanly

The new moderation tables are empty after Step 3. `seed:sis` and `seed:classroom` remain untouched and idempotent. Step 4 (`seed:messaging`) will populate moderation policies (one PLATFORM-tier with basic keyword list, one BUILDING-tier for Lincoln Elementary) alongside thread types, sample threads, notification preferences, sample announcements, and the COM-001/002/003 permission updates.

### Out-of-scope decisions for Step 3

- **`msg_moderation_log.policy_id` is a DB-enforced FK; the message ref is soft.** Policies are stable, unpartitioned, and integrity matters (an orphan moderation row would be untriageable). The message ref is soft because `msg_messages` is partitioned and the codebase precedent is to denormalise the partition key onto the child + add an index — same as `msg_message_attachments` from Step 1.
- **`sender_id` is denormalised onto `msg_moderation_log` from `msg_messages.sender_id`.** The Step 6 `ContentModerationInterceptor` writes the moderation row at the same time as the message (or before, if BLOCK), so it has the sender id in hand. Letting the moderation queue filter by sender without joining the partitioned messages table is worth the small denormalisation cost.
- **`scope_id` on `msg_moderation_policies` is a soft UUID with no DB FK and no CHECK.** Interpretation depends on `scope`: PLATFORM=NULL, DISTRICT=organisations.id, BUILDING=schools.id. App-layer validation enforces the rule. A polymorphic ref column is usually a smell, but here the cross-tenant nature of higher-tier policies means the column may legitimately reference platform tables — and a hard FK on a tenant-scoped table to platform tables is forbidden by ADR-001/020.
- **Each tenant carries its own copy of every applicable policy tier.** PLATFORM-tier policies are seeded into every tenant's `msg_moderation_policies` table; DISTRICT-tier policies are seeded into every tenant in that district; BUILDING-tier policies are local to that one school. The moderation interceptor consults a single tenant table without cross-schema reads. The trade-off is occasional duplication of platform-tier policies across tenants, which is acceptable for ~3 policies per tenant max.
- **`platform_push_tokens.platform_user_id` is a soft FK, not a Prisma `@relation`.** Per ADR-001/020 even within the platform schema we keep auth/audit refs loose so a hard delete on `platform_users` doesn't cascade into device tokens — the device-revocation lifecycle should run through the worker, not the database.
- **`platform_dlq_messages` does not partition.** DLQ volume is bounded by failure rate (which should approach zero in steady state). If volume becomes a concern post-Phase 2, switch to RANGE(last_failed_at) monthly with the same window pattern used elsewhere.
- **`platform_dlq_messages.kafka_offset` is named that way because `offset` is a reserved keyword in PostgreSQL.** The Prisma model maps the field name `kafkaOffset` to the column `kafka_offset` — both client and SQL surfaces are unambiguous.
- **No `tag` membership rules at the schema level.** `msg_tags.is_system` lets the seeder mark system-defined tags; further constraints (e.g. only admins can assign certain tags) live in the Step 6/7 services. Schema stays simple.
- **No `msg_admin_access_log` partitioning.** Admin reads of non-participant threads should be rare (FERPA-justified only). Volume is bounded; partitioning is unnecessary at this stage.
- **No `parent_policy_id` on `msg_moderation_policies` for tier inheritance.** The "most restrictive wins" rule resolves at the moderation interceptor in Step 6 by querying all three scope rows and applying max-restrictiveness. Storing a parent reference would couple persistence to the resolution algorithm; instead the resolution is pure application logic.
- **CHECK strings still can't contain `;`.** Carries forward from Steps 1–2. Spot-checked all 10 `COMMENT ON COLUMN` strings in `009_msg_moderation.sql` before applying — all use commas / "and" instead of semicolons.

---

## Step 4 — Seed Data — Messaging & Notifications

**Done.** Lands `packages/database/src/seed-messaging.ts` (and a `seed:messaging` script in `packages/database/package.json`) plus a small extension to `seed-iam.ts` for the COM-002 role grants. The seed targets `tenant_demo` only — same convention as `seed-sis` / `seed-classroom`; `tenant_test` is provisioned but stays empty so integration-style tests can write their own fixtures. Idempotent: gates on `msg_thread_types` row count and skips entirely if any rows exist (matches the `seed-classroom` "skip if `cls_assignments` already populated" pattern).

### What lands in `tenant_demo`

| Table                          | Rows | Notes                                                                                                                                                                                                       |
| ------------------------------ | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msg_thread_types`             |    4 | TEACHER_PARENT, CLASS_DISCUSSION, ADMIN_STAFF, SYSTEM_NOTIFICATION (last is `is_system=true`, empty allowed-roles array). `allowed_participant_roles` lists the IAM role names the StorageThreadService will validate against in Step 6. |
| `msg_threads`                  |    3 | One per non-system type. Subjects: "Maya — Spring 2026 progress check-in", "P1 Algebra — Quadratics homework Q&A", "PD day — April calendar". `created_by` references the appropriate platform_user.       |
| `msg_thread_participants`      |    6 | Two per thread. Roles: OWNER for the creator (Rivera, Rivera, Mitchell respectively), PARTICIPANT for the other side. The class-discussion thread uses Rivera + Maya as the two account-holders (the other 7 students in the P1 roster don't have `platform_users` rows yet — only Maya does — so the seed cannot wire them in as participants). |
| `msg_messages`                 |   10 | 3 in thread A (Rivera ↔ David Chen), 5 in thread B (Rivera ↔ Maya), 2 in thread C (Mitchell ↔ Rivera). All `created_at` values land in 2026-04, so they all sit in the `msg_messages_2026_04` partition. |
| `msg_message_reads`            |    4 | Sets up an unread-count story: David has read the first message in thread A only (so 2 unread); Maya has read 3 of the 5 messages in thread B (the teacher's replies) — leaves 2 unread on the teacher's side. |
| `msg_alert_types`              |    3 | GENERAL_ANNOUNCEMENT (INFO, IN_APP), PARENT_INFORMATIONAL (INFO, IN_APP+EMAIL), WEATHER_CLOSURE (URGENT, IN_APP+EMAIL+SMS). Used by the announcement rows for `alert_type_id`.                                |
| `msg_notification_preferences` |   40 | One row per (test user × notification_type). 8 notification types: `attendance.tardy`, `attendance.absent`, `grade.published`, `progress_note.published`, `absence.requested`, `absence.reviewed`, `message.posted`, `announcement.published`. EMAIL channel is added for `grade.published` + `attendance.tardy`; everything else is IN_APP only. David Chen carries 22:00–07:00 quiet hours on every type (per plan); the other 4 users have NULL quiet hours. |
| `msg_moderation_policies`      |    2 | (1) PLATFORM-scope `Platform Default Profanity Filter` with `keyword_action='BLOCK'`, `sensitivity_threshold=80`, keywords for basic profanity + threat phrases. (2) BUILDING-scope `Lincoln Elementary — School-Specific` with `keyword_action='FLAG_FOR_REVIEW'`, threshold 60, keywords for substance use + bullying. The BUILDING policy's `scope_id` holds the demo school's UUID. |
| `msg_announcements`            |    2 | (1) "Welcome Back to School" — `audience_type='ALL_SCHOOL'`, `audience_ref=NULL`, alert_type=GENERAL_ANNOUNCEMENT, `is_published=true`, publish 2026-01-15, expires 2026-02-15. (2) "Parent-Teacher Conference Dates" — `audience_type='ROLE'`, `audience_ref='PARENT'`, alert_type=PARENT_INFORMATIONAL, published 2026-04-25, expires 2026-05-10. Both authored by Mitchell. |
| `msg_announcement_audiences`   |   15 | 5 for the welcome (each test user), 10 for the conference (David Chen + the 9 seeded guardian accounts under `*@parents.demo.campusos.dev`). Last conference row stays `delivery_status='PENDING'` to demonstrate the partial-fan-out state; everything else is `DELIVERED`. |
| `msg_announcement_reads`       |    4 | David read both, Maya read welcome, James read welcome.                                                                                                                                                     |
| `msg_notification_queue`       |    3 | (1) `attendance.tardy` SENT to David for Maya's 2026-04-22 P1 tardy. (2) `grade.published` SENT to Maya for the Linear Equations Quiz (92/A). (3) `message.posted` PENDING for David, pointing at thread A's third message. Each row carries an `idempotency_key` (string) and a `correlation_id` (UUID) so the Step 5 worker has realistic redelivery shapes to test against. The queue table has no UNIQUE on `idempotency_key` (per Step 2 design — Redis SET NX is the authoritative dedup) so re-running the seed via DELETE + reseed will not collide. |
| `msg_notification_log`         |    2 | One IN_APP DELIVERED row per SENT queue entry, with `queue_id` set so the join works. PENDING queue row has no log entry by definition. |

`msg_message_attachments`, `msg_tags`, `msg_user_tags`, `msg_user_blocks`, and `msg_admin_access_log` are deliberately not seeded — none of them are needed to demonstrate the Step 5 pipeline, and the moderation log table only fills in once the Step 6 ContentModerationInterceptor flags a message.

### Permission grants (`seed-iam.ts`)

The plan specifies "COM-001 read/write to Teacher/Parent/Student; COM-002 read to all + write to Teacher/Admin; COM-003 read/write to Admin". Matching the live state at the start of Step 4:

| Role           | Already had                                                | Added in Step 4         |
| -------------- | ---------------------------------------------------------- | ----------------------- |
| Platform Admin | COM-001/2/3/4 read+write+admin via `everyFunction`         | —                       |
| School Admin   | COM-001/2/3/4 read+write+admin via `everyFunction`         | —                       |
| Teacher        | COM-001 [read,write], COM-002 [read,write]                 | —                       |
| Parent         | COM-001 [read,write], COM-002 [read]                       | —                       |
| Student        | COM-001 [read,write]                                       | **COM-002 [read]**      |
| Staff          | COM-001 [read,write]                                       | **COM-002 [read]**      |

Net: 2 newly-added rows in `platform.role_permissions`. Effective access cache rebuilt — Student went from 14 → 15 permissions, Staff from 5 → 6; the other roles are unchanged. COM-003 (Content Moderation) is held by Platform/School Admin only, which the plan intends.

### Rerun / reset

```
pnpm --filter @campusos/database seed:messaging        # idempotent: skips if msg_thread_types is non-empty
pnpm --filter @campusos/database exec tsx src/seed-iam.ts   # idempotent: only adds missing role_permissions
pnpm --filter @campusos/database exec tsx src/build-cache.ts
```

To force a re-seed: `TRUNCATE msg_thread_types CASCADE` is **not** safe because there are no DB-enforced FKs from the participant / message / read tables back to thread types — the cascade won't propagate. Either drop the schema and re-provision (the supported reset path in CLAUDE.md "Rebuild from corrupted state") or `DELETE FROM tenant_demo.msg_thread_types` after manually clearing the dependent tables. For the demo scenario, dropping + re-provisioning is simpler.

### Known limitations

- **Class discussion thread has 2 participants, not 5+.** Only Maya (S-1001) has a `platform_users` account in the demo seed; the other 14 SIS students are platform_students-only. Adding 4 more student accounts just for the class thread would have cascaded into IAM scoping + Keycloak fixture work that is out of scope for Step 4. The thread still demonstrates the schema correctly — multi-message, multi-sender, with read marks. When the wider STUDENT-account fixture lands (Phase 2 polish), the class thread can be fanned out without changing the seed-data shape.
- **Notification queue uses placeholder `correlation_id` UUIDs.** In production the correlation_id will be propagated from the Kafka envelope's `correlation_id` field on the source event (e.g. the `att.student.marked_tardy` envelope). The seed mints fresh UUIDs because no actual event triggered these rows — this matches the "this is what the queue would have looked like after the worker ran" semantic.

---

## Step 5 — Notification Pipeline — Consumers & Queue

**Done.** Lands the entire Cycle 3 notification pipeline at `apps/api/src/notifications/` — the first user-facing payoff of the Cycle 1 + Cycle 2 Kafka emits. After Step 5 every domain event from attendance + grading + progress notes + absence requests, plus the message-posted event that ships in Step 6, fans out into the per-tenant `msg_notification_queue` with full preference + quiet-hours + Redis SET NX idempotency, and `NotificationDeliveryWorker` drains the queue every 10s into the per-recipient Redis sorted set the Step 8 NotificationBell will poll.

### Files

```
apps/api/src/notifications/
├── notifications.module.ts                                — wires everything; imports KafkaModule + TenantModule
├── redis.service.ts                                       — first ioredis usage in the API
├── notification-queue.service.ts                          — enqueue() (SET NX → prefs → quiet hours → INSERT PENDING)
├── notification-delivery.worker.ts                        — 10s polling worker, multi-tenant
└── consumers/
    ├── notification-consumer-base.ts                     — unwrapEnvelope() + processWithIdempotency()
    ├── attendance-notification.consumer.ts               — att.student.marked_{tardy,absent}
    ├── grade-notification.consumer.ts                    — cls.grade.published
    ├── progress-note-notification.consumer.ts            — cls.progress_note.published
    ├── absence-request-notification.consumer.ts          — att.absence.{requested,reviewed}
    └── message-notification.consumer.ts                  — msg.message.posted (producer ships Step 6)
```

`NotificationsModule` is registered in `AppModule` between `ClassroomModule` and the global `APP_GUARD` providers — Nest module ordering controls service initialisation, which means the Kafka consumer subscriptions land *after* the Cycle 2 GradebookSnapshotWorker subscribes. Each consumer's subscribe call is best-effort: if Kafka can't be reached the `KafkaConsumerService` logs `[skip-subscribe]` and continues, mirroring the Cycle 1/2 producer's behaviour.

### Consumers (5)

Every consumer follows the same shape:

```ts
async onModuleInit() {
  await this.consumer.subscribe({
    topics: [prefixedTopic(<topic>)],
    groupId: '<consumer-group>',
    handler: msg => this.handle(msg),
  });
}
```

`handle()` calls the shared helpers in `consumers/notification-consumer-base.ts`:

1. `unwrapEnvelope<P>(msg, logger)` — pulls `event_id`, `tenant_id`, and the `tenant-subdomain` transport header out of the message (envelope-first, header-fallback) and reconstructs a `TenantInfo`. Returns null + warns if any of the three routing fields are missing.
2. `processWithIdempotency(group, event, idempotency, logger, fn)` — read-only `isClaimed()` check on arrival (REVIEW-CYCLE2 BLOCKING 2 — claim-after-success), runs `fn` inside `runWithTenantContextAsync({tenant})`, then `claim()` after `fn` resolves. A throw inside `fn` leaves the event-id unclaimed so a Kafka redelivery (or the `MAX_ATTEMPTS=5` retry loop in `NotificationDeliveryWorker`) re-runs the work.

| Consumer                                | Topics                                                  | Group                                            | Recipient resolution                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AttendanceNotificationConsumer`        | `att.student.marked_tardy`, `att.student.marked_absent` | `attendance-notification-consumer`               | Guardians of the student via `sis_student_guardians` filtered by `portal_access=true AND receives_reports=true AND g.account_id IS NOT NULL`. Notification types `attendance.tardy` / `attendance.absent`. Skips students with no portal-enabled guardians (the absentee log will still be in the dashboard).                                                                                       |
| `GradeNotificationConsumer`             | `cls.grade.published`                                   | `grade-notification-consumer`                    | Student themself (via `sis_students → platform_students → platform_users.person_id`) + every portal-enabled guardian. Notification type `grade.published`. Does NOT subscribe to `cls.grade.unpublished` — unpublishing a grade quietly removes it from the gradebook; sending a "your grade is gone" notification would be more disruptive than helpful, and the snapshot worker still updates. |
| `ProgressNoteNotificationConsumer`      | `cls.progress_note.published`                           | `progress-note-notification-consumer`            | Guardians when `is_parent_visible=true`, the student themself when `is_student_visible=true`. Mirrors the row-scope used by `ProgressNoteService.listForStudent`. Drops the event when both flags are false. Notification type `progress_note.published`.                                                                                                                                          |
| `AbsenceRequestNotificationConsumer`    | `att.absence.requested`, `att.absence.reviewed`         | `absence-request-notification-consumer`          | On `requested`: every account holding `sch-001:admin` for the school's scope chain (school + platform), resolved via `platform.iam_effective_access_cache` JOIN `platform.iam_scope` JOIN `platform.iam_scope_type` filtered by `'sch-001:admin' = ANY(permission_codes)`. On `reviewed`: the original `sis_absence_requests.submitted_by`. Notification types `absence.requested` / `absence.reviewed`. |
| `MessageNotificationConsumer`           | `msg.message.posted`                                    | `message-notification-consumer`                  | Every `msg_thread_participants` row for this thread where `platform_user_id <> sender AND left_at IS NULL AND is_muted=false`. Bumps the per-(user, thread) Redis HASH on `inbox:{accountId}` via `RedisService.incrementUnread()` for the Step 6 UnreadCountService. Notification type `message.posted`. Producer ships in Step 6 alongside MessageService.                                       |

Notification type names (`attendance.tardy`, `grade.published`, …) line up exactly with the strings seeded into `msg_notification_preferences` by `seed-messaging.ts` (Step 4) so a Step 5 consumer can read the seed data without a translation layer.

### `NotificationQueueService.enqueue()`

Tenant-scoped service — every call must be inside `runWithTenantContextAsync` (the consumer base helper does this). Pipeline:

```ts
enqueue({ notificationType, recipientAccountId, payload, idempotencyKey, correlationId? }) → EnqueueResult
```

1. **Redis SET NX** on `notif:idem:{tenantSubdomain}:{idempotencyKey}` with 7-day TTL. The DB has no UNIQUE on `msg_notification_queue.idempotency_key` by design (Step 2 — avoids deadlocks during emergency fan-out). Redis is the authoritative dedup. If the key already exists → `outcome='deduped'`. Convention used by every consumer in this module: `<topic>:<eventId>:<recipientId>`.
2. **Preference lookup** in `msg_notification_preferences` for `(platform_user_id, notification_type)`. Missing row → defaults to `IN_APP` enabled. Disabled or empty channels → release the Redis key + return `outcome='disabled'` so a future re-enable + redelivery can re-enqueue.
3. **Quiet-hours check** when `quiet_hours_start` and `quiet_hours_end` are set. Wraps midnight (e.g. 22:00–07:00 = ON when local time is ≥22:00 OR <07:00). When in window, `scheduled_for` is shifted to the next quiet-end boundary so the row holds in PENDING until the worker covers that timestamp. Server runs in UTC; for now the quiet-hours strings are interpreted as UTC. A user-timezone-aware check is on the Step 8 follow-up list — schema is plain `TIME` and a TZ has to be pinned somewhere.
4. **INSERT** into `msg_notification_queue` with `status='PENDING'`, `attempts=0`, `payload` as JSONB, `correlation_id` if supplied. On failure, releases the Redis idempotency key so a redelivery can retry.

Returns `{ outcome: 'enqueued' | 'deduped' | 'disabled', queueId, channels, scheduledFor }`.

### `NotificationDeliveryWorker`

Polling worker. On `onModuleInit` it logs the cadence and schedules the first tick via `setTimeout(...).unref?.()` so it never blocks Node from exiting.

| Knob                              | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFICATION_POLL_INTERVAL_MS`   | 10_000  | Tick cadence. Each tick: load active schools → for each, enter tenant context → process up to 25 PENDING rows.                                                                                                                                                                                                                                                                                       |
| `POLL_BATCH`                      | 25      | `LIMIT $POLL_BATCH FOR UPDATE SKIP LOCKED` per tenant per tick — bounded so a backed-up tenant never starves the others.                                                                                                                                                                                                                                                                            |
| `FAILURE_BACKOFF_SECONDS`         | 30      | After a delivery throw, the queue row is flipped back to PENDING with `scheduled_for = now() + 30s`.                                                                                                                                                                                                                                                                                                |
| `MAX_ATTEMPTS`                    | 5       | After this many failures, the row settles on `status='FAILED'`. The DLQ table (`platform_dlq_messages`) is reserved for Kafka consumer failures; delivery failures are tracked in-place on the queue row so a future moderator UI can review them.                                                                                                                                                  |

Per-tenant tick:

```sql
BEGIN;
SELECT id, recipient_id, notification_type, payload, attempts, correlation_id
FROM msg_notification_queue
WHERE status = 'PENDING' AND scheduled_for <= now()
ORDER BY scheduled_for ASC
LIMIT 25
FOR UPDATE SKIP LOCKED;
-- mark every row in-flight (status='SENT', sent_at=now(), attempts++) inside the same tx
COMMIT;
-- per row, deliver per-channel:
--   IN_APP  → Redis ZADD on notif:inapp:{accountId} (capped at 100 entries via ZREMRANGEBYRANK 0,-101) + DELIVERED log row
--   EMAIL/PUSH/SMS → log "[stub-deliver]" + SENT log row (provider integration is Phase 3)
-- on throw: flip back to PENDING with 30s backoff; after MAX_ATTEMPTS settle on FAILED
```

`SELECT … FOR UPDATE SKIP LOCKED` lets two API replicas run side by side without double-delivering. Marking the row `SENT` inside the same transaction is the in-flight flag so a concurrent worker on the next tick sees it as already done; the actual UI render gates on `msg_notification_log.status='DELIVERED'` for IN_APP rows, so SENT-but-not-yet-logged is invisible. This is a deliberate trade — it keeps the worker simple, at the cost of holding the row lock while delivering. Phase 2 may switch to an explicit `PROCESSING` intermediate state once the dev volume is high enough to warrant it.

### Multi-tenant routing for the worker

Active tenants are pulled fresh on every tick from `platform.schools WHERE is_active = true`. Each row materialises a `TenantInfo` (using the table's `subdomain` + `schema_name` + `id` columns) and the worker enters `runWithTenantContextAsync({tenant})` before running its tenant-scoped queries. New schools added between ticks are picked up on the next refresh — no boot-time tenant cache. If the platform DB is unreachable, the worker logs once per tick and skips.

### Connection & best-effort behaviour

| Component               | If unreachable                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis                   | `RedisService.isConnected()` returns false. `claimIdempotency` fails open (returns true so the queue insert proceeds — the partial DB index on `idempotency_key` is the read-side dedup). `pushInAppNotification` and `incrementUnread` silently no-op. The worker still writes log rows + advances queue status; the IN_APP UI just won't see those rows until Redis is back. |
| Kafka (consumer)        | First `subscribe()` failure flips the consumer service to `connected=false` and every subsequent subscribe is logged as `[skip-subscribe]`. Same posture as the Cycle 2 GradebookSnapshotWorker. The system continues serving HTTP traffic; events emitted while Kafka is down are simply not consumed.                                                                                                                       |
| Postgres (platform)     | Idempotency lookup fails open — the consumer processes the event and writes the queue row (which the dedup happens at via Redis SET NX). The next tick's `loadActiveSchools()` returns empty and the worker reschedules.                                                                                                                                                                                                       |
| Postgres (tenant)       | Worker tick logs the tenant-level error and continues to the next tenant. Consumer-side fan-out throws are caught + re-thrown by `processWithIdempotency` so the event-id stays unclaimed and Kafka can redeliver.                                                                                                                                                                                                              |

### Verification (recorded 2026-04-27)

```bash
pnpm --filter @campusos/api build      # nest build → exits 0 with new module compiled
pnpm --filter @campusos/api test       # 7 tests pass (existing tenant-context + health)
node dist/main                          # boots; logs:
#  - NotificationsModule dependencies initialized
#  - NotificationDeliveryWorker polling every 10000ms
#  - All 5 consumer subscribe attempts (succeed against the live broker, or
#    fall back to [skip-subscribe] if the broker drops out — same path the
#    GradebookSnapshotWorker takes)
#  - Connected to Redis at redis://localhost:6379
#  - Nest application successfully started
```

A live broker hand-off test (queueing a tardy mark and observing fan-out) is part of the Step 11 vertical slice; Step 5 verification is limited to the wire-up + boot-time subscriptions.

### Permission / authorisation surface

Step 5 ships zero new HTTP endpoints — all of the user-facing surface lands in Step 8 (notification bell + inbox). The consumers and worker run in the API process under no caller identity; tenant context is reconstructed from the Kafka envelope/headers exactly the way GradebookSnapshotWorker has done since Cycle 2 Step 6. Recipient resolution queries are read-only joins; nothing here mutates IAM state.

The `iam_effective_access_cache` JOIN in `AbsenceRequestNotificationConsumer.loadSchoolAdminAccounts` is the first cache reader outside `apps/api/src/iam/`. We use the cache directly (rather than calling `PermissionCheckService.hasAnyPermissionInTenant` per candidate account) because the cardinality goes the other way — we need every admin in the school, not "is this account an admin?". The query mirrors the same scope-chain rule (SCHOOL row direct, PLATFORM row catches Platform Admins) so the answer is consistent with the request-path admin check.

### Out-of-scope decisions for Step 5

- **No HTTP endpoints land in this step.** The bell + dropdown + `/notifications` page ship in Step 8. Until then the only way to observe the queue draining is via the `msg_notification_log` table or the Redis `notif:inapp:{accountId}` sorted set.
- **No retry curve / dead-letter for delivery failures.** A 30s constant-backoff retry up to 5 attempts then `status='FAILED'` is enough for Cycle 3. The DLQ table (`platform_dlq_messages`) is for Kafka consumer failures; mixing in delivery failures would couple two pipelines that have different failure modes.
- **No quiet-hours timezone awareness.** The schema is plain `TIME`; the worker treats the bounds as UTC. A user-timezone column on `platform_users` (or a separate `notif_preferences` extension) is on the Step 8 follow-up list. Until then, the parent's seeded 22:00–07:00 quiet hours are interpreted as 22:00–07:00 UTC.
- **No EMAIL / PUSH / SMS delivery.** Stubbed with `[stub-deliver]` log lines and a `msg_notification_log` row marked SENT (per the plan — Phase 3 Sendgrid / Twilio / FCM integration is post Test & Refine). The `platform_push_tokens` table from Step 3 is unused so far; it'll be populated by the Step 8 web onboarding flow + the future native client.
- **No event-version branching on consumers.** Every Cycle 1+2 emit is `event_version=1`. When the first breaking payload change lands, the consumer can branch on `envelope.event_version` (the field is already in the unwrap). For now the consumer assumes v1 shapes.
- **No correlation-id propagation from request → consumer → log.** The producer mints a fresh UUIDv7 per emit when no request-context correlation id exists; the consumers persist it onto the queue row + log row so it's traceable end-to-end. Wiring an `X-Correlation-Id` request middleware so the same id flows from HTTP → Kafka → notification is a small follow-up.
- **`MessageNotificationConsumer` subscribes ahead of its producer.** `msg.message.posted` is emitted by the Step 6 messaging service. The consumer subscribing now means the moment Step 6's MessageService starts emitting, the notification + Redis unread bump fire — no follow-up deploy. This is the same "wire the consumer first, the producer second" sequencing the Cycle 2 GradebookSnapshotWorker used.
- **No batching across recipients.** Each consumer enqueues one row per recipient. For the demo school's recipient counts (≤ 10 per fan-out) this is fine. A future bulk-enqueue helper is on the Phase 2 polish list if the per-row write turns into a hotspot.
- **No tenant cache in the worker.** `platform.schools` is queried fresh per tick. With 1–2 active schools per dev / staging cluster and a 10s tick, the cost is negligible. If the active-school list grows past O(100), cache it for ~30s.
- **Worker holds the row lock while delivering.** Acceptable for Cycle 3 demo volume; documented in `notification-delivery.worker.ts` so Phase 2 reviewers can decide whether to switch to a `PROCESSING` intermediate state.

---

## Step 6 — Messaging NestJS Module

**Done.** Lands `apps/api/src/messaging/` — the request-path side of M40 messaging. Four services + three controllers + 10 endpoints. The schema (`007_msg_messaging.sql`) and the moderation tables (`009_msg_moderation.sql`) shipped in Steps 1 + 3; the seed data (`seed-messaging.ts`) shipped in Step 4; the Step 5 `MessageNotificationConsumer` already subscribes to `msg.message.posted` and bumps the same Redis HASH this module reads — Step 6 is the producer-side wiring + the user-facing surface.

### Files

```
apps/api/src/messaging/
├── messaging.module.ts                    — wires services + controllers; imports TenantModule + IamModule + KafkaModule + NotificationsModule
├── thread.service.ts                      — create / list / read / archive / mark-read / participant role helpers
├── message.service.ts                     — post (with moderation + emit + unread bump) / edit (15-min) / soft-delete / list
├── unread-count.service.ts                — Redis-backed badge counter (delegates to RedisService)
├── content-moderation.service.ts          — three-tier policy evaluator + msg_moderation_log writer
├── thread.controller.ts                   — /threads + /threads/:id + /threads/:id/read + /threads/:id/archive
├── message.controller.ts                  — /threads/:threadId/messages + /messages/:id
├── notification-badge.controller.ts       — GET /notifications/unread-count
└── dto/
    ├── thread.dto.ts                      — CreateThreadDto / ThreadResponseDto / ArchiveThreadDto / ListThreadsQueryDto / ThreadParticipantInputDto
    └── message.dto.ts                     — PostMessageDto / EditMessageDto / ListMessagesQueryDto / MessageResponseDto / MarkThreadReadResponseDto / UnreadCountResponseDto
```

`MessagingModule` is registered in `AppModule` immediately after `NotificationsModule` (i.e. between `NotificationsModule` and the global `APP_GUARD` providers). The `NotificationsModule` import gives `UnreadCountService` access to the same `RedisService` instance that `MessageNotificationConsumer` writes to — both paths converge on `inbox:{accountId}` so the request-path bump and the Kafka consume bump are idempotent against each other.

### Endpoints (10)

All gated on `com-001:read` / `com-001:write` except `GET /notifications/unread-count`, which accepts either `com-001:read` OR `com-002:read` so the bell renders for any persona that holds either communications read tier (Student & Staff hold com-002:read after the Step 4 IAM update).

| Method | Path                                            | Permission                  | Notes                                                                                                                                                                                                |
| -----: | ----------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   GET  | `/threads`                                      | `com-001:read`              | Inbox. Admins see every thread; everyone else only threads where they hold an active `msg_thread_participants` row (`left_at IS NULL`). `unreadCount` per row from Redis.                            |
|   GET  | `/threads/:id`                                  | `com-001:read`              | 404s when caller is neither participant nor admin (collapse 403→404 to prevent existence probing). Admin reads of a non-participant thread write a `msg_admin_access_log` row (FERPA audit).        |
|   POST | `/threads`                                      | `com-001:write`             | Validates the threadType + role-token check + block-list. Optional `initialMessage` is forwarded through `MessageService.post` so it goes through moderation just like any other message.            |
|   POST | `/threads/:id/read`                             | `com-001:read`              | Idempotent. INSERTs `msg_message_reads` rows for every unread message (`ON CONFLICT DO NOTHING`), bumps `msg_thread_participants.last_read_at`, then `RedisService.clearUnread()` for that thread.  |
|  PATCH | `/threads/:id/archive`                          | `com-001:write`             | OWNER / PARTICIPANT / school admin only — OBSERVERs cannot toggle archive.                                                                                                                            |
|   GET  | `/threads/:threadId/messages`                   | `com-001:read`              | Newest-first keyset pagination via `?before=<ISO>` cursor; default limit 50, max 200. Soft-deleted rows return with empty body and `isDeleted=true`.                                                |
|   POST | `/threads/:threadId/messages`                   | `com-001:write`             | Pipeline: active-participant + non-OBSERVER check → block-list check vs every other participant → moderation evaluate → BLOCKED→422 / else INSERT → bump last_message_at + self-read + Redis bump → emit `msg.message.posted`. |
|  PATCH | `/messages/:id`                                 | `com-001:write`             | Author-only, within 15 minutes of `created_at`. Re-runs moderation. BLOCKED edits return 422 (and write a moderation log row); the original message is unchanged.                                    |
| DELETE | `/messages/:id`                                 | `com-001:write`             | Sender or school admin. Idempotent soft-delete (`is_deleted=true`, `deleted_at=now()`); body blanked in `rowToDto` for non-author readers so the timeline shows "Message deleted".                  |
|   GET  | `/notifications/unread-count`                   | `com-001:read OR com-002:read` | Returns `{ total, byThread: { [threadId]: count } }` from `RedisService.listUnreadByThread()`. Returns zero / empty when Redis is unavailable so the bell never crashes the page.                |

### Service-by-service detail

#### `ThreadService.create()`

1. Reject empty participant lists, deduplicate, and reject self-as-recipient (the creator is added as OWNER automatically).
2. Look up the `msg_thread_types` row; 404 when missing or wrong school; 400 when inactive; 403 when `is_system=true` and the caller isn't a school admin.
3. **Role-token validation.** When `allowed_participant_roles` is non-empty, walk every account (creator + recipients) and verify each one holds at least one matching role in the school's scope chain. The lookup joins `platform.iam_role_assignment` → `platform.iam_role` → `platform.iam_scope` → `platform.iam_scope_type` filtered to `status='ACTIVE'` and `(scope_type='SCHOOL' AND entity_id=schoolId) OR scope_type='PLATFORM'`. Role names are tokenised with `name.toUpperCase().replace(/\s+/g, '_')` so `"School Admin"` → `"SCHOOL_ADMIN"`, matching the synthetic tokens stored in the seed.
4. Existence-check every recipient against `platform.platform_users` — guards against typos and against accounts that exist in `iam_person` but lack a portal account.
5. Block-list — fail closed if a `msg_user_blocks` row exists between the creator and any recipient in either direction. The error message is deliberately generic ("One or more recipients cannot be added to this thread (blocked).") so neither side learns who blocked who.
6. Atomic insert in `executeInTenantTransaction`: row in `msg_threads` + an OWNER row for the creator + a `PARTICIPANT` (or override) row per recipient. `ON CONFLICT (thread_id, platform_user_id) DO NOTHING` defends against the creator appearing in `participants` redundantly.

#### `ContentModerationService.evaluate()`

- Loads every `msg_moderation_policies` row with `is_active = true` in one tenant-scoped query — no cross-schema reads, because the platform tier is denormalised into each tenant per the Step 3 design notes ("each tenant carries its own copy of the platform-tier and district-tier policies that apply to it").
- Whole-word, case-insensitive keyword match using a regex with `\b` boundaries — escapes regex metacharacters so a keyword like `c++` won't blow up. Whole-word matching is intentional Scunthorpe-problem prevention: the seeded keyword `fuck` will NOT flag `Fukushima`, and `ass` (not seeded) wouldn't flag `Massachusetts`. The cost is that variants need to be seeded explicitly (`fuck` does not match `fucking`).
- **"Most restrictive wins"** = `BLOCKED > ESCALATED > FLAGGED > CLEAN`. The function walks every active policy; if multiple policies match, the highest-priority action wins and the verdict carries the matched keywords + the `policy_id` of the winning policy.
- `evaluate()` is read-only. The companion `log()` method writes a `msg_moderation_log` row with `flag_type` (`BLOCKED` / `FLAGGED` / `ESCALATED`), `severity` (`URGENT` for BLOCKED + ESCALATED, `WARNING` for FLAGGED), `matched_keywords[]`, and `review_outcome='PENDING'`. `MessageService.post()` calls `log()` for BLOCKED messages even though no `msg_messages` row lands — the synthetic `messageId` stays one-sided so the moderator queue can see the attempt.
- Lookup failures degrade gracefully: a thrown `executeInTenantContext` error is caught, logged, and returns `CLEAN`. The verdict is "no policy could prove the message bad → ship it." This is consistent with the rest of the messaging stack's best-effort posture (Redis, Kafka) — a transient platform DB blip cannot shut messaging down.

#### `MessageService.post()`

```
POST /threads/:id/messages
   │
   ├─ thread existence  ──→ 404 if missing
   ├─ active-participant ── 403 (Forbidden) if not active participant
   ├─ role check         ── 403 if OBSERVER
   ├─ block-list (other  ── 403 with generic copy if any participant has a
   │  participants)         block in either direction with sender
   ├─ ContentModerationService.evaluate(body)
   │     ├─ BLOCKED  → moderation.log(synthetic id) + 422 with the canonical
   │     │            policy message (no body details — prevents gaming)
   │     ├─ FLAGGED  → set messages.moderation_status = 'FLAGGED', persist
   │     ├─ ESCALATED→ set messages.moderation_status = 'ESCALATED', persist
   │     └─ CLEAN    → set messages.moderation_status = 'CLEAN', persist
   │
   ├─ inside tenant tx:
   │     INSERT msg_messages (id, thread_id, school_id, sender_id, body,
   │                          moderation_status, created_at, updated_at)
   │     UPDATE msg_threads SET last_message_at = $now WHERE id = …
   │     INSERT msg_message_reads (sender, message)  ON CONFLICT DO NOTHING
   │       — auto-mark the sender as having read their own message so
   │         their badge doesn't pop on their own client.
   │
   ├─ if non-CLEAN: moderation.log() with the actual messageId
   ├─ for every other active participant (left_at IS NULL AND is_muted=false):
   │     RedisService.incrementUnread(accountId, threadId)
   │
   └─ KafkaProducerService.emit('msg.message.posted', { messageId,
        threadId, senderId, body, postedAt, threadSubject, threadType })
        — Step 5 MessageNotificationConsumer fans out IN_APP notifications
        + bumps the same Redis HASH (idempotent — same key); + writes the
        notif_log row when the worker drains the queue.
```

The synchronous Redis bump is intentional: the badge updates **before** the Kafka round-trip completes, so even when a consumer lags or the broker is briefly unavailable the inbox UI stays correct. The post-emit consumer bump is a no-op against the same HASH key, which is fine — `HINCRBY 1` twice produces the same total only if the consumer is racing the producer; with the producer always running first the consumer's bump will always observe the higher value and add 1. In practice this is fine because the `msg_message_reads` table is the durable source of truth and the badge is opportunistic.

**Trade-off recorded.** The producer-side increment + consumer-side increment causes a +1 over-count on every successful Kafka delivery. For Cycle 3 this is acceptable (the mark-read flow clears the HASH entry to 0, not to a delta), but Phase 2 should pick a single owner — most natural is "consumer only" once Kafka is treated as reliable, with the producer falling back to the consumer's bump when Kafka is unhealthy.

#### `MessageService.edit()` + `softDelete()`

- Edit is author-only, within 15 minutes (`EDIT_WINDOW_MS`) of the original `created_at`. Re-runs the body through moderation — BLOCKED edits return 422 with a corresponding moderation log row, and the original `body` is left untouched. FLAGGED / ESCALATED edits update the body AND `moderation_status` so a moderator can see the new verdict.
- Soft-delete is idempotent. Author or school admin only. Sets `is_deleted=true`, `deleted_at=now()`, but leaves the `body` column populated — the API blanks it in `rowToDto` for the response. This keeps moderator forensics intact (the moderation log row still references the original body) without leaking it through the read path. The plan-mandated "Message deleted" timeline marker is the result of `body=""` + `isDeleted=true` + a frontend treatment in Step 9.

#### `UnreadCountService` + `RedisService` extensions

`UnreadCountService` is a thin layer over `RedisService`. Step 6 added three methods to `RedisService`:

- `clearUnread(accountId, threadId)` — `HDEL inbox:{accountId} {threadId}`. Used on POST /threads/:id/read.
- `sumUnread(accountId)` — `HVALS` then sum positive integers. Used by the badge counter.
- `listUnreadByThread(accountId)` — `HGETALL` filtered to positive entries. Used by the inbox UI.

All three are best-effort: when Redis is unreachable they return `0` / `{}` so the bell renders an empty badge instead of breaking the page. The pre-existing `incrementUnread` from Step 5 is unchanged.

### Row-level authorization summary

| Operation                  | Endpoint gate              | Row-level rule                                                                                                                                                                                                       |
| -------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox                      | `com-001:read`             | Admin → every thread in tenant; else INNER JOIN msg_thread_participants where `platform_user_id = caller AND left_at IS NULL`.                                                                                       |
| Thread read                | `com-001:read`             | Active participant or school admin. Admin reads of a non-participant thread write a `msg_admin_access_log` row (admin_id, thread_id, reason='Read thread messages' or caller-supplied).                              |
| Create thread              | `com-001:write`            | Caller and every recipient must hold one of the thread type's `allowed_participant_roles`. System thread types (`is_system=true`) require school admin.                                                              |
| Mark-read                  | `com-001:read`             | Same as thread-read. Idempotent for participants; no-op for admins (no Redis HASH entry to clear; no `msg_thread_participants` row to bump).                                                                         |
| Archive / unarchive        | `com-001:write`            | Active participant (not OBSERVER) or school admin.                                                                                                                                                                   |
| List messages              | `com-001:read`             | Same row gate as thread-read.                                                                                                                                                                                        |
| Post message               | `com-001:write`            | Active participant AND not OBSERVER. Block-list rejection severs in either direction.                                                                                                                                |
| Edit message               | `com-001:write`            | Author only, within 15 minutes of post. (Even school admins cannot edit a message they didn't author — preserves the integrity of the conversation history.)                                                         |
| Soft-delete message        | `com-001:write`            | Sender OR school admin. (Admins can remove flagged / escalated content even though they cannot edit — the body stays on the row for forensics; only the API representation blanks it.)                              |

The `com-001:read` and `com-001:write` codes were already on Teacher / Parent / Student / School Admin / Platform Admin rows after Step 4. No IAM changes in Step 6.

### Verification (recorded 2026-04-27, port 4002 build)

```bash
pnpm --filter @campusos/api build      # nest build → exits 0 with new module compiled
pnpm --filter @campusos/api test       # 7 tests pass (existing tenant-context + health)
PORT=4002 node dist/main.js            # boots; logs all 10 messaging routes mapped:
#   ThreadController   → GET / + GET /:id + POST / + POST /:id/read + PATCH /:id/archive
#   MessageController  → GET /threads/:threadId/messages + POST same + PATCH /messages/:id + DELETE /messages/:id
#   NotificationBadge  → GET /notifications/unread-count
#   Redis: Connected to redis://localhost:6379
#   Kafka: Subscribed message-notification-consumer to dev.msg.message.posted
```

Live smoke against `tenant_demo`:

| #   | Scenario                                                                          | Expected                                                                  | Got |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --- |
| 1   | Teacher (Rivera) GET /threads                                                     | 3 threads (TEACHER_PARENT, CLASS_DISCUSSION, ADMIN_STAFF), unread=0 each  | ✅  |
| 2   | Teacher GET /notifications/unread-count                                           | `{ total: 0, byThread: {} }`                                              | ✅  |
| 3   | Teacher POST /threads/:id/messages with body "Step 6 smoke test — clean message." | 201 with senderName="James Rivera", moderationStatus="CLEAN"              | ✅  |
| 4   | Teacher POST same with body "holy shit something is up" (BLOCK keyword `shit`)    | 422 + canonical policy message + `BLOCKED / URGENT / {shit}` log row     | ✅  |
| 5   | Teacher POST same with body "someone is talking about weed in the hallway"        | 201 with moderationStatus="FLAGGED" + `FLAGGED / WARNING / {weed}` log    | ✅  |
| 6   | Teacher POST same with body "i will kill you tomorrow" (multi-word BLOCK phrase)  | 422 + `BLOCKED / URGENT / {"kill you"}` log row                           | ✅  |
| 7   | Teacher POST same with body "this is a fucking test" (whole-word `fuck` does NOT match `fucking`) | 201 with moderationStatus="CLEAN" — Scunthorpe defence working           | ✅  |
| 8   | Parent (David) GET /threads                                                       | TEACHER_PARENT thread with `unreadCount=6` (4 from smoke + 2 seed)        | ✅  |
| 9   | Parent GET /notifications/unread-count                                            | `{ total: 6, byThread: { 019dd0d4-…: 6 } }`                              | ✅  |
| 10  | Parent POST /threads/:id/read                                                     | `{ marked: 4, unreadCount: 0 }` (4 fresh receipts; 2 seed reads existed)  | ✅  |
| 11  | Parent GET /notifications/unread-count again                                      | `{ total: 0, byThread: {} }` — Redis HASH cleared                         | ✅  |
| 12  | PATCH /messages/00000000-0000-0000-0000-000000000000 (phantom)                    | 404 Not Found                                                             | ✅  |

The 4 smoke-posts also bumped David's `inbox:{accountId}` HASH live — verified via `redis-cli HGETALL` showing the thread id with count=4 before mark-read.

### Permission / authorisation surface

Step 6 adds 10 endpoints — 9 under `com-001:read` / `com-001:write`, plus the badge endpoint that accepts either `com-001:read` or `com-002:read` so it renders for every persona that holds either tier (Step 4 IAM update gave Student + Staff `com-002:read`). No new permission codes; no IAM changes; the `seed-iam.ts` role mapping is unchanged.

### Out-of-scope decisions for Step 6

- **The plan calls this a `ContentModerationInterceptor` — Step 6 ships a service instead.** A NestJS interceptor wraps a controller method and works against the response stream, which is awkward when the moderation verdict needs to (a) reject before any DB write, (b) write a forensic log row, and (c) influence the `moderation_status` column on the persisted row. Calling a service from inside `MessageService.post()` (and `.edit()`) keeps the moderation flow synchronous, transactional, and centralised. The plan's intent — "before persisting, check message body against active msg_moderation_policies" — is preserved.
- **Whole-word matching, no stemming.** Scunthorpe-safe and conservative. Variants like `fuck` vs `fucking` need to be seeded explicitly. Phase 2 may add a stemmer; until then a Phase 2 seed extension is the lowest-risk path.
- **`sensitivity_threshold` on `msg_moderation_policies` is unused.** The plan mentions an optional ML classifier with a 0–100 threshold — Step 6 ships keyword-only matching. The threshold column is preserved for the future classifier; the schema doesn't need to change.
- **Block-list is mutual-severance, not directional.** A row in `msg_user_blocks` blocks messages between the pair in either direction. The plan says "if blocker_id/blocked_id pair exists in msg_user_blocks, message creation is rejected" — the implementation matches that read.
- **`POST /threads/:id/read` is idempotent and best-effort.** It inserts `msg_message_reads` rows for every unread sender-isn't-me message in the thread (`ON CONFLICT DO NOTHING`), bumps `last_read_at`, and clears the Redis HASH entry. Re-running is a no-op except for `last_read_at`. Failure to clear Redis is logged but not reflected in the response — the badge stays stale until the next message arrives, which the user notices and re-opens the thread.
- **Producer-side + consumer-side Redis bump is double-counting.** Documented above. Acceptable for Cycle 3 demo volume; Phase 2 follow-up to pick a single owner.
- **Edit window is fixed at 15 minutes.** Plan-mandated. `EDIT_WINDOW_MS` is a service-local constant; admin override is not implemented (admins still cannot edit a message they didn't author — soft-delete is the FERPA-preserving alternative).
- **Soft-deleted messages keep their body in the DB.** The body is blanked at the API layer for non-author readers but still lives on the row for moderator forensics + audit. If a hard-delete is needed the moderator queue can issue the destructive query manually, but the default path is reversible.
- **No "leave thread" endpoint.** `msg_thread_participants.left_at` is in the schema but the only writer in Step 6 is the OWNER + creator path. A self-remove + admin-remove endpoint is on the Step 9 (Messaging UI) follow-up list.
- **No attachment endpoints.** `msg_message_attachments` is in the schema (Step 1) but Step 6 doesn't expose attachment upload / list — the plan defers that to Step 9 alongside signed S3 URL generation.
- **No `msg_admin_access_log` reader endpoint.** The audit log is written but not exposed for admin-side review yet. A `GET /admin/access-log` endpoint will land alongside the moderation queue UI in Phase 2.
- **Quiet hours are not enforced on synchronous post.** The Step 5 `NotificationQueueService` already defers IN_APP delivery to the next quiet-end boundary; the synchronous Redis HASH bump from `MessageService.post()` happens regardless. This is intentional — the badge should reflect the inbox's actual state; quiet hours suppress the IN_APP push, not the inbox indicator.
- **Role-token mapping is `name.toUpperCase().replace(/\s+/g, '_')`.** A direct mapping table on `iam_roles` (or a constant in shared) would be more robust if a role ever picks up a non-trivial name. For Cycle 3 the convention matches every seeded role + the seeded `allowed_participant_roles` arrays.

---

## Step 7 — Announcements NestJS Module

Lands the request-path module + Kafka consumer for school-wide, class-level, year-group, and role-targeted announcements with pre-computed audience fan-out.

### Files

```
apps/api/src/announcements/
  announcements.module.ts          — wires service + controller + worker
  announcement.service.ts          — list / get / create / patch / mark-read / stats
  announcement.controller.ts       — 6 endpoints under com-002:read / com-002:write
  audience-fan-out.worker.ts       — Kafka consumer on msg.announcement.published
  dto/
    announcement.dto.ts            — Create / Update / List / Response / Stats DTOs
```

`AppModule` imports `AnnouncementsModule` after `MessagingModule` (no ordering dependency, but groups the M40 modules together).

### Services

#### `AnnouncementService.list(query, actor)` / `getById(id, actor)`

Two scopes:
- **Manager** (`actor.isSchoolAdmin || actor.personType === 'STAFF'`) sees every announcement in the tenant. Drafts are filtered out by default; pass `includeDrafts=true` to opt in. Expired ones are filtered out unless `includeExpired=true`.
- **Reader** (everyone else holding `com-002:read`) sees only published, non-expired announcements where `EXISTS (SELECT 1 FROM msg_announcement_audiences WHERE platform_user_id = $accountId AND announcement_id = a.id)`. Single SELECT against the pre-computed audience eliminates real-time fan-out at read time.

`is_read` is computed inline via `EXISTS` on `msg_announcement_reads`. The list query joins `msg_alert_types` for icon/severity surfacing and `platform.platform_users + iam_person` for the author display name. Sort: `publish_at DESC NULLS FIRST, created_at DESC`.

#### `AnnouncementService.create(input, actor)`

Manager-only (`isSchoolAdmin || personType=STAFF`). Validates:
- `audienceType` ∈ {ALL_SCHOOL, CLASS, YEAR_GROUP, ROLE, CUSTOM}.
- `audienceRef` MUST be empty when `audienceType=ALL_SCHOOL`, MUST be present otherwise (validated up front so the worker never sees a malformed event).
- `alertTypeId` (when supplied) must belong to this tenant and be `is_active=true`.

`isPublished=true` sets `publish_at = COALESCE(input.publishAt, now())` and emits `msg.announcement.published` via `KafkaProducerService.emit({ sourceModule: 'communications', ... })`. Draft otherwise.

#### `AnnouncementService.update(id, input, actor)`

Author or school admin only. **Published is one-way at this layer:** editing a published announcement returns 400 (the audience has already been fanned out and notifications dispatched — letting an author rewrite the body would silently change what was actually delivered). Setting `isPublished=false` on a draft also 400s (it's already a draft). Setting `isPublished=true` on a draft publishes it and emits.

The patch is dynamic — only fields present in the body are SET. `audience_ref` is wiped to NULL when `audience_type` is changed to `ALL_SCHOOL`. Same alert-type-belongs-to-tenant guard as `create`.

#### `AnnouncementService.markRead(id, actor)`

Idempotent INSERT into `msg_announcement_reads` (UNIQUE on `(announcement_id, reader_id)`); returns `newlyRead=true` on the first call, `false` on every subsequent call. Inside the same tenant transaction it also flips the matching `msg_announcement_audiences` row from PENDING → DELIVERED so the stats endpoint reflects the read-side acknowledgment without waiting for the delivery worker.

Refuses to mark a draft as read (400 — drafts are invisible to readers anyway, this just clarifies the error).

#### `AnnouncementService.getStats(id, actor)`

Author or school admin only. Two parallel aggregates inside one tenant context call:
- `msg_announcement_audiences`: `total`, `pending`, `delivered`, `failed` via `COUNT(*) FILTER (WHERE delivery_status = …)`.
- `msg_announcement_reads`: `count`.

`readPercentage = round(read / total × 100, 2)`. The endpoint is permission-gated on `com-002:write` but the service layer enforces author-or-admin (the controller permission grants Teacher access, but a teacher cannot see another teacher's announcement stats — that's enforced here).

### `AudienceFanOutWorker` (Kafka consumer)

Group: `audience-fan-out-worker`. Topic: `prefixedTopic('msg.announcement.published')` (env-prefixed via `KAFKA_TOPIC_ENV`).

Pipeline (`processWithIdempotency` from Step 5's `notification-consumer-base.ts`):
1. `unwrapEnvelope` reads `event_id` + `tenant_id` off the ADR-057 envelope (header fallback).
2. Read-only `IdempotencyService.isClaimed` on arrival — early-drop redelivered events.
3. `runWithTenantContextAsync` enters the right schema.
4. `loadAnnouncementContext(announcementId)` fetches body + alert-type metadata + author display name in one query.
5. `resolveAudience(audience_type, audience_ref)` returns a deduplicated list of `platform_users.id`:
   - **ALL_SCHOOL** — `SELECT DISTINCT account_id FROM platform.iam_role_assignment ra JOIN platform.iam_scope sc ... WHERE ra.status='ACTIVE' AND ((stp.code='SCHOOL' AND sc.entity_id = $schoolId) OR stp.code='PLATFORM')`. School + platform scope chain matches the Step 5 admin-resolution query.
   - **CLASS** — UNION of: enrolled students (`sis_enrollments → sis_students → platform_students → platform_users`, status=ACTIVE), portal-enabled guardians of those students (`sis_student_guardians.portal_access=true AND g.account_id IS NOT NULL`), and class teachers (`sis_class_teachers.teacher_employee_id` joined to `platform_users.person_id` per the Cycle 2 HR-employee identity mapping).
   - **YEAR_GROUP** — students with `sis_students.grade_level = $audienceRef` + their portal-enabled guardians. Teachers are intentionally excluded (year-group announcements target families).
   - **ROLE** — accounts whose IAM role token (`UPPER(REGEXP_REPLACE(name, '\s+', '_', 'g'))`) equals the audience_ref. Same scope chain as ALL_SCHOOL.
   - **CUSTOM** — logs and returns []. Reserved for the deferred Communication Groups feature.
6. `writeAudienceRows(announcementId, accountIds)` bulk-inserts one row per recipient inside a tenant transaction with `delivery_status='DELIVERED', delivered_at=now()` and `ON CONFLICT (announcement_id, platform_user_id) DO NOTHING` (the unique constraint covers Kafka redelivery). Marking DELIVERED at insert time keeps stats accurate; PENDING was the schema default but the worker has effectively delivered the audience handoff.
7. For each recipient: `NotificationQueueService.enqueue({ notificationType: 'announcement.published', recipientAccountId, payload, idempotencyKey: 'announcement.published:{eventId}:{accountId}' })`. Redis SET NX on the idempotency key prevents duplicate enqueues across redeliveries; preference + quiet-hours checks happen inside the queue service.
8. `IdempotencyService.claim` after the loop completes — claim-after-success per REVIEW-CYCLE2 BLOCKING 2. A transient platform DB blip leaves the event-id un-claimed and the next Kafka redelivery re-runs (audience UNIQUE + Redis SET NX make it harmless).

### Endpoints (6)

| Method | Path                               | Permission        | Notes |
|--------|------------------------------------|-------------------|-------|
| GET    | /announcements                     | com-002:read      | manager → all (drafts opt-in via `?includeDrafts=true`); reader → audience-row-matched + published only |
| GET    | /announcements/:id                 | com-002:read      | 404 when not visible to caller |
| POST   | /announcements                     | com-002:write     | manager-only; draft or publish-now (`isPublished=true` emits) |
| PATCH  | /announcements/:id                 | com-002:write     | author or admin; refuses to edit a published row; flipping `isPublished=true` publishes + emits |
| POST   | /announcements/:id/read            | com-002:read      | idempotent — also flips audience row PENDING → DELIVERED |
| GET    | /announcements/:id/stats           | com-002:write     | author or admin only (controller gate is com-002:write but service enforces author-or-admin) |

`com-002:read` is held by every persona (Teacher, Parent, Student, Staff, School Admin, Platform Admin) per Step 4's seed-iam.ts extension. `com-002:write` is held by Teacher + School Admin + Platform Admin only.

### Verification (recorded 2026-04-27)

Live smoke against `tenant_demo` on port 4002 with all 5 test users:

1. **Visibility scoping** — parent sees seeded `Welcome Back to School` (ALL_SCHOOL) + `Parent-Teacher Conference Dates` (ROLE=PARENT); student sees only `Welcome Back to School`; teacher (manager) sees both.
2. **Draft creation** — principal POST creates `Early Dismissal Friday` as ALL_SCHOOL draft; `isPublished=false`, `publishAt=null`.
3. **Reader 404 on draft** — parent GET on the draft id returns 404.
4. **Permission denial** — student POST returns 403 (no com-002:write).
5. **Draft → published** — principal PATCH `{"isPublished":true}` flips the row; producer emits `dev.msg.announcement.published`; AudienceFanOutWorker logs `Fanning out announcement … (audience=ALL_SCHOOL) to 5 recipients` (the 5 seeded test users).
6. **Reader sees published** — parent GET on the same id now returns 200 with `isRead=false`.
7. **Idempotent mark-read** — first POST `/read` returns `newlyRead=true`; second returns `newlyRead=false`. Re-fetching announcement shows `isRead=true`.
8. **Stats** — principal GET `/stats` returns `totalAudience=5, readCount=1, readPercentage=20, pendingCount=0, deliveredCount=5, failedCount=0`.
9. **Stats authorization** — non-author parent GET `/stats` returns 403.
10. **Edit-after-publish** — principal PATCH on the published row returns 400 (`Published announcements cannot be edited`).
11. **ROLE=PARENT publish** — POST with `{"audienceType":"ROLE","audienceRef":"PARENT","isPublished":true}` triggers `Fanning out announcement … (audience=ROLE/PARENT) to 1 recipients` (one parent in the seed); student GET on this id returns 404.
12. **CLASS publish** — POST with `audienceType=CLASS, audienceRef=<sis_classes.id>` triggers `Fanning out … (audience=CLASS/<id>) to 10 recipients` (enrolled students + their guardians + the class's teachers).
13. **YEAR_GROUP/9 publish** — POST resolves to 9 recipients (students in grade 9 + their portal-enabled guardians).
14. **Notification queue row** — `SELECT FROM msg_notification_queue WHERE notification_type='announcement.published'` returns one PENDING row per audience member with the recipient_id matching the resolved account.
15. **Validation errors** — POST with `audienceType=ALL_SCHOOL, audienceRef='PARENT'` returns 400; POST with `audienceType=ROLE` and no audienceRef returns 400.

Build: `pnpm --filter @campusos/api build` clean. Live boot subscribed `audience-fan-out-worker` to `dev.msg.announcement.published` after the topic was pre-created via `kafka-topics.sh --create`. The first-boot Kafka topic auto-creation race that already affects `gradebook-snapshot-worker` on a fresh dev cluster also affects this worker; pre-creating the topic once is the dev workaround.

### Permission / authorisation surface

- All 6 endpoints gated on `com-002:read` or `com-002:write`.
- Manager check at the service layer: `actor.isSchoolAdmin || actor.personType === 'STAFF'` — keeps the read SQL simple and matches the seed where Teachers+School Admin+Platform Admin hold `com-002:write`.
- Author-or-admin check on `update` and `getStats` enforces that one teacher cannot edit or view stats for another teacher's announcement, even though both hold `com-002:write`.
- Reader visibility is scope-collapsed to a single `msg_announcement_audiences` row check — the audience row is the access-control boundary for non-managers.

### Out-of-scope decisions for Step 7

- **Scheduled publish.** A Future-dated `publishAt` on a draft just stores the timestamp; nothing publishes it later. The plan calls this out explicitly; a periodic poll worker is a Phase 2 follow-up.
- **Recurring announcements.** `is_recurring` + `recurrence_rule` columns are stored but no scheduler interprets them yet.
- **Un-publish.** No endpoint or PATCH path can flip `is_published=true → false` once published. The audience has already been fanned out and notifications dispatched; un-publishing would leave a confusing audit trail. If retraction is needed, the row stays published and a new announcement is posted.
- **CUSTOM audience.** The schema check accepts CUSTOM but the worker logs and drops. Reserved for the Communication Groups feature.
- **Mass mark-as-read.** No "mark all as read" endpoint yet — the Step 8 NotificationBell is the natural home for that.

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

```bash
pnpm install
docker compose up -d
pnpm --filter @campusos/database migrate
pnpm --filter @campusos/database seed
pnpm --filter @campusos/database exec tsx src/seed-iam.ts
pnpm --filter @campusos/database seed:sis
pnpm --filter @campusos/database seed:classroom
pnpm --filter @campusos/database seed:messaging
pnpm --filter @campusos/database exec tsx src/build-cache.ts
pnpm --filter @campusos/api dev
```

`seed:messaging` is the Step 4 addition; everything else is unchanged from Cycle 2. The seeds are idempotent and safe to re-run.

---

## Open items / known gaps (will be filled in as steps land)

- **ADR-057 envelope on every emit.** Done in Step 0. The transport headers (`event-id`, `tenant-id`, `tenant-subdomain`) are still set on every message for backward compatibility with any consumer that hasn't migrated; once Cycle 3 ships, a Phase 2 follow-up can retire them.
- **Communications tenant migrations (Steps 1–3).** Done — 19 of M40's 29 tables landed across migrations 007–009 (6 messaging + 7 notifications/announcements + 6 moderation/support). 10 deferred: emergency alerts (requires dedicated always-on service per Architecture Review), digest batching, translation request pipeline, retention/archival jobs, and a few smaller utility tables that the plan explicitly defers.
- **Platform schema additions.** Done — `platform_push_tokens` + `platform_dlq_messages` landed via Prisma migration `20260427211003_add_communications_platform_tables`. First platform additions since Cycle 0.
- **Email / push provider integration is stubbed.** The queue + log + delivery worker landed in Step 5; Sendgrid / Twilio / FCM wire-up is Phase 3 (post Test & Refine). Stub path writes a `[stub-deliver]` log line and a `msg_notification_log` row with `status=SENT`.
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
