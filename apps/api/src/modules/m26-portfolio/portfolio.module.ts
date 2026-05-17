import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { PortfolioService } from './portfolio.service';
import { ShareService } from './share.service';
import { AchievementService } from './achievement.service';
import { PortfolioController } from './portfolio.controller';

// P2-27 — Portfolio Advanced
import { PortfolioSectionService } from './section.service';
import { ReflectionService } from './reflection.service';
import { EndorsementService } from './endorsement.service';
import { ReadinessPathwayService } from './readiness.service';
import { CollegeApplicationService } from './college-application.service';
import { ResumeService } from './resume.service';
import { MilestoneAutoCheckConsumer } from './milestone-auto-check.consumer';
import { PortfolioAdvancedController } from './portfolio-advanced.controller';

/**
 * Portfolio Module — M26 (Cycle 24) + M26 .1 P2-27 Portfolio Advanced.
 *
 * Cycle 24: 3 services + 1 controller + ~21 endpoints + 1 Kafka emit
 * (pfl.achievement.awarded).
 *
 * P2-27: 6 more services + 1 controller + ~26 endpoints + 1 Kafka emit
 * (pfl.pathway.milestone_completed) + 1 Kafka consumer
 * (MilestoneAutoCheckConsumer subscribed to sis.service_learning.approved
 * and sis.transcript.generated).
 *
 * Module totals after P2-27:
 *   9 services + 2 controllers + 1 consumer + ~47 endpoints + 2 Kafka emits.
 *
 * Five structural keystones across the cycle:
 *   1. PORTFOLIO SECTIONS with drag-reorder — UNIQUE(portfolio_id,
 *      sort_order) caught by the section reorder helper using a
 *      negative-sort_order parking trick to dodge the UNIQUE during
 *      swaps inside one tx.
 *   2. STUDENT-OWNED REFLECTIONS — UNIQUE(portfolio_item_id, student_id)
 *      caps reflections at one per (item, student) and the service
 *      enforces only the writing student may edit.
 *   3. ENDORSEMENT ROLE RESTRICTION — students and guardians refused
 *      at the service layer; TEACHER role additionally requires an
 *      assigned-teacher relationship.
 *   4. PATHWAY MILESTONE JSONB PROGRESS — milestone_statuses array
 *      stored in JSONB; overall_progress recomputed on every status
 *      change inside one tenant tx; emits pfl.pathway.milestone_completed
 *      on COMPLETED transitions.
 *   5. CROSS-MODULE AUTO-CHECK — MilestoneAutoCheckConsumer subscribes
 *      to sis.service_learning.approved + sis.transcript.generated and
 *      auto-completes matching milestones for the affected student
 *      inside one tenant tx. Resume PDF auto-populates from endorsement
 *      skills + achievements + service hours + extracurriculars.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    PortfolioService,
    ShareService,
    AchievementService,
    // P2-27
    PortfolioSectionService,
    ReflectionService,
    EndorsementService,
    ReadinessPathwayService,
    CollegeApplicationService,
    ResumeService,
    MilestoneAutoCheckConsumer,
  ],
  controllers: [PortfolioController, PortfolioAdvancedController],
  exports: [
    PortfolioService,
    ShareService,
    AchievementService,
    PortfolioSectionService,
    ReflectionService,
    EndorsementService,
    ReadinessPathwayService,
    CollegeApplicationService,
    ResumeService,
  ],
})
export class PortfolioModule {}
