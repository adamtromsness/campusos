import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

// ── Enums ────────────────────────────────────────────────────────────

export const CREDENTIAL_TYPES = [
  'TEACHING_LICENSE',
  'SAFEGUARDING',
  'FIRST_AID',
  'BACKGROUND_CHECK',
  'SPECIALIST_QUALIFICATION',
  'OTHER',
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'EXPIRED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const POOL_STATUSES = ['ACTIVE', 'SUSPENDED', 'REMOVED'] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

export const JOB_TYPES = ['FULL_DAY', 'HALF_DAY', 'SPECIFIC_PERIODS'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['OPEN', 'FILLED', 'CANCELLED', 'EXPIRED', 'UNFILLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const NOTIFICATION_TIERS = ['POOL', 'MARKETPLACE'] as const;
export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

export const NOTIFICATION_RESPONSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;
export type NotificationResponse = (typeof NOTIFICATION_RESPONSES)[number];

export const ASSIGNMENT_STATUSES = [
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'NO_SHOW',
  'CANCELLED',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

// ── Profile DTOs ─────────────────────────────────────────────────────

export class CreateSubstituteProfileDto {
  @ApiProperty()
  @IsUUID()
  personId!: string;

  @ApiProperty()
  @IsString()
  displayName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  gradeLevels!: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjectAreas?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  yearsExperience?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxTravelMiles?: number;
}

/**
 * Self-service registration body — no personId field; the caller's
 * JWT subject is the canonical identity. Used by the Getting Started
 * "I want to substitute teach" card where the user holds no IAM
 * permissions yet.
 */
export class RegisterSubstituteSelfDto {
  @ApiPropertyOptional() @IsOptional() @IsString() displayName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bio?: string;
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  gradeLevels!: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjectAreas?: string[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) yearsExperience?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxDistanceMiles?: number;
}

export class SubstituteProfileResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() personId!: string;
  @ApiProperty({ nullable: true }) displayName!: string | null;
  @ApiProperty({ nullable: true }) bio!: string | null;
  @ApiProperty({ type: [String] }) gradeLevels!: string[];
  @ApiProperty({ type: [String] }) subjectAreas!: string[];
  @ApiProperty({ nullable: true }) yearsExperience!: number | null;
  @ApiProperty({ nullable: true }) maxTravelMiles!: number | null;
  @ApiProperty() isAvailable!: boolean;
  @ApiProperty({ nullable: true }) overallRating!: string | null;
  @ApiProperty() totalAssignments!: number;
  @ApiProperty() isActive!: boolean;
}

export class SubstituteSearchDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  gradeLevels?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subjectAreas?: string[];

  @ApiPropertyOptional({
    description: 'School id to honour PREFERRED + BLOCKED preferences against.',
  })
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @ApiPropertyOptional({ description: 'Optional date for availability check (ISO date).' })
  @IsOptional()
  @IsDateString()
  availableOn?: string;

  @ApiPropertyOptional({
    description: 'Only return substitutes with at least one VERIFIED credential.',
  })
  @IsOptional()
  @IsBoolean()
  verifiedOnly?: boolean;
}

// ── Pool DTOs ────────────────────────────────────────────────────────

export class AddToPoolDto {
  @ApiProperty()
  @IsUUID()
  substituteId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdatePoolMemberDto {
  @ApiPropertyOptional({ enum: POOL_STATUSES })
  @IsOptional()
  @IsIn(POOL_STATUSES as unknown as string[])
  status?: PoolStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  suspendedUntil?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  suspensionReason?: string;
}

export class SchoolPoolMemberResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() substituteId!: string;
  @ApiProperty({ nullable: true }) substituteName!: string | null;
  @ApiProperty({ nullable: true }) overallRating!: string | null;
  @ApiProperty({ enum: POOL_STATUSES }) status!: PoolStatus;
  @ApiProperty({ nullable: true }) suspendedUntil!: string | null;
  @ApiProperty({ nullable: true }) suspensionReason!: string | null;
  @ApiProperty() addedAt!: string;
}

// ── Job DTOs ─────────────────────────────────────────────────────────

export class PostJobDto {
  @ApiProperty()
  @IsUUID()
  absentTeacherId!: string;

  @ApiProperty()
  @IsDateString()
  jobDate!: string;

  @ApiProperty()
  @IsString()
  startTime!: string; // HH:MM format

  @ApiProperty()
  @IsString()
  endTime!: string;

  @ApiPropertyOptional({ enum: JOB_TYPES })
  @IsOptional()
  @IsIn(JOB_TYPES as unknown as string[])
  jobType?: JobType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  specialRequirements?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(5)
  acceptanceWindowMinutes?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Optional sch_timetable_slots ids to snapshot.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  timetableSlotIds?: string[];
}

export class JobPostingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() absentTeacherId!: string;
  @ApiProperty({ nullable: true }) absentTeacherName!: string | null;
  @ApiProperty() jobDate!: string;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiProperty({ enum: JOB_TYPES }) jobType!: JobType;
  @ApiProperty({ nullable: true }) gradeLevel!: string | null;
  @ApiProperty({ nullable: true }) subject!: string | null;
  @ApiProperty({ enum: JOB_STATUSES }) status!: JobStatus;
  @ApiProperty({ enum: NOTIFICATION_TIERS }) notificationTier!: NotificationTier;
  @ApiProperty() acceptanceWindowMinutes!: number;
  @ApiProperty({ nullable: true }) escalateToMarketplaceAt!: string | null;
  @ApiProperty({ nullable: true }) filledAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [Object] }) classes!: Array<{
    id: string;
    timetableSlotId: string;
    className: string;
    roomName: string | null;
    periodLabel: string | null;
  }>;
  @ApiProperty({ type: [Object] }) notifications!: Array<{
    id: string;
    substituteId: string;
    response: NotificationResponse;
    notifiedAt: string;
    respondedAt: string | null;
    acceptanceWindowExpiresAt: string;
    notificationTier: NotificationTier;
  }>;
}

