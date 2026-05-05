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
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ─── Const enum mirrors ────────────────────────────────────────

export const PRIMARY_CONCERNS = [
  'ACADEMIC',
  'BEHAVIORAL',
  'SOCIAL_EMOTIONAL',
  'ATTENDANCE',
  'CRISIS',
  'TRANSITION',
  'GENERAL',
] as const;
export type PrimaryConcern = (typeof PRIMARY_CONCERNS)[number];

export const CASELOAD_STATUSES = ['ACTIVE', 'CLOSED', 'TRANSFERRED'] as const;
export type CaseloadStatus = (typeof CASELOAD_STATUSES)[number];

export const REFERRAL_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type ReferralPriority = (typeof REFERRAL_PRIORITIES)[number];

export const REFERRAL_STATUSES = [
  'SUBMITTED',
  'TRIAGED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const ACTIVITY_TYPES = [
  'STATUS_CHANGE',
  'ASSIGNMENT_CHANGE',
  'NOTE_ADDED',
  'PARENT_NOTIFIED',
  'ESCALATED',
  'EXTERNAL_CONTACT_MADE',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// ─── Caseload DTOs ────────────────────────────────────────────

export class CaseloadResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() counselorId!: string;
  @ApiPropertyOptional({ nullable: true }) counselorName!: string | null;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentGradeLevel!: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiPropertyOptional({ nullable: true }) academicYearName!: string | null;
  @ApiProperty({ enum: PRIMARY_CONCERNS }) primaryConcern!: PrimaryConcern;
  @ApiProperty() isPrimaryCounselor!: boolean;
  @ApiProperty({ enum: CASELOAD_STATUSES }) status!: CaseloadStatus;
  @ApiProperty() openedAt!: string;
  @ApiPropertyOptional({ nullable: true }) closedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) closureReason!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Inlined for getById only' })
  sessionCount?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Inlined for getById only' })
  lastSessionDate?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Inlined for getById only' })
  linkedBipId?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateCaseloadDto {
  @ApiProperty()
  @IsUUID()
  counselorId!: string;

  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty({ enum: PRIMARY_CONCERNS })
  @IsIn(PRIMARY_CONCERNS as unknown as string[])
  primaryConcern!: PrimaryConcern;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isPrimaryCounselor?: boolean;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  openedAt!: string;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

  @ApiPropertyOptional({
    description:
      'When set, links this caseload to an originating referral and transitions it to IN_PROGRESS',
  })
  @IsOptional()
  @IsUUID()
  fromReferralId?: string;
}

export class UpdateCaseloadDto {
  @ApiPropertyOptional({ enum: PRIMARY_CONCERNS })
  @IsOptional()
  @IsIn(PRIMARY_CONCERNS as unknown as string[])
  primaryConcern?: PrimaryConcern;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class CloseCaseloadDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  closureReason!: string;
}

export class ListCaseloadsQueryDto {
  @ApiPropertyOptional({ enum: CASELOAD_STATUSES })
  @IsOptional()
  @IsIn(CASELOAD_STATUSES as unknown as string[])
  status?: CaseloadStatus;

  @ApiPropertyOptional({ enum: PRIMARY_CONCERNS })
  @IsOptional()
  @IsIn(PRIMARY_CONCERNS as unknown as string[])
  concern?: PrimaryConcern;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  counselorId?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}

// ─── Referral type DTOs ───────────────────────────────────────

export class ReferralTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: REFERRAL_PRIORITIES }) defaultPriority!: ReferralPriority;
  @ApiProperty() requiresParentNotification!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateReferralTypeDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiProperty({ enum: REFERRAL_PRIORITIES })
  @IsIn(REFERRAL_PRIORITIES as unknown as string[])
  defaultPriority!: ReferralPriority;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresParentNotification?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateReferralTypeDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ enum: REFERRAL_PRIORITIES })
  @IsOptional()
  @IsIn(REFERRAL_PRIORITIES as unknown as string[])
  defaultPriority?: ReferralPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresParentNotification?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Referral DTOs ────────────────────────────────────────────

