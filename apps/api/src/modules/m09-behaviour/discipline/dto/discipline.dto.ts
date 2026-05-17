import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ─── Const enum mirrors ────────────────────────────────────────

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

// ─── Category DTOs ────────────────────────────────────────────

export class CategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SEVERITIES }) severity!: Severity;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class CreateCategoryDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ enum: SEVERITIES })
  @IsIn(SEVERITIES as unknown as string[])
  severity!: Severity;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: SEVERITIES })
  @IsOptional()
  @IsIn(SEVERITIES as unknown as string[])
  severity?: Severity;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Action Type DTOs ─────────────────────────────────────────

export class ActionTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() requiresParentNotification!: boolean;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class CreateActionTypeDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresParentNotification?: boolean;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class UpdateActionTypeDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresParentNotification?: boolean;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Action DTOs ──────────────────────────────────────────────

export class ActionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() incidentId!: string;
  @ApiProperty() actionTypeId!: string;
  @ApiProperty() actionTypeName!: string;
  @ApiProperty() requiresParentNotification!: boolean;
  @ApiPropertyOptional({ nullable: true }) assignedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) startDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) endDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() parentNotified!: boolean;
  @ApiPropertyOptional({ nullable: true }) parentNotifiedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateActionDto {
  @ApiProperty()
  @IsUUID()
  actionTypeId!: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD start date for multi-day consequences.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD end date. Must be >= startDate when both set.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class UpdateActionDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD start date.' })
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD end date. Must be >= startDate when both set.' })
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional({
    description:
      'Mark the action as parent-notified. Stamps parent_notified_at = now() when flipping to true.',
  })
  @IsOptional()
  @IsBoolean()
  parentNotified?: boolean;
}

// ─── Incident DTOs ────────────────────────────────────────────

export class IncidentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentGradeLevel!: string | null;
  @ApiPropertyOptional({ nullable: true }) reportedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) reportedByName!: string | null;
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryName!: string;
  @ApiProperty({ enum: SEVERITIES }) severity!: Severity;
  @ApiProperty() description!: string;
  @ApiProperty() incidentDate!: string;
  @ApiPropertyOptional({ nullable: true }) incidentTime!: string | null;
  @ApiPropertyOptional({ nullable: true }) location!: string | null;
  @ApiPropertyOptional({ nullable: true }) witnesses!: string | null;
  @ApiProperty({ enum: INCIDENT_STATUSES }) status!: IncidentStatus;
  @ApiPropertyOptional({ nullable: true }) resolvedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolvedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: string | null;
  /**
   * Internal admin notes. Populated for admin / counsellor / staff readers
   * with the manager-tier permission. Stripped from parent + student
   * payloads at the service layer per the row-scope contract.
   */
  @ApiPropertyOptional({ nullable: true }) adminNotes!: string | null;
  @ApiProperty({ type: [ActionResponseDto] }) actions!: ActionResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateIncidentDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description!: string;

  @ApiProperty({ description: 'YYYY-MM-DD date the incident took place.' })
  @IsDateString()
  incidentDate!: string;

  @ApiPropertyOptional({
    description: 'HH:MM or HH:MM:SS local time the incident took place.',
  })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}(:\d{2})?$/, { message: 'incidentTime must be HH:MM or HH:MM:SS' })
  incidentTime?: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  witnesses?: string | null;
}

export class ReviewIncidentDto {
  @ApiPropertyOptional({
    description:
      'Optional internal admin note appended on transition to UNDER_REVIEW. Visible to admins and counsellors only.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}

export class ResolveIncidentDto {
  @ApiPropertyOptional({
    description:
      'Optional internal admin note appended on resolution. Visible to admins and counsellors only.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}

export class ListIncidentsQueryDto {
  @ApiPropertyOptional({ enum: INCIDENT_STATUSES })
  @IsOptional()
  @IsIn(INCIDENT_STATUSES as unknown as string[])
  status?: IncidentStatus;

  @ApiPropertyOptional({ enum: SEVERITIES })
  @IsOptional()
  @IsIn(SEVERITIES as unknown as string[])
  severity?: Severity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD lower bound on incident_date.' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD upper bound on incident_date.' })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ default: 100, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : parseInt(String(value), 10)))
  @IsInt()
  @Min(1)
  limit?: number;
}
