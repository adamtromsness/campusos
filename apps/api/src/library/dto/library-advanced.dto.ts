import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * P2-25a + P2-25b — Library Advanced DTOs.
 *
 * Class set checkouts, AI-ready recommendations, interlibrary loans,
 * catalogue import. The Cycle 12 lib_reading_lists DTO continues to
 * live in library.dto.ts — only the new fields target_grade_level +
 * curriculum_unit_id were added there.
 */

// ── Class set checkouts ────────────────────────────────────────

export const CLASS_SET_STATUSES = ['ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED', 'OVERDUE'] as const;
export type ClassSetStatus = (typeof CLASS_SET_STATUSES)[number];

export class CreateClassSetCheckoutDto {
  @ApiProperty({
    description:
      'The catalogue item being bulk-checked-out. The service validates copy_count <= available copies of this item before INSERTing the class set + its children.',
  })
  @IsUUID()
  catalogueItemId!: string;

  @ApiProperty({
    description:
      'The teacher patron person id (platform.iam_person). The service validates the teacher has an hr_employees row in this tenant before creating the class set.',
  })
  @IsUUID()
  teacherPatronId!: string;

  @ApiPropertyOptional({
    description:
      'Soft UUID ref to sis_classes(id). Optional — a class set may be checked out by a teacher for general use without binding to a specific class.',
  })
  @IsOptional()
  @IsUUID()
  classId?: string;

  @ApiProperty({ description: 'Number of copies to check out. Must be > 0.' })
  @IsInt()
  @Min(1)
  copyCount!: number;

  @ApiProperty({
    description:
      'YYYY-MM-DD format. The service stamps each individual lib_checkouts row with this.',
  })
  @IsString()
  @IsNotEmpty()
  checkoutDate!: string;

