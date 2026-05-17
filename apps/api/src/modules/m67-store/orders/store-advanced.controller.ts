import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '@shared/auth';
import { ActorContextService, type ResolvedActor } from '@modules/m00-platform';
import { InventoryAdjustmentService } from '../inventory/inventory-adjustment.service';
import { PromotionService } from '../promotions/promotion.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { GiftCardService } from '../gift-cards/gift-card.service';
import { WishlistService } from '../wishlists/wishlist.service';
import { PriceScheduleService } from '../inventory/price-schedule.service';
import { CategoryHierarchyService } from '../categories/category-hierarchy.service';
import {
  AddWishlistDto,
  AdjustLoyaltyPointsDto,
  ApplyPromoCodeDto,
  CancelGiftCardDto,
  CreateCategoryDto,
  CreateInventoryAdjustmentDto,
  CreatePriceScheduleDto,
  CreatePromotionDto,
  EarnLoyaltyPointsDto,
  IssueGiftCardDto,
  RedeemGiftCardDto,
  RedeemLoyaltyPointsDto,
  TopUpGiftCardDto,
  UpdateCategoryDto,
  UpdatePromotionDto,
  UpdateWishlistDto,
  UpsertLoyaltyConfigDto,
  type GiftCardStatus,
} from './dto/commerce-store.dto';

interface AuthRequest extends Request {
  user?: { accountId: string; personId: string };
}

@ApiTags('Store Advanced')
@Controller()
export class StoreAdvancedController {
  constructor(
    private readonly actorContext: ActorContextService,
    private readonly inventoryAdjustments: InventoryAdjustmentService,
    private readonly promotions: PromotionService,
    private readonly loyalty: LoyaltyService,
    private readonly giftCards: GiftCardService,
    private readonly wishlists: WishlistService,
    private readonly priceSchedules: PriceScheduleService,
    private readonly categories: CategoryHierarchyService,
  ) {}

  private async resolve(req: AuthRequest): Promise<ResolvedActor> {
    return this.actorContext.resolveActor(req.user!.accountId, req.user!.personId);
  }

  // ── Inventory Adjustments (STR-001) ───────────────────────────────

