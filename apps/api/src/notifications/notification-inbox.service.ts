import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { RedisService } from './redis.service';

/**
 * NotificationInboxService — the read side of the Step 5 notification
 * pipeline (Cycle 3 Step 8).
 *
 * The Step 8 NotificationBell needs three things:
 *   - a single badge count for everything the user hasn't seen yet,
 *   - a "last 10 recent" list for the dropdown,
 *   - a paginated history page at /notifications.
 *
 * Storage layout (recap from Step 5):
 *   - Redis sorted set `notif:inapp:{accountId}` — last 100 IN_APP
 *     deliveries, score=epoch ms, member={queue_id, notification_type,
 *     payload, delivered_at}. Capped by `pushInAppNotification`.
 *   - `msg_notification_queue` — durable per-recipient row for every
 *     enqueue, status=PENDING/SENT/FAILED. Holds the JSONB payload.
 *   - `msg_notification_log` — partitioned per-channel delivery audit.
 *
 * "Read" state for the bell is a single timestamp per user
 * (`notif:lastread:{accountId}`). Anything delivered with a higher score
 * is unread. This avoids per-message read-receipt churn for what is
 * fundamentally a bell badge — the user opens the bell, "everything I
 * just saw becomes read", and the count goes to zero. Per-item dismissal
 * isn't a Phase 1 requirement.
 *
 * The dropdown reads from Redis (cheap; the worker maintains the cap).
 * The /notifications page reads from `msg_notification_queue` so the
 * full history (older than 100 most-recent) is reachable.
 */
@Injectable()
export class NotificationInboxService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Fetch the last `limit` in-app notifications + the unread count for the
   * given account. Used by the NotificationBell dropdown.
   *
   * `unreadCount` is `ZCOUNT > lastReadAt` against the same sorted set
   * the dropdown reads. The same cap (100) applies to the count, which
   * is fine for a UI badge — anything over 99 is rendered as "99+".
   */
  async getInbox(accountId: string, limit: number): Promise<InboxResult> {
    var lastReadAt = await this.redis.getNotificationLastReadAt(accountId);
    var raw = await this.redis.listInAppNotifications(accountId, limit);
    var items: NotificationInboxItem[] = raw.map((entry) => toInboxItem(entry, lastReadAt));
    var unreadCount = await this.redis.countInAppSince(accountId, lastReadAt);
    return { unreadCount: unreadCount, items: items, lastReadAt: lastReadAt };
  }

  /**
   * Bump the last-read timestamp to "now" so the badge clears on the
   * next poll. Idempotent — calling repeatedly just sets the timestamp
   * forward. Returns the value written.
   */
  async markAllRead(accountId: string): Promise<number> {
    var now = Date.now();
    await this.redis.setNotificationLastReadAt(accountId, now);
    return now;
  }

  /**
   * Paginated history reads from `msg_notification_queue`. We page by
   * `(sent_or_created_at, id)` keyset so a stable cursor works across
   * partitions in the future.
   *
   * Tenant-scoped: must run inside `executeInTenantContext`. The caller
   * (controller) is request-bound and resolves tenant via the resolver
   * middleware, so the surrounding context is already pinned.
   */
  async getHistory(accountId: string, opts: HistoryOptions): Promise<HistoryResult> {
    var limit = clampLimit(opts.limit, 25, 100);
    var lastReadAt = await this.redis.getNotificationLastReadAt(accountId);

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // Filter to delivered + currently-pending; FAILED rows aren't useful
      // to render in a user-facing inbox. Type filter is exact-match.
      var sql =
        'SELECT id::text AS id, ' +
        '       notification_type, ' +
        '       payload, ' +
        '       status, ' +
        '       COALESCE(sent_at, created_at) AS occurred_at ' +
        'FROM msg_notification_queue ' +
        "WHERE recipient_id = $1::uuid AND status IN ('SENT','PENDING') ";
      var args: unknown[] = [accountId];
      var nextIdx = 2;
      if (opts.type && opts.type.length > 0) {
        sql += 'AND notification_type = $' + nextIdx + ' ';
        args.push(opts.type);
        nextIdx++;
      }
      if (opts.before) {
        sql += 'AND COALESCE(sent_at, created_at) < $' + nextIdx + '::timestamptz ';
        args.push(opts.before);
        nextIdx++;
      }
      sql += 'ORDER BY COALESCE(sent_at, created_at) DESC, id DESC ';
      sql += 'LIMIT $' + nextIdx;
      args.push(limit + 1);
      return client.$queryRawUnsafe<HistoryRow[]>(sql, ...args);
    });

    var hasMore = rows.length > limit;
    var sliced = hasMore ? rows.slice(0, limit) : rows;
    var items = sliced.map((r) => historyRowToItem(r, lastReadAt));
    var nextCursor = hasMore ? sliced[sliced.length - 1]!.occurred_at.toISOString() : null;
    return { items: items, nextCursor: nextCursor, lastReadAt: lastReadAt };
  }
}

interface HistoryRow {
  id: string;
  notification_type: string;
  payload: unknown;
  status: string;
  occurred_at: Date;
}

export interface HistoryOptions {
  limit?: number;
  type?: string;
  /** ISO timestamp keyset cursor — return rows strictly older than this. */
  before?: string;
}

export interface NotificationInboxItem {
  /** queue id (when known) — stable handle for the future per-item dismiss. */
  id: string | null;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  isRead: boolean;
}

export interface InboxResult {
  unreadCount: number;
  items: NotificationInboxItem[];
  /** Epoch ms; 0 if the user has never opened the bell. */
  lastReadAt: number;
}

export interface HistoryResult {
  items: NotificationInboxItem[];
  nextCursor: string | null;
  lastReadAt: number;
}

function toInboxItem(
  entry: { score: number; value: Record<string, unknown> },
  lastReadAt: number,
): NotificationInboxItem {
  var v = entry.value;
  var queueId = typeof v.queue_id === 'string' ? v.queue_id : null;
  var type = typeof v.notification_type === 'string' ? v.notification_type : 'unknown';
  var deliveredAt =
    typeof v.delivered_at === 'string' ? v.delivered_at : new Date(entry.score).toISOString();
  var payload =
    v.payload && typeof v.payload === 'object' ? (v.payload as Record<string, unknown>) : {};
  return {
    id: queueId,
    type: type,
    occurredAt: deliveredAt,
    payload: payload,
    isRead: entry.score <= lastReadAt,
  };
}

function historyRowToItem(row: HistoryRow, lastReadAt: number): NotificationInboxItem {
  var occurredMs = row.occurred_at.getTime();
  var payload =
    row.payload && typeof row.payload === 'object'
      ? (row.payload as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    type: row.notification_type,
    occurredAt: row.occurred_at.toISOString(),
    payload: payload,
    isRead: occurredMs <= lastReadAt,
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 1) return 1;
  if (value > max) return max;
  return Math.floor(value);
}
