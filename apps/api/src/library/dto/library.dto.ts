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

  /**
   * Active-checkout details (checkoutId, patronId, patronName, dates,
   * renewal count) — populated only for librarians and admins per
   * REVIEW-CYCLE12 BLOCKING 3. Catalogue-only readers (students /
   * parents / general staff) get `null` here even when a checkout
   * exists. Use `isCheckedOut` to know whether the copy is currently
   * out without leaking the patron identity.
   */
  @ApiPropertyOptional({ type: ActiveCheckoutDto })
  activeCheckout!: ActiveCheckoutDto | null;

  @ApiProperty()
  pendingHoldsCount!: number;

  /**
   * Whether the copy is currently checked out — derived from
   * `copy.isAvailable`. Visible to all callers regardless of librarian
   * scope so the patron-facing UI can render an "On loan" badge
   * without seeing who has it.
   */
  @ApiProperty()
  isCheckedOut!: boolean;
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

// ── Reading programme + log + review enums ──────────────────────

export const READING_PROGRAMME_AUDIENCE_TYPES = [
  'SCHOOL_WIDE',
  'YEAR_GROUP',
  'CLASS',
  'CUSTOM',
] as const;
export type ReadingProgrammeAudienceType = (typeof READING_PROGRAMME_AUDIENCE_TYPES)[number];

export const READING_LIST_TYPES = [
  'CLASS',
  'YEAR_GROUP',
  'CURRICULUM_UNIT',
  'GENERAL',
  'NEW_ARRIVALS',
] as const;
export type ReadingListType = (typeof READING_LIST_TYPES)[number];

export const READING_LIST_ITEM_TYPES = [
  'REQUIRED',
  'RECOMMENDED',
  'EXTENSION',
  'REFERENCE',
] as const;
export type ReadingListItemType = (typeof READING_LIST_ITEM_TYPES)[number];

// ── Reading programme DTOs ──────────────────────────────────────

export class CreateReadingProgrammeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  targetBooks?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  targetPages?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiProperty({ enum: READING_PROGRAMME_AUDIENCE_TYPES })
  @IsIn(READING_PROGRAMME_AUDIENCE_TYPES as unknown as string[])
  targetAudienceType!: ReadingProgrammeAudienceType;

  @ApiPropertyOptional({
    description:
      'Polymorphic target ref interpreted by audience type. NULL for SCHOOL_WIDE. sis_classes.id for CLASS. Year-group label encoded as UUID for YEAR_GROUP.',
  })
  @IsOptional()
  @IsUUID()
  targetId?: string;
}

export class UpdateReadingProgrammeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  targetBooks?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  targetPages?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReadingProgrammeProgressDto {
  @ApiProperty()
  programmeId!: string;
  @ApiProperty()
  studentId!: string;
  @ApiProperty()
  booksRead!: number;
  @ApiProperty()
  pagesRead!: number;
  @ApiProperty()
  isComplete!: boolean;
  @ApiPropertyOptional()
  lastUpdatedAt!: string | null;
}

export class ReadingProgrammeResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty()
  name!: string;
  @ApiPropertyOptional()
  description!: string | null;
  @ApiPropertyOptional()
  academicYearId!: string | null;
  @ApiPropertyOptional()
  targetBooks!: number | null;
  @ApiPropertyOptional()
  targetPages!: number | null;
  @ApiPropertyOptional()
  startDate!: string | null;
  @ApiPropertyOptional()
  endDate!: string | null;
  @ApiProperty()
  isActive!: boolean;
  @ApiProperty({ enum: READING_PROGRAMME_AUDIENCE_TYPES })
  targetAudienceType!: ReadingProgrammeAudienceType;
  @ApiPropertyOptional()
  targetId!: string | null;
  @ApiPropertyOptional({ type: ReadingProgrammeProgressDto })
  myProgress?: ReadingProgrammeProgressDto | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

export class ReadingProgrammeLeaderboardEntryDto {
  @ApiProperty()
  studentId!: string;
  @ApiPropertyOptional()
  studentName!: string | null;
  @ApiProperty()
  booksRead!: number;
  @ApiProperty()
  pagesRead!: number;
  @ApiProperty()
  isComplete!: boolean;
}

// ── Reading log DTOs ────────────────────────────────────────────

export class CreateReadingLogDto {
  @ApiProperty()
  @IsUUID()
  catalogueItemId!: string;

  @ApiPropertyOptional({
    description:
      "ISO date when the student started reading. Optional. The Step 7 service treats a populated startedDate as 'in progress' until completedDate is set.",
  })
  @IsOptional()
  @IsString()
  startedDate?: string;

