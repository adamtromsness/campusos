import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

/*
 * scheduling-advanced-b.dto.ts — P2-17b request + response shapes.
 *
 * Covers ExamScheduling + CoTeaching + PullOut + CrossSchoolStaff +
 * CoverArrangement services.
 */

// ──────────────────────────────────────────────────────────────
// Exam scheduling
// ──────────────────────────────────────────────────────────────

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateExamSessionDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  examName!: string;

  @ApiPropertyOptional({ description: 'Soft FK to sis_courses (optional).' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiProperty({ example: '2026-06-15' })
  @IsDateString()
  examDate!: string;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(TIME_REGEX, { message: 'startTime must be HH:MM or HH:MM:SS' })
  startTime!: string;

  @ApiProperty({ example: '11:00' })
  @IsString()
  @Matches(TIME_REGEX, { message: 'endTime must be HH:MM or HH:MM:SS' })
  endTime!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @ApiPropertyOptional({
    description: 'Venue-level extension applied to every student (minutes).',
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  extraTimeMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class AddExamRoomDto {
  @ApiProperty()
  @IsUUID()
  roomId!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  capacity!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isMainRoom?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class AssignSeatDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  roomId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  seatNumber?: string;

  @ApiPropertyOptional({
    description:
      'Optional override for extra_time_minutes. When omitted the service auto-populates from sis_student_active_accommodations.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  extraTimeMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  separateRoom?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readerRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  scribeRequired?: boolean;
}

export class AssignInvigilatorDto {
  @ApiProperty()
  @IsUUID()
  roomId!: string;

  @ApiProperty()
  @IsUUID()
  invigilatorId!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isLead?: boolean;
}

export class ExamSessionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() examName!: string;
  @ApiProperty({ nullable: true }) subjectId!: string | null;
  @ApiProperty() examDate!: string;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiProperty() durationMinutes!: number;
  @ApiProperty() extraTimeMinutes!: number;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: () => [ExamRoomResponseDto] }) rooms!: ExamRoomResponseDto[];
  @ApiProperty({ type: () => [ExamSeatingResponseDto] }) seatings!: ExamSeatingResponseDto[];
  @ApiProperty({ type: () => [ExamInvigilatorResponseDto] })
  invigilators!: ExamInvigilatorResponseDto[];
}

export class ExamRoomResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() roomId!: string;
  @ApiProperty() capacity!: number;
  @ApiProperty() isMainRoom!: boolean;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class ExamSeatingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() roomId!: string;
  @ApiProperty({ nullable: true }) seatNumber!: string | null;
  @ApiProperty() extraTimeMinutes!: number;
  @ApiProperty() separateRoom!: boolean;
  @ApiProperty() readerRequired!: boolean;
  @ApiProperty() scribeRequired!: boolean;
}

export class ExamInvigilatorResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() roomId!: string;
  @ApiProperty() invigilatorId!: string;
  @ApiProperty() isLead!: boolean;
}

export class ExamRoomConflictDto {
  @ApiProperty() roomId!: string;
  @ApiProperty({ description: 'Conflicting slot or booking id.' }) conflictId!: string;
  @ApiProperty({ description: 'TIMETABLE_SLOT or ROOM_BOOKING.' }) conflictType!: string;
  @ApiProperty() conflictWindow!: string;
}

// ──────────────────────────────────────────────────────────────
// Co-teaching
// ──────────────────────────────────────────────────────────────

const TEACHING_MODELS = [
  'TEAM_TEACHING',
  'ONE_TEACH_ONE_SUPPORT',
  'STATION_ROTATION',
  'PARALLEL_TEACHING',
  'ALTERNATIVE_TEACHING',
] as const;

export class CreateCoteachingDto {
  @ApiProperty()
  @IsUUID()
  timetableSlotId!: string;

  @ApiProperty()
  @IsUUID()
  primaryTeacherId!: string;

  @ApiProperty()
  @IsUUID()
  secondaryTeacherId!: string;

  @ApiProperty({ enum: TEACHING_MODELS })
  @IsIn(TEACHING_MODELS)
  teachingModel!: (typeof TEACHING_MODELS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateCoteachingDto {
  @ApiPropertyOptional({ enum: TEACHING_MODELS })
  @IsOptional()
  @IsIn(TEACHING_MODELS)
  teachingModel?: (typeof TEACHING_MODELS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CoteachingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() timetableSlotId!: string;
  @ApiProperty() primaryTeacherId!: string;
  @ApiProperty() secondaryTeacherId!: string;
  @ApiProperty({ enum: TEACHING_MODELS }) teachingModel!: (typeof TEACHING_MODELS)[number];
  @ApiProperty({ nullable: true }) effectiveFrom!: string | null;
  @ApiProperty({ nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

// ──────────────────────────────────────────────────────────────
// Pull-out interventions
// ──────────────────────────────────────────────────────────────

const PULLOUT_FREQUENCY = ['WEEKLY', 'FORTNIGHTLY', 'DAILY', 'CUSTOM'] as const;

export class CreatePullOutDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  regularSlotId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  interventionName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  interventionProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  interventionLocation?: string;

  @ApiProperty()
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ enum: PULLOUT_FREQUENCY })
  @IsIn(PULLOUT_FREQUENCY)
  frequency!: (typeof PULLOUT_FREQUENCY)[number];

  @ApiPropertyOptional({ description: 'SMALLINT[] weekdays 0..6. Required for CUSTOM.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  daysOfWeek?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdatePullOutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: PULLOUT_FREQUENCY })
  @IsOptional()
  @IsIn(PULLOUT_FREQUENCY)
  frequency?: (typeof PULLOUT_FREQUENCY)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  daysOfWeek?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class PullOutResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() regularSlotId!: string;
  @ApiProperty() interventionName!: string;
  @ApiProperty({ nullable: true }) interventionProvider!: string | null;
  @ApiProperty({ nullable: true }) interventionLocation!: string | null;
  @ApiProperty() startDate!: string;
  @ApiProperty({ nullable: true }) endDate!: string | null;
  @ApiProperty({ enum: PULLOUT_FREQUENCY }) frequency!: (typeof PULLOUT_FREQUENCY)[number];
  @ApiProperty({ nullable: true, type: [Number] }) daysOfWeek!: number[] | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ description: 'Number of sis_attendance_records rows pre-marked PULL_OUT.' })
  attendancePremarked!: number;
}

// ──────────────────────────────────────────────────────────────
// Cross-school staff
// ──────────────────────────────────────────────────────────────

export class CreateCrossSchoolStaffDto {
  @ApiProperty()
  @IsUUID()
  visitingSchoolId!: string;

  @ApiProperty({ description: 'iam_person.id — keystone for the person-level EXCLUSION.' })
  @IsUUID()
  personId!: string;

  @ApiProperty({ description: 'hr_employees.id in the home school.' })
  @IsUUID()
  homeEmployeeId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  roleAtVisitingSchool!: string;

  @ApiProperty()
  @IsDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxPeriodsPerWeek?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateCrossSchoolStaffDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxPeriodsPerWeek?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CrossSchoolStaffResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() homeSchoolId!: string;
  @ApiProperty() visitingSchoolId!: string;
  @ApiProperty() personId!: string;
  @ApiProperty() homeEmployeeId!: string;
  @ApiProperty() roleAtVisitingSchool!: string;
  @ApiProperty() effectiveFrom!: string;
  @ApiProperty({ nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ nullable: true }) maxPeriodsPerWeek!: number | null;
  @ApiProperty({ nullable: true }) approvedBy!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

// ──────────────────────────────────────────────────────────────
// Cover arrangements
// ──────────────────────────────────────────────────────────────

const COVER_TYPES = [
  'SUBSTITUTE_REPLACEMENT',
  'INTERNAL_COVER',
  'CLASS_MERGE',
  'CLASS_SPLIT',
  'SELF_STUDY',
] as const;

const COVER_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED'] as const;

const DISPOSITIONS = [
  'COVERED_BY_SUB',
  'MERGED_INTO',
  'SPLIT_TO',
  'SELF_STUDY',
  'CANCELLED',
] as const;

export class CreateCoverArrangementDto {
  @ApiProperty()
  @IsUUID()
  absentTeacherId!: string;

  @ApiProperty()
  @IsDateString()
  coverDate!: string;

  @ApiProperty({ enum: COVER_TYPES })
  @IsIn(COVER_TYPES)
  coverType!: (typeof COVER_TYPES)[number];

  @ApiPropertyOptional({ description: 'Soft FK to sub_assignments (P2-9).' })
  @IsOptional()
  @IsUUID()
  subAssignmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  coveringTeacherId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateCoverArrangementStatusDto {
  @ApiProperty({ enum: COVER_STATUSES })
  @IsIn(COVER_STATUSES)
  status!: (typeof COVER_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class AddCoverClassDto {
  @ApiProperty()
  @IsUUID()
  affectedClassId!: string;

  @ApiProperty()
  @IsUUID()
  affectedSlotId!: string;

  @ApiProperty({ enum: DISPOSITIONS })
  @IsIn(DISPOSITIONS)
  disposition!: (typeof DISPOSITIONS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  destinationRoomId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supervisingTeacherId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CoverSplitStudentInputDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  destinationClassLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  destinationRoomId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supervisingTeacherId?: string;
}

export class AddCoverSplitStudentsDto {
  @ApiProperty({ type: [CoverSplitStudentInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  students!: CoverSplitStudentInputDto[];
}

export class CoverArrangementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() absentTeacherId!: string;
  @ApiProperty() coverDate!: string;
  @ApiProperty({ enum: COVER_TYPES }) coverType!: (typeof COVER_TYPES)[number];
  @ApiProperty({ nullable: true }) subAssignmentId!: string | null;
  @ApiProperty({ nullable: true }) coveringTeacherId!: string | null;
  @ApiProperty({ enum: COVER_STATUSES }) status!: (typeof COVER_STATUSES)[number];
  @ApiProperty({ nullable: true }) completedAt!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: () => [CoverArrangementClassResponseDto] })
  classes!: CoverArrangementClassResponseDto[];
}

export class CoverArrangementClassResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() arrangementId!: string;
  @ApiProperty() affectedClassId!: string;
  @ApiProperty() affectedSlotId!: string;
  @ApiProperty({ enum: DISPOSITIONS }) disposition!: (typeof DISPOSITIONS)[number];
  @ApiProperty({ nullable: true }) destinationRoomId!: string | null;
  @ApiProperty({ nullable: true }) supervisingTeacherId!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: () => [CoverSplitStudentResponseDto] })
  splitStudents!: CoverSplitStudentResponseDto[];
}

export class CoverSplitStudentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() arrangementClassId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty({ nullable: true }) destinationClassLabel!: string | null;
  @ApiProperty({ nullable: true }) destinationRoomId!: string | null;
  @ApiProperty({ nullable: true }) supervisingTeacherId!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}
