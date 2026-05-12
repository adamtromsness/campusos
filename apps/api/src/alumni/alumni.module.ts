import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AlumniProfileService, AlumniTagService } from './profile.service';
import { CampaignService, DonationService, OutreachService } from './campaign.service';
import { AlumniEventService, AlumniNewsService, ReunionGroupService } from './news.service';
import { AlumniController } from './alumni.controller';

/**
 * Alumni Module — M102 (Phase 2 Cycle 22, Wave D Module Completion).
 *
 * 8 services + 1 controller + ~28 endpoints under PUB-004 + 2 Kafka
 * emit topics (alm.campaign.activated, alm.donation.received).
 *
 * Three structural keystones:
 *   1. ADR-055 identity — alm_alumni_profiles links to platform.iam_person
 *      via person_id (soft cross-schema ref per ADR-001/020). The
 *      same identity record an alumnus held as a student is reused
 *      so portfolio, achievements, and household links carry over.
 *      RLS: alumni read + update only their OWN row; admins bypass.
 *      Opt-out is hidden from the public directory but visible to
 *      the owner and admin.
 *   2. Multi-currency donations — alm_donations stores amount +
 *      currency + fx_rate_at_donation + amount_in_reporting_currency.
 *      Campaign totals SUM the reporting currency column, cached in
 *      Redis campaign:raised:{id} TTL=5min, invalidated on every
 *      INSERT. The DonationService computes
 *      amount_in_reporting_currency before insert with explicit
 *      Math.round to 2dp.
 *   3. Soft P2-12 Events linkage — alm_events.evt_event_id has NO FK
 *      constraint by design. The AlumniEventService resolves at
 *      read time and gracefully falls back to rsvp_url when the
 *      Events module is not enabled or the row is missing. The
 *      Alumni module compiles and runs regardless of Events status.
 *
 * Permission code: PUB-004 (already in catalogue from earlier waves).
 * Distribution:
 *   - Teacher / Parent: PUB-004:read (browse directory)
 *   - Student: PUB-004:read + write (own profile management once
 *     graduated; service-layer row-scope enforces own-only)
 *   - Staff: PUB-004:read + write (alumni office operator —
 *     campaigns + news + events + reunions)
 *   - School Admin / Platform Admin: read + write + admin via
 *     everyFunction (configuration surfaces)
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
  providers: [
    AlumniProfileService,
    AlumniTagService,
    CampaignService,
    DonationService,
    OutreachService,
    AlumniNewsService,
    ReunionGroupService,
    AlumniEventService,
  ],
  controllers: [AlumniController],
  exports: [
    AlumniProfileService,
    AlumniTagService,
    CampaignService,
    DonationService,
    OutreachService,
    AlumniNewsService,
    ReunionGroupService,
    AlumniEventService,
  ],
})
export class AlumniModule {}
