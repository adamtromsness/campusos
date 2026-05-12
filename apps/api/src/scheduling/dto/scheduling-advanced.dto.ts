import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/*
 * Scheduling Advanced DTOs (P2-17a).
 *
 * Covers Rotation cycles + calendar, Scheduling constraints, Subject
 * choices + windows, Scheduling requests + candidates + slots +
 * activation log, plus the small extension on the existing
 * sch_room_change_requests surface.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Rotation cycles
// ─────────────────────────────────────────────────────────────────────────────

export class RotationCycleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() cycleLength!: number;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
}

export class CreateRotationCycleDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ minimum: 1, maximum: 14 })
  @IsInt()
  @Min(1)
  @Max(14)
  cycleLength!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateRotationCycleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class RotationCalendarEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() rotationCycleId!: string;
  @ApiProperty() calendarDate!: string;
  @ApiProperty() rotationDay!: number;
  @ApiProperty() isSchoolDay!: boolean;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class UpsertRotationCalendarDto {
  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  calendarDate!: string;

  @ApiProperty({ minimum: 1, maximum: 14 })
  @IsInt()
  @Min(1)
  @Max(14)
  rotationDay!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isSchoolDay?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class GenerateCalendarDto {
  @ApiProperty({ description: 'ISO date YYYY-MM-DD — first date in the cycle.' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD — last date in the cycle.' })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'ISO date YYYY-MM-DD list of dates to skip (closures, holidays).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsDateString({}, { each: true })
  closureDates?: string[];
}

export class RotationDayLookupDto {
  @ApiProperty() date!: string;
  @ApiProperty() rotationCycleId!: string;
  @ApiProperty() rotationDay!: number;
  @ApiProperty() isSchoolDay!: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling constraints
// ─────────────────────────────────────────────────────────────────────────────

export class SchedulingConstraintsResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() hardConstraints!: unknown[];
  @ApiProperty() softConstraints!: unknown[];
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
}

export class CreateSchedulingConstraintsDto {
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiProperty({ type: 'array' })
  @IsArray()
  hardConstraints!: unknown[];

  @ApiProperty({ type: 'array' })
  @IsArray()
  softConstraints!: unknown[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject choices + windows
// ─────────────────────────────────────────────────────────────────────────────

export class SubjectChoiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() courseId!: string;
  @ApiPropertyOptional({ nullable: true }) courseName!: string | null;
  @ApiPropertyOptional({ nullable: true }) preferenceRank!: number | null;
  @ApiProperty() isRequired!: boolean;
  @ApiPropertyOptional({ nullable: true }) submittedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class SubmitSubjectChoiceDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty()
  @IsUUID()
  courseId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  preferenceRank?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SubjectChoiceDemandRowDto {
  @ApiProperty() courseId!: string;
  @ApiProperty() courseName!: string;
  @ApiProperty() totalStudents!: number;
  @ApiProperty() requiredCount!: number;
  @ApiProperty() rankedFirstCount!: number;
}

export class SubjectChoiceWindowResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiPropertyOptional({ nullable: true }) name!: string | null;
  @ApiProperty() opensAt!: string;
  @ApiProperty() closesAt!: string;
  @ApiPropertyOptional({ type: [String], nullable: true })
  targetGradeLevels!: string[] | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
}

export class CreateSubjectChoiceWindowDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty()
  @IsISO8601()
  opensAt!: string;

  @ApiProperty()
  @IsISO8601()
  closesAt!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  targetGradeLevels?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling requests + candidates + slots
// ─────────────────────────────────────────────────────────────────────────────

export class SchedulingRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiProperty() constraintId!: string;
  @ApiProperty() sectionCountAtSubmission!: number;
  @ApiProperty() solverAlgorithm!: 'CP_SAT' | 'HEURISTIC';
  @ApiProperty() status!: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  @ApiProperty() requestedBy!: string;
  @ApiPropertyOptional({ nullable: true }) candidatesGenerated!: number | null;
  @ApiProperty() queuedAt!: string;
  @ApiPropertyOptional({ nullable: true }) startedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) errorMessage!: string | null;
  @ApiPropertyOptional({ type: [Object], nullable: true })
  candidates?: SchedulingCandidateResponseDto[] | null;
}

export class CreateSchedulingRequestDto {
  @ApiProperty()
  @IsUUID()
  constraintId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({
    description:
      'Manual override for the section count (used by ADR-060 to pick the solver). When omitted the service counts sis_classes for the current academic year.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sectionCount?: number;

  @ApiPropertyOptional({
    description:
      'Override the ADR-060 default solver algorithm. CP_SAT requires sectionCount ≤ 300; HEURISTIC accepts any size.',
    enum: ['CP_SAT', 'HEURISTIC'],
  })
  @IsOptional()
  @IsIn(['CP_SAT', 'HEURISTIC'])
  solverAlgorithm?: 'CP_SAT' | 'HEURISTIC';
}

export class SchedulingCandidateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() requestId!: string;
  @ApiPropertyOptional({ nullable: true }) candidateName!: string | null;
  @ApiPropertyOptional({ nullable: true }) solverSeed!: string | null;
  @ApiProperty() totalSlots!: number;
  @ApiProperty() totalClashes!: number;
  @ApiProperty() allConstraintsSatisfied!: boolean;
  @ApiProperty({ type: 'array' }) constraintViolations!: unknown[];
  @ApiPropertyOptional({ nullable: true }) softConstraintScore!: number | null;
  @ApiProperty() reviewStatus!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED';
  @ApiPropertyOptional({ nullable: true }) reviewedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewNotes!: string | null;
}

export class CandidateSlotResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() candidateId!: string;
  @ApiPropertyOptional({ nullable: true }) classId!: string | null;
  @ApiPropertyOptional({ nullable: true }) teacherId!: string | null;
  @ApiPropertyOptional({ nullable: true }) roomId!: string | null;
  @ApiPropertyOptional({ nullable: true }) periodId!: string | null;
  @ApiPropertyOptional({ nullable: true }) dayOfWeek!: number | null;
  @ApiPropertyOptional({ nullable: true }) rotationDay!: number | null;
  @ApiProperty() hasClash!: boolean;
  @ApiPropertyOptional({ nullable: true }) clashDescription!: string | null;
}

export class ReviewCandidateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNotes?: string;
}

export class ResolveClashDto {
  @ApiProperty()
  @IsUUID()
  slotId!: string;

  @ApiPropertyOptional({
    description:
      'New clash_description. Omit to clear the clash flag (sets has_clash=false and clash_description=NULL).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  clashDescription?: string;
}

export class ActivationLogResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() candidateId!: string;
  @ApiProperty() slotsPromoted!: number;
  @ApiProperty() slotsSkipped!: number;
  @ApiProperty() activatedBy!: string;
  @ApiProperty() activatedAt!: string;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class ActivateCandidateResponseDto {
  @ApiProperty() candidateId!: string;
  @ApiProperty() slotsPromoted!: number;
  @ApiProperty() slotsSkipped!: number;
  @ApiProperty() activationLogId!: string;
}
