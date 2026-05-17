import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth/require-permission.decorator';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { RequisitionService } from './requisitions.service';
import { GoodsReceiptService, PurchaseOrderService } from './purchase-orders.service';
import {
  DistributionService,
  ProcurementSettingsService,
  ReturnService,
  VendorPerformanceService,
} from './distribution.service';
import {
  ApproveRequisitionDto,
  CreateDistributionDto,
  CreateGoodsReceiptDto,
  CreatePurchaseOrderDto,
  CreateRequisitionDto,
  CreateRequisitionLineDto,
  CreateReturnDto,
  POTransitionDto,
  RejectRequisitionDto,
  UpdateProcurementSettingsDto,
  UpdateReturnDto,
} from './dto/procurement.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Procurement')
@Controller()
export class ProcurementController {
  constructor(
    private readonly requisitions: RequisitionService,
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly receipts: GoodsReceiptService,
    private readonly distributions: DistributionService,
    private readonly returns: ReturnService,
    private readonly vendorPerformance: VendorPerformanceService,
    private readonly settings: ProcurementSettingsService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Procurement controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Requisitions ───
  @Get('procurement/requisitions')
  @RequirePermission('prc-001:read')
  async listRequisitions(@Query('status') status: string | undefined, @Req() req: AuthedRequest) {
    return this.requisitions.list(await this.resolveActor(req), status);
  }

  @Get('procurement/requisitions/:id')
  @RequirePermission('prc-001:read')
  async getRequisition(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.requisitions.getById(id, await this.resolveActor(req));
  }

  @Post('procurement/requisitions')
  @RequirePermission('prc-001:write')
  async createRequisition(@Body() dto: CreateRequisitionDto, @Req() req: AuthedRequest) {
    return this.requisitions.create(await this.resolveActor(req), dto);
  }

  @Post('procurement/requisitions/:id/lines')
  @RequirePermission('prc-001:write')
  async addRequisitionLine(
    @Param('id') id: string,
    @Body() dto: CreateRequisitionLineDto,
    @Req() req: AuthedRequest,
  ) {
    return this.requisitions.addLine(await this.resolveActor(req), id, dto);
  }

  @Delete('procurement/requisitions/lines/:lineId')
  @RequirePermission('prc-001:write')
  async removeRequisitionLine(@Param('lineId') lineId: string, @Req() req: AuthedRequest) {
    return this.requisitions.removeLine(await this.resolveActor(req), lineId);
  }

  @Patch('procurement/requisitions/:id/submit')
  @RequirePermission('prc-001:write')
  @ApiOperation({
    summary:
      'Submit a DRAFT requisition. Validates all required fields + at-least-one-line + budget remaining (when budgetLineId set), then emits prc.requisition.submitted for the approval workflow.',
  })
  async submitRequisition(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.requisitions.submit(await this.resolveActor(req), id);
  }

  @Patch('procurement/requisitions/:id/approve')
  @RequirePermission('prc-001:write')
  @ApiOperation({
    summary:
      'Advance the requisition through the approval chain: SUBMITTED → DEPT_APPROVED → ADMIN_APPROVED → DISTRICT_APPROVED.',
  })
  async approveRequisition(
    @Param('id') id: string,
    @Body() dto: ApproveRequisitionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.requisitions.approve(await this.resolveActor(req), id, dto);
  }

  @Patch('procurement/requisitions/:id/reject')
  @RequirePermission('prc-001:write')
  async rejectRequisition(
    @Param('id') id: string,
    @Body() dto: RejectRequisitionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.requisitions.reject(await this.resolveActor(req), id, dto);
  }

  // ─── Purchase Orders ───
  @Get('procurement/purchase-orders')
  @RequirePermission('prc-002:read')
  async listPOs(@Query('status') status?: string, @Query('vendorId') vendorId?: string) {
    return this.purchaseOrders.list({ status, vendorId });
  }

  @Get('procurement/purchase-orders/:id')
  @RequirePermission('prc-002:read')
  async getPO(@Param('id') id: string) {
    return this.purchaseOrders.getById(id);
  }

  @Post('procurement/purchase-orders')
  @RequirePermission('prc-002:write')
  async createPO(@Body() dto: CreatePurchaseOrderDto, @Req() req: AuthedRequest) {
    return this.purchaseOrders.create(await this.resolveActor(req), dto);
  }

  @Patch('procurement/purchase-orders/:id/transition')
  @RequirePermission('prc-002:write')
  @ApiOperation({
    summary:
      'BUDGET COMMITMENT KEYSTONE — ISSUE creates prc_budget_commitments + bumps fin_budget_lines.encumbered_amount in one tenant tx; CLOSE / CANCEL release. budgetLineId in body overrides parent requisition default.',
  })
  async transitionPO(
    @Param('id') id: string,
    @Body() dto: POTransitionDto & { budgetLineId?: string },
    @Req() req: AuthedRequest,
  ) {
    const { budgetLineId, ...rest } = dto;
    return this.purchaseOrders.transition(await this.resolveActor(req), id, rest, budgetLineId);
  }

  // ─── Goods Receipts ───
  @Get('procurement/purchase-orders/:id/receipts')
  @RequirePermission('prc-002:read')
  async listReceipts(@Param('id') id: string) {
    return this.receipts.listForPO(id);
  }

  @Post('procurement/purchase-orders/:id/receipts')
  @RequirePermission('prc-002:write')
  @ApiOperation({
    summary:
      'Receive goods against a PO. Atomically writes receipt + lines, updates prc_vendor_performance with on-time + quality scores, and auto-flips PO status to PARTIALLY_RECEIVED or RECEIVED based on cumulative quantities.',
  })
  async createReceipt(
    @Param('id') id: string,
    @Body() dto: CreateGoodsReceiptDto,
    @Req() req: AuthedRequest,
  ) {
    return this.receipts.create(await this.resolveActor(req), id, dto);
  }

  // ─── Distributions ───
  @Get('procurement/receipts/:receiptId/distributions')
  @RequirePermission('prc-003:read')
  async listDistributions(@Param('receiptId') receiptId: string) {
    return this.distributions.listForReceipt(receiptId);
  }

  @Post('procurement/receipts/:receiptId/distributions')
  @RequirePermission('prc-003:write')
  @ApiOperation({
    summary:
      'CROSS-MODULE DISTRIBUTION KEYSTONE — emits prc.distribution.completed with destination_module so the downstream module (tech / trn / fds / lib / ath / ext / fac / str) can react.',
  })
  async createDistribution(
    @Param('receiptId') receiptId: string,
    @Body() dto: CreateDistributionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.distributions.create(await this.resolveActor(req), receiptId, dto);
  }

  // ─── Returns ───
  @Get('procurement/returns')
  @RequirePermission('prc-003:read')
  async listReturns(@Query('status') status?: string) {
    return this.returns.listAll({ status });
  }

  @Get('procurement/returns/:id')
  @RequirePermission('prc-003:read')
  async getReturn(@Param('id') id: string) {
    return this.returns.getById(id);
  }

  @Get('procurement/receipt-lines/:receiptLineId/returns')
  @RequirePermission('prc-003:read')
  async listReturnsForLine(@Param('receiptLineId') receiptLineId: string) {
    return this.returns.listForReceiptLine(receiptLineId);
  }

  @Post('procurement/receipt-lines/:receiptLineId/returns')
  @RequirePermission('prc-003:write')
  async createReturn(
    @Param('receiptLineId') receiptLineId: string,
    @Body() dto: CreateReturnDto,
    @Req() req: AuthedRequest,
  ) {
    return this.returns.create(await this.resolveActor(req), receiptLineId, dto);
  }

  @Patch('procurement/returns/:id')
  @RequirePermission('prc-003:write')
  @ApiOperation({
    summary:
      'Update a return — SHIP (INITIATED → SHIPPED_TO_VENDOR), RESOLVE (→ RESOLVED with required resolution), CANCEL.',
  })
  async updateReturn(
    @Param('id') id: string,
    @Body() dto: UpdateReturnDto,
    @Req() req: AuthedRequest,
  ) {
    return this.returns.update(await this.resolveActor(req), id, dto);
  }

  // ─── Vendor Performance ───
  @Get('procurement/vendor-performance')
  @RequirePermission('prc-003:read')
  async listVendorPerformance() {
    return this.vendorPerformance.list();
  }

  @Get('procurement/vendor-performance/:vendorId')
  @RequirePermission('prc-003:read')
  async getVendorPerformance(@Param('vendorId') vendorId: string) {
    return this.vendorPerformance.getForVendor(vendorId);
  }

  // ─── Settings ───
  @Get('procurement/settings')
  @RequirePermission('prc-001:read')
  async getSettings() {
    return this.settings.get();
  }

  @Patch('procurement/settings')
  @RequirePermission('prc-001:admin')
  async updateSettings(@Body() dto: UpdateProcurementSettingsDto, @Req() req: AuthedRequest) {
    return this.settings.update(await this.resolveActor(req), dto);
  }
}
