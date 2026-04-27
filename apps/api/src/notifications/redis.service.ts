import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * RedisService — best-effort ioredis wrapper for the notification pipeline.
 *
 * Cycle 3 Step 5 introduces Redis usage to the API for:
 *   - Notification idempotency: SET NX with TTL on
 *     `notif:idem:{tenantSubdomain}:{idempotencyKey}` (avoids the
 *     deadlock-prone DB UNIQUE on `msg_notification_queue.idempotency_key`
 *     called out in Step 2's design notes).
 *   - In-app delivery: ZADD into `notif:inapp:{accountId}` (sorted set,
 *     score = epoch ms, member = JSON). The Step 8 notification bell will
 *     ZRANGE this set to render unread.
 *   - Per-(user, thread) unread message counters for Step 6 messaging.
 *     Owned and incremented by `MessageNotificationConsumer`; the actual
 *     `UnreadCountService` ships in Step 6.
 *
 * Connection strategy mirrors KafkaProducerService — connect on module
 * init; if Redis is unreachable (common in dev when docker-compose hasn't
 * started Redis) log a warning and silently no-op on subsequent calls.
 * Request handling is never blocked.
 *
 * Idempotency TTL: 7 days. Long enough to dedupe a pathological Kafka
 * redelivery loop, short enough that the keyspace stays bounded.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private connected = false;

  async onModuleInit(): Promise<void> {
    var url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 2_000,
        maxRetriesPerRequest: 1,
        retryStrategy: function () {
          return null;
        },
      });
      this.client.on('error', (err) => {
        // Suppress connection-refused chatter while the broker is still down;
        // we already log the unavailable state once on connect failure below.
        if (this.connected) {
          this.logger.warn('Redis error: ' + (err?.message || String(err)));
        }
      });
      await this.client.connect();
      this.connected = true;
      this.logger.log('Connected to Redis at ' + url);
    } catch (e: any) {
      this.connected = false;
      this.logger.warn(
        'Redis unavailable; notification pipeline will skip Redis writes (best-effort mode). ' +
          (e?.message || e),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch (e: any) {
        this.logger.warn('Redis quit error: ' + (e?.message || e));
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Try to claim an idempotency key. Returns true on first claim, false if
   * the key already existed. Returns true (fail-open) when Redis is down so
   * the queue insert isn't blocked — the tenant DB index on
   * `idempotency_key` is the secondary read-side dedup signal.
   */
  async claimIdempotency(key: string, ttlSeconds = 60 * 60 * 24 * 7): Promise<boolean> {
    if (!this.connected || !this.client) return true;
    try {
      var result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (e: any) {
      this.logger.warn('Redis SET NX failed (' + key + '): ' + (e?.message || e));
      return true;
    }
  }

  /**
   * Drop an idempotency key — used when the post-claim insert fails so a
   * retry can re-claim the same key. Best-effort; failures are logged and
   * swallowed.
   */
  async releaseIdempotency(key: string): Promise<void> {
    if (!this.connected || !this.client) return;
    try {
      await this.client.del(key);
    } catch (e: any) {
      this.logger.warn('Redis DEL failed (' + key + '): ' + (e?.message || e));
    }
  }

  /**
   * Append an in-app notification to the recipient's sorted set. Keeps the
   * set capped at the most recent 100 entries to prevent unbounded growth.
   * Score is epoch ms so ZREVRANGE returns newest-first.
   */
  async pushInAppNotification(accountId: string, payload: object): Promise<void> {
    if (!this.connected || !this.client) return;
    var key = 'notif:inapp:' + accountId;
    try {
      await this.client.zadd(key, Date.now(), JSON.stringify(payload));
      // Keep last 100. ZREMRANGEBYRANK with negative indices trims the head.
      await this.client.zremrangebyrank(key, 0, -101);
    } catch (e: any) {
      this.logger.warn('Redis ZADD failed (' + key + '): ' + (e?.message || e));
    }
  }

  /**
   * Increment the per-(user, thread) unread counter. Used by the Step 6
   * messaging UnreadCountService and by MessageNotificationConsumer when a
   * new message hits the topic.
   */
  async incrementUnread(accountId: string, threadId: string): Promise<void> {
    if (!this.connected || !this.client) return;
    var key = 'inbox:' + accountId;
    try {
      await this.client.hincrby(key, threadId, 1);
    } catch (e: any) {
      this.logger.warn('Redis HINCRBY failed (' + key + '): ' + (e?.message || e));
    }
  }

  /**
   * Clear the per-(user, thread) unread counter. Called by the Step 6
   * UnreadCountService when a user opens a thread (POST /threads/:id/read).
   * Removes the field from the per-user inbox HASH so getBadgeCount no
   * longer includes it. Best-effort — failures degrade to "badge stays
   * stale until the next message arrives".
   */
  async clearUnread(accountId: string, threadId: string): Promise<void> {
    if (!this.connected || !this.client) return;
    var key = 'inbox:' + accountId;
    try {
      await this.client.hdel(key, threadId);
    } catch (e: any) {
      this.logger.warn('Redis HDEL failed (' + key + '): ' + (e?.message || e));
    }
  }

  /**
   * Sum every entry in the user's inbox HASH. Used by the badge endpoint
   * (GET /notifications/unread-count) to render a single number across all
   * threads. Returns 0 when Redis is unreachable so the bell shows no badge
   * rather than crashing.
   */
  async sumUnread(accountId: string): Promise<number> {
    if (!this.connected || !this.client) return 0;
    var key = 'inbox:' + accountId;
    try {
      var values = await this.client.hvals(key);
      var total = 0;
      for (var i = 0; i < values.length; i++) {
        var n = Number(values[i]);
        if (Number.isFinite(n) && n > 0) total += n;
      }
      return total;
    } catch (e: any) {
      this.logger.warn('Redis HVALS failed (' + key + '): ' + (e?.message || e));
      return 0;
    }
  }

  /**
   * Return the (threadId → unread count) map for the user. Used by the
   * inbox UI in Step 9 to render per-thread unread badges in one call.
   * Filters out zero / negative entries.
   */
  async listUnreadByThread(accountId: string): Promise<Record<string, number>> {
    if (!this.connected || !this.client) return {};
    var key = 'inbox:' + accountId;
    try {
      var raw = await this.client.hgetall(key);
      var out: Record<string, number> = {};
      var keys = Object.keys(raw);
      for (var i = 0; i < keys.length; i++) {
        var t = keys[i]!;
        var n = Number(raw[t]);
        if (Number.isFinite(n) && n > 0) out[t] = n;
      }
      return out;
    } catch (e: any) {
      this.logger.warn('Redis HGETALL failed (' + key + '): ' + (e?.message || e));
      return {};
    }
  }

  /**
   * Read the most-recent N in-app notifications for the recipient. Each
   * entry comes back with `score` (epoch ms — set by
   * `pushInAppNotification`) and `value` (the parsed JSON body that the
   * delivery worker wrote). Returns newest-first.
   *
   * Returns empty when Redis is unavailable so the inbox UI degrades to
   * "no recent notifications" rather than throwing.
   */
  async listInAppNotifications(
    accountId: string,
    limit: number,
  ): Promise<Array<{ score: number; value: Record<string, unknown> }>> {
    if (!this.connected || !this.client) return [];
    var key = 'notif:inapp:' + accountId;
    try {
      var raw = await this.client.zrevrange(key, 0, Math.max(0, limit - 1), 'WITHSCORES');
      var out: Array<{ score: number; value: Record<string, unknown> }> = [];
      for (var i = 0; i < raw.length; i += 2) {
        var member = raw[i]!;
        var score = Number(raw[i + 1]);
        try {
          var parsed = JSON.parse(member);
          if (parsed && typeof parsed === 'object') {
            out.push({ score: score, value: parsed as Record<string, unknown> });
          }
        } catch {
          // Skip malformed members rather than failing the whole call.
        }
      }
      return out;
    } catch (e: any) {
      this.logger.warn('Redis ZREVRANGE failed (' + key + '): ' + (e?.message || e));
      return [];
    }
  }

  /**
   * Count entries in the in-app sorted set with score strictly greater
   * than `sinceMs`. Used by the bell badge to render unread = (delivered
   * after lastReadAt). Returns 0 when Redis is unavailable.
   */
  async countInAppSince(accountId: string, sinceMs: number): Promise<number> {
    if (!this.connected || !this.client) return 0;
    var key = 'notif:inapp:' + accountId;
    try {
      // ZCOUNT min max — using "(sinceMs" makes the lower bound exclusive
      // so an item with score === sinceMs is treated as "already read".
      var n = await this.client.zcount(key, '(' + sinceMs, '+inf');
      return Number(n) || 0;
    } catch (e: any) {
      this.logger.warn('Redis ZCOUNT failed (' + key + '): ' + (e?.message || e));
      return 0;
    }
  }

  /**
   * Read the user's last-read timestamp (epoch ms as string). Returns 0
   * when no key exists — meaning every delivered notification is unread.
   */
  async getNotificationLastReadAt(accountId: string): Promise<number> {
    if (!this.connected || !this.client) return 0;
    var key = 'notif:lastread:' + accountId;
    try {
      var raw = await this.client.get(key);
      if (!raw) return 0;
      var n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch (e: any) {
      this.logger.warn('Redis GET failed (' + key + '): ' + (e?.message || e));
      return 0;
    }
  }

  /**
   * Bump the user's last-read timestamp to `ms`. Best-effort. The bell
   * calls this on "Mark all read"; the badge count goes to zero
   * immediately on the next poll.
   *
   * Stored as plain string with no TTL — the keyspace stays bounded by
   * the active-user count, which is much smaller than the queue keyspace.
   */
  async setNotificationLastReadAt(accountId: string, ms: number): Promise<void> {
    if (!this.connected || !this.client) return;
    var key = 'notif:lastread:' + accountId;
    try {
      await this.client.set(key, String(ms));
    } catch (e: any) {
      this.logger.warn('Redis SET failed (' + key + '): ' + (e?.message || e));
    }
  }
}
