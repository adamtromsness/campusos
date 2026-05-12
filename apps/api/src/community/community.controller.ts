import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import {
  CreateAssetPurchaseDto,
  CreateConditionReportDto,
  CreateMarketplaceListingDto,
  CreateRatingDto,
  CreateWatchListDto,
  ItemCondition,
  LISTING_TYPES,
  ListingStatus,
  ListingType,
  PatchAssetTransactionDto,
  PatchMarketplaceListingDto,
  RATEABLE_TYPES,
  RateableType,
  SEARCH_CONTENT_TYPES,
  SearchContentType,
  UpdateCommunityProfileDto,
} from './dto/community.dto';
import { AssetTransactionService } from './services/asset-transaction.service';
import { CommunityProfileService } from './services/community-profile.service';
import { MarketplaceListingService } from './services/marketplace-listing.service';
import { RatingService } from './services/rating.service';
import { SearchService } from './services/search.service';
import { WatchListService } from './services/watch-list.service';

interface AuthedRequest extends Request {
  user: { sub: string; personId: string };
}

/**
 * P2-21c — Community Exchange Controller (/api/v1/community/*).
 *
 * Cross-school marketplace + community profiles + ratings + search.
 * Tenant-scoped (regular guard chain): the X-Tenant-Subdomain header
 * resolves the current tenant; AuthGuard + TenantGuard + PermissionGuard
 * all run. Marketplace data lives in the platform schema for cross-
 * school visibility, but the request is tenant-scoped because every
 * actor belongs to some school.
 *
 * Permission gates (MKT-001..010 already in the catalogue):
 *   MKT-001 Marketplace Listings — browse + create (parents read only)
 *   MKT-002 Marketplace Purchasing — buy + ship + confirm
 *   MKT-003 Surplus Asset Exchange — admin override for transactions
 *   MKT-005 Community Profiles — own profile + leaderboard
 *   MKT-006 Ratings & Reviews — rate listings + transactions
 *   MKT-007 Watch Lists — school admin / staff own school's watch lists
 *
 * Parents are blocked from POST /marketplace at the SERVICE layer
 * (MarketplaceListingService.assertCanCreateListing) — even though
 * they hold mkt-001:read for browsing, the gate is the personType
 * check.
 */
@ApiTags('Community Exchange')
@Controller('community')
export class CommunityController {
  constructor(
    private readonly profiles: CommunityProfileService,
    private readonly listings: MarketplaceListingService,
    private readonly transactions: AssetTransactionService,
    private readonly watchLists: WatchListService,
    private readonly ratings: RatingService,
    private readonly search: SearchService,
    private readonly actorContext: ActorContextService,
  ) {}

  // ── Community profiles ───────────────────────────────────────────

  @Get('profiles/leaderboard')
  @RequirePermission('mkt-005:read')
  @ApiOperation({ summary: 'Top community profiles by reputation points (public only).' })
  leaderboard(@Query('limit') limit?: string) {
    const lim = limit ? Number(limit) : 25;
    return this.profiles.leaderboard(lim);
  }

  @Get('profiles/me')
  @RequirePermission('mkt-005:read')
  @ApiOperation({
    summary: "Get the calling user's own community profile (created on first access).",
  })
  async getMyProfile(@Req() req: AuthedRequest) {
    return this.profiles.getOrCreate(req.user.personId, 'Community member');
  }

  @Patch('profiles/me')
  @RequirePermission('mkt-005:write')
  @ApiOperation({ summary: "Patch the calling user's own community profile." })
  async updateMyProfile(@Req() req: AuthedRequest, @Body() body: UpdateCommunityProfileDto) {
    return this.profiles.updateOwn(req.user.personId, body);
  }

  @Get('profiles/:id')
  @RequirePermission('mkt-005:read')
  @ApiOperation({
    summary:
      "Get a community profile by id. Private profiles (is_public=false) are visible only to the owner — non-owners see 404 don't-leak-existence (REVIEW-P2C21 BLOCKING 7).",
  })
  async getProfile(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.profiles.getById(id, { personId: req.user.personId });
  }

  // ── Marketplace listings ─────────────────────────────────────────

