import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { ApplicationService } from './application.service';
import { InterviewService } from './interview.service';
import { JobPostingService } from './job-posting.service';
import { OfferService } from './offer.service';
import { RecruitmentController } from './recruitment.controller';

/**
 * Recruitment Module — P2C4 sub-cycle b.
 *
 * 4 services + 1 controller + ~22 endpoints + 2 Kafka emit topics
 * (hr.job.posted on LIVE transition; hr.offer.accepted on offer
 * accept). Both emits go through OutboxService.enqueueInTx so a
 * Kafka outage does not lose the event — the Cycle 31 outbox
 * publisher worker delivers durably with retry.
 *
 * Three structural keystones:
 *   1. PUBLIC JOB BOARD — GET /hr/jobs-public is @Public() and
 *      filters to status=LIVE only. The tenant-resolver middleware
 *      pins the school context from the request subdomain, so the
 *      board automatically shows the current school's open
 *      requisitions.
 *   2. PUBLIC APPLICATION PATH — POST /hr/jobs/:postingId/apply is
 *      @Public(). ApplicationService.apply() looks up iam_person by
 *      lowercased email and creates platform_users on miss with
 *      status=INVITED. UNIQUE(posting_id, person_id) prevents
 *      double-apply.
 *   3. AUTO-HIRE ON OFFER ACCEPT — OfferService.respond ACCEPTED
 *      branch INSERTs hr_employees + hr_employee_positions in the
 *      same tx as the offer status flip, then enqueues
 *      hr.offer.accepted via outbox. The hire workflow no longer
 *      needs an admin to manually re-key the candidate's data; the
 *      person identity flows through directly.
 *
 * Permission gate: HR-002 (Recruitment & Hiring) for all controller
 * endpoints. Read on hr-002:read, write on hr-002:write, admin via
 * everyFunction. Public endpoints (job-board + apply) bypass the
 * IAM gate via @Public() but still go through the tenant resolver.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  controllers: [RecruitmentController],
  providers: [JobPostingService, ApplicationService, InterviewService, OfferService],
  exports: [JobPostingService, ApplicationService, InterviewService, OfferService],
})
export class RecruitmentModule {}
