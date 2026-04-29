import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { PaymentService } from './payment.service';
import { ListPaymentsQueryDto, PayInvoiceDto, PaymentResponseDto } from './dto/payment.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Payments')
@ApiBearerAuth()
@Controller()
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly actors: ActorContextService,
  ) {}

  @Get('payments')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List payments (admin: all, parent: own family)' })
  async list(
    @Query() query: ListPaymentsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<PaymentResponseDto[]> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payments.list(query, actor);
  }

  @Get('payments/:id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get a payment (row-scoped to admin or owning account holder)' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<PaymentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payments.getById(id, actor);
  }

  @Post('invoices/:id/pay')
  @RequirePermission('fin-001:write')
  @ApiOperation({
    summary:
      'Pay an invoice (parent or admin). Locks invoice FOR UPDATE, writes PAYMENT ledger entry, recomputes status, emits pay.payment.received. Stripe stubbed in dev.',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayInvoiceDto,
    @Req() req: AuthedRequest,
  ): Promise<PaymentResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.payments.pay(id, body, actor);
  }
}
