import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { KafkaModule } from '../kafka/kafka.module';
import { RedisService } from './redis.service';
import { NotificationQueueService } from './notification-queue.service';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationInboxController } from './notification-inbox.controller';
import { AttendanceNotificationConsumer } from './consumers/attendance-notification.consumer';
import { GradeNotificationConsumer } from './consumers/grade-notification.consumer';
import { ProgressNoteNotificationConsumer } from './consumers/progress-note-notification.consumer';
import { AbsenceRequestNotificationConsumer } from './consumers/absence-request-notification.consumer';
import { MessageNotificationConsumer } from './consumers/message-notification.consumer';
import { TicketNotificationConsumer } from './consumers/ticket-notification.consumer';

/**
 * NotificationsModule — M40 notification pipeline (Cycle 3 Step 5).
 *
 * Wires the five Kafka consumers that close the event loop from Cycles 1
 * and 2 (attendance, grade, progress-note, absence-request) plus the
 * forward-compatible message-posted consumer that the Step 6 messaging
 * service will produce against. Each consumer:
 *
 *   - subscribes via KafkaConsumerService under its own consumer group,
 *   - reads tenant + event id off the ADR-057 envelope (with header
 *     fallback), guards reprocessing through `IdempotencyService.isClaimed`,
 *   - resolves recipient accounts inside `runWithTenantContextAsync`, and
 *   - calls NotificationQueueService.enqueue() which applies the
 *     preference + quiet-hours + Redis SET NX checks and inserts a
 *     PENDING row into `msg_notification_queue`.
 *
 * NotificationDeliveryWorker polls every active tenant on a 10-second
 * tick and drains PENDING rows: writes the in-app sorted set in Redis
 * for IN_APP recipients, stubs EMAIL / PUSH / SMS (Phase 3 wiring), and
 * records each attempt in `msg_notification_log`.
 *
 * Redis is a hard dependency for the IN_APP path; the RedisService is
 * best-effort on connection — if Redis is unreachable the worker logs and
 * skips the in-app push but continues to write logs and stub the other
 * channels so the queue rows still drain.
 */
@Module({
  imports: [TenantModule, KafkaModule],
  providers: [
    RedisService,
    NotificationQueueService,
    NotificationDeliveryWorker,
    NotificationInboxService,
    AttendanceNotificationConsumer,
    GradeNotificationConsumer,
    ProgressNoteNotificationConsumer,
    AbsenceRequestNotificationConsumer,
    MessageNotificationConsumer,
    TicketNotificationConsumer,
  ],
  controllers: [NotificationInboxController],
  exports: [
    RedisService,
    NotificationQueueService,
    NotificationDeliveryWorker,
    NotificationInboxService,
  ],
})
export class NotificationsModule {}
