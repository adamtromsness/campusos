import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RubricCriterionInputDto {
  @ApiPropertyOptional({ description: 'Existing criterion id when updating; omit on create.' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  criterionName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: 'Percentage of total grade (0–100). SUM across criteria SHOULD equal 100.',
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  weight!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(1000)
  maxPoints!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  sortOrder!: number;

  @ApiPropertyOptional({
    description:
      'Optional array of {level_name, description, points} performance level definitions.',
  })
  @IsOptional()
  @IsArray()
  performanceLevels?: Array<Record<string, unknown>>;
}

export class CreateRubricDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Mark as a template available for cloning into assignments.',
  })
  @IsOptional()
  @IsBoolean()
  isTemplate?: boolean;

  @ApiProperty({ type: [RubricCriterionInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RubricCriterionInputDto)
  criteria!: RubricCriterionInputDto[];
}

export class UpdateRubricDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isTemplate?: boolean;

  @ApiPropertyOptional({
    type: [RubricCriterionInputDto],
    description:
      'When provided, replaces the rubric criteria atomically. Omit to leave criteria untouched.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RubricCriterionInputDto)
  criteria?: RubricCriterionInputDto[];
}

export class CloneRubricDto {
  @ApiPropertyOptional({
    description: 'Optional new title for the cloned rubric. Defaults to "<source title> (copy)".',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;
}

export class CreateRubricScoreDto {
  @ApiProperty()
  @IsUUID()
  submissionId!: string;

  @ApiProperty()
  @IsUUID()
  criterionId!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(1000)
  pointsAwarded!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  performanceLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  feedback?: string;
}

export interface RubricCriterionResponseDto {
  id: string;
  rubricId: string;
  criterionName: string;
  description: string | null;
  weight: number;
  maxPoints: number;
  sortOrder: number;
  performanceLevels: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface RubricResponseDto {
  id: string;
  schoolId: string;
  createdBy: string;
  createdByName: string | null;
  title: string;
  description: string | null;
  isTemplate: boolean;
  totalPoints: number;
  weightTotal: number;
  weightWarning: string | null;
  criteria: RubricCriterionResponseDto[];
  createdAt: string;
  updatedAt: string;
}

export interface RubricScoreResponseDto {
  id: string;
  submissionId: string;
  criterionId: string;
  criterionName: string;
  scoredBy: string;
  scoredByName: string | null;
  pointsAwarded: number;
  performanceLevel: string | null;
  feedback: string | null;
  createdAt: string;
  updatedAt: string;
}
