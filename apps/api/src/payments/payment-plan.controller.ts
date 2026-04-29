import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { PaymentPlanService } from './payment-plan.service';
import { CreatePaymentPlanDto, PaymentPlanResponseDto } from './dto/payment-plan.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Payment Plans')
@ApiBearerAuth()
@Controller()
export class PaymentPlanController {
  constructor(
    private readonly plans: PaymentPlanService,
    private readonly actors: ActorContextService,
  ) {}

  @Post('invoices/:id/payment-plan')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Create a payment plan for an invoice (admin only). Auto-generates installment rows.',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreatePaymentPlanDto,
    @Req() req: AuthedRequest,
  ): Promise<PaymentPlanResponseDto> {
    var actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.plans.create(id, body, actor);
  }

  @Get('payment-plans/:id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get a payment plan with installments' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentPlanResponseDto> {
    return this.plans.getById(id);
  }
}
