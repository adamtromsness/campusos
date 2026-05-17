import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { EventService, TierService } from './events.service';
import { OrderService, RefundService } from './orders.service';
import {
  CompListService,
  GateScanService,
  SeasonPassService,
  VolunteerService,
} from './gate.service';
import { EventRevenueService } from './revenue.service';
import {
  AddCompEntryDto,
  CancelOrderDto,
  CompCheckDto,
  ConfirmOrderDto,
  CreateEventDto,
  CreateSeasonPassDto,
  CreateTierDto,
  CreateVolunteerDto,
  EventStatus,
  EventType,
  GateScanDto,
  OrderStatus,
  PurchaseDto,
  RefundOrderDto,
  SeasonPassGateCheckDto,
  UpdateEventDto,
  UpdateTierDto,
  UpdateVolunteerDto,
} from './dto/events.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Events')
@Controller()
export class EventsController {
  constructor(
    private readonly events: EventService,
    private readonly tiers: TierService,
    private readonly orders: OrderService,
    private readonly refunds: RefundService,
    private readonly gate: GateScanService,
    private readonly seasonPasses: SeasonPassService,
    private readonly compList: CompListService,
    private readonly volunteers: VolunteerService,
    private readonly revenue: EventRevenueService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Events controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Events ───
  @Get('events')
  @RequirePermission('evt-001:read')
  @ApiOperation({
    summary: 'List events — public surface shows ON_SALE / SOLD_OUT / COMPLETED only.',
  })
  async listEvents(
    @Req() req: AuthedRequest,
    @Query('status') status?: EventStatus,
    @Query('eventType') eventType?: EventType,
    @Query('fromDate') fromDate?: string,
  ) {
    const actor = await this.resolveActor(req);
    return this.events.list(actor, { status, eventType, fromDate });
  }

  // Revenue must be declared BEFORE `events/:id` so the literal path
  // wins over the dynamic param. NestJS matches routes in declaration
  // order so `events/revenue/summary` here resolves before `:id`.
  @Get('events/revenue/summary')
  @RequirePermission('evt-001:read')
  @ApiOperation({
    summary: 'School-wide revenue rollup by event type for the supplied window (default 90 days).',
  })
  async revenueSummary(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.revenue.summary({ from, to }, await this.resolveActor(req));
  }

  @Get('events/:id/revenue')
  @RequirePermission('evt-001:read')
  @ApiOperation({
    summary: 'Per-event revenue + attendance report (gross, refunds, Stripe fees, net, by tier).',
  })
  async revenueForEvent(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.revenue.forEvent(id, await this.resolveActor(req));
  }

  @Get('events/:id')
  @RequirePermission('evt-001:read')
  async getEvent(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.events.getById(id, await this.resolveActor(req));
  }

  @Post('events')
  @RequirePermission('evt-001:write')
  async createEvent(@Body() dto: CreateEventDto, @Req() req: AuthedRequest) {
    return this.events.create(dto, await this.resolveActor(req));
  }

  @Patch('events/:id')
  @RequirePermission('evt-001:write')
  async patchEvent(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @Req() req: AuthedRequest,
  ) {
    return this.events.patch(id, dto, await this.resolveActor(req));
  }

  @Post('events/:id/complete')
  @RequirePermission('evt-001:write')
  @ApiOperation({
    summary: 'Mark event COMPLETED. Emits evt.event.completed for the Cycle 26 GLConsumer.',
  })
  async completeEvent(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.events.complete(id, await this.resolveActor(req));
  }

  // ─── Tiers ───
  @Get('events/:id/tiers')
  @RequirePermission('evt-001:read')
  async listTiers(@Param('id') eventId: string) {
    return this.tiers.listForEvent(eventId);
  }

  @Post('events/:id/tiers')
  @RequirePermission('evt-001:write')
  async createTier(
    @Param('id') eventId: string,
    @Body() dto: CreateTierDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tiers.create(eventId, dto, await this.resolveActor(req));
  }

  @Patch('events/tiers/:tierId')
  @RequirePermission('evt-001:write')
  async patchTier(
    @Param('tierId') tierId: string,
    @Body() dto: UpdateTierDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tiers.patch(tierId, dto, await this.resolveActor(req));
  }

  // ─── Orders ───
  @Get('events/orders')
  @RequirePermission('evt-001:read')
  async listOrders(
    @Req() req: AuthedRequest,
    @Query('eventId') eventId?: string,
    @Query('status') status?: OrderStatus,
    @Query('mine') mine?: string,
  ) {
    return this.orders.list(await this.resolveActor(req), {
      eventId,
      status,
      mine: mine === 'true',
    });
  }

  @Get('events/orders/my')
  @RequirePermission('evt-001:read')
  async listMyOrders(@Req() req: AuthedRequest) {
    return this.orders.list(await this.resolveActor(req), { mine: true });
  }

  @Get('events/orders/:id')
  @RequirePermission('evt-001:read')
  async getOrder(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.getById(id, await this.resolveActor(req));
  }

  @Post('events/:eventId/purchase')
  @RequirePermission('evt-001:write')
  @ApiOperation({
    summary:
      'Purchase tickets — atomic UPDATE WHERE quantity_sold + qty <= quantity per tier. 0 rows matched returns 409 Sold Out.',
  })
  async purchase(
    @Param('eventId') eventId: string,
    @Body() dto: PurchaseDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.purchase(eventId, dto, await this.resolveActor(req));
  }

  @Post('events/orders/:id/confirm')
  @RequirePermission('evt-001:write')
  @ApiOperation({
    summary:
      'Confirm a PENDING order. Stripe webhook callback (stubbed in dev). Emits evt.order.confirmed.',
  })
  async confirmOrder(
    @Param('id') id: string,
    @Body() dto: ConfirmOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.confirm(id, dto, await this.resolveActor(req));
  }

  @Post('events/orders/:id/cancel')
  @RequirePermission('evt-001:write')
  async cancelOrder(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.cancel(id, dto, await this.resolveActor(req));
  }

  // ─── Refunds ───
  @Get('events/orders/:id/refunds')
  @RequirePermission('evt-001:read')
  async listRefunds(@Param('id') orderId: string, @Req() req: AuthedRequest) {
    return this.refunds.listForOrder(orderId, await this.resolveActor(req));
  }

  @Post('events/orders/:id/refund')
  @RequirePermission('evt-001:write')
  @ApiOperation({
    summary: 'Issue a refund. Admin/writer scope. Emits evt.refund.issued for GL posting.',
  })
  async issueRefund(
    @Param('id') orderId: string,
    @Body() dto: RefundOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.refunds.issue(orderId, dto, await this.resolveActor(req));
  }

  // ─── Gate scan ───
  @Post('events/gate/scan')
  @RequirePermission('evt-001:write')
  @ApiOperation({
    summary:
      'Atomic gate scan — UPDATE WHERE qr_code_token AND status=VALID. Every attempt logged regardless of result.',
  })
  async gateScan(@Body() dto: GateScanDto, @Req() req: AuthedRequest) {
    return this.gate.scan(dto, await this.resolveActor(req));
  }

  // ─── Season passes ───
  @Get('events/season-passes')
  @RequirePermission('evt-001:read')
  async listSeasonPasses(@Req() req: AuthedRequest) {
    return this.seasonPasses.listForActor(await this.resolveActor(req));
  }

  @Get('events/season-passes/my')
  @RequirePermission('evt-001:read')
  async listMyPasses(@Req() req: AuthedRequest) {
    return this.seasonPasses.listForActor(await this.resolveActor(req));
  }

  @Post('events/season-passes')
  @RequirePermission('evt-001:write')
  async createSeasonPass(@Body() dto: CreateSeasonPassDto, @Req() req: AuthedRequest) {
    return this.seasonPasses.create(dto, await this.resolveActor(req));
  }

  @Post('events/season-passes/:id/revoke')
  @RequirePermission('evt-001:write')
  async revokeSeasonPass(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.seasonPasses.revoke(id, await this.resolveActor(req));
  }

  @Post('events/gate/season-pass-check')
  @RequirePermission('evt-001:write')
  async seasonPassGate(@Body() dto: SeasonPassGateCheckDto, @Req() req: AuthedRequest) {
    return this.seasonPasses.gateCheck(dto, await this.resolveActor(req));
  }

  // ─── Comp lists ───
  @Get('events/:id/comp-list')
  @RequirePermission('evt-001:write')
  async listComp(@Param('id') eventId: string, @Req() req: AuthedRequest) {
    return this.compList.listForEvent(eventId, await this.resolveActor(req));
  }

  @Post('events/:id/comp-list')
  @RequirePermission('evt-001:write')
  async addComp(
    @Param('id') eventId: string,
    @Body() dto: AddCompEntryDto,
    @Req() req: AuthedRequest,
  ) {
    return this.compList.add(eventId, dto, await this.resolveActor(req));
  }

  @Delete('events/:id/comp-list/:entryId')
  @RequirePermission('evt-001:write')
  async removeComp(
    @Param('id') eventId: string,
    @Param('entryId') entryId: string,
    @Req() req: AuthedRequest,
  ) {
    await this.compList.remove(eventId, entryId, await this.resolveActor(req));
    return { ok: true };
  }

  @Post('events/gate/comp-check')
  @RequirePermission('evt-001:write')
  async compGate(@Body() dto: CompCheckDto, @Req() req: AuthedRequest) {
    return this.compList.gateCheck(dto, await this.resolveActor(req));
  }

  // ─── Volunteers ───
  @Get('events/:id/volunteers')
  @RequirePermission('evt-001:read')
  async listVolunteers(@Param('id') eventId: string) {
    return this.volunteers.listForEvent(eventId);
  }

  @Post('events/:id/volunteers')
  @RequirePermission('evt-001:read')
  async signUpVolunteer(
    @Param('id') eventId: string,
    @Body() dto: CreateVolunteerDto,
    @Req() req: AuthedRequest,
  ) {
    return this.volunteers.signUp(eventId, dto, await this.resolveActor(req));
  }

  @Patch('events/volunteers/:volunteerId')
  @RequirePermission('evt-001:read')
  async patchVolunteer(
    @Param('volunteerId') volunteerId: string,
    @Body() dto: UpdateVolunteerDto,
    @Req() req: AuthedRequest,
  ) {
    return this.volunteers.patch(volunteerId, dto, await this.resolveActor(req));
  }
}
