import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '@shared/auth';
import { RequirePermission } from '@shared/auth';
import { ActorContextService } from '@modules/m00-platform';
import { InventoryService, ProductService, StoreService } from '../products/products.service';
import { ApprovalService, OrderService } from './orders.service';
import {
  ExternalCustomerService,
  RevenueService,
  ShippingService,
} from '../products/revenue.service';
import {
  AdjustInventoryDto,
  CancelOrderDto,
  CreateExternalCustomerDto,
  CreateOrderDto,
  CreateProductDto,
  CreateShippingOptionDto,
  CreateStoreDto,
  DeclineApprovalDto,
  FulfilOrderDto,
  MaterialiseRevenueDto,
  UpdateProductDto,
  UpdateShippingOptionDto,
  UpdateStoreDto,
} from './dto/store.dto';

interface AuthedRequest extends Request {
  user?: {
    sub: string;
    personId: string;
    email: string;
    displayName: string;
    sessionId: string;
  };
}

@ApiTags('Store')
@Controller()
export class StoreController {
  constructor(
    private readonly stores: StoreService,
    private readonly products: ProductService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly approvals: ApprovalService,
    private readonly externalCustomers: ExternalCustomerService,
    private readonly shipping: ShippingService,
    private readonly revenue: RevenueService,
    private readonly actors: ActorContextService,
  ) {}

  private async resolveActor(req: AuthedRequest) {
    if (!req.user) throw new Error('Unauthenticated request reached Store controller');
    return this.actors.resolveActor(req.user.sub, req.user.personId);
  }

  // ─── Stores ───
  @Get('store/stores')
  @RequirePermission('str-001:read')
  async listStores(@Query('includeInactive') includeInactive?: string) {
    return this.stores.list(includeInactive === 'true');
  }

  @Get('store/stores/:id')
  @RequirePermission('str-001:read')
  async getStore(@Param('id') id: string) {
    return this.stores.getById(id);
  }

  @Post('store/stores')
  @RequirePermission('str-003:write')
  async createStore(@Body() dto: CreateStoreDto, @Req() req: AuthedRequest) {
    return this.stores.create(await this.resolveActor(req), dto);
  }

  @Patch('store/stores/:id')
  @RequirePermission('str-003:write')
  async patchStore(
    @Param('id') id: string,
    @Body() dto: UpdateStoreDto,
    @Req() req: AuthedRequest,
  ) {
    return this.stores.patch(await this.resolveActor(req), id, dto);
  }

