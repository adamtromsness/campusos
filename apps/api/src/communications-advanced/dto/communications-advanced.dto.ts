import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTOs for Phase 2 Cycle 19 sub-cycle a (P2-19a) — Translation +
 * Templates + Broadcast Analytics.
 *
 * Conventions match the rest of the codebase: per-route DTOs use
 * class-validator decorators with the global ValidationPipe enforcing
 * `forbidNonWhitelisted: true` so unknown fields surface as 400.
 */

export type TemplateCategory =
  | 'ANNOUNCEMENT'
  | 'REMINDER'
  | 'EMERGENCY'
  | 'WELCOME'
  | 'FOLLOW_UP'
  | 'CUSTOM';

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'ANNOUNCEMENT',
  'REMINDER',
  'EMERGENCY',
  'WELCOME',
  'FOLLOW_UP',
  'CUSTOM',
];

export type SegmentType =
  | 'ALL_PARENTS'
  | 'ALL_STAFF'
  | 'GRADE_LEVEL'
  | 'CLASS'
  | 'TRANSPORT_ROUTE'
  | 'CUSTOM';

export const SEGMENT_TYPES: SegmentType[] = [
  'ALL_PARENTS',
  'ALL_STAFF',
  'GRADE_LEVEL',
  'CLASS',
  'TRANSPORT_ROUTE',
  'CUSTOM',
];

/* ── Language preferences ───────────────────────────────────────── */

export class LanguagePreferenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() preferredLanguage!: string;
  @ApiProperty() autoTranslateIncoming!: boolean;
  @ApiProperty() autoTranslateOutgoing!: boolean;
  @ApiProperty() updatedAt!: string;
}

export class UpdateLanguagePreferenceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'preferredLanguage must contain non-whitespace characters' })
  @MaxLength(32)
  preferredLanguage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoTranslateIncoming?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoTranslateOutgoing?: boolean;
}

/* ── Translations ───────────────────────────────────────────────── */

export class TranslationDto {
  @ApiProperty() id!: string;
  @ApiProperty() messageId!: string;
  @ApiProperty() messageCreatedAt!: string;
  @ApiProperty() targetLanguage!: string;
  @ApiProperty() translatedText!: string;
  @ApiPropertyOptional() sourceLanguage!: string | null;
  @ApiPropertyOptional() modelVersion!: string | null;
  @ApiPropertyOptional() confidence!: number | null;
  @ApiProperty() translatedAt!: string;
  @ApiPropertyOptional() requestedBy!: string | null;
  @ApiProperty() cached!: boolean;
}

export class TranslateRequestDto {
  @ApiProperty() @IsUUID() messageId!: string;

  @ApiProperty()
  @IsString()
  @Matches(/\S/, { message: 'targetLanguage must contain non-whitespace characters' })
  @MaxLength(32)
  targetLanguage!: string;

  /**
   * Optional override of the source message text. When omitted the
   * service joins msg_messages to pull the canonical body. Useful for
   * the auto-translate worker path where the text is already in hand.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  sourceText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  sourceLanguage?: string;
}

/* ── Templates ──────────────────────────────────────────────────── */

export class TemplateVariableDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message: 'variable name must be a valid identifier (letters, digits, underscore)',
  })
  @MaxLength(64)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultValue?: string;
}

