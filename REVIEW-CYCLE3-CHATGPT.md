# Cycle 3 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Date:** April 28, 2026
**Scope:** Full Cycle 3 (Communications — messaging, notifications, announcements, moderation, vertical-slice CAT)
**Reviewed at SHA:** `7c7e3d4` (commit `feat: Cycle 3 Step 11 — vertical-slice CAT (cycle complete)`)
**Verdict:** **REJECT pending two reliability/security fixes**

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

## Final gate decision

**Reject pending fixes.**

Fix the shared Kafka consumer failure semantics and the notification delivery in-flight state. Then re-review for approval.
