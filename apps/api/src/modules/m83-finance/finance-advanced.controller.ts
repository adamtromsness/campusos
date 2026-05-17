import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import {
  ActorContextService,
  type ResolvedActor,
} from '@modules/m00-platform';
import { DepartmentalBudgetService } from './departmental-budget.service';
import { BudgetTransferService } from './budget-transfer.service';
import { JournalBatchService } from './journal-batch.service';
import {
  AddJournalEntryLineDto,
  CreateBudgetTransferDto,
  CreateDepartmentalBudgetDto,
  CreateJournalBatchDto,
  RejectBudgetTransferDto,
  UpdateDepartmentalBudgetDto,
  VoidJournalBatchDto,
  type BudgetCategory,
  type BudgetTransferStatus,
  type JournalBatchStatus,
} from './dto/commerce-advanced.dto';

interface AuthRequest extends Request {
  user?: { accountId: string; personId: string };
}

@ApiTags('Finance — Budget Transfers + Journal Batches')
@Controller()
export class FinanceAdvancedController {
  constructor(
    private readonly actorContext: ActorContextService,
    private readonly budgets: DepartmentalBudgetService,
    private readonly transfers: BudgetTransferService,
    private readonly journals: JournalBatchService,
  ) {}

  private async resolve(req: AuthRequest): Promise<ResolvedActor> {
    return this.actorContext.resolveActor(req.user!.accountId, req.user!.personId);
  }

  // ── Departmental Budgets (FIN-006) ────────────────────────────────

  @Get('finance/departmental-budgets')
  @RequirePermission('fin-006:read')
  @ApiOperation({
    summary:
      'List departmental budgets. available_amount = allocated - committed - spent (computed in service code so it can go negative on overspend, which the variance dashboard surfaces).',
  })
  async listBudgets(
    @Req() req: AuthRequest,
    @Query('academicYearId') academicYearId?: string,
    @Query('department') department?: string,
    @Query('category') category?: BudgetCategory,
  ) {
    return this.budgets.list(await this.resolve(req), {
      academicYearId,
      department,
      category,
    });
  }

  @Get('finance/departmental-budgets/:id')
  @RequirePermission('fin-006:read')
  @ApiOperation({ summary: 'Get a departmental budget with computed available_amount.' })
  async getBudget(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.budgets.getById(await this.resolve(req), id);
  }

  @Post('finance/departmental-budgets')
  @RequirePermission('fin-006:admin')
  @ApiOperation({ summary: 'Create a departmental budget (FIN-006:admin).' })
  async createBudget(@Req() req: AuthRequest, @Body() body: CreateDepartmentalBudgetDto) {
    return this.budgets.create(await this.resolve(req), body);
  }

  @Patch('finance/departmental-budgets/:id')
  @RequirePermission('fin-006:admin')
  @ApiOperation({ summary: 'Update a departmental budget (FIN-006:admin).' })
  async patchBudget(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateDepartmentalBudgetDto,
  ) {
    return this.budgets.patch(await this.resolve(req), id, body);
  }

  // ── Budget Transfers (FIN-006) ────────────────────────────────────

  @Get('finance/budget-transfers')
  @RequirePermission('fin-006:read')
  @ApiOperation({ summary: 'List budget transfers, optionally filtered by status.' })
  async listTransfers(@Req() req: AuthRequest, @Query('status') status?: BudgetTransferStatus) {
    return this.transfers.list(await this.resolve(req), status);
  }

  @Get('finance/budget-transfers/:id')
  @RequirePermission('fin-006:read')
  @ApiOperation({ summary: 'Get a single budget transfer.' })
  async getTransfer(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.transfers.getById(await this.resolve(req), id);
  }

  @Post('finance/budget-transfers')
  @RequirePermission('fin-006:read')
  @ApiOperation({ summary: 'Request a budget transfer (PENDING).' })
  async requestTransfer(@Req() req: AuthRequest, @Body() body: CreateBudgetTransferDto) {
    return this.transfers.request(await this.resolve(req), body);
  }

  @Post('finance/budget-transfers/:id/approve')
  @RequirePermission('fin-006:admin')
  @ApiOperation({
    summary:
      'Atomic approve — from_budget allocated decremented + to_budget allocated incremented + transfer flipped to APPROVED in one tenant tx with FOR UPDATE locks on both budget rows.',
  })
  async approveTransfer(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.transfers.approve(await this.resolve(req), id);
  }

  @Post('finance/budget-transfers/:id/reject')
  @RequirePermission('fin-006:admin')
  @ApiOperation({ summary: 'Reject a PENDING budget transfer with a reason.' })
  async rejectTransfer(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectBudgetTransferDto,
  ) {
    return this.transfers.reject(await this.resolve(req), id, body);
  }

  // ── Journal Entry Batches (FIN-005) ───────────────────────────────

  @Get('finance/journal-entry-batches')
  @RequirePermission('fin-005:read')
  @ApiOperation({ summary: 'List manual journal entry batches.' })
  async listJournalBatches(@Req() req: AuthRequest, @Query('status') status?: JournalBatchStatus) {
    return this.journals.list(await this.resolve(req), status);
  }

  @Get('finance/journal-entry-batches/:id')
  @RequirePermission('fin-005:read')
  @ApiOperation({ summary: 'Get a manual journal batch with inlined lines.' })
  async getJournalBatch(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.journals.getById(await this.resolve(req), id);
  }

  @Post('finance/journal-entry-batches')
  @RequirePermission('fin-005:admin')
  @ApiOperation({ summary: 'Create a DRAFT manual journal batch.' })
  async createJournalBatch(@Req() req: AuthRequest, @Body() body: CreateJournalBatchDto) {
    return this.journals.create(await this.resolve(req), body);
  }

  @Post('finance/journal-entry-batches/:id/lines')
  @RequirePermission('fin-005:admin')
  @ApiOperation({
    summary:
      'Add a single-sided line to a DRAFT journal batch (debit OR credit, never both; non-zero). Recomputes parent batch totals + is_balanced flag.',
  })
  async addLine(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddJournalEntryLineDto,
  ) {
    return this.journals.addLine(await this.resolve(req), id, body);
  }

  @Delete('finance/journal-entry-batches/:id/lines/:lineId')
  @RequirePermission('fin-005:admin')
  @ApiOperation({
    summary: 'Remove a line from a DRAFT journal batch and recompute totals.',
  })
  async removeLine(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lineId', new ParseUUIDPipe()) lineId: string,
  ) {
    return this.journals.removeLine(await this.resolve(req), id, lineId);
  }

  @Post('finance/journal-entry-batches/:id/post')
  @RequirePermission('fin-005:admin')
  @ApiOperation({
    summary:
      'POST a DRAFT journal batch. KEYSTONE: validates total_debits = total_credits AND entry_count > 0 before creating Cycle 26 fin_gl_entries for each line. Unbalanced batches are rejected with the entire tx rolling back.',
  })
  async postJournalBatch(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.journals.post(await this.resolve(req), id);
  }

  @Post('finance/journal-entry-batches/:id/void')
  @RequirePermission('fin-005:admin')
  @ApiOperation({ summary: 'Void a POSTED journal batch with a reason.' })
  async voidJournalBatch(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: VoidJournalBatchDto,
  ) {
    return this.journals.void(await this.resolve(req), id, body);
  }
}
