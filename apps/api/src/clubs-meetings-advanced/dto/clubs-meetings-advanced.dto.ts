import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
} from 'class-validator';

/* ── Club budgets ─────────────────────────────────────────────── */

export type BudgetTransactionType = 'ALLOCATION' | 'EXPENSE' | 'REFUND' | 'ADJUSTMENT';

export class CreateClubBudgetDto {
  @ApiProperty()
  @IsUUID()
  activityId!: string;

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  allocatedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateClubBudgetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  allocatedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class RecordBudgetTransactionDto {
  @ApiProperty({ enum: ['ALLOCATION', 'EXPENSE', 'REFUND', 'ADJUSTMENT'] })
  @IsString()
  transactionType!: BudgetTransactionType;

  @ApiProperty()
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  receiptS3Key?: string;
}

export class ClubBudgetTransactionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() budgetId!: string;
  @ApiProperty({ enum: ['ALLOCATION', 'EXPENSE', 'REFUND', 'ADJUSTMENT'] })
  transactionType!: BudgetTransactionType;
  @ApiProperty() amount!: number;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() receiptS3Key?: string | null;
  @ApiProperty() recordedBy!: string;
  @ApiPropertyOptional() recordedByName?: string | null;
  @ApiProperty() createdAt!: string;
}

export class ClubBudgetResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() activityId!: string;
  @ApiPropertyOptional() activityName?: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiPropertyOptional() academicYearName?: string | null;
  @ApiProperty() allocatedAmount!: number;
  @ApiProperty() spentAmount!: number;
  @ApiProperty() remainingAmount!: number;
  @ApiPropertyOptional() approvedBy?: string | null;
  @ApiPropertyOptional() approvedByName?: string | null;
  @ApiPropertyOptional() approvedAt?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/* ── Field trip evaluations ───────────────────────────────────── */

export class CreateFieldTripEvaluationDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  overallRating!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  educationalValueRating?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  logisticsRating?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  safetyRating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comments?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  wouldRecommend?: boolean;
}

export class FieldTripEvaluationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() fieldTripId!: string;
  @ApiProperty() evaluatedBy!: string;
  @ApiPropertyOptional() evaluatedByName?: string | null;
  @ApiProperty() overallRating!: number;
  @ApiPropertyOptional() educationalValueRating?: number | null;
  @ApiPropertyOptional() logisticsRating?: number | null;
  @ApiPropertyOptional() safetyRating?: number | null;
  @ApiPropertyOptional() comments?: string | null;
  @ApiPropertyOptional() wouldRecommend?: boolean | null;
  @ApiProperty() createdAt!: string;
}

export class FieldTripEvaluationSummaryDto {
  @ApiProperty() fieldTripId!: string;
  @ApiProperty() evaluationCount!: number;
  @ApiPropertyOptional() averageOverall?: number | null;
  @ApiPropertyOptional() averageEducational?: number | null;
  @ApiPropertyOptional() averageLogistics?: number | null;
  @ApiPropertyOptional() averageSafety?: number | null;
  @ApiProperty() recommendCount!: number;
}

/* ── Service partner orgs ─────────────────────────────────────── */

export class CreateServicePartnerOrgDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  orgName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceTypes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  websiteUrl?: string;
}

export class UpdateServicePartnerOrgDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  orgName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceTypes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  websiteUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ServicePartnerOrgResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() orgName!: string;
  @ApiPropertyOptional() contactName?: string | null;
  @ApiPropertyOptional() contactEmail?: string | null;
  @ApiPropertyOptional() contactPhone?: string | null;
  @ApiProperty({ type: [String] }) serviceTypes!: string[];
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() websiteUrl?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/* ── Meeting templates ────────────────────────────────────────── */

export class TemplateAgendaItemInputDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreateMeetingTemplateDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  meetingTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDurationMinutes?: number;

  @ApiPropertyOptional({ type: [TemplateAgendaItemInputDto] })
  @IsOptional()
  @IsArray()
  @Type(() => TemplateAgendaItemInputDto)
  defaultAgenda?: TemplateAgendaItemInputDto[];
}

export class UpdateMeetingTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  meetingTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  defaultDurationMinutes?: number;

  @ApiPropertyOptional({ type: [TemplateAgendaItemInputDto] })
  @IsOptional()
  @IsArray()
  @Type(() => TemplateAgendaItemInputDto)
  defaultAgenda?: TemplateAgendaItemInputDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateMeetingFromTemplateDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty()
  @IsString()
  scheduledAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  participantIds?: string[];
}

export class MeetingTemplateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() meetingTypeId?: string | null;
  @ApiPropertyOptional() meetingTypeName?: string | null;
  @ApiProperty() defaultDurationMinutes!: number;
  @ApiProperty() defaultAgenda!: TemplateAgendaItemInputDto[];
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() createdByName?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/* ── AI meeting minutes ───────────────────────────────────────── */

export type AIMinutesStatus = 'PENDING' | 'GENERATED' | 'APPROVED';

export class GenerateAIMinutesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  rawTranscript?: string;
}

export class AIMinutesActionItemDto {
  @ApiProperty() title!: string;
  @ApiPropertyOptional() assigneeName?: string | null;
  @ApiPropertyOptional() dueDate?: string | null;
}

export class AIMinutesKeyDecisionDto {
  @ApiProperty() decision!: string;
  @ApiPropertyOptional() context?: string | null;
}

export class AIMinutesResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiPropertyOptional() rawTranscript?: string | null;
  @ApiPropertyOptional() aiSummary?: string | null;
  @ApiProperty({ type: [AIMinutesActionItemDto] }) aiActionItems!: AIMinutesActionItemDto[];
  @ApiProperty({ type: [AIMinutesKeyDecisionDto] }) aiKeyDecisions!: AIMinutesKeyDecisionDto[];
  @ApiPropertyOptional() modelVersion?: string | null;
  @ApiPropertyOptional() generatedAt?: string | null;
  @ApiProperty({ enum: ['PENDING', 'GENERATED', 'APPROVED'] }) status!: AIMinutesStatus;
  @ApiPropertyOptional() approvedBy?: string | null;
  @ApiPropertyOptional() approvedByName?: string | null;
  @ApiPropertyOptional() approvedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
