import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { ActivityService } from './activity.service';
import { MembershipService } from './membership.service';
import { ScheduleService } from './schedule.service';
import { FieldTripService } from './field-trip.service';
import { ConsentService } from './consent.service';
import { ChaperoneService } from './chaperone.service';
import { ElectionService } from './election.service';
import { VoteService } from './vote.service';
import { ServiceProgrammeService } from './service-programme.service';
import { ServiceHourService } from './service-hour.service';
import { ClubsController } from './clubs.controller';

/**
 * Clubs Module — M64 Clubs and Student Life (Cycle 17).
 *
 * 10 services + 1 controller + ~36 endpoints across 4 domains:
 *   1. Activity types + activities + membership + schedules.
 *   2. Field trips + parent consent (PARENT CONSENT KEYSTONE) +
 *      chaperones. Emits ext.consent.received.
 *   3. Elections + candidates + structurally anonymous voting
 *      (ANONYMITY KEYSTONE — ext_votes carries no voter identity)
 *      + results aggregation. Emits ext.election.results.published.
 *   4. Service programmes + student hour logging (STUDENT-INPUT
 *      KEYSTONE — third student-input surface in CampusOS) +
 *      supervisor approval + per-(programme, student) progress.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    ActivityService,
    MembershipService,
    ScheduleService,
    FieldTripService,
    ConsentService,
    ChaperoneService,
    ElectionService,
    VoteService,
    ServiceProgrammeService,
    ServiceHourService,
  ],
  controllers: [ClubsController],
  exports: [
    ActivityService,
    MembershipService,
    ScheduleService,
    FieldTripService,
    ConsentService,
    ChaperoneService,
    ElectionService,
    VoteService,
    ServiceProgrammeService,
    ServiceHourService,
  ],
})
export class ClubsModule {}
