import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
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
  CreateAtRiskConfigDto,
  CreateReportDefinitionDto,
  CreateScheduledReportDto,
  ListAcademicArgs,
  ListAttendanceArgs,
  RunReportDto,
  RunWorkersDto,
  UpdateAtRiskConfigDto,
  UpdateReportDefinitionDto,
  UpdateScheduledReportDto,
  WorkerRunSummaryDto,
} from './dto/analytics.dto';

interface AuthedRequest extends Request {
  user: { sub: string; personId: string };
}

@ApiTags('Analytics & Reporting')
@Controller()
export class AnalyticsController {
  constructor(
    private readonly actors: ActorContextService,
    private readonly dashboards: DashboardService,
    private readonly checkpoints: CheckpointService,
    private readonly sisWorker: SISReadModelWorker,
    private readonly classroomWorker: ClassroomReadModelWorker,
    private readonly atRiskWorker: AtRiskEvaluationWorker,
    private readonly schoolWorker: SchoolSummaryWorker,
    private readonly districtWorker: DistrictAnalyticsWorker,
    private readonly wellbeingWorker: WellbeingTrendsWorker,
    private readonly financeWorker: FinanceARWorker,
    private readonly definitions: ReportDefinitionService,
    private readonly runs: ReportRunService,
    private readonly scheduled: ScheduledReportWorker,
  ) {}

  /** ─── Dashboards ──────────────────────────────────────────────── */

