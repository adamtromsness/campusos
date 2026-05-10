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
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { DiscountRuleService } from './discount-rule.service';
import { AutoInvoiceService } from './auto-invoice.service';
import {
  CreateDiscountRuleDto,
  DiscountRuleResponseDto,
  ListDiscountRulesQueryDto,
  UpdateDiscountRuleDto,
} from './dto/discount-rule.dto';
import {
  AutoInvoiceRuleResponseDto,
  CreateAutoInvoiceRuleDto,
  InvoiceGenerationRunResponseDto,
  ListInvoiceGenerationRunsQueryDto,
  TriggerAutoInvoiceRuleDto,
  UpdateAutoInvoiceRuleDto,
} from './dto/auto-invoice-rule.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
}

@ApiTags('Payments: Billing Config')
@ApiBearerAuth()
@Controller('payments')
export class BillingConfigController {
  constructor(
    private readonly discounts: DiscountRuleService,
    private readonly autoInvoice: AutoInvoiceService,
    private readonly actors: ActorContextService,
  ) {}

  /** ───── Discount Rules ───── */

  @Get('discount-rules')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List discount rules (admin only)' })
  async listDiscountRules(
    @Query() query: ListDiscountRulesQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<DiscountRuleResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.discounts.list(query, actor);
  }

  @Get('discount-rules/:id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get a discount rule' })
  async getDiscountRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<DiscountRuleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.discounts.getById(id, actor);
  }

  @Post('discount-rules')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Create a discount rule (admin only)' })
  async createDiscountRule(
    @Body() body: CreateDiscountRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<DiscountRuleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.discounts.create(body, actor);
  }

  @Patch('discount-rules/:id')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Patch a discount rule (admin only)' })
  async updateDiscountRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDiscountRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<DiscountRuleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.discounts.update(id, body, actor);
  }

  /** ───── Auto-Invoice Rules ───── */

  @Get('auto-invoice-rules')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List auto-invoice rules (admin only)' })
  async listAutoRules(
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<AutoInvoiceRuleResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.listRules(includeInactive === 'true', actor);
  }

  @Get('auto-invoice-rules/:id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get an auto-invoice rule' })
  async getAutoRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<AutoInvoiceRuleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.getRuleById(id, actor);
  }

  @Post('auto-invoice-rules')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Create an auto-invoice rule (admin only)' })
  async createAutoRule(
    @Body() body: CreateAutoInvoiceRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<AutoInvoiceRuleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.createRule(body, actor);
  }

  @Patch('auto-invoice-rules/:id')
  @RequirePermission('fin-001:admin')
  @ApiOperation({ summary: 'Patch an auto-invoice rule (admin only)' })
  async updateAutoRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAutoInvoiceRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<AutoInvoiceRuleResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.updateRule(id, body, actor);
  }

  @Post('auto-invoice-rules/:id/trigger')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Trigger an auto-invoice rule synchronously. Walks eligible students, groups by family billing account, and creates DRAFT invoices with discount line items applied.',
  })
  async triggerAutoRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TriggerAutoInvoiceRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceGenerationRunResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.triggerRule(id, body, actor);
  }

  @Post('fee-schedules/:id/generate-invoices')
  @RequirePermission('fin-001:admin')
  @ApiOperation({
    summary:
      'Manual one-shot bulk invoice generation for a fee schedule. Creates a FEE_SCHEDULE_BULK run.',
  })
  async generateFromFeeSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TriggerAutoInvoiceRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceGenerationRunResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.generateFromFeeSchedule(id, body.academicYearId ?? null, actor);
  }

  @Get('invoice-generation-runs')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'List invoice generation runs (admin only)' })
  async listGenerationRuns(
    @Query() query: ListInvoiceGenerationRunsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceGenerationRunResponseDto[]> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.listRuns(query, actor);
  }

  @Get('invoice-generation-runs/:id')
  @RequirePermission('fin-001:read')
  @ApiOperation({ summary: 'Get a single invoice generation run' })
  async getGenerationRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<InvoiceGenerationRunResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.autoInvoice.getRunById(id, actor);
  }
}
