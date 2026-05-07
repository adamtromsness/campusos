import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { AnalyticsController } from './analytics.controller';
import { DashboardService } from './dashboard.service';
import {
  AtRiskEvaluationWorker,
  CheckpointService,
  ClassroomReadModelWorker,
  SISReadModelWorker,
} from './workers.service';
import {
  DistrictAnalyticsWorker,
  FinanceARWorker,
  SchoolSummaryWorker,
  WellbeingTrendsWorker,
} from './cross-domain.service';
import {
  ReportDefinitionService,
  ReportRunService,
  ScheduledReportWorker,
} from './reports.service';

/**
 * Analytics Module — M110 Analytics & Reporting (Cycle 29).
 *
 * Wave 7 (Analytics & Governance) opening cycle. Read layer per
 * ADR-008 CQRS-lite. 7 workers + 3 read services + 1 controller +
 * ~30 endpoints under rpt-001..004 + 1 Kafka emit
 * (rpt.at_risk.flagged).
 *
 * Six structural keystones:
 *   1. READ MODEL OWNERSHIP — workers are the sole writers to rpt_*.
 *      Analytics API is read-only.
 *   2. FROM_SNAPSHOT REBUILD — rpt_rebuild_snapshots stores frozen
 *      aggregate state + Kafka offsets per ADR-049.
 *   3. OFFSET-BASED CHECKPOINTS — rpt_analytics_worker_checkpoints
 *      stores Kafka positions, never timestamps.
 *   4. CONFIGURABLE AT-RISK DETECTION — rpt_at_risk_configurations
 *      JSONB rules driven by AtRiskEvaluationWorker. Newly flagged
 *      students fire rpt.at_risk.flagged.
 *   5. CHAINED NIGHTLY EXECUTION — SIS → Classroom → AtRisk → School
 *      → District (03:00 UTC) → Wellbeing → Finance.
 *   6. CRON-DRIVEN SCHEDULED REPORTS — ScheduledReportWorker is the
 *      first cron-driven worker in CampusOS. 5-field cron expressions
 *      with timezone-aware next_run_at computation.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    DashboardService,
    CheckpointService,
    SISReadModelWorker,
    ClassroomReadModelWorker,
    AtRiskEvaluationWorker,
    SchoolSummaryWorker,
    DistrictAnalyticsWorker,
    WellbeingTrendsWorker,
    FinanceARWorker,
    ReportDefinitionService,
    ReportRunService,
    ScheduledReportWorker,
  ],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
