import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type FrameworkSource = 'PLATFORM' | 'SCHOOL';
export const FRAMEWORK_SOURCES: readonly FrameworkSource[] = ['PLATFORM', 'SCHOOL'] as const;

export type StandardSource = 'PLATFORM' | 'SCHOOL';

export type CurriculumMapStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export const CURRICULUM_MAP_STATUSES: readonly CurriculumMapStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED',
] as const;

export type GapType = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE';
export const GAP_TYPES: readonly GapType[] = ['NOT_STARTED', 'PARTIAL', 'COMPLETE'] as const;

export type ResourceType = 'FILE' | 'URL' | 'VIDEO' | 'TEXTBOOK';
export const RESOURCE_TYPES: readonly ResourceType[] = [
  'FILE',
  'URL',
  'VIDEO',
  'TEXTBOOK',
] as const;

// ── Frameworks ───────────────────────────────────────────────

export class FrameworkDto {
  id!: string;
  source!: FrameworkSource;
  name!: string;
  body!: string | null;
  region!: string | null;
  version!: string | null;
  description!: string | null;
  schoolId!: string | null;
  isActive!: boolean;
  standardCount!: number;
}

export class FrameworkDetailDto extends FrameworkDto {
  standards!: StandardDto[];
}

export class CreateCustomFrameworkDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateCustomFrameworkDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateAdoptionDto {
  @ApiProperty()
  @IsUUID()
  platformFrameworkId!: string;

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class AdoptionDto {
  id!: string;
  schoolId!: string;
  platformFrameworkId!: string;
  platformFrameworkName!: string;
  academicYearId!: string;
  academicYearName!: string;
  adoptedAt!: string;
  adoptedBy!: string;
  notes!: string | null;
}

// ── Standards ────────────────────────────────────────────────

export class StandardDto {
  id!: string;
  source!: StandardSource;
  frameworkId!: string;
  frameworkName!: string;
  code!: string;
  description!: string;
  gradeBand!: string | null;
  domain!: string | null;
  cluster!: string | null;
}

export class CreateStandardDto {
  @ApiProperty()
  @IsUUID()
  frameworkId!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 100)
  code!: string;

  @ApiProperty()
  @IsString()
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeBand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  domain?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cluster?: string;
}

export class UpdateStandardDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeBand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  domain?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cluster?: string;
}

// ── Curriculum Maps ──────────────────────────────────────────

export class CreateCurriculumMapDto {
  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  frameworkId?: string;

  @ApiProperty()
  @IsString()
  subject!: string;

  @ApiProperty()
  @IsString()
  gradeLevel!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateCurriculumMapDto {
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
  subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  frameworkId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(CURRICULUM_MAP_STATUSES as unknown as string[])
  status?: CurriculumMapStatus;
}

export class CurriculumMapDto {
  id!: string;
  schoolId!: string;
  academicYearId!: string;
  academicYearName!: string;
  frameworkId!: string | null;
  frameworkName!: string | null;
  frameworkSource!: FrameworkSource | null;
  subject!: string;
  gradeLevel!: string;
  title!: string;
  description!: string | null;
  status!: CurriculumMapStatus;
  createdBy!: string;
  publishedAt!: string | null;
  archivedAt!: string | null;
  unitCount!: number;
  totalStandards!: number;
  gapSummary!: { complete: number; partial: number; notStarted: number };
}

// ── Units ────────────────────────────────────────────────────

export class CreateUnitDto {
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
  @IsInt()
  @Min(1)
  estimatedWeeks?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  essentialQuestions?: string[];
}

export class UpdateUnitDto {
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
  @IsInt()
  @Min(1)
  estimatedWeeks?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  essentialQuestions?: string[];
}

export class ReorderUnitsDto {
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  @IsArray()
  order!: Array<{ unitId: string; sequenceOrder: number }>;
}

export class UnitDto {
  id!: string;
  curriculumMapId!: string;
  title!: string;
  description!: string | null;
  sequenceOrder!: number;
  estimatedWeeks!: number | null;
  startDate!: string | null;
  endDate!: string | null;
  essentialQuestions!: string[];
  standardCount!: number;
  lessonCount!: number;
  resourceCount!: number;
  gapSummary!: { complete: number; partial: number; notStarted: number };
}

export class UnitDetailDto extends UnitDto {
  standards!: UnitStandardDto[];
  lessons!: UnitLessonDto[];
  resources!: ResourceDto[];
  gaps!: DeliveryGapDto[];
}

export class UnitStandardDto {
  id!: string;
  unitId!: string;
  standardId!: string;
  standard!: StandardDto;
  notes!: string | null;
}

export class AlignStandardDto {
  @ApiProperty()
  @IsUUID()
  standardId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UnitLessonDto {
  id!: string;
  unitId!: string;
  clsLessonId!: string;
  lessonTitle!: string;
  lessonDate!: string | null;
  lessonStatus!: string;
}

export class LinkLessonDto {
  @ApiProperty()
  @IsUUID()
  clsLessonId!: string;
}

// ── Delivery Gaps ────────────────────────────────────────────

export class DeliveryGapDto {
  id!: string;
  unitId!: string;
  unitTitle!: string;
  curriculumMapId!: string;
  standardId!: string;
  standardCode!: string;
  standardDescription!: string;
  gapType!: GapType;
  lessonsPlanned!: number;
  lessonsDelivered!: number;
  lastAssessedAt!: string | null;
  computedAt!: string;
}

// ── Resource Links ──────────────────────────────────────────

export class CreateResourceDto {
  @ApiProperty()
  @IsIn(RESOURCE_TYPES as unknown as string[])
  resourceType!: ResourceType;

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
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isTeacherOnly?: boolean;
}

export class UpdateResourceDto {
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
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isTeacherOnly?: boolean;
}

export class ResourceDto {
  id!: string;
  unitId!: string;
  resourceType!: ResourceType;
  title!: string;
  description!: string | null;
  url!: string | null;
  s3Key!: string | null;
  isTeacherOnly!: boolean;
  uploadedBy!: string;
  createdAt!: string;
}
