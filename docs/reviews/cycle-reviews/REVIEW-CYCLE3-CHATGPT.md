# Cycle 3 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Scope:** Full Cycle 3 (Communications — messaging, notifications, announcements, moderation, vertical-slice CAT)
**Final verdict:** **APPROVED** at SHA `592d366` (April 28, 2026)
**Verdict trail:**

| Round | Date           | SHA       | Verdict                                            |
| ----: | -------------- | --------- | -------------------------------------------------- |
|     1 | April 28, 2026 | `7c7e3d4` | REJECT pending two reliability/security fixes      |
|     2 | April 28, 2026 | `592d366` | APPROVED to proceed (one follow-up for next cycle) |

---

## Summary

This was a re-review at `7c7e3d4`. The prior round caught three issues that were resolved by the time the cycle closed:

- ADR-057 envelope is now implemented in `KafkaProducerService.emit()` with env-prefixed topics and an envelope body.
- Cycle 2/3 modules are registered in `AppModule`.

However, two BLOCKING issues and one MAJOR issue remain.

---

## BLOCKING 1 — Kafka consumers still swallow handler failures

ADR-057 requires consumer idempotency and DLQ behavior after failures.

`KafkaConsumerService` still catches handler errors, logs them, and does not rethrow. That means KafkaJS can advance the offset even though the handler failed. The notification consumers correctly avoid claiming idempotency until after success, but because the shared consumer wrapper swallows the error, failed events may not be redelivered.

**Reference:** `apps/api/src/kafka/kafka-consumer.service.ts`

**Fix:** rethrow handler failures and let Kafka retry, or implement explicit retry/DLQ inside `KafkaConsumerService`.

---

## BLOCKING 2 — Notification delivery can silently lose rows

`NotificationDeliveryWorker` marks queue rows `SENT` before actual delivery, then delivers afterward. If the process crashes after the status update but before Redis/log delivery, the row remains `SENT` and will not be retried.

**Reference:** `apps/api/src/notifications/notification-delivery.worker.ts`

**Fix:** use `PROCESSING`/lease semantics, or deliver while holding the row lock and only mark `SENT` after successful delivery. At minimum, do not use `SENT` as an in-flight state.

---

## MAJOR — Announcement manager scope is too broad

`AnnouncementService.isManager()` treats every `STAFF` actor as a manager. On `GET /announcements`, any staff user with `com-002:read` would be treated as manager and could see tenant-wide announcements, including drafts depending on query flags.

**Reference:** `apps/api/src/announcements/announcement.service.ts`

**Fix:** base manager capability on `com-002:write` or school-admin status, not `personType === STAFF`.

---

## Positive findings

- The envelope handoff and code are now aligned. The handoff defines Step 0 as replacing bare payloads with the ADR-057 envelope, and the producer now does that.
- Messaging endpoints are permission-protected and actor-scoped.
- Thread visibility is participant/admin scoped, with admin audit logging on non-participant reads.
- Notification enqueue has Redis idempotency and releases the Redis key when DB insert fails.

---

## Round 1 gate decision

**Reject pending fixes.**

Fix the shared Kafka consumer failure semantics and the notification delivery in-flight state. Then re-review for approval.

---

# Round 2 — Re-review at `592d366`

**Date:** April 28, 2026
**SHA:** `592d366` (commit `fix(cycle3): address ChatGPT review — consumer retry/DLQ, delivery state, manager scope`)
**Verdict:** **APPROVED**

## Summary

The three remaining findings from Round 1 are addressed.

## Fixed

1. **Kafka consumer failure handling.** `KafkaConsumerService` now rethrows handler failures until max attempts, then writes to `platform.platform_dlq_messages` and advances the partition. That resolves the at-least-once / DLQ concern.

   _Reference:_ `apps/api/src/kafka/kafka-consumer.service.ts`

2. **Notification delivery in-flight state.** The worker now uses `PENDING → PROCESSING → SENT`, with stale-`PROCESSING` recovery and retry/backoff. `SENT` no longer means "in flight."

   _Reference:_ `apps/api/src/notifications/notification-delivery.worker.ts`

3. **Announcement manager scope.** `isManager()` now checks school-admin or `com-002:write` in the tenant scope chain, instead of treating all staff as managers.

   _Reference:_ `apps/api/src/announcements/announcement.service.ts`

## Final gate decision

**Approved to proceed.**

## Carry-over for the next cycle

One follow-up to verify in the next cycle: ensure the `platform.platform_dlq_messages` table exists in migrations and is seeded/available in all environments, since the consumer now depends on it.

**Status of the follow-up at approval time:** the table is already in the platform Prisma migration `20260427211003_add_communications_platform_tables` (Cycle 3 Step 3), and the CI workflow runs `npx prisma migrate deploy --schema=prisma/platform/schema.prisma` so the table is created in CI and any environment that follows the deploy pipeline. The follow-up is therefore satisfied at the schema level; what remains is operational — wire a DLQ-row dashboard / alert into Phase 2 so a parked poison message gets human attention, not just a quiet row in a table.
