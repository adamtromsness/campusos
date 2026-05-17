import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Visibility lattice (4-tier) ─────────────────────────────

export type PortfolioVisibility = 'PRIVATE' | 'TEACHER' | 'PARENT' | 'PUBLIC';
export const PORTFOLIO_VISIBILITIES: readonly PortfolioVisibility[] = [
  'PRIVATE',
  'TEACHER',
  'PARENT',
  'PUBLIC',
] as const;

// ── Item type (6-value) ─────────────────────────────────────

export type PortfolioItemType =
  | 'SUBMISSION'
  | 'GRADE'
  | 'ACHIEVEMENT'
  | 'REFLECTION'
  | 'EXTERNAL_FILE'
  | 'CERTIFICATE';
export const PORTFOLIO_ITEM_TYPES: readonly PortfolioItemType[] = [
  'SUBMISSION',
  'GRADE',
  'ACHIEVEMENT',
  'REFLECTION',
  'EXTERNAL_FILE',
  'CERTIFICATE',
] as const;

// ── Share status (3-value) ──────────────────────────────────

export type ShareStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export const SHARE_STATUSES: readonly ShareStatus[] = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;

// ── Achievement type (6-value) ──────────────────────────────

export type AchievementType =
  | 'ACADEMIC'
  | 'SPORTING'
  | 'MUSICAL'
  | 'LEADERSHIP'
  | 'COMMUNITY'
  | 'CUSTOM';
export const ACHIEVEMENT_TYPES: readonly AchievementType[] = [
  'ACADEMIC',
  'SPORTING',
  'MUSICAL',
  'LEADERSHIP',
  'COMMUNITY',
  'CUSTOM',
] as const;

// ── Achievement share platform (3-value) ────────────────────

export type AchievementSharePlatform = 'EMAIL' | 'SOCIAL' | 'PORTFOLIO';
export const ACHIEVEMENT_SHARE_PLATFORMS: readonly AchievementSharePlatform[] = [
  'EMAIL',
  'SOCIAL',
  'PORTFOLIO',
] as const;

// ── Portfolio DTOs ──────────────────────────────────────────

export class PortfolioItemDto {
  id!: string;
  portfolioId!: string;
  itemType!: PortfolioItemType;
  sourceRefId!: string | null;
  sourceTitle!: string | null;
  title!: string;
  description!: string | null;
  s3Key!: string | null;
  isFeatured!: boolean;
  addedAt!: string;
}

export class PortfolioDto {
  id!: string;
  studentId!: string;
  studentName!: string | null;
  schoolId!: string;
  title!: string;
  description!: string | null;
  visibility!: PortfolioVisibility;
  shareLinkEnabled!: boolean;
  itemCount!: number;
  achievementCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class PortfolioDetailDto extends PortfolioDto {
  items!: PortfolioItemDto[];
}

export class CreatePortfolioDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: PORTFOLIO_VISIBILITIES })
  @IsOptional()
  @IsIn(PORTFOLIO_VISIBILITIES as unknown as string[])
  visibility?: PortfolioVisibility;
}

export class UpdatePortfolioDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: PORTFOLIO_VISIBILITIES })
  @IsOptional()
  @IsIn(PORTFOLIO_VISIBILITIES as unknown as string[])
  visibility?: PortfolioVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  shareLinkEnabled?: boolean;
}

export class CreatePortfolioItemDto {
  @ApiProperty({ enum: PORTFOLIO_ITEM_TYPES })
  @IsIn(PORTFOLIO_ITEM_TYPES as unknown as string[])
  itemType!: PortfolioItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sourceRefId?: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;
}

export class UpdatePortfolioItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;
}

export class ItemSourceCandidateDto {
  itemType!: PortfolioItemType;
  sourceRefId!: string;
  title!: string;
  subtitle!: string | null;
}

// ── Share DTOs ──────────────────────────────────────────────

export class ShareDto {
  id!: string;
  portfolioId!: string;
  shareToken!: string;
  expiresAt!: string | null;
  recipientEmail!: string | null;
  viewedAt!: string | null;
  status!: ShareStatus;
  createdAt!: string;
}

export class CreateShareDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  recipientEmail?: string;
}

export class PublicPortfolioViewDto {
  portfolioId!: string;
  studentName!: string | null;
  title!: string;
  description!: string | null;
  schoolName!: string | null;
  featuredItems!: PortfolioItemDto[];
  items!: PortfolioItemDto[];
  achievements!: AchievementDto[];
}

// ── Achievement DTOs ────────────────────────────────────────

export class AchievementDto {
  id!: string;
  studentId!: string;
  studentName!: string | null;
  schoolId!: string;
  title!: string;
  achievementType!: AchievementType;
  sourceModule!: string | null;
  sourceRefId!: string | null;
  awardedAt!: string;
  awardedById!: string | null;
  awardedByName!: string | null;
  description!: string | null;
  badgeImageUrl!: string | null;
  shareCount!: number;
  createdAt!: string;
}

export class CreateAchievementDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ enum: ACHIEVEMENT_TYPES })
  @IsIn(ACHIEVEMENT_TYPES as unknown as string[])
  achievementType!: AchievementType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceModule?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sourceRefId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  awardedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  badgeImageUrl?: string;
}

export class UpdateAchievementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  badgeImageUrl?: string;
}

export class AchievementShareDto {
  id!: string;
  achievementId!: string;
  sharedById!: string;
  platform!: AchievementSharePlatform;
  sharedAt!: string;
}

export class CreateAchievementShareDto {
  @ApiProperty({ enum: ACHIEVEMENT_SHARE_PLATFORMS })
  @IsIn(ACHIEVEMENT_SHARE_PLATFORMS as unknown as string[])
  platform!: AchievementSharePlatform;
}