  @Get('marketplace')
  @RequirePermission('mkt-001:read')
  @ApiOperation({
    summary:
      'List marketplace listings. ?search uses tsvector GIN index; ?listingType filters by 6-value enum; ?status defaults to ACTIVE for the public browse path.',
  })
  listMarketplace(
    @Query('search') search?: string,
    @Query('listingType') listingType?: string,
    @Query('status') status?: string,
    @Query('minPriceCents') minPriceCents?: string,
    @Query('maxPriceCents') maxPriceCents?: string,
    @Query('conditionMin') conditionMin?: string,
    @Query('limit') limit?: string,
  ) {
    const type =
      listingType && (LISTING_TYPES as readonly string[]).includes(listingType)
        ? (listingType as ListingType)
        : undefined;
    return this.listings.list({
      listingType: type,
      status: status as ListingStatus | undefined,
      search,
      minPriceCents: minPriceCents ? Number(minPriceCents) : undefined,
      maxPriceCents: maxPriceCents ? Number(maxPriceCents) : undefined,
      conditionMin: conditionMin as ItemCondition | undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('marketplace/:id')
  @RequirePermission('mkt-001:read')
  @ApiOperation({ summary: 'Get a marketplace listing with seller display name + rating rollup.' })
  getListing(@Param('id') id: string) {
    return this.listings.getById(id);
  }

  @Post('marketplace')
  @RequirePermission('mkt-001:write')
  @ApiOperation({
    summary:
      'Create a marketplace listing in DRAFT status. PARENTS BLOCKED at service layer per ADR-073 — only STAFF or school admin can list.',
  })
  async createListing(@Req() req: AuthedRequest, @Body() body: CreateMarketplaceListingDto) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    const tenant = getCurrentTenant();
    return this.listings.create(actor, tenant.schoolId, body);
  }

  @Patch('marketplace/:id')
  @RequirePermission('mkt-001:write')
  @ApiOperation({
    summary:
      'Patch a listing. DRAFT->ACTIVE publishes (emits mkt.listing.published). Only the seller or a school admin can edit.',
  })
  async patchListing(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PatchMarketplaceListingDto,
  ) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.listings.patch(actor, id, body);
  }

  // ── Asset transactions ───────────────────────────────────────────

  @Get('transactions/my')
  @RequirePermission('mkt-002:read')
  @ApiOperation({ summary: 'Transactions where the calling user is either buyer or seller.' })
  async listMyTransactions(@Req() req: AuthedRequest) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.transactions.listForActor(actor);
  }

  @Get('transactions/:id')
  @RequirePermission('mkt-002:read')
  @ApiOperation({
    summary:
      'Get a transaction by id. Actor-scoped: buyer, seller, seller-school admin, or buyer-school admin only — everyone else 404 (REVIEW-P2C21 BLOCKING 3).',
  })
  async getTransaction(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.transactions.getById(id, actor);
  }

