import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const TRIGGER_TYPES = [
  'ENROLMENT_CONFIRMED',
  'TERM_START',
  'DATE_OF_MONTH',
  'ACADEMIC_YEAR_START',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const RUN_TYPES = ['MANUAL_BATCH', 'AUTO_RULE_TRIGGERED', 'FEE_SCHEDULE_BULK'] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export class AutoInvoiceRuleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: TRIGGER_TYPES }) triggerType!: TriggerType;
  @ApiProperty() feeScheduleId!: string;
  @ApiPropertyOptional({ nullable: true }) feeScheduleName!: string | null;
  @ApiPropertyOptional({ nullable: true }) triggerDayOfMonth!: number | null;
  @ApiPropertyOptional({ nullable: true }) triggerTermOffsetDays!: number | null;
  @ApiPropertyOptional({ nullable: true }) appliesToGradeLevel!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ nullable: true }) lastRunAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateAutoInvoiceRuleDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty({ enum: TRIGGER_TYPES })
  @IsIn(TRIGGER_TYPES as unknown as string[])
  triggerType!: TriggerType;
  @ApiProperty() @IsUUID() feeScheduleId!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(28) triggerDayOfMonth?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() triggerTermOffsetDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) appliesToGradeLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateAutoInvoiceRuleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(28) triggerDayOfMonth?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() triggerTermOffsetDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) appliesToGradeLevel?: string;
}

export class InvoiceGenerationRunResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: RUN_TYPES }) runType!: RunType;
  @ApiPropertyOptional({ nullable: true }) feeScheduleId!: string | null;
  @ApiPropertyOptional({ nullable: true }) feeScheduleName!: string | null;
  @ApiPropertyOptional({ nullable: true }) autoRuleId!: string | null;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiPropertyOptional({ nullable: true }) initiatedBy!: string | null;
  @ApiProperty() totalFamiliesTargeted!: number;
  @ApiProperty() invoicesCreated!: number;
  @ApiProperty() invoicesSkipped!: number;
  @ApiProperty() invoicesFailed!: number;
  @ApiProperty({ enum: RUN_STATUSES }) status!: RunStatus;
  @ApiPropertyOptional({ nullable: true }) errorSummary!: string | null;
  @ApiPropertyOptional({ nullable: true }) startedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TriggerAutoInvoiceRuleDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() academicYearId?: string;
}

export class ListInvoiceGenerationRunsQueryDto {
  @ApiPropertyOptional({ enum: RUN_STATUSES })
  @IsOptional()
  @IsIn(RUN_STATUSES as unknown as string[])
  status?: RunStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() autoRuleId?: string;
}
