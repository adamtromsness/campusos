import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { AccreditationController } from './accreditation.controller';
import { FrameworkService } from './framework.service';
import { EvidenceService } from './evidence.service';
import { SelfStudyService } from './self-study.service';
import { ActionPlanService } from './action-plan.service';
import { SiteVisitService } from './site-visit.service';
import { ActionPlanOverdueWorker } from './action-plan-overdue.worker';

/**
 * Accreditation Module — M85 (P2-23a).
 *
 * 5 services + 1 controller + 1 background worker + ~22 endpoints +
 * 1 Kafka emit topic (acc.action_plan.overdue, durable via outbox).
 *
 * Three structural keystones:
 *   1. PLATFORM/TENANT DUAL FRAMEWORKS — national accreditation
 *      frameworks (AdvancED, IB MYP, CIS) live in
 *      platform.acc_frameworks_platform + acc_standards_platform
 *      seeded once by seed-accreditation.ts. Schools adopt via
 *      tenant acc_school_framework_adoptions; school-custom
 *      frameworks live in tenant acc_frameworks.
 *   2. SOFT INTEGRITY ON standard_id — acc_evidence_items,
 *      acc_self_study_ratings, and acc_action_plans all carry
 *      standard_id as a soft UUID per ADR-001/020. The access.ts
 *      `resolveStandard()` helper checks platform first, then
 *      tenant custom frameworks, and 404s when neither matches.
 *   3. READINESS SCORE FORMULA — SiteVisitService caches
 *      acc_site_visit_prep.readiness_score = round(
 *        (count(standards with rating IN current cycle AND ≥1
 *               APPROVED evidence) / total_adopted_standards) × 100
 *      ). Recomputed on every evidence approval + every rating
 *      submission. The ActionPlanOverdueWorker flips IN_PROGRESS to
 *      OVERDUE on target_date < CURRENT_DATE and emits
 *      `acc.action_plan.overdue` via the platform outbox with a
 *      deterministic v5-shape event_id keyed on actionPlanId.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    FrameworkService,
    EvidenceService,
    SelfStudyService,
    ActionPlanService,
    SiteVisitService,
    ActionPlanOverdueWorker,
  ],
  controllers: [AccreditationController],
  exports: [
    FrameworkService,
    EvidenceService,
    SelfStudyService,
    ActionPlanService,
    SiteVisitService,
    ActionPlanOverdueWorker,
  ],
})
export class AccreditationModule {}
