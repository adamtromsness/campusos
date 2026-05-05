import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// ── Enums ────────────────────────────────────────────────────────

export const FREQUENCY_RECOMMENDATIONS = ['DAILY', 'WEEKLY', 'MONTHLY', 'AS_NEEDED'] as const;
export type FrequencyRecommendation = (typeof FREQUENCY_RECOMMENDATIONS)[number];

export const QUESTION_TYPES = [
  'SCALE_1_5',
  'SCALE_1_10',
  'YES_NO',
  'FREE_TEXT',
  'EMOJI_SCALE',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const WELLBEING_DOMAINS = ['ACADEMIC', 'SOCIAL', 'EMOTIONAL', 'PHYSICAL', 'SAFETY'] as const;
export type WellbeingDomain = (typeof WELLBEING_DOMAINS)[number];

export const DEPLOYMENT_TARGET_TYPES = [
  'CASELOAD',
  'CLASS',
  'YEAR_GROUP',
  'SCHOOL',
  'CUSTOM_LIST',
] as const;
export type DeploymentTargetType = (typeof DEPLOYMENT_TARGET_TYPES)[number];

export const DEPLOYMENT_STATUSES = ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

// ── Survey template DTOs ─────────────────────────────────────────

export class CreateQuestionInputDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  questionText!: string;

  @ApiProperty({ enum: QUESTION_TYPES })
  @IsIn(QUESTION_TYPES as unknown as string[])
  questionType!: QuestionType;

  @ApiProperty({ enum: WELLBEING_DOMAINS })
  @IsIn(WELLBEING_DOMAINS as unknown as string[])
  domain!: WellbeingDomain;

  @ApiProperty()
  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class CreateSurveyTemplateDto {
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

  @ApiProperty({ enum: FREQUENCY_RECOMMENDATIONS })
  @IsIn(FREQUENCY_RECOMMENDATIONS as unknown as string[])
  frequencyRecommendation!: FrequencyRecommendation;

  @ApiProperty({ type: [CreateQuestionInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionInputDto)
  questions!: CreateQuestionInputDto[];
}

export class UpdateSurveyTemplateDto {
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

  @ApiPropertyOptional({ enum: FREQUENCY_RECOMMENDATIONS })
  @IsOptional()
  @IsIn(FREQUENCY_RECOMMENDATIONS as unknown as string[])
  frequencyRecommendation?: FrequencyRecommendation;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AddQuestionDto extends CreateQuestionInputDto {}

export class UpdateQuestionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  questionText?: string;

  @ApiPropertyOptional({ enum: QUESTION_TYPES })
  @IsOptional()
  @IsIn(QUESTION_TYPES as unknown as string[])
  questionType?: QuestionType;

  @ApiPropertyOptional({ enum: WELLBEING_DOMAINS })
  @IsOptional()
  @IsIn(WELLBEING_DOMAINS as unknown as string[])
  domain?: WellbeingDomain;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class WellbeingQuestionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() templateId!: string;
  @ApiProperty() questionText!: string;
  @ApiProperty({ enum: QUESTION_TYPES }) questionType!: QuestionType;
  @ApiProperty({ enum: WELLBEING_DOMAINS }) domain!: WellbeingDomain;
  @ApiProperty() sortOrder!: number;
}

export class SurveyTemplateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: FREQUENCY_RECOMMENDATIONS })
  frequencyRecommendation!: FrequencyRecommendation;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdById!: string;
  @ApiPropertyOptional({ nullable: true }) createdByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ type: [WellbeingQuestionResponseDto] })
  questions?: WellbeingQuestionResponseDto[];
}

// ── Deployment DTOs ──────────────────────────────────────────────

export class CreateDeploymentDto {
  @ApiProperty()
  @IsUUID()
  templateId!: string;

  @ApiProperty()
  @IsDateString()
  deployAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({ enum: DEPLOYMENT_TARGET_TYPES })
  @IsIn(DEPLOYMENT_TARGET_TYPES as unknown as string[])
  targetType!: DeploymentTargetType;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  targetIds?: string[];
}

