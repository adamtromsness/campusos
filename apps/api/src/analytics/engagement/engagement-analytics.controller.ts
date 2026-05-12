import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { EngagementReadService, type DateRangeArgs } from './engagement-read.service';

/**
 * P2-15b Engagement + Performance Read-Model Controller.
 *
 * 9 read-only endpoints — one per engagement rpt_* table. Gated on
 * RPT-001..003 read tiers; tenant-scoped via the resolved tenant
 * context. All reads route through EngagementReadService which is
 * replica-friendly under TenantPrismaService.executeInTenantContext.
 *
 * Endpoint scope:
 *   GET /analytics/enrolment-funnel    — rpt-001:read
 *   GET /analytics/athletics-season    — rpt-001:read
 *   GET /analytics/officials           — rpt-002:read (weekly batch + market view)
 *   GET /analytics/game-results        — rpt-001:read
 *   GET /analytics/groups-engagement   — rpt-001:read
 *   GET /analytics/publications        — rpt-001:read
 *   GET /analytics/clubs               — rpt-001:read
 *   GET /analytics/communications      — rpt-001:read
 *   GET /analytics/wellbeing-trends    — rpt-002:read (school-tier, aggregate only)
 *
 * The wellbeing-trends endpoint returns ONLY the aggregate rollup — the
 * rpt_wellbeing_domain_trends table has no student_id column and the
 * service performs no individual-student join on read.
 */
@ApiTags('Analytics — Engagement & Performance Read Models')
@Controller('analytics')
export class EngagementAnalyticsController {
  constructor(private readonly reads: EngagementReadService) {}

  @Get('enrolment-funnel')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(school, academic_year) enrolment funnel rollup.' })
  async enrolmentFunnel() {
    return this.reads.listEnrolmentFunnel();
  }

  @Get('athletics-season')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(season, programme) athletics season rollup.' })
  async athleticsSeason() {
    return this.reads.listAthSeasons();
  }

  @Get('officials')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-week officials marketplace rollup (weekly batch).' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async officials(@Query() args: DateRangeArgs) {
    return this.reads.listOfficialsMarketplace(args);
  }

  @Get('game-results')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-game results with statistical leaders.' })
  async gameResults() {
    return this.reads.listGameResults();
  }

  @Get('groups-engagement')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(group, period) engagement rollup.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async groupsEngagement(@Query() args: DateRangeArgs) {
    return this.reads.listGroupsEngagement(args);
  }

  @Get('publications')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-period publications distribution rollup.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async publications(@Query() args: DateRangeArgs) {
    return this.reads.listPublications(args);
  }

  @Get('clubs')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(academic_year, club) extracurricular activities rollup.' })
  async clubs() {
    return this.reads.listClubsService();
  }

  @Get('communications')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-period messaging + broadcast metrics.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async communications(@Query() args: DateRangeArgs) {
    return this.reads.listCommsMetrics(args);
  }

  @Get('wellbeing-trends')
  @RequirePermission('rpt-002:read')
  @ApiOperation({
    summary:
      'Per-(period, grade_level, domain) wellbeing aggregate. PRIVACY KEYSTONE — no individual student attribution.',
  })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async wellbeingTrends(@Query() args: DateRangeArgs) {
    return this.reads.listWellbeingDomainTrends(args);
  }
}