export class AssignmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty() substituteId!: string;
  @ApiProperty() confirmedAt!: string;
  @ApiProperty({ enum: ASSIGNMENT_STATUSES }) status!: AssignmentStatus;
  @ApiProperty({ nullable: true }) checkInAt!: string | null;
  @ApiProperty({ nullable: true }) checkOutAt!: string | null;
  @ApiProperty() isLateCancellation!: boolean;
  @ApiProperty({ nullable: true }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true }) cancelledByType!: 'SCHOOL' | 'SUBSTITUTE' | null;
  @ApiProperty({ nullable: true }) cancellationReason!: string | null;
}

// ── Availability DTOs ───────────────────────────────────────────────

export const AVAILABILITY_TYPES = ['RECURRING', 'SPECIFIC', 'BLOCKED'] as const;
export type AvailabilityType = (typeof AVAILABILITY_TYPES)[number];

export class CreateAvailabilityDto {
  @ApiProperty({ enum: AVAILABILITY_TYPES })
  @IsIn(AVAILABILITY_TYPES as unknown as string[])
  availabilityType!: AvailabilityType;

  @ApiPropertyOptional({ description: '0=Sun..6=Sat; required when availabilityType=RECURRING.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dayOfWeek?: number;

  @ApiPropertyOptional({ description: 'ISO date; required when SPECIFIC or BLOCKED.' })
  @IsOptional()
  @IsDateString()
  specificDate?: string;

  @ApiPropertyOptional({ description: 'HH:MM. Optional — NULL pair means whole-day window.' })
  @IsOptional()
  @IsString()
  startTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class AvailabilityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() substituteId!: string;
  @ApiProperty({ enum: AVAILABILITY_TYPES }) availabilityType!: AvailabilityType;
  @ApiProperty({ nullable: true }) dayOfWeek!: number | null;
  @ApiProperty({ nullable: true }) specificDate!: string | null;
  @ApiProperty({ nullable: true }) startTime!: string | null;
  @ApiProperty({ nullable: true }) endTime!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

// ── Preference DTOs ─────────────────────────────────────────────────

export const PREFERENCE_TYPES = ['PREFERRED', 'BLOCKED'] as const;
export type PreferenceType = (typeof PREFERENCE_TYPES)[number];

export class CreatePreferenceDto {
  @ApiProperty()
  @IsUUID()
  schoolId!: string;

  @ApiProperty({ enum: PREFERENCE_TYPES })
  @IsIn(PREFERENCE_TYPES as unknown as string[])
  preferenceType!: PreferenceType;

  @ApiPropertyOptional({ description: 'Private — visible to substitute only.' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class PreferenceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() substituteId!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: PREFERENCE_TYPES }) preferenceType!: PreferenceType;
  @ApiProperty({ nullable: true }) reason!: string | null;
}

// ── Assignment DTOs ─────────────────────────────────────────────────

export class CancelAssignmentDto {
  @ApiProperty({ enum: ['SCHOOL', 'SUBSTITUTE'] })
  @IsIn(['SCHOOL', 'SUBSTITUTE'])
  cancelledByType!: 'SCHOOL' | 'SUBSTITUTE';

  @ApiProperty()
  @IsString()
  cancellationReason!: string;
}

// ── Rating DTOs ─────────────────────────────────────────────────────

export const RATER_TYPES = ['SCHOOL_RATES_SUB', 'SUB_RATES_SCHOOL'] as const;
export type RaterType = (typeof RATER_TYPES)[number];

export class CreateRatingDto {
  @ApiProperty({ enum: RATER_TYPES })
  @IsIn(RATER_TYPES as unknown as string[])
  raterType!: RaterType;

  @ApiPropertyOptional({ description: '1.0–5.0' })
  @IsOptional()
  overallScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  professionalism?: number;

  @ApiPropertyOptional()
  @IsOptional()
  punctuality?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comments?: string;
}

export class RatingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() assignmentId!: string;
  @ApiProperty({ enum: RATER_TYPES }) raterType!: RaterType;
  @ApiProperty({ nullable: true }) overallScore!: string | null;
  @ApiProperty({ nullable: true }) professionalism!: string | null;
  @ApiProperty({ nullable: true }) punctuality!: string | null;
  @ApiProperty({ nullable: true }) comments!: string | null;
  @ApiProperty() ratedAt!: string;
  @ApiProperty({ nullable: true }) ratedBy!: string | null;
}

// ── Session Note DTOs ───────────────────────────────────────────────

export class CreateSessionNoteDto {
  @ApiProperty()
  @IsString()
  notesText!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  homeworkSet?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isVisibleToTeacher?: boolean;
}

export class SessionNoteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() assignmentId!: string;
  @ApiProperty() notesText!: string;
  @ApiProperty({ nullable: true }) homeworkSet!: string | null;
  @ApiProperty() isVisibleToTeacher!: boolean;
  @ApiProperty() submittedAt!: string;
}

// ── Pay Rate DTOs ───────────────────────────────────────────────────

export const RATE_TYPES = ['HOURLY', 'DAILY', 'HALF_DAY'] as const;
export type RateType = (typeof RATE_TYPES)[number];

export class CreatePayRateDto {
  @ApiPropertyOptional({
    description: 'Omit (or use the sentinel zero UUID) for the school default rate.',
  })
  @IsOptional()
  @IsUUID()
  substituteId?: string;

