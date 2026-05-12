import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { OperationsReadService, type DateRangeArgs } from './operations-read.service';

/**
 * P2-15a Operations Read-Model Controller.
 *
 * 9 read-only endpoints — one per operations rpt_* table. All gated on
 * RPT-001..003 with the lightweight `:read` tier (read-side, all
 * personas that hold any analytics read code reach them). All routes
 * are school-scoped via the resolved tenant context, and every read
 * runs through `OperationsReadService` which is replica-friendly (the
 * single TenantPrismaService call is what swaps in `executeOnReplica`
 * when that helper lands in P2-15b).
 *
 * RPT-001 — daily operations read (procurement, store, meal counts, library)
 * RPT-002 — school-level read (NSLP federal report, ridership, fleet, facilities condition, KPI)
 * RPT-003 — district-level read (reserved for cross-school comparisons in P2-15b)
 */
@ApiTags('Analytics — Operations Read Models')
@Controller('analytics')
export class OperationsAnalyticsController {
  constructor(private readonly reads: OperationsReadService) {}

  @Get('procurement')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(month, department, vendor) procurement rollup.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async procurement(@Query() args: DateRangeArgs) {
    return this.reads.listProcurement(args);
  }

  @Get('store-sales')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(month, product) store sales rollup.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async storeSales(@Query() args: DateRangeArgs) {
    return this.reads.listStoreSales(args);
  }

  @Get('meal-counts')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-(service_date, meal_type) food service meal counts.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async mealCounts(@Query() args: DateRangeArgs) {
    return this.reads.listMealCounts(args);
  }

  @Get('nslp')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-month federal NSLP summary (compliance reporting).' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async nslp(@Query() args: DateRangeArgs) {
    return this.reads.listNslp(args);
  }

  @Get('ridership')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-(route, month) transportation ridership rollup.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async ridership(@Query() args: DateRangeArgs) {
    return this.reads.listRidership(args);
  }

  @Get('facilities-condition')
  @RequirePermission('rpt-002:read')
  @ApiOperation({
    summary: 'Per-(building, space) current facilities condition + open work orders.',
  })
  async facilitiesCondition() {
    return this.reads.listFacilitiesCondition();
  }

  @Get('facilities-kpi')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-month facilities KPI rollup (nightly materialised).' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async facilitiesKpi(@Query() args: DateRangeArgs) {
    return this.reads.listFacilitiesKpi(args);
  }

  @Get('tech-fleet')
  @RequirePermission('rpt-002:read')
  @ApiOperation({ summary: 'Per-(device_type) IT fleet status rollup.' })
  async techFleet() {
    return this.reads.listTechFleet();
  }

  @Get('library-circulation')
  @RequirePermission('rpt-001:read')
  @ApiOperation({ summary: 'Per-month library circulation rollup including top-10 titles.' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async libraryCirculation(@Query() args: DateRangeArgs) {
    return this.reads.listLibraryCirculation(args);
  }
}