export class ReferralActivityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() referralId!: string;
  @ApiProperty() actorId!: string;
  @ApiPropertyOptional({ nullable: true }) actorName!: string | null;
  @ApiProperty({ enum: ACTIVITY_TYPES }) activityType!: ActivityType;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ReferralResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentGradeLevel!: string | null;
  @ApiProperty() referredById!: string;
  @ApiPropertyOptional({ nullable: true }) referredByName!: string | null;
  @ApiProperty() referralTypeId!: string;
  @ApiPropertyOptional({ nullable: true }) referralTypeName!: string | null;
  @ApiProperty() requiresParentNotification!: boolean;
  @ApiPropertyOptional({ nullable: true }) assignedCounselorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedCounselorName!: string | null;
  @ApiProperty({ enum: REFERRAL_PRIORITIES }) priority!: ReferralPriority;
  @ApiProperty({ enum: REFERRAL_STATUSES }) status!: ReferralStatus;
  @ApiProperty() reason!: string;
  @ApiProperty() parentNotified!: boolean;
  @ApiPropertyOptional({ nullable: true }) parentNotifiedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) outcome!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({
    description: 'Inlined for getById only',
    type: [ReferralActivityResponseDto],
  })
  activity?: ReferralActivityResponseDto[];
}

export class CreateReferralDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  referralTypeId!: string;

  @ApiProperty({ minLength: 10, maxLength: 4000 })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  reason!: string;

  @ApiPropertyOptional({
    enum: REFERRAL_PRIORITIES,
    description: "Optional override; defaults to the referral_type's default_priority.",
  })
  @IsOptional()
  @IsIn(REFERRAL_PRIORITIES as unknown as string[])
  priority?: ReferralPriority;
}