  @ApiPropertyOptional({
    description:
      'ISO date when the student finished reading. Setting this triggers the programme-progress auto-upsert: every active programme covering this student gets books_read += 1 + pages_read += pages_read.',
  })
  @IsOptional()
  @IsString()
  completedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  pagesRead?: number;

  @ApiPropertyOptional({
    description: 'Star rating 1..5. Optional until the student completes the read.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewText?: string;
}

export class UpdateReadingLogDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  completedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  pagesRead?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewText?: string;
}

export class ReadingLogResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  studentId!: string;
  @ApiPropertyOptional()
  studentName!: string | null;
  @ApiProperty()
  catalogueItemId!: string;
  @ApiPropertyOptional()
  itemTitle!: string | null;
  @ApiPropertyOptional()
  itemAuthor!: string | null;
  @ApiPropertyOptional()
  startedDate!: string | null;
  @ApiPropertyOptional()
  completedDate!: string | null;
  @ApiPropertyOptional()
  pagesRead!: number | null;
  @ApiPropertyOptional()
  rating!: number | null;
  @ApiPropertyOptional()
  reviewText!: string | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

// ── Reading list DTOs ───────────────────────────────────────────

export class CreateReadingListDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: READING_LIST_TYPES })
  @IsIn(READING_LIST_TYPES as unknown as string[])
  listType!: ReadingListType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetClassId?: string;

  @ApiPropertyOptional({
    description:
      'P2-25a — Free-form grade label for list_type=YEAR_GROUP. Optional for other list types.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  targetGradeLevel?: string;

  @ApiPropertyOptional({
    description:
      'P2-25a — Soft UUID ref to cur_units(id). Populated when list_type=CURRICULUM_UNIT to link the list to a specific curriculum unit.',
  })
  @IsOptional()
  @IsUUID()
  curriculumUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class UpdateReadingListDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: READING_LIST_TYPES })
  @IsOptional()
  @IsIn(READING_LIST_TYPES as unknown as string[])
  listType?: ReadingListType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetClassId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  targetGradeLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  curriculumUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class CreateReadingListItemDto {
  @ApiProperty()
  @IsUUID()
  catalogueItemId!: string;

  @ApiPropertyOptional({ enum: READING_LIST_ITEM_TYPES })
  @IsOptional()
  @IsIn(READING_LIST_ITEM_TYPES as unknown as string[])
  itemType?: ReadingListItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateReadingListItemDto {
  @ApiPropertyOptional({ enum: READING_LIST_ITEM_TYPES })
  @IsOptional()
  @IsIn(READING_LIST_ITEM_TYPES as unknown as string[])
  itemType?: ReadingListItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ReadingListItemResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  readingListId!: string;
  @ApiProperty()
  catalogueItemId!: string;
  @ApiPropertyOptional()
  itemTitle!: string | null;
  @ApiPropertyOptional()
  itemAuthor!: string | null;
  @ApiPropertyOptional()
  itemCoverImageUrl!: string | null;
  @ApiProperty({ enum: READING_LIST_ITEM_TYPES })
  itemType!: ReadingListItemType;
  @ApiProperty()
  sortOrder!: number;
  @ApiPropertyOptional()
  notes!: string | null;
  @ApiProperty()
  addedById!: string;
  @ApiPropertyOptional()
  addedByName!: string | null;
  @ApiProperty()
  createdAt!: string;
}

export class ReadingListResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty()
  name!: string;
  @ApiPropertyOptional()
  description!: string | null;
  @ApiProperty({ enum: READING_LIST_TYPES })
  listType!: ReadingListType;
  @ApiProperty()
  createdById!: string;
  @ApiPropertyOptional()
  createdByName!: string | null;
  @ApiPropertyOptional()
  targetClassId!: string | null;
  @ApiPropertyOptional()
  targetGradeLevel!: string | null;
  @ApiPropertyOptional()
  curriculumUnitId!: string | null;
  @ApiPropertyOptional()
  academicYearId!: string | null;
  @ApiProperty()
  isPublished!: boolean;
  @ApiPropertyOptional()
  publishedAt!: string | null;
  @ApiProperty()
  itemCount!: number;
  @ApiPropertyOptional({ type: [ReadingListItemResponseDto] })
  items?: ReadingListItemResponseDto[];
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

// ── Review DTOs ─────────────────────────────────────────────────

export class CreateReviewDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewText?: string;
}

export class UpdateReviewDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewText?: string;
}

export class ReviewResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  itemId!: string;
  @ApiProperty()
  studentId!: string;
  @ApiPropertyOptional()
  studentName!: string | null;
  @ApiProperty()
  rating!: number;
  @ApiPropertyOptional()
  reviewText!: string | null;
  @ApiProperty()
  isApproved!: boolean;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}
