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
}