export class TriageReferralDto {
  @ApiProperty()
  @IsUUID()
  assignedCounselorId!: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class AcceptReferralDto {
  @ApiPropertyOptional({
    description:
      'When true, automatically open a caseload for the student under the assigned counsellor.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  openCaseload?: boolean;

  @ApiPropertyOptional({
    enum: PRIMARY_CONCERNS,
    description: 'Required when openCaseload=true. Inferred from referral when omitted.',
  })
  @IsOptional()
  @IsIn(PRIMARY_CONCERNS as unknown as string[])
  caseloadConcern?: PrimaryConcern;

  @ApiPropertyOptional({ description: 'Required when openCaseload=true.' })
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class CompleteReferralDto {
  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  outcome!: string;
}

export class DeclineReferralDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

export class ListReferralsQueryDto {
  @ApiPropertyOptional({ enum: REFERRAL_STATUSES })
  @IsOptional()
  @IsIn(REFERRAL_STATUSES as unknown as string[])
  status?: ReferralStatus;

  @ApiPropertyOptional({ enum: REFERRAL_PRIORITIES })
  @IsOptional()
  @IsIn(REFERRAL_PRIORITIES as unknown as string[])
  priority?: ReferralPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  referralTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedCounselorId?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}

// ─── Session enum mirrors ─────────────────────────────────────

export const SESSION_TYPES = [
  'INDIVIDUAL',
  'GROUP',
  'CRISIS',
  'CHECK_IN',
  'PARENT_MEETING',
  'CONSULTATION',
] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_STATUSES = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['ATTENDED', 'NO_SHOW', 'LATE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

// ─── Session DTOs ─────────────────────────────────────────────

export class SessionParticipantResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiPropertyOptional({ nullable: true }) caseloadId!: string | null;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) attendanceStatus!: AttendanceStatus;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class SessionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() counselorId!: string;
  @ApiPropertyOptional({ nullable: true }) counselorName!: string | null;
  @ApiProperty() sessionDate!: string;
  @ApiPropertyOptional({ nullable: true }) durationMinutes!: number | null;
  @ApiProperty({ enum: SESSION_TYPES }) sessionType!: SessionType;
  @ApiPropertyOptional({ nullable: true }) primaryCaseloadId!: string | null;
  @ApiPropertyOptional({ nullable: true }) primaryStudentId!: string | null;
  @ApiPropertyOptional({ nullable: true }) primaryStudentName!: string | null;
  @ApiPropertyOptional({ nullable: true }) referralId!: string | null;
  @ApiProperty({ enum: SESSION_STATUSES }) status!: SessionStatus;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({
    description: 'Inlined for getById only',
    type: [SessionParticipantResponseDto],
  })
  participants?: SessionParticipantResponseDto[];
}

export class CreateSessionDto {
  @ApiProperty()
  @IsUUID()
  counselorId!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  sessionDate!: string;

  @ApiPropertyOptional({ description: 'Minutes; > 0' })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiProperty({ enum: SESSION_TYPES })
  @IsIn(SESSION_TYPES as unknown as string[])
  sessionType!: SessionType;

  @ApiPropertyOptional({
    description:
      'Required for INDIVIDUAL sessions to identify the student. Must be NULL for GROUP sessions.',
  })
  @IsOptional()
  @IsUUID()
  primaryCaseloadId?: string | null;

  @ApiPropertyOptional({ description: 'Optional link to the originating referral.' })
  @IsOptional()
  @IsUUID()
  referralId?: string | null;

  @ApiPropertyOptional({ enum: SESSION_STATUSES, default: 'SCHEDULED' })
  @IsOptional()
  @IsIn(SESSION_STATUSES as unknown as string[])
  status?: SessionStatus;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class UpdateSessionDto {
  @ApiPropertyOptional({ enum: SESSION_STATUSES })
  @IsOptional()
  @IsIn(SESSION_STATUSES as unknown as string[])
  status?: SessionStatus;

  @ApiPropertyOptional({ description: 'Minutes; > 0' })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional({ enum: SESSION_TYPES })
  @IsOptional()
  @IsIn(SESSION_TYPES as unknown as string[])
  sessionType?: SessionType;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class AddParticipantDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  caseloadId?: string | null;

  @ApiPropertyOptional({ enum: ATTENDANCE_STATUSES, default: 'ATTENDED' })
  @IsOptional()
  @IsIn(ATTENDANCE_STATUSES as unknown as string[])
  attendanceStatus?: AttendanceStatus;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class MarkAttendanceDto {
  @ApiProperty({ enum: ATTENDANCE_STATUSES })
  @IsIn(ATTENDANCE_STATUSES as unknown as string[])
  attendanceStatus!: AttendanceStatus;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class ListSessionsQueryDto {
  @ApiPropertyOptional({ enum: SESSION_STATUSES })
  @IsOptional()
  @IsIn(SESSION_STATUSES as unknown as string[])
  status?: SessionStatus;

  @ApiPropertyOptional({ enum: SESSION_TYPES })
  @IsOptional()
  @IsIn(SESSION_TYPES as unknown as string[])
  sessionType?: SessionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  caseloadId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  counselorId?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}

// ─── Session Note DTOs (FERPA-protected) ──────────────────────

export class SessionNoteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiProperty() notesText!: string;
  @ApiPropertyOptional({ type: [String], nullable: true })
  goalsAddressed!: string[] | null;
  @ApiProperty() followUpRequired!: boolean;
  @ApiPropertyOptional({ nullable: true }) followUpNotes!: string | null;
  @ApiProperty() isLocked!: boolean;
  @ApiPropertyOptional({ nullable: true }) lockedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) lockedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) lockedByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateSessionNoteDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ minLength: 1, maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  notesText!: string;

  @ApiPropertyOptional({ type: [String], description: 'Optional goals_addressed array' })
  @IsOptional()
  @IsString({ each: true })
  goalsAddressed?: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  followUpNotes?: string | null;
}

export class UpdateSessionNoteDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 8000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  notesText?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  goalsAddressed?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  followUpNotes?: string | null;
}

// ─── MTSS / RTI enum mirrors ──────────────────────────────────

export const MTSS_TIERS = ['TIER_1', 'TIER_2', 'TIER_3'] as const;
export type MtssTier = (typeof MTSS_TIERS)[number];

export const MTSS_DOMAINS = ['ACADEMIC', 'BEHAVIORAL', 'SOCIAL_EMOTIONAL', 'ATTENDANCE'] as const;
export type MtssDomain = (typeof MTSS_DOMAINS)[number];

export const MTSS_TIER_STATUSES = ['ACTIVE', 'EXITED', 'PROMOTED', 'DEMOTED'] as const;
export type MtssTierStatus = (typeof MTSS_TIER_STATUSES)[number];

export const INTERVENTION_TYPES = [
  'ACADEMIC_SUPPORT',
  'BEHAVIORAL_SUPPORT',
  'SOCIAL_EMOTIONAL_LEARNING',
  'ATTENDANCE_SUPPORT',
  'COUNSELING',
  'EXTERNAL_SERVICE',
] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

export const INTERVENTION_STATUSES = ['ACTIVE', 'COMPLETED', 'DISCONTINUED'] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

export const MEETING_OUTCOMES = [
  'NO_CHANGE',
  'TIER_UP',
  'TIER_DOWN',
  'EXIT',
  'CONTINUE_WITH_ADJUSTMENT',
] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

// ─── MTSS Tier DTOs ───────────────────────────────────────────

export class MtssTierResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiPropertyOptional({ nullable: true }) academicYearName!: string | null;
  @ApiProperty({ enum: MTSS_TIERS }) tier!: MtssTier;
  @ApiProperty({ enum: MTSS_DOMAINS }) domain!: MtssDomain;
  @ApiProperty() assignedById!: string;
  @ApiPropertyOptional({ nullable: true }) assignedByName!: string | null;
  @ApiProperty() assignedAt!: string;
  @ApiProperty() reviewDate!: string;
  @ApiPropertyOptional({ nullable: true }) exitDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) exitReason!: string | null;
  @ApiProperty({ enum: MTSS_TIER_STATUSES }) status!: MtssTierStatus;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateMtssTierDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty({ enum: MTSS_TIERS })
  @IsIn(MTSS_TIERS as unknown as string[])
  tier!: MtssTier;

