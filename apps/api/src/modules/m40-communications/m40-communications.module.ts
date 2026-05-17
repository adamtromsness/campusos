import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications/notifications.module';
import { MessagingModule } from './messaging/messaging.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { EmergencyAlertsModule } from './emergency-alerts/emergency-alerts.module';
import { CommunicationsAdvancedModule } from './messaging/communications-advanced.module';

/**
 * M40 Communications — canonical aggregator for notifications,
 * messaging, announcements, emergency-alerts, and communications-
 * advanced (translation, templates, broadcast analytics, moderation).
 */
@Module({
  imports: [
    NotificationsModule,
    MessagingModule,
    AnnouncementsModule,
    EmergencyAlertsModule,
    CommunicationsAdvancedModule,
  ],
  exports: [
    NotificationsModule,
    MessagingModule,
    AnnouncementsModule,
    EmergencyAlertsModule,
    CommunicationsAdvancedModule,
  ],
})
export class M40CommunicationsModule {}
