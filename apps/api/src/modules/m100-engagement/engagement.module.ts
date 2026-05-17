import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { EngagementController } from './engagement.controller';
import { ConferenceEventService } from './conference-event.service';
import { ConferenceSlotService } from './conference-slot.service';
import { ConferenceBookingService } from './conference-booking.service';
import { ConferenceStatusWorker } from './conference-status.worker';
import { EngagementScoreService } from './engagement-score.service';
import { EngagementScoreWorker } from './engagement-score.worker';
import { ParentSurveyService } from './parent-survey.service';

/**
 * Parent Engagement Module — M100 (P2-24a).
 *
 * 5 services + 1 controller + 2 background workers + ~24 endpoints +
 * 2 Kafka emit topics (eng.conference.booking_open,
 * eng.survey.opened — both durable via the platform outbox).
 *
 * Three structural keystones:
 *   1. ATOMIC CONFERENCE SLOT BOOKING — ConferenceBookingService.book
 *      runs the canonical lock-free UPDATE … WHERE status='AVAILABLE'
 *      pattern. Zero rows returned = 409 Conflict. Postgres serialises
 *      concurrent UPDATEs so exactly one wins the transition.
 *   2. CROSS-MODULE ENGAGEMENT SCORING — EngagementScoreWorker reads
 *      from 5 source modules (sis_attendance_records,
 *      msg_message_reads, eng_conference_bookings, evt_volunteers,
 *      pay_invoices) and computes a composite score per family.
 *      Weights + thresholds are configurable per school via
 *      school_config (engagement_score_weights +
 *      engagement_level_thresholds).
 *   3. ANONYMOUS SURVEY CONTRACT — ParentSurveyService.submitResponse
 *      NEVER stores respondent_id when survey.is_anonymous=true. The
 *      contract is enforced at the service layer; aggregated rollups
 *      live in response_data_aggregated and never expose raw text.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    ConferenceEventService,
    ConferenceSlotService,
    ConferenceBookingService,
    ConferenceStatusWorker,
    EngagementScoreService,
    EngagementScoreWorker,
    ParentSurveyService,
  ],
  controllers: [EngagementController],
  exports: [
    ConferenceEventService,
    ConferenceSlotService,
    ConferenceBookingService,
    ConferenceStatusWorker,
    EngagementScoreService,
    EngagementScoreWorker,
    ParentSurveyService,
  ],
})
export class EngagementModule {}