  @ApiProperty({
    description: 'YYYY-MM-DD format. Must be >= checkoutDate (schema-side dates_chk).',
  })
  @IsString()
  @IsNotEmpty()
  dueDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ReturnClassSetCopiesDto {
  @ApiProperty({
    description:
      'Number of copies to mark as returned. The service validates returnedCount + returned <= copy_count and walks the status state machine.',
  })
  @IsInt()
  @Min(1)
  copiesReturned!: number;

  @ApiPropertyOptional({ description: 'Optional barcodes of the specific copies being returned.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  barcodes?: string[];
}

export class ClassSetCheckoutResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty()
  catalogueItemId!: string;
  @ApiPropertyOptional()
  catalogueItemTitle!: string | null;
  @ApiPropertyOptional()
  catalogueItemAuthor!: string | null;
  @ApiProperty()
  teacherPatronId!: string;
  @ApiPropertyOptional()
  teacherName!: string | null;
  @ApiPropertyOptional()
  classId!: string | null;
  @ApiProperty()
  copyCount!: number;
  @ApiProperty()
  checkoutDate!: string;
  @ApiProperty()
  dueDate!: string;
  @ApiProperty()
  returnedCount!: number;
  @ApiProperty({ enum: CLASS_SET_STATUSES })
  status!: ClassSetStatus;
  @ApiPropertyOptional()
  notes!: string | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

export class ListClassSetsArgsDto {
  @ApiPropertyOptional({ enum: CLASS_SET_STATUSES })
  @IsOptional()
  @IsIn(CLASS_SET_STATUSES as unknown as string[])
  status?: ClassSetStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  teacherPatronId?: string;
}

// ── Recommendations ────────────────────────────────────────────

export const RECOMMENDATION_REASONS = [
  'COLLABORATIVE_FILTERING',
  'READING_LEVEL_MATCH',
  'SUBJECT_MATCH',
  'NEW_ARRIVAL',
  'STAFF_PICK',
] as const;
export type RecommendationReason = (typeof RECOMMENDATION_REASONS)[number];

export class RecommendationResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  studentId!: string;
  @ApiProperty()
  recommendedItemId!: string;
  @ApiPropertyOptional()
  itemTitle!: string | null;
  @ApiPropertyOptional()
  itemAuthor!: string | null;
  @ApiPropertyOptional()
  itemCoverImageUrl!: string | null;
  @ApiProperty({ enum: RECOMMENDATION_REASONS })
  reasonType!: RecommendationReason;
  @ApiPropertyOptional()
  score!: number | null;
  @ApiPropertyOptional({ type: Object })
  reasonMetadata!: Record<string, unknown> | null;
  @ApiPropertyOptional()
  dismissedAt!: string | null;
  @ApiProperty()
  generatedAt!: string;
}

// ── Interlibrary loans ─────────────────────────────────────────

export const ILL_DIRECTIONS = ['BORROWED', 'LENT'] as const;
export type IllDirection = (typeof ILL_DIRECTIONS)[number];

export const ILL_STATUSES = [
  'REQUESTED',
  'IN_TRANSIT',
  'ACTIVE',
  'RETURNED',
  'OVERDUE',
  'LOST',
] as const;
export type IllStatus = (typeof ILL_STATUSES)[number];

export class CreateInterlibraryLoanDto {
  @ApiProperty({ enum: ILL_DIRECTIONS })
  @IsIn(ILL_DIRECTIONS as unknown as string[])
  loanDirection!: IllDirection;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  partnerInstitution!: string;

  @ApiPropertyOptional({
    description:
      'LENT requires this populated (schema-side direction_chk). BORROWED is nullable because the title may not be in our catalogue.',
  })
  @IsOptional()
  @IsUUID()
  catalogueItemId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  author?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  isbn?: string;

  @ApiProperty({ description: 'YYYY-MM-DD format.' })
  @IsString()
  @IsNotEmpty()
  requestDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateInterlibraryLoanDto {
  @ApiPropertyOptional({ enum: ILL_STATUSES })
  @IsOptional()
  @IsIn(ILL_STATUSES as unknown as string[])
  status?: IllStatus;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD format.' })
  @IsOptional()
  @IsString()
  receivedDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD format.' })
  @IsOptional()
  @IsString()
  sentDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD format.' })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD format.' })
  @IsOptional()
  @IsString()
  returnedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class InterlibraryLoanResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty({ enum: ILL_DIRECTIONS })
  loanDirection!: IllDirection;
  @ApiProperty()
  partnerInstitution!: string;
  @ApiPropertyOptional()
  catalogueItemId!: string | null;
  @ApiProperty()
  title!: string;
  @ApiPropertyOptional()
  author!: string | null;
  @ApiPropertyOptional()
  isbn!: string | null;
  @ApiProperty()
  requestDate!: string;
  @ApiPropertyOptional()
  receivedDate!: string | null;
  @ApiPropertyOptional()
  sentDate!: string | null;
  @ApiPropertyOptional()
  dueDate!: string | null;
  @ApiPropertyOptional()
  returnedDate!: string | null;
  @ApiProperty({ enum: ILL_STATUSES })
  status!: IllStatus;
  @ApiPropertyOptional()
  notes!: string | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

export class ListIllArgsDto {
  @ApiPropertyOptional({ enum: ILL_STATUSES })
  @IsOptional()
  @IsIn(ILL_STATUSES as unknown as string[])
  status?: IllStatus;

  @ApiPropertyOptional({ enum: ILL_DIRECTIONS })
  @IsOptional()
  @IsIn(ILL_DIRECTIONS as unknown as string[])
  loanDirection?: IllDirection;
}

// ── Catalogue import jobs ──────────────────────────────────────

export const IMPORT_TYPES = ['ISBN_BATCH', 'MARC_IMPORT', 'CSV_UPLOAD', 'WORLDCAT_SYNC'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export const IMPORT_STATUSES = ['QUEUED', 'PARSING', 'IMPORTING', 'COMPLETED', 'FAILED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export class CreateCatalogueImportJobDto {
  @ApiProperty({ enum: IMPORT_TYPES })
  @IsIn(IMPORT_TYPES as unknown as string[])
  importType!: ImportType;

  @ApiPropertyOptional({
    description: 'Optional uploaded file key — required for CSV_UPLOAD / MARC_IMPORT.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceFileS3Key?: string;

  @ApiPropertyOptional({
    description:
      'For ISBN_BATCH — array of ISBNs to import. The service stores the inline list and the worker processes them.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  isbns?: string[];
}

export class CatalogueImportJobResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  schoolId!: string;
  @ApiProperty({ enum: IMPORT_TYPES })
  importType!: ImportType;
  @ApiPropertyOptional()
  sourceFileS3Key!: string | null;
  @ApiPropertyOptional()
  totalRecords!: number | null;
  @ApiProperty()
  recordsImported!: number;
  @ApiProperty()
  recordsSkipped!: number;
  @ApiProperty()
  recordsFailed!: number;
  @ApiProperty({ enum: IMPORT_STATUSES })
  status!: ImportStatus;
  @ApiProperty()
  initiatedById!: string;
  @ApiPropertyOptional()
  initiatedByName!: string | null;
  @ApiPropertyOptional()
  errorLogS3Key!: string | null;
  @ApiPropertyOptional()
  startedAt!: string | null;
  @ApiPropertyOptional()
  completedAt!: string | null;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;
}

// Wire up the unused-import escape so eslint/strict-tsc don't fail on
// IsISO8601 + IsNumber + Max which are reserved for follow-up fields.
void IsISO8601;
void IsNumber;
void Max;
