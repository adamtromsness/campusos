import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ListAssignmentsQueryDto {
  @ApiPropertyOptional({
    description:
      'Include unpublished assignments (drafts) and the teacher view of due dates. ' +
      'Ignored for student/parent callers — they only ever see published, non-deleted rows.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeUnpublished?: boolean;
}

export class CreateAssignmentDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Markdown / plain-text instructions shown to students' })
  @IsOptional()
  @IsString()
  instructions?: string;

  @ApiProperty({ description: 'School-wide assignment type (Quiz, Test, Homework, …)' })
  @IsUUID()
  assignmentTypeId!: string;

  @ApiPropertyOptional({
    description:
      'Per-class category id (Homework / Assessments / Participation). Optional but strongly ' +
      'recommended — the snapshot worker needs a category to compute weighted averages.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Grading scale id (default scale used if omitted)' })
  @IsOptional()
  @IsUUID()
  gradingScaleId?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp; null for no deadline' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'Maximum points; defaults to 100', minimum: 0.01 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  maxPoints?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isAiGradingEnabled?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isExtraCredit?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Publish on create — students can see the assignment immediately. Defaults false ' +
      '(draft). Toggle later with PATCH.',
  })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  instructions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignmentTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  gradingScaleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional({ minimum: 0.01 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  maxPoints?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAiGradingEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isExtraCredit?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class AssignmentTypeSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['HOMEWORK', 'QUIZ', 'TEST', 'PROJECT', 'CLASSWORK'] })
  category!: string;
}

export class AssignmentCategorySummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() weight!: number;
}

export class AssignmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) instructions!: string | null;
  @ApiProperty({ type: AssignmentTypeSummaryDto })
  assignmentType!: AssignmentTypeSummaryDto;
  @ApiProperty({ type: AssignmentCategorySummaryDto, nullable: true })
  category!: AssignmentCategorySummaryDto | null;
  @ApiProperty({ nullable: true }) gradingScaleId!: string | null;
  @ApiProperty({ nullable: true }) dueDate!: string | null;
  @ApiProperty() maxPoints!: number;
  @ApiProperty() isAiGradingEnabled!: boolean;
  @ApiProperty() isExtraCredit!: boolean;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
