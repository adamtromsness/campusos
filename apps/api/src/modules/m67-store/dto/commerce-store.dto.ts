import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * P2-29b — DTOs for the Store Advanced surface (M67.1).
 *
 * Lives in its own file so commerce.dto.ts (P2-29a Procurement +
 * Finance) and commerce-store.dto.ts (P2-29b Store) can move
 * independently. Both files are imported by the shared
 * CommerceController.
 */

// ── Inventory Adjustments ─────────────────────────────────────────

export type InventoryAdjustmentType =
  | 'RECOUNT'
  | 'DAMAGE'
  | 'THEFT'
  | 'RETURN_TO_STOCK'
  | 'WRITE_OFF';

export const INVENTORY_ADJUSTMENT_TYPES: InventoryAdjustmentType[] = [
  'RECOUNT',
  'DAMAGE',
  'THEFT',
  'RETURN_TO_STOCK',
  'WRITE_OFF',
];

export interface InventoryAdjustmentDto {
  id: string;
  schoolId: string;
  productId: string;
  inventoryId: string;
  adjustmentType: InventoryAdjustmentType;
  quantityDelta: number;
  reason: string;
  adjustedBy: string;
  notes: string | null;
  createdAt: string;
}

export class CreateInventoryAdjustmentDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  inventoryId!: string;

  @IsIn(INVENTORY_ADJUSTMENT_TYPES)
  adjustmentType!: InventoryAdjustmentType;

  @IsInt()
  quantityDelta!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ── Promotions ────────────────────────────────────────────────────

export type PromotionDiscountType = 'PERCENTAGE' | 'FLAT_AMOUNT' | 'BOGO' | 'FREE_SHIPPING';

export const PROMOTION_DISCOUNT_TYPES: PromotionDiscountType[] = [
  'PERCENTAGE',
  'FLAT_AMOUNT',
  'BOGO',
  'FREE_SHIPPING',
];

export interface PromotionDto {
  id: string;
  storeId: string;
  name: string;
  description: string | null;
  discountType: PromotionDiscountType;
  discountValue: number;
  minOrderAmount: number | null;
  promoCode: string | null;
  startsAt: string;
  endsAt: string;
  maxUses: number | null;
  currentUses: number;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromotionDetailDto extends PromotionDto {
  productIds: string[];
}

export class CreatePromotionDto {
  @IsUUID()
  storeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(PROMOTION_DISCOUNT_TYPES)
  discountType!: PromotionDiscountType;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountValue!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderAmount?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  promoCode?: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  productIds?: string[];
}

export class UpdatePromotionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountValue?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderAmount?: number;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ApplyPromoCodeDto {
  @IsUUID()
  storeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  promoCode!: string;
}

// ── Loyalty ───────────────────────────────────────────────────────

export type LoyaltyTransactionType = 'EARNED' | 'REDEEMED' | 'ADJUSTMENT';

export interface LoyaltyConfigDto {
  id: string;
  storeId: string;
  pointsPerDollar: number;
  redemptionRateCents: number;
  minRedemptionPoints: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyTransactionDto {
  id: string;
  storeId: string;
  customerPersonId: string;
  transactionType: LoyaltyTransactionType;
  points: number;
  orderId: string | null;
  description: string | null;
  createdAt: string;
}

export interface LoyaltyBalanceDto {
  storeId: string;
  customerPersonId: string;
  balance: number;
  totalEarned: number;
  totalRedeemed: number;
  totalAdjusted: number;
}

export class UpsertLoyaltyConfigDto {
  @IsUUID()
  storeId!: string;

  @IsInt()
  @Min(1)
  pointsPerDollar!: number;

  @IsInt()
  @Min(1)
  redemptionRateCents!: number;

  @IsInt()
  @Min(1)
  minRedemptionPoints!: number;

  @IsBoolean()
  isEnabled!: boolean;
}

export class EarnLoyaltyPointsDto {
  @IsUUID()
  storeId!: string;

  @IsUUID()
  customerPersonId!: string;

  @IsInt()
  @Min(1)
  points!: number;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class RedeemLoyaltyPointsDto {
  @IsUUID()
  storeId!: string;

  @IsUUID()
  customerPersonId!: string;

  @IsInt()
  @Min(1)
  points!: number;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class AdjustLoyaltyPointsDto {
  @IsUUID()
  storeId!: string;

  @IsUUID()
  customerPersonId!: string;

  @IsInt()
  @Min(1)
  points!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  description!: string;
}

// ── Gift Cards ────────────────────────────────────────────────────

export type GiftCardStatus = 'ACTIVE' | 'DEPLETED' | 'CANCELLED';
export type GiftCardTransactionType = 'PURCHASE' | 'REDEMPTION' | 'TOP_UP';

export interface GiftCardDto {
  id: string;
  storeId: string;
  cardCode: string;
  initialBalanceCents: number;
  currentBalanceCents: number;
  purchasedBy: string | null;
  recipientEmail: string | null;
  status: GiftCardStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GiftCardDetailDto extends GiftCardDto {
  transactions: GiftCardTransactionDto[];
}

export interface GiftCardTransactionDto {
  id: string;
  cardId: string;
  transactionType: GiftCardTransactionType;
  amountCents: number;
  orderId: string | null;
  performedBy: string | null;
  notes: string | null;
  createdAt: string;
}

export class IssueGiftCardDto {
  @IsUUID()
  storeId!: string;

  @IsInt()
  @Min(100)
  @Max(100000000)
  initialBalanceCents!: number;

  @IsOptional()
  @IsUUID()
  purchasedBy?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  recipientEmail?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class RedeemGiftCardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  cardCode!: string;

  @IsInt()
  @Min(1)
  @Max(100000000)
  amountCents!: number;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class TopUpGiftCardDto {
  @IsInt()
  @Min(100)
  @Max(100000000)
  amountCents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CancelGiftCardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

// ── Wishlists ─────────────────────────────────────────────────────

export interface WishlistEntryDto {
  id: string;
  customerPersonId: string;
  productId: string;
  notifyOnRestock: boolean;
  createdAt: string;
}

export class AddWishlistDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsBoolean()
  notifyOnRestock?: boolean;
}

export class UpdateWishlistDto {
  @IsBoolean()
  notifyOnRestock!: boolean;
}

// ── Price Schedules ───────────────────────────────────────────────

export interface PriceScheduleDto {
  id: string;
  productId: string;
  scheduledPrice: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  appliedAt: string | null;
  revertedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export class CreatePriceScheduleDto {
  @IsUUID()
  productId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  scheduledPrice!: number;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ── Category Hierarchy ────────────────────────────────────────────

export interface CategoryNodeDto {
  id: string;
  storeId: string;
  name: string;
  description: string | null;
  parentCategoryId: string | null;
  sortOrder: number;
  isActive: boolean;
  children: CategoryNodeDto[];
  createdAt: string;
  updatedAt: string;
}

export class CreateCategoryDto {
  @IsUUID()
  storeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsUUID()
  parentCategoryId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsUUID()
  parentCategoryId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