  // ─── Products ───
  @Get('store/stores/:id/products')
  @RequirePermission('str-001:read')
  async listProducts(
    @Param('id') id: string,
    @Query('category') category?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.products.listForStore(id, {
      category,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('store/products/:id')
  @RequirePermission('str-001:read')
  async getProduct(@Param('id') id: string) {
    return this.products.getById(id);
  }

  @Post('store/products')
  @RequirePermission('str-001:write')
  async createProduct(@Body() dto: CreateProductDto, @Req() req: AuthedRequest) {
    return this.products.create(await this.resolveActor(req), dto);
  }

  @Patch('store/products/:id')
  @RequirePermission('str-001:write')
  async patchProduct(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: AuthedRequest,
  ) {
    return this.products.patch(await this.resolveActor(req), id, dto);
  }

  // ─── Inventory ───
  @Get('store/inventory')
  @RequirePermission('str-001:write')
  async inventoryDashboard() {
    return this.inventory.dashboard();
  }

  @Patch('store/inventory/:id')
  @RequirePermission('str-001:write')
  @ApiOperation({
    summary:
      'Adjust an inventory row. When stock crosses from above-reorder-point to at-or-below, emits str.inventory.reorder_needed AFTER tx commits (delta-based; no re-fire on subsequent below-threshold adjustments).',
  })
  async adjustInventory(
    @Param('id') id: string,
    @Body() dto: AdjustInventoryDto,
    @Req() req: AuthedRequest,
  ) {
    await this.inventory.adjust(await this.resolveActor(req), id, dto);
    return { ok: true };
  }

  // ─── Orders ───
  @Get('store/orders')
  @RequirePermission('str-002:read')
  async listOrders(
    @Req() req: AuthedRequest,
    @Query('storeId') storeId?: string,
    @Query('status') status?: string,
    @Query('orderType') orderType?: string,
  ) {
    return this.orders.list(await this.resolveActor(req), { storeId, status, orderType });
  }

  @Get('store/orders/:id')
  @RequirePermission('str-002:read')
  async getOrder(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.getById(id, await this.resolveActor(req));
  }

  @Post('store/orders')
  @RequirePermission('str-002:write')
  @ApiOperation({
    summary:
      'PARENT APPROVAL GATE KEYSTONE — STUDENT orders auto-create a PENDING str_order_approvals row + reserve inventory but do NOT charge payment until the parent approves. PARENT/EXTERNAL orders charge directly and emit str.order.completed at order-create time.',
  })
  async createOrder(@Body() dto: CreateOrderDto, @Req() req: AuthedRequest) {
    return this.orders.create(await this.resolveActor(req), dto);
  }

  @Patch('store/orders/:id/fulfil')
  @RequirePermission('str-002:write')
  async fulfilOrder(
    @Param('id') id: string,
    @Body() dto: FulfilOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.fulfil(await this.resolveActor(req), id, dto);
  }

  @Patch('store/orders/:id/complete')
  @RequirePermission('str-002:write')
  @ApiOperation({
    summary:
      'Mark order COMPLETED. Decrements quantity_on_hand by line.quantity for every IN_STOCK line + flips them to FULFILLED, atomically inside one tenant tx.',
  })
  async completeOrder(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.orders.complete(await this.resolveActor(req), id);
  }

  @Patch('store/orders/:id/cancel')
  @RequirePermission('str-002:write')
  async cancelOrder(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return this.orders.cancel(await this.resolveActor(req), id, dto);
  }

  // ─── Approvals ───
  @Get('store/approvals')
  @RequirePermission('str-002:read')
  async listApprovals(@Req() req: AuthedRequest) {
    return this.approvals.listForParent(await this.resolveActor(req));
  }

  @Patch('store/approvals/:id/approve')
  @RequirePermission('str-002:write')
  @ApiOperation({
    summary:
      'Parent approves a PENDING student order. Atomically flips approval to APPROVED + advances the order to PROCESSING + emits str.order.completed for Cycle 6 family-billing pickup.',
  })
  async approveApproval(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.approvals.approve(await this.resolveActor(req), id);
  }

  @Patch('store/approvals/:id/decline')
  @RequirePermission('str-002:write')
  @ApiOperation({
    summary:
      'Parent declines a PENDING student order with required reason. Order flips to CANCELLED + reserved inventory released atomically.',
  })
  async declineApproval(
    @Param('id') id: string,
    @Body() dto: DeclineApprovalDto,
    @Req() req: AuthedRequest,
  ) {
    return this.approvals.decline(await this.resolveActor(req), id, dto);
  }

  // ─── External customers ───
  @Get('store/external-customers')
  @RequirePermission('str-003:read')
  async listExternalCustomers(@Req() req: AuthedRequest) {
    return this.externalCustomers.list(await this.resolveActor(req));
  }

  @Get('store/external-customers/:id')
  @RequirePermission('str-003:read')
  async getExternalCustomer(@Param('id') id: string) {
    return this.externalCustomers.getById(id);
  }

  /**
   * Public endpoint — unauthenticated alumni / community visitors create an
   * external customer record at PUBLIC store checkout. No PRC-* gate.
   */
  @Public()
  @Post('shop/external-customers')
  @ApiOperation({ summary: 'Public: register an external customer for PUBLIC store checkout.' })
  async registerExternalCustomer(@Body() dto: CreateExternalCustomerDto) {
    return this.externalCustomers.create(dto);
  }

  // ─── Shipping options ───
  @Get('store/stores/:id/shipping-options')
  @RequirePermission('str-001:read')
  async listShippingOptions(
    @Param('id') id: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.shipping.listForStore(id, includeInactive === 'true');
  }

  @Post('store/shipping-options')
  @RequirePermission('str-003:write')
  async createShippingOption(@Body() dto: CreateShippingOptionDto, @Req() req: AuthedRequest) {
    return this.shipping.create(await this.resolveActor(req), dto);
  }

  @Patch('store/shipping-options/:id')
  @RequirePermission('str-003:write')
  async patchShippingOption(
    @Param('id') id: string,
    @Body() dto: UpdateShippingOptionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.shipping.patch(await this.resolveActor(req), id, dto);
  }

  // ─── Revenue ───
  @Get('store/revenue')
  @RequirePermission('str-003:read')
  async listRevenue(@Req() req: AuthedRequest, @Query('storeId') storeId?: string) {
    return this.revenue.list(await this.resolveActor(req), storeId);
  }

  @Post('store/revenue/materialise')
  @RequirePermission('str-003:write')
  @ApiOperation({
    summary:
      'StoreRevenueWorker — aggregates COMPLETED orders for the store + period, sums revenue + cost, computes gross margin, UPSERTs into str_store_revenue keyed on (store, period_start, period_end). Idempotent.',
  })
  async materialiseRevenue(@Body() dto: MaterialiseRevenueDto, @Req() req: AuthedRequest) {
    return this.revenue.materialise(await this.resolveActor(req), dto);
  }
}
