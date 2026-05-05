import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ── Enums ────────────────────────────────────────────────────────

export const LOCATION_TYPES = [
  'SHELF',
  'DISPLAY',
  'BOOK_DROP',
  'PROCESSING',
  'REPAIR',
  'STORAGE',
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const COPY_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'LOST'] as const;
export type CopyCondition = (typeof COPY_CONDITIONS)[number];

export const COPY_LOCATION_STATUSES = [
  'ON_SHELF',
  'IN_BOOK_DROP',
  'IN_PROCESSING',
  'CHECKED_OUT',
  'ON_HOLD_SHELF',
  'IN_REPAIR',
  'LOST',
] as const;
export type CopyLocationStatus = (typeof COPY_LOCATION_STATUSES)[number];

// ── Location DTOs ────────────────────────────────────────────────

export class CreateLocationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: LOCATION_TYPES })
  @IsIn(LOCATION_TYPES as unknown as string[])
  locationType!: LocationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: LOCATION_TYPES })
  @IsOptional()
  @IsIn(LOCATION_TYPES as unknown as string[])
  locationType?: LocationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LocationResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty({ enum: LOCATION_TYPES })
  locationType!: LocationType;
  @ApiProperty()
  sortOrder!: number;
  @ApiProperty()
  isActive!: boolean;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

// ── Catalogue item DTOs ──────────────────────────────────────────

export class CreateCatalogueItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  author?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  isbn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  publisher?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(2200)
  publishYear?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  deweyDecimal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  coverImageUrl?: string;
}

export class UpdateCatalogueItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  author?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  isbn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  publisher?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(2200)
  publishYear?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  deweyDecimal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  coverImageUrl?: string;
}

export class CatalogueItemSearchHitDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  title!: string;
  @ApiPropertyOptional()
  author!: string | null;
  @ApiPropertyOptional()
  isbn!: string | null;
  @ApiPropertyOptional()
  category!: string | null;
  @ApiPropertyOptional()
  deweyDecimal!: string | null;
  @ApiPropertyOptional()
  coverImageUrl!: string | null;
  @ApiProperty()
  totalCopies!: number;
  @ApiProperty()
  availableCopies!: number;
  @ApiPropertyOptional()
  averageRating!: number | null;
  @ApiProperty()
  reviewCount!: number;
}

export class CopyResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  catalogueItemId!: string;
  @ApiPropertyOptional()
  locationId!: string | null;
  @ApiPropertyOptional()
  locationName!: string | null;
  @ApiProperty()
  barcode!: string;
  @ApiProperty({ enum: COPY_CONDITIONS })
  condition!: CopyCondition;
  @ApiProperty()
  isAvailable!: boolean;
  @ApiPropertyOptional()
  replacementValue!: number | null;
  @ApiProperty({ enum: COPY_LOCATION_STATUSES })
  locationStatus!: CopyLocationStatus;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

export class CatalogueItemResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty()
  title!: string;
  @ApiPropertyOptional()
  author!: string | null;
  @ApiPropertyOptional()
  isbn!: string | null;
  @ApiPropertyOptional()
  publisher!: string | null;
  @ApiPropertyOptional()
  publishYear!: number | null;
  @ApiPropertyOptional()
  category!: string | null;
  @ApiPropertyOptional()
  deweyDecimal!: string | null;
  @ApiPropertyOptional()
  description!: string | null;
  @ApiPropertyOptional()
  coverImageUrl!: string | null;
  @ApiProperty()
  totalCopies!: number;
  @ApiProperty()
  availableCopies!: number;
  @ApiProperty()
  activeHoldsCount!: number;
  @ApiPropertyOptional()
  averageRating!: number | null;
  @ApiProperty()
  reviewCount!: number;
  @ApiPropertyOptional({ type: [CopyResponseDto] })
  copies?: CopyResponseDto[];
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

// ── Copy DTOs ────────────────────────────────────────────────────

export class CreateCopyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  barcode!: string;

  @ApiPropertyOptional({ enum: COPY_CONDITIONS })
  @IsOptional()
  @IsIn(COPY_CONDITIONS as unknown as string[])
  condition?: CopyCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: COPY_LOCATION_STATUSES })
  @IsOptional()
  @IsIn(COPY_LOCATION_STATUSES as unknown as string[])
  locationStatus?: CopyLocationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  replacementValue?: number;
}

export class UpdateCopyDto {
  @ApiPropertyOptional({ enum: COPY_CONDITIONS })
  @IsOptional()
  @IsIn(COPY_CONDITIONS as unknown as string[])
  condition?: CopyCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @ApiPropertyOptional({ enum: COPY_LOCATION_STATUSES })
  @IsOptional()
  @IsIn(COPY_LOCATION_STATUSES as unknown as string[])
  locationStatus?: CopyLocationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  replacementValue?: number;
}

// ── Barcode lookup keystone ──────────────────────────────────────

export class ActiveCheckoutDto {
  @ApiProperty()
  checkoutId!: string;
  @ApiProperty()
  patronId!: string;
  @ApiPropertyOptional()
  patronName!: string | null;
  @ApiProperty()
  checkoutDate!: string;
  @ApiProperty()
  dueDate!: string;
  @ApiProperty()
  daysUntilDue!: number;
  @ApiProperty()
  status!: string;
  @ApiProperty()
  renewalCount!: number;
}

