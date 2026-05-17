import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { ChartOfAccountsService, FundService, PeriodService } from './chart.service';
import { PostingService } from './posting.service';
import {
  APPaymentService,
  APVoucherService,
  BoardReportService,
  BudgetService,
  GrantService,
  ReconciliationService,
  SupplierService,
} from './budgets.service';
import {
  APPaymentDto,
  APVoucherDto,
  APVoucherTransitionDto,
  BoardReportDto,
  BudgetDto,
  ChartAccountDto,
  CreateAPPaymentDto,
  CreateAPVoucherDto,
  CreateBoardReportDto,
  CreateBudgetDto,
  CreateBudgetLineDto,
  CreateChartAccountDto,
  CreateFundDto,
  CreateGrantDto,
  CreateJournalBatchDto,
  CreatePeriodDto,
  CreatePeriodSeriesDto,
  CreateReconciliationDto,
  CreateSupplierDto,
  FinalizeReconciliationDto,
  FundDto,
  GrantDto,
  JournalBatchDto,
  PeriodDto,
  ReconciliationDto,
  SupplierDto,
  TrialBalanceResponseDto,
  UpdateBudgetDto,
  UpdateChartAccountDto,
  UpdateFundDto,
  UpdateGrantDto,
  UpdatePeriodStatusDto,
  VoidJournalBatchDto,
} from './dto/finance.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Finance')
@Controller()
export class FinanceController {
  constructor(
    private readonly funds: FundService,
    private readonly accounts: ChartOfAccountsService,
    private readonly periods: PeriodService,
    private readonly posting: PostingService,
    private readonly suppliers: SupplierService,
    private readonly budgets: BudgetService,
    private readonly apVouchers: APVoucherService,
    private readonly apPayments: APPaymentService,
    private readonly reconciliation: ReconciliationService,
    private readonly boardReports: BoardReportService,
    private readonly grants: GrantService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Finance controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Funds ───
  @Get('finance/funds')
  @RequirePermission('fin-005:read')
  async listFunds(): Promise<FundDto[]> {
    return this.funds.list();
  }

  @Get('finance/funds/:id')
  @RequirePermission('fin-005:read')
  async getFund(@Param('id') id: string): Promise<FundDto> {
    return this.funds.getById(id);
  }

  @Post('finance/funds')
  @RequirePermission('fin-005:write')
  async createFund(@Body() dto: CreateFundDto, @Req() req: AuthedRequest): Promise<FundDto> {
    return this.funds.create(await this.resolveActor(req), dto);
  }

  @Patch('finance/funds/:id')
  @RequirePermission('fin-005:write')
  async patchFund(
    @Param('id') id: string,
    @Body() dto: UpdateFundDto,
    @Req() req: AuthedRequest,
  ): Promise<FundDto> {
    return this.funds.patch(await this.resolveActor(req), id, dto);
  }

  // ─── Chart of Accounts ───
  @Get('finance/accounts')
  @RequirePermission('fin-005:read')
  async listAccounts(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<ChartAccountDto[]> {
    return this.accounts.list(includeInactive === 'true');
  }

  @Get('finance/accounts/:id')
  @RequirePermission('fin-005:read')
  async getAccount(@Param('id') id: string): Promise<ChartAccountDto> {
    return this.accounts.getById(id);
  }

  @Post('finance/accounts')
  @RequirePermission('fin-005:write')
  async createAccount(
    @Body() dto: CreateChartAccountDto,
    @Req() req: AuthedRequest,
  ): Promise<ChartAccountDto> {
    return this.accounts.create(await this.resolveActor(req), dto);
  }

  @Patch('finance/accounts/:id')
  @RequirePermission('fin-005:write')
  @ApiOperation({
    summary:
      'Update an account. is_system accounts (Cash / AR / AP) refuse deactivation regardless of caller.',
  })
  async patchAccount(
    @Param('id') id: string,
    @Body() dto: UpdateChartAccountDto,
    @Req() req: AuthedRequest,
  ): Promise<ChartAccountDto> {
    return this.accounts.patch(await this.resolveActor(req), id, dto);
  }

  @Get('finance/trial-balance')
  @RequirePermission('fin-005:read')
  async trialBalance(@Query('periodId') periodId?: string): Promise<TrialBalanceResponseDto> {
    return this.accounts.trialBalance(periodId);
  }

  // ─── Periods ───
  @Get('finance/periods')
  @RequirePermission('fin-005:read')
  async listPeriods(@Query('fiscalYear') fiscalYear?: string): Promise<PeriodDto[]> {
    return this.periods.list(fiscalYear);
  }

  @Get('finance/periods/:id')
  @RequirePermission('fin-005:read')
  async getPeriod(@Param('id') id: string): Promise<PeriodDto> {
    return this.periods.getById(id);
  }

  @Post('finance/periods')
  @RequirePermission('fin-005:write')
  async createPeriod(@Body() dto: CreatePeriodDto, @Req() req: AuthedRequest): Promise<PeriodDto> {
    return this.periods.create(await this.resolveActor(req), dto);
  }

  @Post('finance/periods/series')
  @RequirePermission('fin-005:write')
  @ApiOperation({
    summary: 'Bulk-create 12 monthly accounting periods for a fiscal year starting at yearStart.',
  })
  async createPeriodSeries(
    @Body() dto: CreatePeriodSeriesDto,
    @Req() req: AuthedRequest,
  ): Promise<PeriodDto[]> {
    return this.periods.createSeries(await this.resolveActor(req), dto);
  }

  @Patch('finance/periods/:id/status')
  @RequirePermission('fin-005:write')
  @ApiOperation({
    summary:
      'Transition period status. LOCKED is permanent — the service refuses any transition out of LOCKED, regardless of caller (financial integrity invariant).',
  })
  async patchPeriodStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePeriodStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<PeriodDto> {
    return this.periods.patchStatus(await this.resolveActor(req), id, dto);
  }

  // ─── Journal Batches ───
  @Get('finance/journal-batches')
  @RequirePermission('fin-005:read')
  async listBatches(
    @Query('status') status?: string,
    @Query('periodId') periodId?: string,
    @Query('sourceModule') sourceModule?: string,
  ): Promise<JournalBatchDto[]> {
    return this.posting.list({ status, periodId, sourceModule });
  }

  @Get('finance/journal-batches/:id')
  @RequirePermission('fin-005:read')
  async getBatch(@Param('id') id: string): Promise<JournalBatchDto> {
    return this.posting.getById(id);
  }

  @Post('finance/journal-batches')
  @RequirePermission('fin-005:write')
  @ApiOperation({
    summary:
      'Create a DRAFT batch with its GL entry lines. The batch is NOT posted yet — call POST /finance/journal-batches/:id/post to validate balance and flip to POSTED.',
  })
  async createBatch(
    @Body() dto: CreateJournalBatchDto,
    @Req() req: AuthedRequest,
  ): Promise<JournalBatchDto> {
    return this.posting.createDraft(await this.resolveActor(req), dto);
  }

  @Post('finance/journal-batches/:id/post')
  @RequirePermission('fin-005:write')
  @ApiOperation({
    summary:
      'Post a DRAFT batch — the ADR-058 / ADR-059 keystone. Validates SUM(debit) = SUM(credit) inside the same tenant tx as the status flip; on imbalance the entire transaction rolls back.',
  })
  async postBatch(@Param('id') id: string, @Req() req: AuthedRequest): Promise<JournalBatchDto> {
    return this.posting.post(await this.resolveActor(req), id);
  }

  @Post('finance/journal-batches/:id/void')
  @RequirePermission('fin-005:admin')
  @ApiOperation({
    summary:
      'Void a POSTED batch. Original lines are preserved for audit; status flips to VOIDED and budget actuals are reversed.',
  })
  async voidBatch(
    @Param('id') id: string,
    @Body() dto: VoidJournalBatchDto,
    @Req() req: AuthedRequest,
  ): Promise<JournalBatchDto> {
    return this.posting.void(await this.resolveActor(req), id, dto);
  }

  // ─── Suppliers ───
  @Get('finance/suppliers')
  @RequirePermission('fin-007:read')
  async listSuppliers(@Query('includeInactive') includeInactive?: string): Promise<SupplierDto[]> {
    return this.suppliers.list(includeInactive === 'true');
  }

  @Get('finance/suppliers/:id')
  @RequirePermission('fin-007:read')
  async getSupplier(@Param('id') id: string): Promise<SupplierDto> {
    return this.suppliers.getById(id);
  }

  @Post('finance/suppliers')
  @RequirePermission('fin-007:write')
  async createSupplier(
    @Body() dto: CreateSupplierDto,
    @Req() req: AuthedRequest,
  ): Promise<SupplierDto> {
    return this.suppliers.create(await this.resolveActor(req), dto);
  }

  // ─── Budgets ───
  @Get('finance/budgets')
  @RequirePermission('fin-006:read')
  async listBudgets(@Query('fiscalYear') fiscalYear?: string): Promise<BudgetDto[]> {
    return this.budgets.list(fiscalYear);
  }

  @Get('finance/budgets/:id')
  @RequirePermission('fin-006:read')
  async getBudget(@Param('id') id: string): Promise<BudgetDto> {
    return this.budgets.getById(id);
  }

  @Post('finance/budgets')
  @RequirePermission('fin-006:write')
  async createBudget(@Body() dto: CreateBudgetDto, @Req() req: AuthedRequest): Promise<BudgetDto> {
    return this.budgets.create(await this.resolveActor(req), dto);
  }

  @Patch('finance/budgets/:id')
  @RequirePermission('fin-006:write')
  async patchBudget(
    @Param('id') id: string,
    @Body() dto: UpdateBudgetDto,
    @Req() req: AuthedRequest,
  ): Promise<BudgetDto> {
    return this.budgets.patch(await this.resolveActor(req), id, dto);
  }

  @Post('finance/budgets/:id/lines')
  @RequirePermission('fin-006:write')
  async addBudgetLine(
    @Param('id') id: string,
    @Body() dto: CreateBudgetLineDto,
    @Req() req: AuthedRequest,
  ): Promise<BudgetDto> {
    return this.budgets.addLine(await this.resolveActor(req), id, dto);
  }

  // ─── AP Vouchers ───
  @Get('finance/ap-vouchers')
  @RequirePermission('fin-007:read')
  async listAPVouchers(
    @Query('status') status?: string,
    @Query('supplierId') supplierId?: string,
  ): Promise<APVoucherDto[]> {
    return this.apVouchers.list({
      status: status as APVoucherDto['status'] | undefined,
      supplierId,
    });
  }

  @Get('finance/ap-vouchers/:id')
  @RequirePermission('fin-007:read')
  async getAPVoucher(@Param('id') id: string): Promise<APVoucherDto> {
    return this.apVouchers.getById(id);
  }

  @Post('finance/ap-vouchers')
  @RequirePermission('fin-007:write')
  async createAPVoucher(
    @Body() dto: CreateAPVoucherDto,
    @Req() req: AuthedRequest,
  ): Promise<APVoucherDto> {
    return this.apVouchers.create(await this.resolveActor(req), dto);
  }

  @Patch('finance/ap-vouchers/:id/transition')
  @RequirePermission('fin-007:admin')
  async transitionAPVoucher(
    @Param('id') id: string,
    @Body() dto: APVoucherTransitionDto,
    @Req() req: AuthedRequest,
  ): Promise<APVoucherDto> {
    return this.apVouchers.transition(await this.resolveActor(req), id, dto);
  }

  // ─── AP Payments ───
  @Get('finance/ap-vouchers/:id/payments')
  @RequirePermission('fin-007:read')
  async listAPPayments(@Param('id') voucherId: string): Promise<APPaymentDto[]> {
    return this.apPayments.listForVoucher(voucherId);
  }

  @Post('finance/ap-vouchers/:id/pay')
  @RequirePermission('fin-007:admin')
  @ApiOperation({
    summary:
      'Pay an AP voucher — creates the payment record AND posts a balanced GL batch (DEBIT GL account / CREDIT Cash) in one tenant transaction.',
  })
  async payAPVoucher(
    @Param('id') id: string,
    @Body() dto: CreateAPPaymentDto,
    @Req() req: AuthedRequest,
  ): Promise<APPaymentDto> {
    return this.apPayments.pay(await this.resolveActor(req), id, dto);
  }

  // ─── Reconciliation ───
  @Get('finance/reconciliation')
  @RequirePermission('fin-008:read')
  async listReconciliation(): Promise<ReconciliationDto[]> {
    return this.reconciliation.list();
  }

  @Get('finance/reconciliation/:id')
  @RequirePermission('fin-008:read')
  async getReconciliation(@Param('id') id: string): Promise<ReconciliationDto> {
    return this.reconciliation.getById(id);
  }

  @Post('finance/reconciliation')
  @RequirePermission('fin-008:write')
  async startReconciliation(
    @Body() dto: CreateReconciliationDto,
    @Req() req: AuthedRequest,
  ): Promise<ReconciliationDto> {
    return this.reconciliation.start(await this.resolveActor(req), dto);
  }

  @Patch('finance/reconciliation/:id/finalize')
  @RequirePermission('fin-008:write')
  async finalizeReconciliation(
    @Param('id') id: string,
    @Body() dto: FinalizeReconciliationDto,
    @Req() req: AuthedRequest,
  ): Promise<ReconciliationDto> {
    return this.reconciliation.finalize(await this.resolveActor(req), id, dto);
  }

  // ─── Board Reports ───
  @Get('finance/board-reports')
  @RequirePermission('fin-008:read')
  async listBoardReports(): Promise<BoardReportDto[]> {
    return this.boardReports.list();
  }

  @Get('finance/board-reports/:id')
  @RequirePermission('fin-008:read')
  async getBoardReport(@Param('id') id: string): Promise<BoardReportDto> {
    return this.boardReports.getById(id);
  }

  @Post('finance/board-reports')
  @RequirePermission('fin-008:write')
  @ApiOperation({
    summary:
      'Generate a board report snapshot. The report_data JSONB is FROZEN at generation time per ADR-010 — no UPDATE / DELETE methods are exposed.',
  })
  async generateBoardReport(
    @Body() dto: CreateBoardReportDto,
    @Req() req: AuthedRequest,
  ): Promise<BoardReportDto> {
    return this.boardReports.generate(await this.resolveActor(req), dto);
  }

  // ─── Grants ───
  @Get('finance/grants')
  @RequirePermission('fin-008:read')
  async listGrants(): Promise<GrantDto[]> {
    return this.grants.list();
  }

  @Get('finance/grants/:id')
  @RequirePermission('fin-008:read')
  async getGrant(@Param('id') id: string): Promise<GrantDto> {
    return this.grants.getById(id);
  }

  @Post('finance/grants')
  @RequirePermission('fin-008:write')
  async createGrant(@Body() dto: CreateGrantDto, @Req() req: AuthedRequest): Promise<GrantDto> {
    return this.grants.create(await this.resolveActor(req), dto);
  }

  @Patch('finance/grants/:id')
  @RequirePermission('fin-008:write')
  async patchGrant(
    @Param('id') id: string,
    @Body() dto: UpdateGrantDto,
    @Req() req: AuthedRequest,
  ): Promise<GrantDto> {
    return this.grants.patch(await this.resolveActor(req), id, dto);
  }
}
