import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/* Cycle 10 Step 5 — Health Records DTO module.
 *
 * Strict class-validator decorators on every input field. The output
 * DTOs (HealthRecordResponseDto + ConditionResponseDto +
 * ImmunisationResponseDto) carry the subset of fields the row-scope
 * filter has already approved for this caller. Field-stripping is
 * the responsibility of the service layer — this file only declares
 * the wire shapes.
 */

export const ConditionSeverity = ['MILD', 'MODERATE', 'SEVERE'] as const;
export type ConditionSeverity = (typeof ConditionSeverity)[number];

export const ImmunisationStatus = ['CURRENT', 'OVERDUE', 'WAIVED'] as const;
export type ImmunisationStatus = (typeof ImmunisationStatus)[number];

export const HealthAccessType = [
  'VIEW_RECORD',
  'VIEW_CONDITIONS',
  'VIEW_IMMUNISATIONS',
  'VIEW_MEDICATIONS',
  'VIEW_VISITS',
  'VIEW_IEP',
  'VIEW_SCREENING',
  'VIEW_DIETARY',
  'EXPORT',
] as const;
export type HealthAccessType = (typeof HealthAccessType)[number];

// ── Allergy entry inside the JSONB column ───────────────────────

export class AllergyEntryDto {
  @ApiProperty()
  @IsString()
  @Length(1, 100)
  allergen!: string;

  @ApiProperty({ enum: ConditionSeverity })
  @IsIn(ConditionSeverity as unknown as string[])
  severity!: ConditionSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reaction?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

// ── Health record write payloads ────────────────────────────────

export class CreateHealthRecordDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  bloodType?: string | null;

  @ApiPropertyOptional({ type: [AllergyEntryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AllergyEntryDto)
  allergies?: AllergyEntryDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emergencyMedicalNotes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  physicianName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  physicianPhone?: string | null;
}

export class UpdateHealthRecordDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  bloodType?: string | null;

  @ApiPropertyOptional({ type: [AllergyEntryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AllergyEntryDto)
  allergies?: AllergyEntryDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  emergencyMedicalNotes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  physicianName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  physicianPhone?: string | null;
}

// ── Condition write payloads ────────────────────────────────────

export class CreateConditionDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  conditionName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  diagnosisDate?: string | null;

  @ApiProperty({ enum: ConditionSeverity })
  @IsIn(ConditionSeverity as unknown as string[])
  severity!: ConditionSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  managementPlan?: string | null;
}

export class UpdateConditionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  conditionName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  diagnosisDate?: string | null;

  @ApiPropertyOptional({ enum: ConditionSeverity })
  @IsOptional()
  @IsIn(ConditionSeverity as unknown as string[])
  severity?: ConditionSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  managementPlan?: string | null;
}

// ── Immunisation write payloads ─────────────────────────────────

export class CreateImmunisationDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  vaccineName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  administeredDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  administeredBy?: string | null;

  @ApiProperty({ enum: ImmunisationStatus })
  @IsIn(ImmunisationStatus as unknown as string[])
  status!: ImmunisationStatus;
}

export class UpdateImmunisationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  vaccineName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  administeredDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  administeredBy?: string | null;

  @ApiPropertyOptional({ enum: ImmunisationStatus })
  @IsOptional()
  @IsIn(ImmunisationStatus as unknown as string[])
  status?: ImmunisationStatus;
}

// ── Access log query ────────────────────────────────────────────

export class ListAccessLogQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  studentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accessedBy?: string;

  @ApiPropertyOptional({ enum: HealthAccessType })
  @IsOptional()
  @IsIn(HealthAccessType as unknown as string[])
  accessType?: HealthAccessType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

// ── Response DTOs ───────────────────────────────────────────────

export class ConditionResponseDto {
  id!: string;
  healthRecordId!: string;
  conditionName!: string;
  diagnosisDate!: string | null;
  isActive!: boolean;
  severity!: ConditionSeverity;
  /** Stripped to null for non-managers (teacher / parent / student). */
  managementPlan!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class ImmunisationResponseDto {
  id!: string;
  healthRecordId!: string;
  vaccineName!: string;
  administeredDate!: string | null;
  dueDate!: string | null;
  administeredBy!: string | null;
  status!: ImmunisationStatus;
  createdAt!: string;
  updatedAt!: string;
}

export class HealthRecordResponseDto {
  id!: string;
  schoolId!: string;
  studentId!: string;
  studentFirstName!: string | null;
  studentLastName!: string | null;
  bloodType!: string | null;
  /** Allergy reaction + notes are stripped for non-manager non-parent
   *  callers (i.e. teachers see allergen + severity only). */
  allergies!: AllergyEntryDto[];
  /** Stripped to null for non-managers; kept for parent and admin. */
  emergencyMedicalNotes!: string | null;
  /** Physician contact stripped for teachers (classroom-irrelevant). */
  physicianName!: string | null;
  physicianPhone!: string | null;
  /** Inlined for the GET /:studentId full endpoint. */
  conditions!: ConditionResponseDto[];
  /** Inlined for the GET /:studentId full endpoint. Empty array for
   *  teachers since immunisations are not classroom-relevant. */
  immunisations!: ImmunisationResponseDto[];
  createdAt!: string;
  updatedAt!: string;
}

export class ImmunisationComplianceRowDto {
  vaccineName!: string;
  totalRows!: number;
  currentCount!: number;
  overdueCount!: number;
  waivedCount!: number;
}

export class HealthAccessLogRowDto {
  id!: string;
  schoolId!: string;
  accessedById!: string;
  accessedByName!: string | null;
  accessedByEmail!: string | null;
  studentId!: string;
  studentName!: string | null;
  accessType!: HealthAccessType;
  ipAddress!: string | null;
  accessedAt!: string;
}

// Used by Step 6 + Step 7 services that call HealthAccessLogService.recordAccess
// directly without going through a controller.
export interface RecordAccessInput {
  studentId: string;
  accessType: HealthAccessType;
  ipAddress?: string | null;
}
