import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnnouncementService } from './announcement.service';
import { AnnouncementController } from './announcement.controller';
import { AudienceFanOutWorker } from './audience-fan-out.worker';

/**
 * AnnouncementsModule — M40 Communications announcements (Cycle 3 Step 7).
 *
 * Wires the request-path AnnouncementService + 6 endpoints, plus the
 * AudienceFanOutWorker Kafka consumer that resolves the audience for every
 * `msg.announcement.published` event and pre-populates
 * `msg_announcement_audiences` so the read path can render announcements
 * with a single `WHERE platform_user_id = ?` lookup.
 *
 * Endpoints — all gated on `com-002:read` / `com-002:write`:
 *   GET    /announcements                  list (manager → all, reader → audience-scoped)
 *   GET    /announcements/:id              single (404 when not visible)
 *   POST   /announcements                  create (draft or publish-now)
 *   PATCH  /announcements/:id              edit draft (or flip to published)
 *   POST   /announcements/:id/read         mark read (idempotent)
 *   GET    /announcements/:id/stats        audience + read counts (author/admin only)
 *
 * Imports:
 *   - TenantModule for TenantPrismaService
 *   - IamModule for ActorContextService (manager / author scoping)
 *   - KafkaModule for the producer (msg.announcement.published) + consumer
 *     plumbing the worker subscribes through
 *   - NotificationsModule for NotificationQueueService (the worker enqueues
 *     one announcement.published notification per audience member)
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
  providers: [AnnouncementService, AudienceFanOutWorker],
  controllers: [AnnouncementController],
  exports: [AnnouncementService],
})
export class AnnouncementsModule {}