  @Get('store/products/:productId/inventory-adjustments')
  @RequirePermission('str-001:read')
  @ApiOperation({ summary: 'List inventory adjustment history for a product.' })
  async listInventoryAdjustments(
    @Req() req: AuthRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryAdjustments.listForProduct(
      await this.resolve(req),
      productId,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('store/inventory-adjustments')
  @RequirePermission('str-001:write')
  @ApiOperation({
    summary:
      'Apply a stock adjustment outside the normal sales flow. Atomically updates str_product_inventory.quantity_on_hand under FOR UPDATE lock + writes the audit row. Refuses adjustments that would drive quantity_on_hand below 0.',
  })
  async adjustInventory(@Req() req: AuthRequest, @Body() body: CreateInventoryAdjustmentDto) {
    return this.inventoryAdjustments.adjust(await this.resolve(req), body);
  }

  // ── Promotions (STR-001) ──────────────────────────────────────────

  @Get('store/promotions')
  @RequirePermission('str-001:read')
  @ApiOperation({ summary: 'List promotions, optionally filtered by storeId and includeInactive.' })
  async listPromotions(
    @Req() req: AuthRequest,
    @Query('storeId') storeId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.promotions.list(await this.resolve(req), storeId, includeInactive === 'true');
  }

  @Get('store/promotions/:id')
  @RequirePermission('str-001:read')
  @ApiOperation({ summary: 'Get a promotion with inlined product ids.' })
  async getPromotion(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.promotions.getById(await this.resolve(req), id);
  }

  @Post('store/promotions')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Create a promotion with optional product allowlist.' })
  async createPromotion(@Req() req: AuthRequest, @Body() body: CreatePromotionDto) {
    return this.promotions.create(await this.resolve(req), body);
  }

  @Patch('store/promotions/:id')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Update a promotion. discount_type and promo_code are immutable.' })
  async patchPromotion(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePromotionDto,
  ) {
    return this.promotions.patch(await this.resolve(req), id, body);
  }

  @Post('store/promotions/apply-code')
  @RequirePermission('str-002:read')
  @ApiOperation({
    summary:
      'KEYSTONE: atomic promo code application. Single UPDATE bundles every gate (active, in date range, max_uses cap) into the WHERE clause + RETURNING — zero rows means the redemption is rejected with no use consumed.',
  })
  async applyPromoCode(@Req() req: AuthRequest, @Body() body: ApplyPromoCodeDto) {
    return this.promotions.applyPromoCode(await this.resolve(req), body);
  }

  // ── Loyalty ───────────────────────────────────────────────────────

  @Get('store/loyalty/config/:storeId')
  @RequirePermission('str-002:read')
  @ApiOperation({ summary: 'Read the loyalty programme config for a store.' })
  async getLoyaltyConfig(
    @Req() req: AuthRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
  ) {
    return this.loyalty.getConfig(await this.resolve(req), storeId);
  }

  @Put('store/loyalty/config')
  @RequirePermission('str-001:admin')
  @ApiOperation({ summary: 'Upsert the loyalty programme config for a store.' })
  async upsertLoyaltyConfig(@Req() req: AuthRequest, @Body() body: UpsertLoyaltyConfigDto) {
    return this.loyalty.upsertConfig(await this.resolve(req), body);
  }

  @Get('store/loyalty/balance')
  @RequirePermission('str-002:read')
  @ApiOperation({
    summary:
      'Aggregate loyalty balance for (storeId, customerPersonId). Customers may only read their own.',
  })
  async getLoyaltyBalance(
    @Req() req: AuthRequest,
    @Query('storeId', new ParseUUIDPipe()) storeId: string,
    @Query('customerPersonId', new ParseUUIDPipe()) customerPersonId: string,
  ) {
    return this.loyalty.getBalance(await this.resolve(req), storeId, customerPersonId);
  }

  @Get('store/loyalty/transactions')
  @RequirePermission('str-002:read')
  @ApiOperation({ summary: 'List the loyalty transaction history. Row-scoped to the customer.' })
  async listLoyaltyTransactions(
    @Req() req: AuthRequest,
    @Query('storeId', new ParseUUIDPipe()) storeId: string,
    @Query('customerPersonId', new ParseUUIDPipe()) customerPersonId: string,
    @Query('limit') limit?: string,
  ) {
    return this.loyalty.listTransactions(
      await this.resolve(req),
      storeId,
      customerPersonId,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('store/loyalty/earn')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Log earned points (admin or system path on order completion).' })
  async earnLoyalty(@Req() req: AuthRequest, @Body() body: EarnLoyaltyPointsDto) {
    return this.loyalty.earn(await this.resolve(req), body);
  }

  @Post('store/loyalty/redeem')
  @RequirePermission('str-002:read')
  @ApiOperation({
    summary:
      'KEYSTONE: atomic redemption. Locks the customer ledger with FOR UPDATE, recomputes balance, refuses if < min_redemption_points OR < requested.',
  })
  async redeemLoyalty(@Req() req: AuthRequest, @Body() body: RedeemLoyaltyPointsDto) {
    return this.loyalty.redeem(await this.resolve(req), body);
  }

  @Post('store/loyalty/adjust')
  @RequirePermission('str-001:admin')
  @ApiOperation({ summary: 'Manual loyalty adjustment (correction). Admin only.' })
  async adjustLoyalty(@Req() req: AuthRequest, @Body() body: AdjustLoyaltyPointsDto) {
    return this.loyalty.adjust(await this.resolve(req), body);
  }

  // ── Gift Cards ────────────────────────────────────────────────────

  @Get('store/gift-cards')
  @RequirePermission('str-001:read')
  @ApiOperation({ summary: 'List gift cards, optionally filtered by storeId and status.' })
  async listGiftCards(
    @Req() req: AuthRequest,
    @Query('storeId') storeId?: string,
    @Query('status') status?: GiftCardStatus,
  ) {
    return this.giftCards.list(await this.resolve(req), storeId, status);
  }

  @Get('store/gift-cards/code/:cardCode')
  @RequirePermission('str-002:read')
  @ApiOperation({ summary: 'Look up a gift card by code with inlined transaction history.' })
  async getGiftCardByCode(@Req() req: AuthRequest, @Param('cardCode') cardCode: string) {
    return this.giftCards.getByCode(await this.resolve(req), cardCode);
  }

  @Post('store/gift-cards/issue')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Issue a new gift card with auto-generated card_code.' })
  async issueGiftCard(@Req() req: AuthRequest, @Body() body: IssueGiftCardDto) {
    return this.giftCards.issue(await this.resolve(req), body);
  }

  @Post('store/gift-cards/redeem')
  @RequirePermission('str-002:read')
  @ApiOperation({
    summary:
      'KEYSTONE: atomic redemption. Single UPDATE with balance gate + expiry + status in WHERE — zero rows means the redemption is rejected and no audit row is written.',
  })
  async redeemGiftCard(@Req() req: AuthRequest, @Body() body: RedeemGiftCardDto) {
    return this.giftCards.redeem(await this.resolve(req), body);
  }

  @Post('store/gift-cards/:id/top-up')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Top up an ACTIVE or DEPLETED gift card. Refuses CANCELLED.' })
  async topUpGiftCard(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TopUpGiftCardDto,
  ) {
    return this.giftCards.topUp(await this.resolve(req), id, body);
  }

  @Post('store/gift-cards/:id/cancel')
  @RequirePermission('str-001:admin')
  @ApiOperation({ summary: 'Cancel a gift card with a reason. Admin only.' })
  async cancelGiftCard(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelGiftCardDto,
  ) {
    return this.giftCards.cancel(await this.resolve(req), id, body);
  }

  // ── Wishlists ─────────────────────────────────────────────────────

  @Get('store/wishlists/:customerPersonId')
  @RequirePermission('str-002:read')
  @ApiOperation({ summary: 'List wishlist entries for a customer. Row-scoped to the customer.' })
  async listWishlist(
    @Req() req: AuthRequest,
    @Param('customerPersonId', new ParseUUIDPipe()) customerPersonId: string,
  ) {
    return this.wishlists.listForCustomer(await this.resolve(req), customerPersonId);
  }

  @Post('store/wishlists/:customerPersonId')
  @RequirePermission('str-002:read')
  @ApiOperation({
    summary: 'Add a product to the customer wishlist. Idempotent on (customer, product).',
  })
  async addWishlist(
    @Req() req: AuthRequest,
    @Param('customerPersonId', new ParseUUIDPipe()) customerPersonId: string,
    @Body() body: AddWishlistDto,
  ) {
    return this.wishlists.add(await this.resolve(req), customerPersonId, body);
  }

  @Patch('store/wishlists/:customerPersonId/:productId')
  @RequirePermission('str-002:read')
  @ApiOperation({ summary: 'Update wishlist entry — toggles notify_on_restock.' })
  async updateWishlist(
    @Req() req: AuthRequest,
    @Param('customerPersonId', new ParseUUIDPipe()) customerPersonId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() body: UpdateWishlistDto,
  ) {
    return this.wishlists.update(await this.resolve(req), customerPersonId, productId, body);
  }

  @Delete('store/wishlists/:customerPersonId/:productId')
  @RequirePermission('str-002:read')
  @ApiOperation({ summary: 'Remove a wishlist entry.' })
  async removeWishlist(
    @Req() req: AuthRequest,
    @Param('customerPersonId', new ParseUUIDPipe()) customerPersonId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    await this.wishlists.remove(await this.resolve(req), customerPersonId, productId);
    return { removed: true };
  }

  // ── Price Schedules ───────────────────────────────────────────────

  @Get('store/products/:productId/price-schedules')
  @RequirePermission('str-001:read')
  @ApiOperation({ summary: 'List scheduled price changes for a product.' })
  async listPriceSchedules(
    @Req() req: AuthRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    return this.priceSchedules.listForProduct(await this.resolve(req), productId);
  }

  @Post('store/price-schedules')
  @RequirePermission('str-001:write')
  @ApiOperation({
    summary:
      'Schedule a future price change. The PriceScheduleWorker applies ripe rows every minute.',
  })
  async createPriceSchedule(@Req() req: AuthRequest, @Body() body: CreatePriceScheduleDto) {
    return this.priceSchedules.create(await this.resolve(req), body);
  }

  @Delete('store/price-schedules/:id')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Remove an unapplied price schedule. Refuses already-applied rows.' })
  async removePriceSchedule(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.priceSchedules.remove(await this.resolve(req), id);
    return { removed: true };
  }

  // ── Category Hierarchy ────────────────────────────────────────────

  @Get('store/categories/:storeId/tree')
  @RequirePermission('str-001:read')
  @ApiOperation({
    summary: 'Read the full category tree for a store, resolved into nested children.',
  })
  async getCategoryTree(
    @Req() req: AuthRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.categories.tree(await this.resolve(req), storeId, includeInactive === 'true');
  }

  @Get('store/categories/:id')
  @RequirePermission('str-001:read')
  @ApiOperation({ summary: 'Read a single category.' })
  async getCategory(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.categories.getById(await this.resolve(req), id);
  }

  @Post('store/categories')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Create a category. parentCategoryId nullable for root-level rows.' })
  async createCategory(@Req() req: AuthRequest, @Body() body: CreateCategoryDto) {
    return this.categories.create(await this.resolve(req), body);
  }

  @Patch('store/categories/:id')
  @RequirePermission('str-001:write')
  @ApiOperation({ summary: 'Update a category. Refuses self-parent (CHECK).' })
  async patchCategory(
    @Req() req: AuthRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    return this.categories.patch(await this.resolve(req), id, body);
  }

  @Delete('store/categories/:id')
  @RequirePermission('str-001:write')
  @ApiOperation({
    summary:
      'Remove a leaf category. Refuses if children still reference it (NO ACTION self-FK). Products with category_id = this id are SET NULL by the schema FK.',
  })
  async removeCategory(@Req() req: AuthRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.categories.remove(await this.resolve(req), id);
    return { removed: true };
  }
}
