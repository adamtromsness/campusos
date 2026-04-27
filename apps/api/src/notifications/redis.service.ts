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
}
