import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ── Application stages ──

export class ApplicationStageResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiPropertyOptional() fromStatus?: string | null;
  @ApiProperty() toStatus!: string;
  @ApiProperty() changedBy!: string;
  @ApiPropertyOptional() changedByName?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() changedAt!: string;
}

export const STAGE_TARGETS = [
  'UNDER_REVIEW',
  'INTERVIEW',
  'ASSESSMENT',
  'OFFERED',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'WITHDRAWN',
  'ENROLLED',
] as const;
export type StageTarget = (typeof STAGE_TARGETS)[number];

export class AdvanceStageDto {
  @ApiProperty({ enum: STAGE_TARGETS })
  @IsIn(STAGE_TARGETS as unknown as string[])
  toStatus!: StageTarget;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ── Application scores ──

export class ApplicationScoreResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() criterionName!: string;
  @ApiProperty() score!: number;
  @ApiPropertyOptional() maxScore?: number | null;
  @ApiProperty() scoredBy!: string;
  @ApiPropertyOptional() scoredByName?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateScoreDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  criterionName!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  score!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateScoreDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  score?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ── Onboarding ──

export const ADMISSION_TYPES = [
  'STANDARD_INTAKE',
  'MID_YEAR_ADMISSION',
  'TRANSFER_IN',
  'RETURNING_STUDENT',
  'INTERNATIONAL',
] as const;
export type AdmissionType = (typeof ADMISSION_TYPES)[number];

export const TASK_CATEGORIES = [
  'ADMINISTRATIVE',
  'HEALTH',
  'IT',
  'FACILITIES',
  'TRANSPORT',
  'COMMUNICATIONS',
  'FINANCE',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_STATUSES = ['PENDING', 'COMPLETED', 'WAIVED', 'OVERDUE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PROGRESS_STATUSES = ['IN_PROGRESS', 'COMPLETE', 'OVERDUE'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export class OnboardingTaskTemplateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() checklistId!: string;
  @ApiProperty() taskName!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty({ enum: TASK_CATEGORIES }) taskCategory!: TaskCategory;
  @ApiProperty() isMandatory!: boolean;
  @ApiPropertyOptional() responsibleRole?: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() dueDaysBeforeStart!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class OnboardingChecklistResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty({ enum: ADMISSION_TYPES }) admissionType!: AdmissionType;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ type: [OnboardingTaskTemplateResponseDto] })
  tasks?: OnboardingTaskTemplateResponseDto[];
}

export class TaskInputDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  taskName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: TASK_CATEGORIES })
  @IsIn(TASK_CATEGORIES as unknown as string[])
  taskCategory!: TaskCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  responsibleRole?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  dueDaysBeforeStart?: number;

  @ApiPropertyOptional()
  @IsOptional()
  isMandatory?: boolean;
}

export class CreateChecklistDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: ADMISSION_TYPES })
  @IsIn(ADMISSION_TYPES as unknown as string[])
  admissionType!: AdmissionType;

  @ApiPropertyOptional({ type: [TaskInputDto] })
  @IsOptional()
  tasks?: TaskInputDto[];
}

export class TaskCompletionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() progressId!: string;
  @ApiProperty() taskId!: string;
  @ApiPropertyOptional() taskName?: string | null;
  @ApiPropertyOptional() taskCategory?: TaskCategory | null;
  @ApiPropertyOptional() responsibleRole?: string | null;
  @ApiPropertyOptional() isMandatory?: boolean;
  @ApiPropertyOptional() sortOrder?: number;
  @ApiProperty({ enum: TASK_STATUSES }) status!: TaskStatus;
  @ApiPropertyOptional() completedBy?: string | null;
  @ApiPropertyOptional() completedByName?: string | null;
  @ApiPropertyOptional() completedAt?: string | null;
  @ApiPropertyOptional() notes?: string | null;
}

export class StudentOnboardingProgressResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() checklistId!: string;
  @ApiPropertyOptional() checklistName?: string | null;
  @ApiPropertyOptional() studentId?: string | null;
  @ApiProperty() startedDate!: string;
  @ApiProperty() targetStartDate!: string;
  @ApiProperty({ enum: PROGRESS_STATUSES }) overallStatus!: ProgressStatus;
  @ApiProperty() tasksTotal!: number;
  @ApiProperty() tasksCompleted!: number;
  @ApiPropertyOptional() completedAt?: string | null;
  @ApiPropertyOptional({ type: [TaskCompletionResponseDto] })
  taskCompletions?: TaskCompletionResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CompleteTaskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
