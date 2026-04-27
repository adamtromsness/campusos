import { Injectable } from '@nestjs/common';
import { RedisService } from '../notifications/redis.service';

/**
 * UnreadCountService — Cycle 3 Step 6.
 *
 * Redis-backed per-(user, thread) unread counter. Owns the read + clear
 * surface against the `inbox:{accountId}` HASH; the increment side already
 * lives in `RedisService.incrementUnread()` (called by
 * MessageService.post() and by MessageNotificationConsumer).
 *
 * The service intentionally never queries `msg_messages` or
 * `msg_message_reads` for counts — at scale the partitioned messages table
 * + per-message read receipts is the wrong shape for a hot badge query.
 * The Redis HASH is the source of truth for the unread badge; the
 * `msg_message_reads` table is the durable record of who read what + when
 * (audit + future cross-device sync).
 *
 * Best-effort against Redis: if the client is down `getBadgeCount` returns
 * 0 (no badge) and `clearThread` is a no-op. The Step 8 NotificationBell
 * shouldn't crash because Redis is restarting.
 */
@Injectable()
export class UnreadCountService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Increment the (user, thread) counter. Called by MessageService.post()
   * for every active recipient at message-send time so the badge updates
   * immediately even if the Kafka consumer lags. Step 5's
   * MessageNotificationConsumer also calls this path on consume — the
   * second increment is redundant for the request-path case but covers
   * messages produced from outside HTTP (workers, future system threads).
   */
  async increment(accountId: string, threadId: string): Promise<void> {
    await this.redis.incrementUnread(accountId, threadId);
  }

  /**
   * Clear the (user, thread) counter. Called when the user opens a thread
   * (POST /threads/:threadId/read). Single HDEL — fast, atomic.
   */
  async clearThread(accountId: string, threadId: string): Promise<void> {
    await this.redis.clearUnread(accountId, threadId);
  }

  /**
   * Total unread across every thread the user is a participant in. Used
   * by GET /notifications/unread-count for the top-bar badge. Returns 0
   * when Redis is unavailable.
   */
  async getBadgeCount(accountId: string): Promise<number> {
    return this.redis.sumUnread(accountId);
  }

  /**
   * Per-thread unread map. Used by GET /threads (inbox) so the UI can
   * render an unread badge next to each thread row in one round-trip.
   */
  async getByThread(accountId: string): Promise<Record<string, number>> {
    return this.redis.listUnreadByThread(accountId);
  }
}
