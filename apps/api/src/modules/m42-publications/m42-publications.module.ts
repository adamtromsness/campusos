import { Module, OnModuleInit } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { NotificationsModule } from '@modules/m40-communications';
import {
  CollaboratorService,
  EditionService,
  PublicationService,
  SeriesService,
} from './series.service';
import { CommentService, ContributorService, SectionService } from './sections.service';
import { DistributionService, SubscriptionService } from './distribution.service';
import { TemplateService, VersionService } from './versions.service';
import {
  PublicationAnalyticsService,
  ScheduledPublishService,
  ScheduledPublishWorker,
} from './scheduled-publish.service';
import { PublicationsController } from './publications.controller';

/**
 * Publications Module — M42 (Cycle 25) + M25 .1 (P2-26).
 *
 * Cycle 25 surface: 9 services + 1 controller + ~34 endpoints +
 * 1 Kafka emit topic (pub.publication.published).
 *
 * P2-26 additions:
 *   - VersionService — IMMUTABLE pub_publication_versions writer with
 *     auto-hook into PublicationService.patchStatus that creates a
 *     STATUS_CHANGE version inside the same tenant tx as the status flip.
 *   - TemplateService — pub_templates CRUD + FROM-TEMPLATE keystone that
 *     auto-populates sections from template_content.sections.
 *   - ScheduledPublishService + ScheduledPublishWorker — scheduled
 *     publishing with timezone-aware queue. Worker fires every minute,
 *     atomically flips schedule + parent publication + creates final
 *     STATUS_CHANGE version + emits pub.publication.published.
 *   - PublicationAnalyticsService — per-publication engagement counters
 *     with atomic SQL-level increments + Redis-backed unique-view dedup.
 *
 * Four structural keystones added in P2-26:
 *   1. Version IMMUTABILITY — pub_publication_versions has NO UPDATE,
 *      NO DELETE at the service layer. Revert creates a NEW version.
 *   2. Template is_system protection — admins + staff cannot edit or
 *      delete is_system=true templates (only the platform seeder writes
 *      those rows).
 *   3. Scheduled publish atomic state machine — worker tx flips schedule
 *      + publication + creates version + emits Kafka, all inside one
 *      tenant tx with deterministic event_id.
 *   4. Analytics atomic counters — UPDATE ... SET counter = counter + 1
 *      so concurrent events from Cycle 14 fan-out cannot lose counts.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
  providers: [
    SeriesService,
    EditionService,
    PublicationService,
    CollaboratorService,
    SectionService,
    ContributorService,
    CommentService,
    DistributionService,
    SubscriptionService,
    VersionService,
    TemplateService,
    ScheduledPublishService,
    PublicationAnalyticsService,
    ScheduledPublishWorker,
  ],
  controllers: [PublicationsController],
  exports: [
    SeriesService,
    EditionService,
    PublicationService,
    SectionService,
    DistributionService,
    SubscriptionService,
    VersionService,
    TemplateService,
    ScheduledPublishService,
    PublicationAnalyticsService,
  ],
})
export class PublicationsModule implements OnModuleInit {
  constructor(
    private readonly publicationService: PublicationService,
    private readonly versionService: VersionService,
  ) {}

  // Bridge VersionService into PublicationService.patchStatus so the
  // auto-version hook fires on every status transition. Done via a
  // setter to dodge the circular constructor dependency.
  onModuleInit(): void {
    this.publicationService.setVersionService(this.versionService);
  }
}