  @ApiProperty({ enum: MTSS_DOMAINS })
  @IsIn(MTSS_DOMAINS as unknown as string[])
  domain!: MtssDomain;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  assignedAt!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  reviewDate!: string;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class UpdateMtssTierDto {
  @ApiPropertyOptional({ enum: MTSS_TIERS })
  @IsOptional()
  @IsIn(MTSS_TIERS as unknown as string[])
  tier?: MtssTier;

  @ApiPropertyOptional({ enum: MTSS_TIER_STATUSES })
  @IsOptional()
  @IsIn(MTSS_TIER_STATUSES as unknown as string[])
  status?: MtssTierStatus;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  reviewDate?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  exitDate?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  exitReason?: string | null;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class ListMtssTiersQueryDto {
  @ApiPropertyOptional({ enum: MTSS_TIERS })
  @IsOptional()
  @IsIn(MTSS_TIERS as unknown as string[])
  tier?: MtssTier;

  @ApiPropertyOptional({ enum: MTSS_DOMAINS })
  @IsOptional()
  @IsIn(MTSS_DOMAINS as unknown as string[])
  domain?: MtssDomain;

  @ApiPropertyOptional({ enum: MTSS_TIER_STATUSES })
  @IsOptional()
  @IsIn(MTSS_TIER_STATUSES as unknown as string[])
  status?: MtssTierStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}

export class MtssDashboardCellDto {
  @ApiProperty({ enum: MTSS_TIERS }) tier!: MtssTier;
  @ApiProperty({ enum: MTSS_DOMAINS }) domain!: MtssDomain;
  @ApiProperty() count!: number;
}

export class MtssDashboardDto {
  @ApiProperty({ type: [MtssDashboardCellDto] }) cells!: MtssDashboardCellDto[];
  @ApiProperty() totalActive!: number;
}

// ─── Intervention DTOs ────────────────────────────────────────

export class InterventionProgressEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() interventionId!: string;
  @ApiProperty() recordedById!: string;
  @ApiPropertyOptional({ nullable: true }) recordedByName!: string | null;
  @ApiProperty() recordedDate!: string;
  @ApiProperty() measureType!: string;
  @ApiPropertyOptional({ nullable: true }) score!: number | null;
  @ApiPropertyOptional({ nullable: true }) benchmark!: number | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class InterventionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() tierId!: string;
  @ApiProperty() interventionName!: string;
  @ApiProperty({ enum: INTERVENTION_TYPES }) interventionType!: InterventionType;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) frequency!: string | null;
  @ApiProperty() startDate!: string;
  @ApiPropertyOptional({ nullable: true }) endDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) providerId!: string | null;
  @ApiPropertyOptional({ nullable: true }) providerName!: string | null;
  @ApiProperty({ enum: INTERVENTION_STATUSES }) status!: InterventionStatus;
  @ApiPropertyOptional({ nullable: true, type: () => InterventionProgressEntryDto })
  latestProgress?: InterventionProgressEntryDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateInterventionDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  interventionName!: string;

  @ApiProperty({ enum: INTERVENTION_TYPES })
  @IsIn(INTERVENTION_TYPES as unknown as string[])
  interventionType!: InterventionType;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  frequency?: string | null;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD; >= startDate' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  providerId?: string | null;
}

export class UpdateInterventionDto {
  @ApiPropertyOptional({ enum: INTERVENTION_STATUSES })
  @IsOptional()
  @IsIn(INTERVENTION_STATUSES as unknown as string[])
  status?: InterventionStatus;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  frequency?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD; >= startDate' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class LogProgressDto {
  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  recordedDate!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  measureType!: string;

