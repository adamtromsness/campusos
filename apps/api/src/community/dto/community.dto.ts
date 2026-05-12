import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const LISTING_TYPES = [
  'EDUCATIONAL',
  'PORTFOLIO',
  'FIELD_TRIP',
  'SURPLUS_ASSET',
  'BOOK',
  'KNOWLEDGE',
] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

export const LISTING_STATUSES = ['DRAFT', 'ACTIVE', 'SOLD', 'EXPIRED'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const ITEM_CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const TRANSACTION_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'SHIPPING',
  'DELIVERED',
  'CONFIRMED',
  'DISPUTED',
  'REFUNDED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const SHIPPING_METHODS = ['PICKUP', 'SCHOOL_DELIVERY', 'CARRIER'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export const BUYER_TYPES = ['SCHOOL', 'INDIVIDUAL'] as const;
export type BuyerType = (typeof BUYER_TYPES)[number];

export const RATEABLE_TYPES = ['LISTING', 'TRANSACTION', 'FORUM_POST'] as const;
export type RateableType = (typeof RATEABLE_TYPES)[number];

export const WATCH_LIST_STATUSES = ['ACTIVE', 'FULFILLED'] as const;
export type WatchListStatus = (typeof WATCH_LIST_STATUSES)[number];

export const CONDITION_REPORT_TYPES = ['SELLER_LISTING', 'BUYER_RECEIPT'] as const;
export type ConditionReportType = (typeof CONDITION_REPORT_TYPES)[number];

export const REPUTATION_REASONS = [
  'LISTING_SOLD',
  'RATING_RECEIVED',
  'HELPFUL_VOTE',
  'FORUM_ANSWER_ACCEPTED',
  'REPORT_UPHELD',
  'ADMIN_ADJUSTMENT',
] as const;
export type ReputationReason = (typeof REPUTATION_REASONS)[number];

export const SEARCH_CONTENT_TYPES = [
  'LISTING',
  'FORUM_POST',
  'KNOWLEDGE_ARTICLE',
  'PROFILE',
] as const;
export type SearchContentType = (typeof SEARCH_CONTENT_TYPES)[number];

/**
 * Platform fee percentage applied to every asset transaction.
 * Surfaces as the schema-level fee_split_chk: platform_fee_cents +
 * seller_receives_cents = total_price_cents. AssetTransactionService
 * uses this constant to compute the split. ADR-073.
 */
export const PLATFORM_FEE_PERCENT = 5;

// ── Community Profile ──────────────────────────────────────────────

export interface CommunityProfileDto {
  id: string;
  personId: string;
  displayName: string;
  bio: string | null;
  schoolName: string | null;
  roleLabel: string | null;
  avatarS3Key: string | null;
  reputationPoints: number;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export class UpdateCommunityProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  schoolName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleLabel?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarS3Key?: string | null;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

// ── Marketplace Listings ────────────────────────────────────────────

export interface MarketplaceListingDto {
  id: string;
  listingType: ListingType;
  title: string;
  description: string;
  sellerSchoolId: string;
  sellerProfileId: string;
  sellerDisplayName: string | null;
  priceCents: number | null;
  condition: ItemCondition | null;
  category: string | null;
  tags: string[];
  photoS3Keys: string[];
  status: ListingStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  averageRating: number | null;
  ratingCount: number;
}

export class CreateMarketplaceListingDto {
  @IsIn(LISTING_TYPES)
  listingType!: ListingType;

  @IsString()
  @Length(3, 200)
  title!: string;

  @IsString()
  @Length(10, 5000)
  description!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceCents?: number | null;

  @IsOptional()
  @IsIn(ITEM_CONDITIONS)
  condition?: ItemCondition | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoS3Keys?: string[];
}

export class PatchMarketplaceListingDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(10, 5000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceCents?: number | null;

  @IsOptional()
  @IsIn(ITEM_CONDITIONS)
  condition?: ItemCondition | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoS3Keys?: string[];

  @IsOptional()
  @IsIn(LISTING_STATUSES)
  status?: ListingStatus;
}

export interface ListMarketplaceArgs {
  listingType?: ListingType;
  status?: ListingStatus;
  search?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  conditionMin?: ItemCondition;
  limit?: number;
}

// ── Asset Transactions ──────────────────────────────────────────────

export interface AssetTransactionDto {
  id: string;
  listingId: string;
  listingTitle: string | null;
  buyerType: BuyerType;
  buyerSchoolId: string | null;
  buyerPersonId: string | null;
  sellerSchoolId: string;
  sellerProfileId: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  platformFeeCents: number;
  sellerReceivesCents: number;
  stripePaymentIntentId: string | null;
  status: TransactionStatus;
  shippingMethod: ShippingMethod | null;
  trackingNumber: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  confirmedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateAssetPurchaseDto {
  @IsIn(BUYER_TYPES)
  buyerType!: BuyerType;

  @IsOptional()
  @IsUUID('all')
  buyerSchoolId?: string | null;

  @IsOptional()
  @IsUUID('all')
  buyerPersonId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  @IsOptional()
  @IsIn(SHIPPING_METHODS)
  shippingMethod?: ShippingMethod;
}

export class PatchAssetTransactionDto {
  @IsOptional()
  @IsIn(TRANSACTION_STATUSES)
  status?: TransactionStatus;

  @IsOptional()
  @IsIn(SHIPPING_METHODS)
  shippingMethod?: ShippingMethod;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  trackingNumber?: string | null;
}

// ── Condition Reports ───────────────────────────────────────────────

export interface ConditionReportDto {
  id: string;
  transactionId: string;
  reporterType: ConditionReportType;
  condition: ItemCondition;
  conditionNotes: string | null;
  photoS3Keys: string[];
  reportedBy: string;
  reportedAt: string;
}

export class CreateConditionReportDto {
  @IsIn(CONDITION_REPORT_TYPES)
  reporterType!: ConditionReportType;

  @IsIn(ITEM_CONDITIONS)
  condition!: ItemCondition;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  conditionNotes?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoS3Keys?: string[];
}

// ── Watch Lists ─────────────────────────────────────────────────────

export interface WatchListDto {
  id: string;
  schoolId: string;
  targetListingType: ListingType;
  searchKeywords: string | null;
  maxPriceCents: number | null;
  conditionMin: ItemCondition | null;
  status: WatchListStatus;
  createdBy: string;
  fulfilledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateWatchListDto {
  @IsIn(LISTING_TYPES)
  targetListingType!: ListingType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  searchKeywords?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  maxPriceCents?: number | null;

  @IsOptional()
  @IsIn(ITEM_CONDITIONS)
  conditionMin?: ItemCondition | null;
}

// ── Ratings ─────────────────────────────────────────────────────────

export interface CommunityRatingDto {
  id: string;
  rateableType: RateableType;
  rateableId: string;
  ratedBy: string;
  ratedByDisplayName: string | null;
  score: number;
  reviewText: string | null;
  helpfulVotes: number;
  createdAt: string;
  updatedAt: string;
}

export class CreateRatingDto {
  @IsIn(RATEABLE_TYPES)
  rateableType!: RateableType;

  @IsUUID('all')
  rateableId!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reviewText?: string | null;
}

// ── Search ──────────────────────────────────────────────────────────

export interface SearchHitDto {
  contentType: SearchContentType;
  contentId: string;
  title: string;
  bodyPreview: string | null;
  schoolId: string | null;
  authorProfileId: string | null;
  contentDate: string | null;
  rank: number;
}
