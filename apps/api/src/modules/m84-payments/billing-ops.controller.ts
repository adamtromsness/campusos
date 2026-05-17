import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { CreditNoteService } from './credit-note.service';
import { ReversalService } from './reversal.service';
import { PaymentAllocationService } from './payment-allocation.service';
import { LateFeeService } from './late-fee.service';
import { SavedPaymentMethodService } from './saved-payment-method.service';
import {
  AllocatePaymentDto,
  CreateSavedPaymentMethodDto,
  CreditNoteResponseDto,
  IssueCreditNoteDto,
  LateFeesScanResponseDto,
  LatePaymentPolicyResponseDto,
  ListCreditNotesQueryDto,
  ListReversalsQueryDto,
  PaymentAllocationResponseDto,
  PaymentReversalResponseDto,
  ReversePaymentDto,
  SavedPaymentMethodResponseDto,
  UpsertLatePaymentPolicyDto,
} from './dto/billing-ops.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Billing Operations')
@ApiBearerAuth()
@Controller('payments')
export class BillingOpsController {
  constructor(
    private readonly creditNotes: CreditNoteService,
    private readonly reversals: ReversalService,
    private readonly allocations: PaymentAllocationService,
    private readonly lateFees: LateFeeService,
    private readonly savedPaymentMethods: SavedPaymentMethodService,
    private readonly actors: ActorContextService,
  ) {}

  /** ───── Credit Notes (IMMUTABLE) ───── */

  @Get('credit-notes')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'List credit notes (admin only). IMMUTABLE — no UPDATE / no DELETE.' })
  async listCreditNotes(
    @Query() query: ListCreditNotesQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<CreditNoteResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.creditNotes.list(query, actor);
  }

  @Get('credit-notes/:id')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Get a credit note (admin only)' })
  async getCreditNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<CreditNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.creditNotes.getById(id, actor);
  }

  @Post('invoices/:id/credit-note')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'IMMUTABLE: issue a credit note against an invoice. Locks invoice, writes a CREDIT pay_ledger_entries row, INSERTs the credit note, recomputes invoice status, emits pay.credit_note.issued. Service has no UPDATE / no DELETE — corrections are made by issuing offsetting credit notes or refunds.',
  })
  async issueCreditNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IssueCreditNoteDto,
    @Req() req: AuthedRequest,
  ): Promise<CreditNoteResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.creditNotes.issue(id, body, actor);
  }

  /** ───── Payment Reversals (IMMUTABLE) ───── */

  @Get('reversals')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary: 'List payment reversals (admin only). IMMUTABLE — no UPDATE / no DELETE.',
  })
  async listReversals(
    @Query() query: ListReversalsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<PaymentReversalResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reversals.list(query, actor);
  }

  @Get('reversals/:id')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Get a payment reversal (admin only)' })
  async getReversal(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PaymentReversalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reversals.getById(id, actor);
  }

  @Post('payments/:id/reverse')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'IMMUTABLE: reverse a COMPLETED payment (BOUNCED_CHEQUE, CHARGEBACK, etc). Locks invoice + payment, writes an offsetting CHARGE ledger entry, flips payment to FAILED, reinstates the invoice status, emits pay.payment.reversed. UNIQUE(payment_id) on the schema enforces one reversal per payment. Service has no UPDATE / no DELETE.',
  })
  async reversePayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReversePaymentDto,
    @Req() req: AuthedRequest,
  ): Promise<PaymentReversalResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.reversals.reverse(id, body, actor);
  }

  /** ───── Payment Allocations ───── */

  @Get('payments/:id/allocations')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'List payment allocations for a payment (admin only)' })
  async listAllocations(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PaymentAllocationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.allocations.listForPayment(id, actor);
  }

  @Post('payments/:id/allocate')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Split a payment across multiple invoices. SUM(allocatedAmount) MUST equal payment.amount. Locks payment FOR UPDATE inside one tx. Idempotent: drops + replaces existing allocations.',
  })
  async allocate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AllocatePaymentDto,
    @Req() req: AuthedRequest,
  ): Promise<PaymentAllocationResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.allocations.allocate(id, body, actor);
  }

  /** ───── Late Payment Policy + Worker ───── */

  @Get('late-payment-policy')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Get the school late payment policy (admin only)' })
  async getLatePaymentPolicy(
    @Req() req: AuthedRequest,
  ): Promise<LatePaymentPolicyResponseDto | null> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lateFees.getPolicy(actor);
  }

  @Put('late-payment-policy')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Upsert the school late payment policy (admin only)' })
  async upsertLatePaymentPolicy(
    @Body() body: UpsertLatePaymentPolicyDto,
    @Req() req: AuthedRequest,
  ): Promise<LatePaymentPolicyResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lateFees.upsertPolicy(body, actor);
  }

  @Post('late-fees/scan')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Run the LateFeesWorker scan synchronously (admin only). Walks invoices past due_date + grace_period_days and applies the configured late fee as a new line item, capped at max.',
  })
  async runLateFeesScan(@Req() req: AuthedRequest): Promise<LateFeesScanResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.lateFees.runScan(actor);
  }

  /** ───── Saved Payment Methods ───── */

  @Get('saved-payment-methods/:familyAccountId')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List saved payment methods for a family (admin or family member)' })
  async listSavedPaymentMethods(
    @Param('familyAccountId', ParseUUIDPipe) familyAccountId: string,
    @Req() req: AuthedRequest,
  ): Promise<SavedPaymentMethodResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.savedPaymentMethods.listForFamily(familyAccountId, actor);
  }

  @Post('saved-payment-methods')
  @RequirePermission('fin-001:write')
  @ApiOperation({
    summary:
      'Add a saved payment method (token-only — Stripe pm_ token + last-four + brand). Card numbers / CVCs / PINs never touch our DB.',
  })
  async createSavedPaymentMethod(
    @Body() body: CreateSavedPaymentMethodDto,
    @Req() req: AuthedRequest,
  ): Promise<SavedPaymentMethodResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.savedPaymentMethods.create(body, actor);
  }

  @Delete('saved-payment-methods/:id')
  @RequirePermission('fin-001:write')
  @ApiOperation({ summary: 'Soft-remove a saved payment method (admin or family member)' })
  async removeSavedPaymentMethod(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ id: string; removed: boolean }> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.savedPaymentMethods.remove(id, actor);
  }
}
