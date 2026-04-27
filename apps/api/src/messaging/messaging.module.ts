import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ThreadService } from './thread.service';
import { MessageService } from './message.service';
import { UnreadCountService } from './unread-count.service';
import { ContentModerationService } from './content-moderation.service';
import { ThreadController } from './thread.controller';
import { MessageController } from './message.controller';
import { NotificationBadgeController } from './notification-badge.controller';

/**
 * MessagingModule — M40 Communications messaging core (Cycle 3 Step 6).
 *
 * Wires the four request-path services:
 *   - ThreadService — create / list / read / archive threads, validates
 *     participant roles against `msg_thread_types.allowed_participant_roles`.
 *   - MessageService — post, edit (author-only, 15-min window), soft-delete,
 *     list. Routes every post through ContentModerationService and emits
 *     `msg.message.posted` so the Step 5 MessageNotificationConsumer fans
 *     out IN_APP notifications + bumps inbox HASH counters.
 *   - UnreadCountService — Redis-backed badge counter. Reads / clears the
 *     `inbox:{accountId}` HASH; the increment side is shared with the
 *     Step 5 consumer so request path + Kafka path converge on the same
 *     key.
 *   - ContentModerationService — three-tier (PLATFORM → DISTRICT →
 *     BUILDING) keyword check. Most-restrictive-action wins. Writes a
 *     `msg_moderation_log` row for every non-CLEAN verdict.
 *
 * Endpoints — all gated on `com-001:read` / `com-001:write`:
 *   GET    /threads                          inbox
 *   GET    /threads/:id                      single thread (with FERPA admin audit)
 *   POST   /threads                          create thread (+ optional initialMessage)
 *   POST   /threads/:id/read                 mark every unread message read
 *   PATCH  /threads/:id/archive              archive / unarchive
 *   GET    /threads/:id/messages             paginated message list
 *   POST   /threads/:id/messages             post (moderation + emit + unread bump)
 *   PATCH  /messages/:id                     edit (author + 15min window)
 *   DELETE /messages/:id                     soft-delete (sender or admin)
 *   GET    /notifications/unread-count       badge count (top bar)
 *
 * Imports:
 *   - TenantModule for TenantPrismaService
 *   - IamModule for ActorContextService (row-level auth + admin status)
 *   - KafkaModule for the producer (msg.message.posted)
 *   - NotificationsModule for RedisService (UnreadCountService delegates
 *     to it; the Step 5 MessageNotificationConsumer also writes the same
 *     keys, so we hit one shared connection)
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
  providers: [ThreadService, MessageService, UnreadCountService, ContentModerationService],
  controllers: [ThreadController, MessageController, NotificationBadgeController],
  exports: [ThreadService, MessageService, UnreadCountService, ContentModerationService],
})
export class MessagingModule {}