  @ApiPropertyOptional({ enum: JOB_TYPES })
  @IsOptional()
  @IsIn(JOB_TYPES as unknown as string[])
  jobType?: JobType;

  @ApiProperty()
  rate!: number;

  @ApiPropertyOptional({ enum: RATE_TYPES, default: 'DAILY' })
  @IsOptional()
  @IsIn(RATE_TYPES as unknown as string[])
  rateType?: RateType;

  @ApiProperty()
  @IsDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'Open-ended when omitted.' })
  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class PayRateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() substituteId!: string;
  @ApiProperty({ enum: JOB_TYPES }) jobType!: JobType;
  @ApiProperty() rate!: string;
  @ApiProperty({ enum: RATE_TYPES }) rateType!: RateType;
  @ApiProperty() effectiveFrom!: string;
  @ApiProperty({ nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
}

export class AssignmentPayDto {
  @ApiProperty() assignmentId!: string;
  @ApiProperty() rate!: string;
  @ApiProperty({ enum: RATE_TYPES }) rateType!: RateType;
  @ApiProperty() rateSource!: 'PER_SUBSTITUTE' | 'SCHOOL_DEFAULT';
  @ApiProperty({ nullable: true }) payRateId!: string | null;
}

// ── Cancellation Policy DTOs ────────────────────────────────────────

export const CANCEL_CONSEQUENCES = [
  'WARNING_ONLY',
  'TEMPORARY_POOL_SUSPENSION',
  'PERMANENT_POOL_REMOVAL',
  'RATING_PENALTY',
] as const;
export type CancelConsequence = (typeof CANCEL_CONSEQUENCES)[number];

export class UpsertCancellationPolicyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  lateWindowHours?: number;

  @ApiPropertyOptional({ enum: CANCEL_CONSEQUENCES })
  @IsOptional()
  @IsIn(CANCEL_CONSEQUENCES as unknown as string[])
  consequence?: CancelConsequence;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  suspensionDurationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  repeatOffenceThreshold?: number;

  @ApiPropertyOptional({ description: '1.0–5.0 penalty applied on RATING_PENALTY.' })
  @IsOptional()
  ratingPenaltyAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CancellationPolicyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() lateWindowHours!: number;
  @ApiProperty({ enum: CANCEL_CONSEQUENCES }) consequence!: CancelConsequence;
  @ApiProperty({ nullable: true }) suspensionDurationDays!: number | null;
  @ApiProperty() repeatOffenceThreshold!: number;
  @ApiProperty({ nullable: true }) ratingPenaltyAmount!: string | null;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty() updatedAt!: string;
}
