import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
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
import {
  FacilitiesReadModelWorker,
  FoodServiceReadModelWorker,
  ITReadModelWorker,
  LibraryReadModelWorker,
  ProcurementReadModelWorker,
  StoreReadModelWorker,
  TransportReadModelWorker,
} from './operations/operations-workers.service';
import { OperationsReadService } from './operations/operations-read.service';
import { OperationsAnalyticsController } from './operations/operations-analytics.controller';
import {
  AthleticsReadModelWorker,
  ClubsReadModelWorker,
  CommsReadModelWorker,
  EnrolmentReadModelWorker,
  GroupsReadModelWorker,
  OfficialsReadModelWorker,
  PublicationsReadModelWorker,
  WellbeingReadModelWorker,
} from './engagement/engagement-workers.service';
import { EngagementReadService } from './engagement/engagement-read.service';
import { EngagementAnalyticsController } from './engagement/engagement-analytics.controller';

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
    // P2-15a Operations Read Models — 7 workers, 9 Kafka consumers, 1 read service.
    ProcurementReadModelWorker,
    StoreReadModelWorker,
    FoodServiceReadModelWorker,
    TransportReadModelWorker,
    FacilitiesReadModelWorker,
    ITReadModelWorker,
    LibraryReadModelWorker,
    OperationsReadService,
    // P2-15b Engagement + Performance Read Models — 8 workers (7 live + 1 weekly batch), 1 read service.
    EnrolmentReadModelWorker,
    AthleticsReadModelWorker,
    OfficialsReadModelWorker,
    GroupsReadModelWorker,
    PublicationsReadModelWorker,
    ClubsReadModelWorker,
    CommsReadModelWorker,
    WellbeingReadModelWorker,
    EngagementReadService,
  ],
  controllers: [AnalyticsController, OperationsAnalyticsController, EngagementAnalyticsController],
})
export class AnalyticsModule {}