export class ListDeploymentsQueryDto {
  @ApiPropertyOptional({ enum: DEPLOYMENT_STATUSES })
  @IsOptional()
  @IsIn(DEPLOYMENT_STATUSES as unknown as string[])
  status?: DeploymentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export class DeploymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() templateId!: string;
  @ApiPropertyOptional({ nullable: true }) templateName!: string | null;
  @ApiProperty() deployedById!: string;
  @ApiPropertyOptional({ nullable: true }) deployedByName!: string | null;
  @ApiProperty() deployAt!: string;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: string | null;
  @ApiProperty({ enum: DEPLOYMENT_TARGET_TYPES }) targetType!: DeploymentTargetType;
  @ApiPropertyOptional({ type: [String], nullable: true }) targetIds!: string[] | null;
  @ApiProperty({ enum: DEPLOYMENT_STATUSES }) status!: DeploymentStatus;
  @ApiPropertyOptional({ nullable: true }) totalTargeted!: number | null;
  @ApiPropertyOptional({ nullable: true }) totalCompleted!: number | null;
  @ApiPropertyOptional({ nullable: true }) completionRate!: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ActivateDeploymentResponseDto {
  @ApiProperty() deployment!: DeploymentResponseDto;
  @ApiProperty() checkinsCreated!: number;
}

// ── Alert + check-in enums ───────────────────────────────────────

export const ALERT_TYPES = [
  'FEELS_UNSAFE',
  'WANTS_TO_TALK',
  'SIGNIFICANT_SCORE_DROP',
  'PERSISTENT_LOW_SCORE',
  'SELF_HARM_INDICATOR',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_STATUSES = ['NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

// ── Check-in DTOs ────────────────────────────────────────────────

export class ListCheckinsQueryDto {
  @ApiPropertyOptional({ description: 'Filter to PENDING (true) or COMPLETED (false) check-ins.' })
  @IsOptional()
  @Type(() => String)
  pending?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => String)
  flagged?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  deploymentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export class CheckinResponseInputDto {
  @ApiProperty()
  @IsUUID()
  questionId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  numericResponse?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  textResponse?: string;
}

export class SubmitCheckinDto {
  @ApiProperty({ type: [CheckinResponseInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckinResponseInputDto)
  responses!: CheckinResponseInputDto[];
}

export class WellbeingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() checkinId!: string;
  @ApiProperty() questionId!: string;
  @ApiPropertyOptional({ nullable: true }) numericResponse!: number | null;
  @ApiPropertyOptional({ nullable: true }) textResponse!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CheckinResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiProperty() templateId!: string;
  @ApiPropertyOptional({ nullable: true }) templateName!: string | null;
  @ApiPropertyOptional({ nullable: true }) deploymentId!: string | null;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiProperty() flaggedForFollowUp!: boolean;
  @ApiPropertyOptional({ nullable: true }) assignedCounselorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedCounselorName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ type: [WellbeingResponseDto] })
  responses?: WellbeingResponseDto[];
}

// ── Alert DTOs ───────────────────────────────────────────────────

export class ListAlertsQueryDto {
  @ApiPropertyOptional({ enum: ALERT_STATUSES })
  @IsOptional()
  @IsIn(ALERT_STATUSES as unknown as string[])
  status?: AlertStatus;

  @ApiPropertyOptional({ enum: ALERT_TYPES })
  @IsOptional()
  @IsIn(ALERT_TYPES as unknown as string[])
  alertType?: AlertType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export class ResolveAlertDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  resolutionNotes!: string;
}

export class AlertResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiProperty() responseId!: string;
  @ApiPropertyOptional({ nullable: true }) checkinId!: string | null;
  @ApiPropertyOptional({ nullable: true }) questionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) questionText!: string | null;
  @ApiPropertyOptional({ nullable: true }) responsePreview!: string | null;
  @ApiProperty({ enum: ALERT_TYPES }) alertType!: AlertType;
  @ApiProperty({ enum: ALERT_STATUSES }) status!: AlertStatus;
  @ApiPropertyOptional({ nullable: true }) acknowledgedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) acknowledgedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) acknowledgedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolutionNotes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
