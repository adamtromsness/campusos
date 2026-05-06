import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import {
  CollaboratorService,
  EditionService,
  PublicationService,
  SeriesService,
} from './series.service';
import { CommentService, ContributorService, SectionService } from './sections.service';
import { DistributionService, SubscriptionService } from './distribution.service';
import { PublicationsController } from './publications.controller';

/**
 * Publications Module — M42 (Cycle 25).
 *
 * 9 services + 1 controller + ~34 endpoints + 1 Kafka emit topic
 * (pub.publication.published). Closes Wave 5 (Academic Advanced).
 *
 * Three structural keystones:
 *   1. ADR-035 approval gate — student-authored sections require an
 *      editor or admin to flip is_approved=true before the parent
 *      publication can advance to APPROVED.
 *   2. Rule-based audience resolution — pub_distribution_rules
 *      walks ROLE / GRADE / CLASS / GROUP_MEMBERSHIP and OR-aggregates
 *      matching account_ids, excluding subscribers who have
 *      UNSUBSCRIBED from the series.
 *   3. Delivery tracking — pub_distribution_recipients carries
 *      PENDING / DELIVERED / OPENED / BOUNCED and the deliveryStatus
 *      endpoint rolls up per-publication metrics.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
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
  ],
  controllers: [PublicationsController],
  exports: [
    SeriesService,
    EditionService,
    PublicationService,
    SectionService,
    DistributionService,
    SubscriptionService,
  ],
})
export class PublicationsModule {}