export class TemplateDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() category!: TemplateCategory;
  @ApiPropertyOptional() subjectTemplate!: string | null;
  @ApiProperty() bodyTemplate!: string;
  @ApiProperty({ type: [TemplateVariableDto] }) variables!: TemplateVariableDto[];
  @ApiProperty({ type: [String] }) allowedRoles!: string[];
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateTemplateDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty()
  @IsIn(TEMPLATE_CATEGORIES)
  category!: TemplateCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subjectTemplate?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  bodyTemplate!: string;

  @ApiPropertyOptional({ type: [TemplateVariableDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedRoles?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(TEMPLATE_CATEGORIES)
  category?: TemplateCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subjectTemplate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  bodyTemplate?: string;

  @ApiPropertyOptional({ type: [TemplateVariableDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedRoles?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RenderTemplateDto {
  @ApiProperty()
  @IsObject()
  values!: Record<string, string>;
}

export class RenderedTemplateDto {
  @ApiProperty() templateId!: string;
  @ApiPropertyOptional() subject!: string | null;
  @ApiProperty() body!: string;
}

export class UseTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  broadcastId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  threadId?: string;
}

export class TemplateUsageDto {
  @ApiProperty() id!: string;
  @ApiProperty() templateId!: string;
  @ApiProperty() usedBy!: string;
  @ApiProperty() usedAt!: string;
  @ApiPropertyOptional() broadcastId!: string | null;
  @ApiPropertyOptional() threadId!: string | null;
  @ApiPropertyOptional() renderedSubject!: string | null;
}

export class TemplateAnalyticsDto {
  @ApiProperty() templateId!: string;
  @ApiProperty() usageCount!: number;
  @ApiPropertyOptional() lastUsedAt!: string | null;
}

/* ── Broadcast segments ─────────────────────────────────────────── */

export class BroadcastSegmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() segmentType!: SegmentType;
  @ApiProperty({ type: Object }) filterCriteria!: Record<string, unknown>;
  @ApiPropertyOptional() estimatedRecipients!: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional() createdBy!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateBroadcastSegmentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty()
  @IsIn(SEGMENT_TYPES)
  segmentType!: SegmentType;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  filterCriteria?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBroadcastSegmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(SEGMENT_TYPES)
  segmentType?: SegmentType;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  filterCriteria?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SegmentResolutionDto {
  @ApiProperty() segmentId!: string;
  @ApiProperty() segmentType!: SegmentType;
  @ApiProperty({ type: [String] }) accountIds!: string[];
  @ApiProperty() totalRecipients!: number;
}

export class SegmentPreviewDto {
  @ApiProperty() segmentId!: string;
  @ApiProperty() segmentType!: SegmentType;
  @ApiProperty() estimatedRecipients!: number;
}

/* ── Broadcast analytics ────────────────────────────────────────── */

export class BroadcastAnalyticsRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() broadcastId!: string;
  @ApiPropertyOptional() segmentId!: string | null;
  @ApiPropertyOptional() segmentName!: string | null;
  @ApiProperty() totalRecipients!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty() opened!: number;
  @ApiProperty() clicked!: number;
  @ApiProperty() bounced!: number;
  @ApiProperty() unsubscribed!: number;
  @ApiPropertyOptional() deliveryRate!: number | null;
  @ApiPropertyOptional() openRate!: number | null;
  @ApiPropertyOptional() clickRate!: number | null;
  @ApiPropertyOptional() lastUpdatedAt!: string | null;
}

export class BroadcastAnalyticsDto {
  @ApiProperty() broadcastId!: string;
  @ApiProperty({ type: [BroadcastAnalyticsRowDto] }) perSegment!: BroadcastAnalyticsRowDto[];
  @ApiPropertyOptional({ type: BroadcastAnalyticsRowDto })
  aggregate!: BroadcastAnalyticsRowDto | null;
}

/**
 * Worker / webhook contract — the inbound delivery event the
 * BroadcastAnalyticsWorker consumes. Documented here so the consumer
 * spec test pins the shape.
 */
export class BroadcastDeliveryEventDto {
  @ApiProperty() @IsUUID() broadcastId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() segmentId?: string;
  @ApiProperty() @IsInt() @Min(0) totalRecipients!: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) delivered?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) opened?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) clicked?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) bounced?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) unsubscribed?: number;
}
// Suppress import-unused on the symbols that read as unused — they're
// load-bearing for class-transformer + class-validator metadata.
void ArrayMaxSize;
void ArrayMinSize;