  @Post('marketplace/:listingId/purchase')
  @RequirePermission('mkt-002:write')
  @ApiOperation({
    summary:
      'Purchase a listing. 5% platform fee + 95% to seller computed before INSERT; schema fee_split_chk is the safety net. Locks the listing FOR UPDATE inside the tx and flips it to SOLD.',
  })
  async purchase(
    @Req() req: AuthedRequest,
    @Param('listingId') listingId: string,
    @Body() body: CreateAssetPurchaseDto,
  ) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.transactions.purchase(actor, listingId, body);
  }

  @Patch('transactions/:id')
  @RequirePermission('mkt-002:write')
  @ApiOperation({
    summary: 'Patch a transaction status / shipping. Lifecycle transitions validated.',
  })
  async patchTransaction(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PatchAssetTransactionDto,
  ) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.transactions.patch(actor, id, body);
  }

  @Post('transactions/:id/condition-report')
  @RequirePermission('mkt-002:write')
  @ApiOperation({
    summary:
      'Submit a SELLER_LISTING (seller-only) or BUYER_RECEIPT (buyer-only) condition report. UNIQUE(transaction, reporter_type).',
  })
  async addConditionReport(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateConditionReportDto,
  ) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.transactions.addConditionReport(actor, id, body);
  }

  @Get('transactions/:id/condition-reports')
  @RequirePermission('mkt-002:read')
  @ApiOperation({
    summary:
      'List condition reports for a transaction. Actor-scoped — same visibility as the parent transaction (REVIEW-P2C21 BLOCKING 3).',
  })
  async listConditionReports(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.transactions.listConditionReports(id, actor);
  }

  // ── Watch lists ──────────────────────────────────────────────────

  @Get('watch-lists')
  @RequirePermission('mkt-007:read')
  @ApiOperation({ summary: "List watch lists for the calling user's school." })
  listWatchLists(@Query('includeFulfilled') includeFulfilled?: string) {
    const tenant = getCurrentTenant();
    return this.watchLists.list(tenant.schoolId, includeFulfilled === 'true');
  }

  @Get('watch-lists/:id')
  @RequirePermission('mkt-007:read')
  @ApiOperation({
    summary:
      'Get a single watch list. School-scoped — cross-school UUIDs collapse to 404 (REVIEW-P2C21 BLOCKING 6).',
  })
  getWatchList(@Param('id') id: string) {
    const tenant = getCurrentTenant();
    return this.watchLists.getById(id, tenant.schoolId);
  }

  @Post('watch-lists')
  @RequirePermission('mkt-007:write')
  @ApiOperation({ summary: 'Create a watch list. Active by default.' })
  async createWatchList(@Req() req: AuthedRequest, @Body() body: CreateWatchListDto) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    const tenant = getCurrentTenant();
    return this.watchLists.create(actor, tenant.schoolId, body);
  }

  @Post('watch-lists/:id/fulfill')
  @RequirePermission('mkt-007:write')
  @ApiOperation({
    summary: 'Mark a watch list FULFILLED. School-scoped (REVIEW-P2C21 BLOCKING 6).',
  })
  fulfillWatchList(@Param('id') id: string) {
    const tenant = getCurrentTenant();
    return this.watchLists.fulfill(id, tenant.schoolId);
  }

  @Post('watch-lists/:id/delete')
  @HttpCode(204)
  @RequirePermission('mkt-007:write')
  @ApiOperation({
    summary: 'Delete a watch list. School-scoped (REVIEW-P2C21 BLOCKING 6).',
  })
  async removeWatchList(@Param('id') id: string): Promise<void> {
    const tenant = getCurrentTenant();
    await this.watchLists.remove(id, tenant.schoolId);
  }

  // ── Ratings ──────────────────────────────────────────────────────

  @Get('ratings/:rateableType/:rateableId')
  @RequirePermission('mkt-006:read')
  @ApiOperation({ summary: 'List ratings for a rateable target. Ordered by helpful_votes DESC.' })
  listRatings(
    @Param('rateableType') rateableType: string,
    @Param('rateableId') rateableId: string,
  ) {
    if (!(RATEABLE_TYPES as readonly string[]).includes(rateableType)) {
      throw new BadRequestException(`rateableType must be one of ${RATEABLE_TYPES.join(', ')}`);
    }
    return this.ratings.listForRateable(rateableType as RateableType, rateableId);
  }

  @Post('ratings')
  @RequirePermission('mkt-006:write')
  @ApiOperation({
    summary:
      'Submit (or re-submit, UNIQUE-aware) a 1-5 star rating with optional review. Refuses self-rating.',
  })
  async createRating(@Req() req: AuthedRequest, @Body() body: CreateRatingDto) {
    const actor = await this.actorContext.resolveActor(req.user.sub, req.user.personId);
    return this.ratings.create(actor, body);
  }

  @Post('ratings/:id/helpful')
  @RequirePermission('mkt-006:write')
  @ApiOperation({
    summary: 'Mark a rating helpful (+1 helpful_votes; awards +5 reputation to rater).',
  })
  helpfulVote(@Param('id') id: string) {
    return this.ratings.helpfulVote(id);
  }

  // ── Search ───────────────────────────────────────────────────────

  @Get('search')
  @RequirePermission('mkt-001:read')
  @ApiOperation({
    summary:
      'Unified full-text search across all community content types via the platform_search_index tsvector GIN index (ADR-076).',
  })
  searchCommunity(
    @Query('q') query?: string,
    @Query('contentType') contentType?: string,
    @Query('limit') limit?: string,
  ) {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException('q query param is required.');
    }
    const ct =
      contentType && (SEARCH_CONTENT_TYPES as readonly string[]).includes(contentType)
        ? (contentType as SearchContentType)
        : undefined;
    return this.search.search(query, ct, limit ? Number(limit) : undefined);
  }

  // ── Catalogue ────────────────────────────────────────────────────

  @Get('catalogue')
  @RequirePermission('mkt-001:read')
  @ApiOperation({ summary: 'Enum catalogue used by the UI dropdowns.' })
  catalogue() {
    return {
      listingTypes: LISTING_TYPES,
      rateableTypes: RATEABLE_TYPES,
      searchContentTypes: SEARCH_CONTENT_TYPES,
    };
  }
}
