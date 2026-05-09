import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorContextService } from '../iam/actor-context.service';
import { RequirePermission } from '../auth/require-permission.decorator';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}
import { PayGradeService } from './pay-grade.service';
import { PayrollService } from './payroll.service';
import { SalaryReviewService } from './salary-review.service';
import {
  CreatePayGradeDto,
  CreatePayPeriodDto,
  CreateSalaryReviewDto,
  CreateSalaryScaleDto,
  ListPayPeriodsQueryDto,
  ListPayrollRecordsQueryDto,
  ListSalaryReviewsQueryDto,
  PayGradeDto,
  PayPeriodDto,
  PayrollRecordDto,
  ProcessPayPeriodDto,
  SalaryReviewDto,
  SalaryScaleDto,
  UpdatePayGradeDto,
  UpdateSalaryReviewDto,
  UpdateSalaryScaleDto,
} from './dto/payroll.dto';

@ApiTags('hr-payroll')
@ApiBearerAuth()
@Controller('hr')
export class PayrollController {
  constructor(
    private readonly payGrades: PayGradeService,
    private readonly payroll: PayrollService,
    private readonly salaryReviews: SalaryReviewService,
    private readonly actors: ActorContextService,
  ) {}

  // ---- Pay grades ----------------------------------------------------------

  @Get('pay-grades')
  @RequirePermission('hr-003:read')
  async listGrades(@Query('includeInactive') includeInactive?: string): Promise<PayGradeDto[]> {
    return this.payGrades.list(includeInactive === 'true');
  }

  @Get('pay-grades/:id')
  @RequirePermission('hr-003:read')
  async getGrade(@Param('id', ParseUUIDPipe) id: string): Promise<PayGradeDto> {
    return this.payGrades.getById(id);
  }

  @Post('pay-grades')
  @RequirePermission('hr-003:admin')
  async createGrade(
    @Req() req: AuthedRequest,
    @Body() input: CreatePayGradeDto,
  ): Promise<PayGradeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payGrades.create(input, actor);
  }

  @Patch('pay-grades/:id')
  @RequirePermission('hr-003:admin')
  async patchGrade(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdatePayGradeDto,
  ): Promise<PayGradeDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payGrades.patch(id, input, actor);
  }

  @Get('pay-grades/:id/scales')
  @RequirePermission('hr-003:read')
  async listScales(@Param('id', ParseUUIDPipe) id: string): Promise<SalaryScaleDto[]> {
    return this.payGrades.listScales(id);
  }

  @Post('pay-grades/:id/scales')
  @RequirePermission('hr-003:admin')
  async addScale(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CreateSalaryScaleDto,
  ): Promise<SalaryScaleDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payGrades.addScale(id, input, actor);
  }

  @Patch('salary-scales/:id')
  @RequirePermission('hr-003:admin')
  async patchScale(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateSalaryScaleDto,
  ): Promise<SalaryScaleDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payGrades.patchScale(id, input, actor);
  }

  // ---- Pay periods + payroll processing -----------------------------------

  @Get('pay-periods')
  @RequirePermission('hr-003:read')
  async listPeriods(@Query() query: ListPayPeriodsQueryDto): Promise<PayPeriodDto[]> {
    return this.payroll.listPeriods(query);
  }

  @Get('pay-periods/:id')
  @RequirePermission('hr-003:read')
  async getPeriod(@Param('id', ParseUUIDPipe) id: string): Promise<PayPeriodDto> {
    return this.payroll.getPeriod(id);
  }

  @Post('pay-periods')
  @RequirePermission('hr-003:admin')
  async createPeriod(
    @Req() req: AuthedRequest,
    @Body() input: CreatePayPeriodDto,
  ): Promise<PayPeriodDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payroll.createPeriod(input, actor);
  }

  @Post('pay-periods/:id/process')
  @RequirePermission('hr-003:admin')
  @ApiOperation({
    summary:
      'Compute gross / deductions / net for every employee in scope and INSERT hr_payroll_records + hr_payroll_deductions rows. Idempotent under retry via UNIQUE(employee_id, pay_period_id) — partial re-runs land missing rows only.',
  })
  async process(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ProcessPayPeriodDto,
  ): Promise<{ processed: number; skipped: number }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payroll.processPeriod(id, input, actor);
  }

  @Post('pay-periods/:id/approve')
  @RequirePermission('hr-003:admin')
  async approve(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayPeriodDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payroll.approvePeriod(id, actor);
  }

  @Post('pay-periods/:id/mark-paid')
  @RequirePermission('hr-003:admin')
  @ApiOperation({
    summary:
      'Flip period + records to PAID and emit hr.payroll.processed (one envelope per record) for the Cycle 26 GLConsumer to post journal entries.',
  })
  async markPaid(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayPeriodDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payroll.markPaid(id, actor);
  }

  // ---- Payroll records (employee self-service or admin lookup) ------------

  @Get('payroll/records')
  @RequirePermission('hr-003:read')
  async listRecords(
    @Req() req: AuthedRequest,
    @Query() query: ListPayrollRecordsQueryDto,
  ): Promise<PayrollRecordDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payroll.listRecords(query, actor);
  }

  @Get('payroll/records/:id')
  @RequirePermission('hr-003:read')
  async getRecord(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayrollRecordDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payroll.getRecord(id, actor);
  }

  // Convenience self-service alias used by the payslip viewer UI.
  @Get('payroll/me/payslips')
  @RequirePermission('hr-003:read')
  async myPayslips(
    @Req() req: AuthedRequest,
    @Query() query: ListPayrollRecordsQueryDto,
  ): Promise<PayrollRecordDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    // Force employee binding even if admin — the "me" alias is
    // explicitly self-only.
    return this.payroll.listRecords({ ...query, employeeId: actor.employeeId ?? undefined }, {
      ...actor,
      isSchoolAdmin: false,
    } as typeof actor);
  }

  // ---- Salary reviews ------------------------------------------------------

  @Get('salary-reviews')
  @RequirePermission('hr-003:read')
  async listReviews(
    @Req() req: AuthedRequest,
    @Query() query: ListSalaryReviewsQueryDto,
  ): Promise<SalaryReviewDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.salaryReviews.list(query, actor);
  }

  @Get('salary-reviews/:id')
  @RequirePermission('hr-003:read')
  async getReview(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SalaryReviewDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.salaryReviews.getById(id, actor);
  }

  @Post('salary-reviews')
  @RequirePermission('hr-003:write')
  async submitReview(
    @Req() req: AuthedRequest,
    @Body() input: CreateSalaryReviewDto,
  ): Promise<SalaryReviewDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.salaryReviews.create(input, actor);
  }

  @Patch('salary-reviews/:id')
  @RequirePermission('hr-003:write')
  async patchReview(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateSalaryReviewDto,
  ): Promise<SalaryReviewDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.salaryReviews.patch(id, input, actor);
  }
}