export class BarcodeLookupResponseDto {
  @ApiProperty({ type: CopyResponseDto })
  copy!: CopyResponseDto;

  @ApiProperty({ type: CatalogueItemResponseDto })
  item!: CatalogueItemResponseDto;

  @ApiPropertyOptional({ type: ActiveCheckoutDto })
  activeCheckout!: ActiveCheckoutDto | null;

  @ApiProperty()
  pendingHoldsCount!: number;
}

// ── Circulation enums ────────────────────────────────────────────

export const PATRON_TYPES = ['STUDENT', 'STAFF'] as const;
export type PatronType = (typeof PATRON_TYPES)[number];

export const CHECKOUT_STATUSES = ['ACTIVE', 'RETURNED', 'OVERDUE', 'LOST'] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const HOLD_STATUSES = ['PENDING', 'READY', 'COLLECTED', 'EXPIRED', 'CANCELLED'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const FINE_TYPES = ['OVERDUE', 'LOST', 'DAMAGE'] as const;
export type FineType = (typeof FINE_TYPES)[number];

export const FINE_STATUSES = ['OUTSTANDING', 'PAID', 'WAIVED'] as const;
export type FineStatus = (typeof FINE_STATUSES)[number];

// ── Checkout policy DTOs ─────────────────────────────────────────

export class CheckoutPolicyResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty({ enum: PATRON_TYPES })
  patronType!: PatronType;
  @ApiProperty()
  maxCheckouts!: number;
  @ApiProperty()
  loanPeriodDays!: number;
  @ApiProperty()
  renewalsAllowed!: number;
  @ApiProperty()
  overdueFinePerDay!: number;
}

// ── Checkout DTOs ────────────────────────────────────────────────

/**
 * Checkout-by-barcode keystone request shape. Either `barcode` or
 * `copyId` must be supplied. The barcode path is the canonical
 * circulation-desk flow (scan the spine); copyId is the API path for
 * a librarian who already has the copy id from the catalogue.
 */
export class CheckoutCreateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  copyId?: string;

  @ApiProperty({
    description: 'iam_person.id of the patron borrowing the book.',
  })
  @IsUUID()
  patronId!: string;

  @ApiPropertyOptional({
    description:
      'Override the loan_period_days from the policy. Optional. Useful for short-loan copies (overnight reading-room sets etc.).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  loanPeriodDays?: number;
}

export class CheckoutResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  copyId!: string;
  @ApiProperty()
  copyBarcode!: string;
  @ApiPropertyOptional()
  itemTitle!: string | null;
  @ApiProperty()
  patronId!: string;
  @ApiPropertyOptional()
  patronName!: string | null;
  @ApiProperty()
  checkoutDate!: string;
  @ApiProperty()
  dueDate!: string;
  @ApiPropertyOptional()
  returnedAt!: string | null;
  @ApiProperty()
  renewalCount!: number;
  @ApiProperty({ enum: CHECKOUT_STATUSES })
  status!: CheckoutStatus;
  @ApiPropertyOptional()
  daysUntilDue!: number | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

export class ListCheckoutsArgsDto {
  @ApiPropertyOptional({ enum: CHECKOUT_STATUSES })
  @IsOptional()
  @IsIn(CHECKOUT_STATUSES as unknown as string[])
  status?: CheckoutStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  patronId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  onlyActive?: boolean;
}

// ── Hold DTOs ────────────────────────────────────────────────────

export class CreateHoldDto {
  @ApiProperty()
  @IsUUID()
  catalogueItemId!: string;

  @ApiPropertyOptional({
    description:
      'Patron iam_person.id. Defaults to the calling actor when omitted (self-service hold). Librarians can pass an explicit patronId to place a hold on behalf of a patron.',
  })
  @IsOptional()
  @IsUUID()
  patronId?: string;
}

export class HoldResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  catalogueItemId!: string;
  @ApiPropertyOptional()
  itemTitle!: string | null;
  @ApiProperty()
  patronId!: string;
  @ApiPropertyOptional()
  patronName!: string | null;
  @ApiProperty()
  placedAt!: string;
  @ApiPropertyOptional()
  expiresAt!: string | null;
  @ApiProperty({ enum: HOLD_STATUSES })
  status!: HoldStatus;
  @ApiPropertyOptional()
  notifiedAt!: string | null;
  @ApiPropertyOptional()
  queuePosition!: number | null;
}

// ── Fine DTOs ────────────────────────────────────────────────────

export class FineResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  checkoutId!: string;
  @ApiPropertyOptional()
  itemTitle!: string | null;
  @ApiProperty()
  patronId!: string;
  @ApiPropertyOptional()
  patronName!: string | null;
  @ApiProperty({ enum: FINE_TYPES })
  fineType!: FineType;
  @ApiProperty()
  amount!: number;
  @ApiPropertyOptional()
  daysOverdue!: number | null;
  @ApiProperty({ enum: FINE_STATUSES })
  status!: FineStatus;
  @ApiPropertyOptional()
  invoiceId!: string | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

export class WaiveFineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
