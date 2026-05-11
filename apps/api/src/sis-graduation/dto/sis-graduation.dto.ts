import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ─── Enum const arrays ───

export const GRADUATION_REQUIREMENT_TYPES = [
  'CREDIT_TOTAL',
  'SUBJECT_CREDIT',
  'SPECIFIC_COURSE',
  'SERVICE_HOURS',
  'ASSESSMENT',
  'MINIMUM_GPA',
] as const;
export type GraduationRequirementType = (typeof GRADUATION_REQUIREMENT_TYPES)[number];

export const GRADUATION_AUDIT_STATUSES = ['MET', 'IN_PROGRESS', 'NOT_MET'] as const;
export type GraduationAuditStatus = (typeof GRADUATION_AUDIT_STATUSES)[number];

export const SERVICE_LEARNING_DEADLINE_TYPES = [
  'END_OF_YEAR',
  'BEFORE_GRADUATION',
  'SPECIFIC_DATE',
] as const;
export type ServiceLearningDeadlineType = (typeof SERVICE_LEARNING_DEADLINE_TYPES)[number];

export const SERVICE_HOURS_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ServiceHoursStatus = (typeof SERVICE_HOURS_STATUSES)[number];

export const GPA_CALCULATION_METHODS = ['UNWEIGHTED', 'WEIGHTED', 'SUBJECT_AREA'] as const;
export type GpaCalculationMethod = (typeof GPA_CALCULATION_METHODS)[number];

export const GPA_SCALE_TYPES = ['FOUR_POINT', 'HUNDRED_POINT'] as const;
export type GpaScaleType = (typeof GPA_SCALE_TYPES)[number];

// ─── Graduation Requirements ───

export class CreateGraduationRequirementDto {
  @ApiProperty({ enum: GRADUATION_REQUIREMENT_TYPES })
  @IsIn(GRADUATION_REQUIREMENT_TYPES as unknown as string[])
  requirementType!: GraduationRequirementType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  requirementName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subjectArea?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  creditsRequired?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  specificCourseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  hoursRequired?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  assessmentName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  minimumGpa?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  appliesToGradeLevels?: string[];
}

export class UpdateGraduationRequirementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requirementName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subjectArea?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  creditsRequired?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  specificCourseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  hoursRequired?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  assessmentName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  minimumGpa?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  appliesToGradeLevels?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class GraduationRequirementDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: GRADUATION_REQUIREMENT_TYPES }) requirementType!: GraduationRequirementType;
  @ApiProperty() requirementName!: string;
  @ApiPropertyOptional() subjectArea!: string | null;
  @ApiPropertyOptional() creditsRequired!: number | null;
  @ApiPropertyOptional() specificCourseId!: string | null;
  @ApiPropertyOptional() hoursRequired!: number | null;
  @ApiPropertyOptional() assessmentName!: string | null;
  @ApiPropertyOptional() minimumGpa!: number | null;
  @ApiProperty({ type: [String] }) appliesToGradeLevels!: string[];
  @ApiProperty() isActive!: boolean;
}

// ─── Graduation Audits ───

export class GraduationAuditDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() requirementId!: string;
  @ApiProperty({ enum: GRADUATION_AUDIT_STATUSES }) status!: GraduationAuditStatus;
  @ApiPropertyOptional() creditsEarned!: number | null;
  @ApiPropertyOptional() creditsRemaining!: number | null;
  @ApiPropertyOptional() detail!: string | null;
  @ApiProperty() lastCalculated!: string;
}

export class GraduationAuditSummaryDto {
  @ApiProperty() studentId!: string;
  @ApiProperty({ type: [GraduationAuditDto] }) audits!: GraduationAuditDto[];
  @ApiProperty() metCount!: number;
  @ApiProperty() inProgressCount!: number;
  @ApiProperty() notMetCount!: number;
  @ApiProperty() isAtRisk!: boolean;
}

// ─── Service Learning ───

export class CreateServiceLearningRequirementDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  gradeLevel!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(500)
  requiredHours!: number;

  @ApiProperty({ enum: SERVICE_LEARNING_DEADLINE_TYPES })
  @IsIn(SERVICE_LEARNING_DEADLINE_TYPES as unknown as string[])
  deadlineType!: ServiceLearningDeadlineType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  specificDeadline?: string;
}

export class ServiceLearningRequirementDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() gradeLevel!: string;
  @ApiProperty() requiredHours!: number;
  @ApiProperty({ enum: SERVICE_LEARNING_DEADLINE_TYPES })
  deadlineType!: ServiceLearningDeadlineType;
  @ApiPropertyOptional() specificDeadline!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class SubmitServiceLearningHoursDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  organisationName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  activityDescription!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0.25)
  @Max(24)
  hours!: number;

  @ApiProperty()
  @IsString()
  serviceDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supervisorName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supervisorContact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  evidenceS3Key?: string;
}

export class ReviewServiceLearningHoursDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNotes?: string;
}

export class ServiceLearningHoursDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() organisationName!: string;
  @ApiProperty() activityDescription!: string;
  @ApiProperty() hours!: number;
  @ApiProperty() serviceDate!: string;
  @ApiPropertyOptional() supervisorName!: string | null;
  @ApiPropertyOptional() supervisorContact!: string | null;
  @ApiPropertyOptional() evidenceS3Key!: string | null;
  @ApiProperty({ enum: SERVICE_HOURS_STATUSES }) status!: ServiceHoursStatus;
  @ApiPropertyOptional() reviewedBy!: string | null;
  @ApiPropertyOptional() reviewedAt!: string | null;
  @ApiPropertyOptional() reviewNotes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ServiceLearningProgressDto {
  @ApiProperty() studentId!: string;
  @ApiProperty() gradeLevel!: string;
  @ApiProperty() approvedHours!: number;
  @ApiProperty() pendingHours!: number;
  @ApiProperty() requiredHours!: number;
  @ApiProperty() remainingHours!: number;
}

// ─── GPA Configurations ───

export class CreateGpaConfigDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  configName!: string;

  @ApiProperty({ enum: GPA_CALCULATION_METHODS })
  @IsIn(GPA_CALCULATION_METHODS as unknown as string[])
  calculationMethod!: GpaCalculationMethod;

  @ApiProperty({ enum: GPA_SCALE_TYPES })
  @IsIn(GPA_SCALE_TYPES as unknown as string[])
  scaleType!: GpaScaleType;

  @ApiProperty()
  @IsObject()
  gradePointMapping!: Record<string, number>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  honorsWeightBonus?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  apWeightBonus?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateGpaConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  configName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  gradePointMapping?: Record<string, number>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  honorsWeightBonus?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  apWeightBonus?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class GpaConfigDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() configName!: string;
  @ApiProperty({ enum: GPA_CALCULATION_METHODS })
  calculationMethod!: GpaCalculationMethod;
  @ApiProperty({ enum: GPA_SCALE_TYPES }) scaleType!: GpaScaleType;
  @ApiProperty() gradePointMapping!: Record<string, number>;
  @ApiProperty() honorsWeightBonus!: number;
  @ApiProperty() apWeightBonus!: number;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() isActive!: boolean;
}

export class GpaSnapshotDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() gpaConfigId!: string;
  @ApiPropertyOptional() academicYearId!: string | null;
  @ApiPropertyOptional() termId!: string | null;
  @ApiPropertyOptional() cumulativeGpa!: number | null;
  @ApiPropertyOptional() termGpa!: number | null;
  @ApiPropertyOptional() totalCreditsAttempted!: number | null;
  @ApiPropertyOptional() totalCreditsEarned!: number | null;
  @ApiPropertyOptional() classRank!: number | null;
  @ApiPropertyOptional() classSize!: number | null;
  @ApiProperty() calculatedAt!: string;
}

// ─── Course Prerequisites ───

export class CreateCoursePrerequisiteDto {
  @ApiProperty()
  @IsUUID()
  courseId!: string;

  @ApiProperty()
  @IsUUID()
  prerequisiteCourseId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  minGrade?: string;
}

export class CoursePrerequisiteDto {
  @ApiProperty() id!: string;
  @ApiProperty() courseId!: string;
  @ApiProperty() prerequisiteCourseId!: string;
  @ApiProperty() isMandatory!: boolean;
  @ApiPropertyOptional() minGrade!: string | null;
  @ApiPropertyOptional() prerequisiteCourseCode!: string | null;
  @ApiPropertyOptional() prerequisiteCourseName!: string | null;
}

export class ValidateCourseRegistrationDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  courseId!: string;
}

export class ValidateCourseRegistrationResponseDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({ type: [String] }) unmetPrerequisites!: string[];
  @ApiProperty({ type: [String] }) warnings!: string[];
}

// ─── Grade Scale Entries ───

export class CreateGradeScaleEntryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  scaleName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  letterGrade!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  minPercentage?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxPercentage?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  gradePoints?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPassing?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class GradeScaleEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() scaleName!: string;
  @ApiProperty() letterGrade!: string;
  @ApiPropertyOptional() minPercentage!: number | null;
  @ApiPropertyOptional() maxPercentage!: number | null;
  @ApiPropertyOptional() gradePoints!: number | null;
  @ApiProperty() isPassing!: boolean;
  @ApiProperty() sortOrder!: number;
}
