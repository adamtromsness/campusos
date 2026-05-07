# Redis Cache Invalidation Contracts (Cycle 31 Step 6)

Every Redis cache entry in CampusOS has a written invalidation
contract. The TTL is the worst-case staleness bound; the explicit
invalidation event is the primary mechanism. **No cache without a
documented invalidation path.**

## IAM effective access — `iam:access:{accountId}:{scopeId}`

| Field          | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Owner          | `apps/api/src/iam/permission-check.service.ts`                   |
| Value shape    | `string[]` — array of permission codes                           |
| TTL            | 300 seconds                                                      |
| Invalidator    | `iam.role_assignment.changed`, `iam.account.suspended` (Phase 2) |
| Sub-second SLA | Yes — 500ms primary-sticky window per ADR-009                    |
| Fallback       | `iam_effective_access_cache` table on miss                       |

The Phase 2 IAM Invalidation Consumer subscribes to the two
invalidator topics and calls `PermissionCheckService.invalidate()`
synchronously. Until that consumer ships, the 5-minute TTL is the
staleness bound.

## Unread message counts — `inbox:{accountId}` (existing, Cycle 3)

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Owner       | `apps/api/src/notifications/redis.service.ts`             |
| Value shape | HASH `{threadId: count}`                                  |
| TTL         | None (managed via HDEL on read + HINCRBY on write)        |
| Invalidator | Sender `MessageService.post` HINCRBYs other participants; |
|             | `ThreadService.markRead` HDELs sender's own field         |
| Fallback    | `msg_message_reads` join on miss                          |

## Catalogue available copies — `lib:avail:{itemId}` (Phase 2 polish)

| Field       | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| Owner       | `apps/api/src/library/catalogue-item.service.ts`                 |
| Value shape | `{ totalCopies: number, availableCopies: number }`               |
| TTL         | 60 seconds                                                       |
| Invalidator | `lib.checkout.created`, `lib.checkout.returned` (Phase 2 events) |
| Fallback    | DB COUNT(\*) on miss                                             |

## Curriculum delivery gaps — `cur:gaps:{mapId}` (Phase 2 polish)

| Field       | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Owner       | `apps/api/src/curriculum/delivery-gap.service.ts`                       |
| Value shape | `{ unitId, standardCode, gapType, lessonsPlanned, lessonsDelivered }[]` |
| TTL         | 1 hour                                                                  |
| Invalidator | Nightly `cur.delivery_gap.detected` worker run                          |
| Fallback    | DB SELECT on miss                                                       |

## Family account balance — `ledger:balance:{accountId}` (existing, Cycle 6)

| Field       | Value                                         |
| ----------- | --------------------------------------------- |
| Owner       | `apps/api/src/payments/ledger.service.ts`     |
| Value shape | `number` (signed balance, USD cents in dev)   |
| TTL         | 30 seconds                                    |
| Invalidator | Same-tx Redis DEL inside every ledger write   |
| Fallback    | `SUM(amount) FROM pay_ledger_entries` on miss |

## Notification last-read — `notif:lastread:{accountId}` (existing, Cycle 3)

| Field       | Value                                         |
| ----------- | --------------------------------------------- |
| Owner       | `apps/api/src/notifications/redis.service.ts` |
| Value shape | `number` (epoch milliseconds)                 |
| TTL         | None                                          |
| Invalidator | `POST /notifications/mark-all-read`           |
| Fallback    | Treat all entries as unread on miss           |

## In-app notification feed — `notif:inapp:{accountId}` (existing, Cycle 3)

| Field       | Value                                                      |
| ----------- | ---------------------------------------------------------- |
| Owner       | `apps/api/src/notifications/redis.service.ts`              |
| Value shape | Sorted set of `{notificationId}` keyed by `score=epoch_ms` |
| TTL         | None (capped at 100 entries via ZREMRANGEBYRANK)           |
| Invalidator | NotificationDeliveryWorker writes; user dismissal removes  |
| Fallback    | `msg_notification_log` query on miss                       |

## Idempotency keys — various prefixes

The `notif:idem:`, `tsk:auto:`, `lib:hold:`, etc. SET-NX keys are
**not** caches — they're claim tokens. They have TTLs but no
invalidation events. Reaching the TTL means a duplicate would be
re-allowed (acceptable — the schema-side UNIQUE / partial UNIQUE is
the secondary read-side dedup signal).

---

**Adding a new cache:** open a PR that updates this document FIRST
with the new key prefix, value shape, TTL, and invalidation event.
A cache without a contract entry fails review.