  @ApiPropertyOptional({ description: 'NUMERIC(8,2)' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? parseFloat(value) : value))
  score?: number;

  @ApiPropertyOptional({ description: 'NUMERIC(8,2) target / threshold' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? parseFloat(value) : value))
  benchmark?: number;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

// ─── Team Meeting DTOs ────────────────────────────────────────

export class TeamMeetingStudentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() teamMeetingId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiPropertyOptional({ nullable: true }) tierId!: string | null;
  @ApiPropertyOptional({ enum: MEETING_OUTCOMES, nullable: true })
  outcome!: MeetingOutcome | null;
  @ApiPropertyOptional({ nullable: true }) outcomeNotes!: string | null;
}

export class TeamMeetingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) meetingId!: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() facilitatedById!: string;
  @ApiPropertyOptional({ nullable: true }) facilitatedByName!: string | null;
  @ApiProperty() meetingDate!: string;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiPropertyOptional({ type: [TeamMeetingStudentResponseDto] })
  students?: TeamMeetingStudentResponseDto[];
  @ApiProperty() createdAt!: string;
}

export class CreateTeamMeetingDto {
  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  meetingDate!: string;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class AttachTeamMeetingStudentDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tierId?: string | null;

  @ApiPropertyOptional({ enum: MEETING_OUTCOMES, nullable: true })
  @IsOptional()
  @IsIn(MEETING_OUTCOMES as unknown as string[])
  outcome?: MeetingOutcome | null;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcomeNotes?: string | null;
}

// ─── Coordinated Care DTOs ────────────────────────────────────

export const CARE_AUTHOR_ROLES = ['NURSE', 'COUNSELLOR'] as const;
export type CareAuthorRole = (typeof CARE_AUTHOR_ROLES)[number];

export class CoordinatedCareNoteDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() authorPersonId!: string;
  @ApiPropertyOptional({ nullable: true }) authorName!: string | null;
  @ApiProperty({ enum: CARE_AUTHOR_ROLES }) authorRole!: CareAuthorRole;
  @ApiProperty() noteText!: string;
  @ApiProperty() createdAt!: string;
}

export class CreateCoordinatedCareNoteDto {
  @ApiProperty({ enum: CARE_AUTHOR_ROLES })
  @IsIn(CARE_AUTHOR_ROLES as unknown as string[])
  authorRole!: CareAuthorRole;

  @ApiProperty({ minLength: 1, maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  noteText!: string;
}

// ─── Mandatory Reports DTOs ───────────────────────────────────

export const REPORT_TYPES = [
  'SUSPECTED_ABUSE',
  'SUSPECTED_NEGLECT',
  'IMMINENT_DANGER',
  'OTHER',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_STATUSES = [
  'FILED',
  'CPS_CONTACTED',
  'INVESTIGATION_ACTIVE',
  'CLOSED',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export class MandatoryReportResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentFirstName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentLastName!: string | null;
  @ApiProperty() reporterPersonId!: string;
  @ApiPropertyOptional({ nullable: true }) reporterName!: string | null;
  @ApiProperty({ enum: REPORT_TYPES }) reportType!: ReportType;
  @ApiProperty() reportedToAuthority!: string;
  @ApiProperty() reportDate!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional({ type: [String], nullable: true })
  supportingDocsS3Keys!: string[] | null;
  @ApiPropertyOptional({ nullable: true }) cpsResponse!: string | null;
  @ApiProperty({ enum: REPORT_STATUSES }) status!: ReportStatus;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateMandatoryReportDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType!: ReportType;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reportedToAuthority!: string;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  @IsDateString()
  reportDate!: string;

  @ApiProperty({ minLength: 1, maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  description!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  supportingDocsS3Keys?: string[];
}

export class UpdateMandatoryReportDto {
  @ApiPropertyOptional({ enum: REPORT_STATUSES })
  @IsOptional()
  @IsIn(REPORT_STATUSES as unknown as string[])
  status?: ReportStatus;

  @ApiPropertyOptional({ maxLength: 8000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  cpsResponse?: string | null;
}

export class ListMandatoryReportsQueryDto {
  @ApiPropertyOptional({ enum: REPORT_STATUSES })
  @IsOptional()
  @IsIn(REPORT_STATUSES as unknown as string[])
  status?: ReportStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}
