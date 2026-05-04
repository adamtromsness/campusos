import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

// ─── Const enum mirrors ────────────────────────────────────────

export const PLAN_TYPES = ['BIP', 'BSP', 'SAFETY_PLAN'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'REVIEW', 'EXPIRED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Statuses a caller can pass into PATCH /:id (the generic update). The
 * dedicated /activate endpoint is the only path to ACTIVE so the partial
 * UNIQUE check is in one place. Generic PATCH only allows DRAFT ↔ REVIEW
 * transitions and explicitly rejects ACTIVE so the partial-UNIQUE
 * keystone never has two write paths.
 */
export const PATCHABLE_PLAN_STATUSES = ['DRAFT', 'REVIEW'] as const;
export type PatchablePlanStatus = (typeof PATCHABLE_PLAN_STATUSES)[number];

export const GOAL_PROGRESS = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET'] as const;
export type GoalProgress = (typeof GOAL_PROGRESS)[number];

export const FEEDBACK_EFFECTIVENESS = [
  'NOT_EFFECTIVE',
  'SOMEWHAT_EFFECTIVE',
  'EFFECTIVE',
  'VERY_EFFECTIVE',
] as const;
export type FeedbackEffectiveness = (typeof FEEDBACK_EFFECTIVENESS)[number];

// ─── Goal DTOs ────────────────────────────────────────────────

export class GoalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() planId!: string;
  @ApiProperty() goalText!: string;
  @ApiPropertyOptional({ nullable: true }) baselineFrequency!: string | null;
  @ApiPropertyOptional({ nullable: true }) targetFrequency!: string | null;
  @ApiPropertyOptional({ nullable: true }) measurementMethod!: string | null;
  @ApiProperty({ enum: GOAL_PROGRESS }) progress!: GoalProgress;
  @ApiPropertyOptional({ nullable: true }) lastAssessedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateGoalDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  goalText!: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  baselineFrequency?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetFrequency?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  measurementMethod?: string | null;
}

export class UpdateGoalDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  goalText?: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  baselineFrequency?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetFrequency?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  measurementMethod?: string | null;

  @ApiPropertyOptional({ enum: GOAL_PROGRESS })
  @IsOptional()
  @IsIn(GOAL_PROGRESS as unknown as string[])
  progress?: GoalProgress;
}

// ─── Feedback DTOs ────────────────────────────────────────────

export class FeedbackResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() planId!: string;
  @ApiPropertyOptional({ nullable: true }) teacherId!: string | null;
  @ApiPropertyOptional({ nullable: true }) teacherName!: string | null;
  @ApiPropertyOptional({ nullable: true }) requestedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) requestedByName!: string | null;
  @ApiProperty() requestedAt!: string;
  @ApiPropertyOptional({ nullable: true }) submittedAt!: string | null;
  @ApiPropertyOptional({ type: [String], nullable: true })
  strategiesObserved!: string[] | null;
  @ApiPropertyOptional({ enum: FEEDBACK_EFFECTIVENESS, nullable: true })
  overallEffectiveness!: FeedbackEffectiveness | null;
  @ApiPropertyOptional({ nullable: true }) classroomObservations!: string | null;
  @ApiPropertyOptional({ nullable: true }) recommendedAdjustments!: string | null;
  /**
   * Convenience: when populated this row carries a snapshot of the parent
   * plan's student so the /bip-feedback/pending list can render the
   * teacher's queue without joining back to svc_behavior_plans on the
   * client. Filled by FeedbackService for the pending list endpoint only;
   * null on the per-plan feedback list.
   */
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiPropertyOptional({ nullable: true }) planType!: string | null;
}

export class RequestFeedbackDto {
  @ApiProperty({ description: 'hr_employees.id of the teacher whose feedback is being requested.' })
  @IsUUID()
  teacherId!: string;
}

export class SubmitFeedbackDto {
  @ApiPropertyOptional({
    description: 'Strategies the teacher observed in the classroom.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  strategiesObserved?: string[];

  @ApiPropertyOptional({ enum: FEEDBACK_EFFECTIVENESS })
  @IsOptional()
  @IsIn(FEEDBACK_EFFECTIVENESS as unknown as string[])
  overallEffectiveness?: FeedbackEffectiveness;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  classroomObservations?: string | null;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  recommendedAdjustments?: string | null;
}

// ─── Behavior Plan DTOs ───────────────────────────────────────

export class BehaviorPlanResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentGradeLevel!: string | null;
  @ApiPropertyOptional({ nullable: true }) caseloadId!: string | null;
  @ApiProperty({ enum: PLAN_TYPES }) planType!: PlanType;
  @ApiProperty({ enum: PLAN_STATUSES }) status!: PlanStatus;
  @ApiPropertyOptional({ nullable: true }) createdById!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdByName!: string | null;
  @ApiProperty() reviewDate!: string;
  @ApiPropertyOptional({ nullable: true }) reviewMeetingId!: string | null;
  @ApiProperty({ type: [String] }) targetBehaviors!: string[];
  @ApiProperty({ type: [String] }) replacementBehaviors!: string[];
  @ApiProperty({ type: [String] }) reinforcementStrategies!: string[];
  @ApiPropertyOptional({ nullable: true }) planDocumentS3Key!: string | null;
  @ApiPropertyOptional({ nullable: true }) sourceIncidentId!: string | null;
  @ApiProperty({ type: [GoalResponseDto] }) goals!: GoalResponseDto[];
  @ApiProperty({ type: [FeedbackResponseDto] }) feedback!: FeedbackResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateBehaviorPlanDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: PLAN_TYPES })
  @IsIn(PLAN_TYPES as unknown as string[])
  planType!: PlanType;

  @ApiProperty({ description: 'YYYY-MM-DD review date (required).' })
  @IsDateString()
  reviewDate!: string;

  @ApiProperty({
    description: 'Behaviours the plan is designed to reduce. Required, at least one entry.',
    type: [String],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Type(() => String)
  targetBehaviors!: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  replacementBehaviors?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reinforcementStrategies?: string[];

  @ApiPropertyOptional({
    description:
      'Optional sis_discipline_incidents.id link. Validated against the same tenant before INSERT (soft cross-module ref per ADR-001/020).',
  })
  @IsOptional()
  @IsUUID()
  sourceIncidentId?: string;

  @ApiPropertyOptional({ description: 'Optional Cycle 11 svc_caseloads.id (forward-compat).' })
  @IsOptional()
  @IsUUID()
  caseloadId?: string;
}

export class UpdateBehaviorPlanDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD review date.' })
  @IsOptional()
  @IsDateString()
  reviewDate?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  targetBehaviors?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  replacementBehaviors?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reinforcementStrategies?: string[];

  @ApiPropertyOptional({
    enum: PATCHABLE_PLAN_STATUSES,
    description:
      'Generic status update. Use /activate to flip DRAFT → ACTIVE and /expire for ACTIVE/REVIEW → EXPIRED. The partial UNIQUE keystone is enforced from /activate only.',
  })
  @IsOptional()
  @IsIn(PATCHABLE_PLAN_STATUSES as unknown as string[])
  status?: PatchablePlanStatus;
}

export class ListBehaviorPlansQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({ enum: PLAN_STATUSES })
  @IsOptional()
  @IsIn(PLAN_STATUSES as unknown as string[])
  status?: PlanStatus;

  @ApiPropertyOptional({ enum: PLAN_TYPES })
  @IsOptional()
  @IsIn(PLAN_TYPES as unknown as string[])
  planType?: PlanType;
}
