import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const AUDIENCE_TYPES = ['ALL_SCHOOL', 'CLASS', 'YEAR_GROUP', 'ROLE', 'CUSTOM'] as const;
export type AudienceType = (typeof AUDIENCE_TYPES)[number];

export class CreateAnnouncementDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: 'Plain-text body. Rich text rendering is a UI concern.' })
  @IsString()
  @MinLength(1)
  body!: string;

  @ApiProperty({ enum: AUDIENCE_TYPES })
  @IsIn(AUDIENCE_TYPES as unknown as string[])
  audienceType!: AudienceType;

  @ApiPropertyOptional({
    description:
      'Polymorphic target identifier interpreted by the AudienceFanOutWorker. ' +
      'CLASS → sis_classes.id (UUID as text), YEAR_GROUP → grade-level label, ' +
      'ROLE → role token (e.g. PARENT). NULL for ALL_SCHOOL.',
  })
  @IsOptional()
  @IsString()
  audienceRef?: string;

  @ApiPropertyOptional({
    description: 'msg_alert_types.id — controls icon and severity in the bell UI',
  })
  @IsOptional()
  @IsUUID()
  alertTypeId?: string;

  @ApiPropertyOptional({ description: 'ISO8601 — defaults to now() on publish' })
  @IsOptional()
  @IsISO8601()
  publishAt?: string;

  @ApiPropertyOptional({ description: 'ISO8601 — when the announcement should auto-hide' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    description:
      'Set true to publish immediately. Defaults to false (saved as draft). Publishing emits ' +
      '`msg.announcement.published` so the AudienceFanOutWorker can resolve the audience.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateAnnouncementDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  body?: string;

  @ApiPropertyOptional({ enum: AUDIENCE_TYPES })
  @IsOptional()
  @IsIn(AUDIENCE_TYPES as unknown as string[])
  audienceType?: AudienceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  audienceRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  alertTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  publishAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    description:
      'Flip to true to publish a draft. Once published, the announcement cannot be edited via ' +
      'this endpoint (it can only be unpublished by re-creating). Setting to false on a ' +
      'published announcement throws — published is one-way for now.',
  })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class ListAnnouncementsQueryDto {
  @ApiPropertyOptional({
    description:
      'Set true to include drafts in the response. Only honoured for callers holding ' +
      'com-002:write — readers always see published-only.',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeDrafts?: boolean;

  @ApiPropertyOptional({
    description: 'Set true to include expired announcements (defaults to active only).',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeExpired?: boolean;
}

export class AnnouncementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty({ nullable: true }) authorName!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: AUDIENCE_TYPES }) audienceType!: AudienceType;
  @ApiProperty({ nullable: true }) audienceRef!: string | null;
  @ApiProperty({ nullable: true }) alertTypeId!: string | null;
  @ApiProperty({ nullable: true }) alertTypeName!: string | null;
  @ApiProperty({ nullable: true }) alertTypeSeverity!: string | null;
  @ApiProperty({ nullable: true }) publishAt!: string | null;
  @ApiProperty({ nullable: true }) expiresAt!: string | null;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty() isRecurring!: boolean;
  @ApiProperty({ nullable: true }) recurrenceRule!: string | null;
  @ApiProperty({ description: 'True if the calling user has read this announcement' })
  isRead!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class MarkAnnouncementReadResponseDto {
  @ApiProperty() announcementId!: string;
  @ApiProperty() readAt!: string;
  @ApiProperty({ description: 'True if a fresh read row was inserted; false if already read.' })
  newlyRead!: boolean;
}

export class AnnouncementStatsResponseDto {
  @ApiProperty() announcementId!: string;
  @ApiProperty({ description: 'Total audience size (msg_announcement_audiences row count)' })
  totalAudience!: number;
  @ApiProperty({ description: 'Number of recipients who have opened the announcement' })
  readCount!: number;
  @ApiProperty({
    description: 'Read percentage rounded to 2 decimals. 0 when audience is empty.',
  })
  readPercentage!: number;
  @ApiProperty({
    description: "Audience rows still PENDING delivery (worker hasn't fanned out yet)",
  })
  pendingCount!: number;
  @ApiProperty() deliveredCount!: number;
  @ApiProperty() failedCount!: number;
}