  @Get('analytics/attendance')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Daily attendance summaries.' })
  async listAttendance(@Req() req: AuthedRequest, @Query() args: ListAttendanceArgs) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listDailyAttendance(actor, args);
  }

  @Get('analytics/academics')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-student academic summary list.' })
  async listAcademic(@Req() req: AuthedRequest, @Query() args: ListAcademicArgs) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listAcademic(actor, args);
  }

  @Get('analytics/classes')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-class performance summaries.' })
  async listClassPerformance(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listClassPerformance(actor);
  }

  @Get('analytics/staff-summary')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-employee staff summary. Manager-only.' })
  async listStaffSummary(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listStaffSummary(actor);
  }

  @Get('analytics/school-summary')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Single school-summary row for the principal dashboard.' })
  async getSchoolSummary(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.getSchoolSummary(actor);
  }

  @Get('analytics/district-summary')
  @RequirePermission('rpt-003:read')
  @ApiOperation({ summary: 'Single district-summary row for the superintendent dashboard.' })
  async getDistrictSummary(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.getDistrictSummary(actor);
  }

  @Get('analytics/district-comparison')
  @RequirePermission('rpt-003:read')
  @ApiOperation({ summary: 'Per-school comparison rows + rankings within the district.' })
  async listDistrictComparison(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listDistrictComparison(actor);
  }

  @Get('analytics/wellbeing-trends')
  @RequirePermission('rpt-002:read')
  @ApiOperation({
    summary: 'Aggregated wellbeing trends per (school, grade, period). NO individual ids.',
  })
  async listWellbeingTrends(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listWellbeingTrends(actor);
  }

  @Get('analytics/aged-debtors')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-family aged debtor buckets.' })
  async listAgedDebtors(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listAgedDebtors(actor);
  }

  /** ─── At-risk ────────────────────────────────────────────────── */

  @Get('analytics/at-risk')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Currently flagged at-risk students.' })
  async listAtRisk(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listAtRiskStudents(actor);
  }

  @Get('analytics/at-risk/configurations')
  @RequirePermission('rpt-002:read')
  async listAtRiskConfigs(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.listAtRiskConfigs(actor);
  }

  @Post('analytics/at-risk/configurations')
  @RequirePermission('rpt-002:write')
  async createAtRiskConfig(@Req() req: AuthedRequest, @Body() dto: CreateAtRiskConfigDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.createAtRiskConfig(actor, dto);
  }

  @Patch('analytics/at-risk/configurations/:id')
  @RequirePermission('rpt-002:write')
  async updateAtRiskConfig(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateAtRiskConfigDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.dashboards.updateAtRiskConfig(actor, id, dto);
  }

  /** ─── Workers ────────────────────────────────────────────────── */

  @Post('analytics/workers/run')
  @RequirePermission('rpt-002:write')
  @ApiOperation({ summary: 'Trigger the chained nightly pipeline (or a single named worker).' })
  async runWorkers(@Body() dto: RunWorkersDto): Promise<WorkerRunSummaryDto[]> {
    const summaries: WorkerRunSummaryDto[] = [];
    const which = dto.worker;

    const runOne = async (name: string, fn: () => Promise<WorkerRunSummaryDto>) => {
      if (which && which !== name) return;
      summaries.push(await fn());
    };

    await runOne('sis', () => this.sisWorker.materialise(dto.asOfDate));
    await runOne('classroom', () => this.classroomWorker.materialise());
    await runOne('at-risk', () => this.atRiskWorker.evaluate());
    await runOne('school-summary', () => this.schoolWorker.materialise());
    await runOne('district', () => this.districtWorker.materialise());
    await runOne('wellbeing', () => this.wellbeingWorker.materialise());
    await runOne('finance-ar', () => this.financeWorker.materialise());

    if (which && summaries.length === 0) {
      throw new BadRequestException(`Unknown worker: ${which}`);
    }
    return summaries;
  }

  @Get('analytics/workers/status')
  @RequirePermission('rpt-002:read')
  async workerStatus() {
    return this.checkpoints.list();
  }

  /** ─── Report engine ──────────────────────────────────────────── */

  @Get('analytics/reports')
  @RequirePermission('rpt-004:read')
  async listReports(@Req() req: AuthedRequest) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.definitions.list(actor);
  }

  @Get('analytics/reports/:id')
  @RequirePermission('rpt-004:read')
  async getReport(@Param('id') id: string) {
    return this.definitions.getById(id);
  }

  @Post('analytics/reports')
  @RequirePermission('rpt-004:write')
  async createReport(@Req() req: AuthedRequest, @Body() dto: CreateReportDefinitionDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.definitions.create(actor, dto);
  }

  @Patch('analytics/reports/:id')
  @RequirePermission('rpt-004:write')
  async updateReport(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateReportDefinitionDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.definitions.update(actor, id, dto);
  }

  @Post('analytics/reports/:id/run')
  @RequirePermission('rpt-004:write')
  async runReport(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: RunReportDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.runs.run(actor, id, dto);
  }

  @Get('analytics/reports/:id/runs')
  @RequirePermission('rpt-004:read')
  async listRunsForReport(@Param('id') id: string) {
    return this.runs.listForDefinition(id);
  }

  /** ─── Scheduled reports ──────────────────────────────────────── */

  @Get('analytics/scheduled-reports')
  @RequirePermission('rpt-004:read')
  async listScheduled() {
    return this.scheduled.list();
  }

  @Post('analytics/scheduled-reports')
  @RequirePermission('rpt-004:write')
  async createScheduled(@Req() req: AuthedRequest, @Body() dto: CreateScheduledReportDto) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.scheduled.create(actor, dto);
  }

  @Patch('analytics/scheduled-reports/:id')
  @RequirePermission('rpt-004:write')
  async updateScheduled(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateScheduledReportDto,
  ) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.scheduled.update(actor, id, dto);
  }

  @Post('analytics/scheduled-reports/:id/run-now')
  @RequirePermission('rpt-004:write')
  async runScheduledNow(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actors.resolveActor(req.user.sub, req.user.personId);
    return this.scheduled.runNow(actor, id);
  }

  /** ─── State report templates ─────────────────────────────────── */

  @Get('analytics/state-reports')
  @RequirePermission('rpt-004:read')
  async listStateReports() {
    return this.dashboards.listStateReportTemplates();
  }
}
