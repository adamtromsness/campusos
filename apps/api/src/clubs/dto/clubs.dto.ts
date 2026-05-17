import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ── Activities ──

export const ACTIVITY_CATEGORIES = [
  'SPORT',
  'ARTS',
  'ACADEMIC',
  'LEADERSHIP',
  'COMMUNITY',
  'OTHER',
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_STATUSES = ['ACTIVE', 'INACTIVE', 'COMPLETED'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const MEMBER_ROLES = ['MEMBER', 'OFFICER', 'PRESIDENT', 'SECRETARY'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export class ActivityTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ACTIVITY_CATEGORIES }) category!: ActivityCategory;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() isActive!: boolean;
}

export class CreateActivityTypeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: ACTIVITY_CATEGORIES })
  @IsIn(ACTIVITY_CATEGORIES as unknown as string[])
  category!: ActivityCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class ActivityScheduleDto {
  @ApiProperty() id!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() dayOfWeek!: number;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiPropertyOptional() location?: string | null;
  @ApiProperty() isActive!: boolean;
}

export class ActivityMemberDto {
  @ApiProperty() id!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName?: string | null;
  @ApiProperty({ enum: MEMBER_ROLES }) role!: MemberRole;
  @ApiProperty() joinedAt!: string;
  @ApiPropertyOptional() leftAt?: string | null;
  @ApiProperty() isActive!: boolean;
}

export class ActivityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() activityTypeId!: string;
  @ApiPropertyOptional() activityTypeName?: string | null;
  @ApiPropertyOptional() activityTypeCategory?: ActivityCategory | null;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiPropertyOptional() advisorId?: string | null;
  @ApiPropertyOptional() advisorName?: string | null;
  @ApiPropertyOptional() maxParticipants?: number | null;
  @ApiProperty({ enum: ACTIVITY_STATUSES }) status!: ActivityStatus;
  @ApiPropertyOptional() meetingLocation?: string | null;
  @ApiProperty() memberCount!: number;
  @ApiPropertyOptional({ type: [ActivityMemberDto] }) members?: ActivityMemberDto[];
  @ApiPropertyOptional({ type: [ActivityScheduleDto] }) schedule?: ActivityScheduleDto[];
}

export class CreateActivityDto {
  @ApiProperty()
  @IsUUID()
  activityTypeId!: string;

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

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  advisorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  meetingLocation?: string;
}

export class UpdateActivityDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_STATUSES })
  @IsOptional()
  @IsIn(ACTIVITY_STATUSES as unknown as string[])
  status?: ActivityStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  advisorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  meetingLocation?: string;
}

export class JoinActivityDto {
  @ApiPropertyOptional({ enum: MEMBER_ROLES, default: 'MEMBER' })
  @IsOptional()
  @IsIn(MEMBER_ROLES as unknown as string[])
  role?: MemberRole;
}

export class AddMemberDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional({ enum: MEMBER_ROLES })
  @IsOptional()
  @IsIn(MEMBER_ROLES as unknown as string[])
  role?: MemberRole;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: MEMBER_ROLES })
  @IsOptional()
  @IsIn(MEMBER_ROLES as unknown as string[])
  role?: MemberRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  leftAt?: string;
}

export class CreateScheduleDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  dayOfWeek!: number;

  @ApiProperty({ description: 'HH:MM' })
  @IsString()
  startTime!: string;

  @ApiProperty({ description: 'HH:MM' })
  @IsString()
  endTime!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;
}

export class UpdateScheduleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  dayOfWeek?: number;

  @ApiPropertyOptional()
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
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ── Field Trips ──

export const TRIP_STATUSES = [
  'PLANNING',
  'APPROVED',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const ATTENDANCE_STATUSES = ['REGISTERED', 'ATTENDED', 'ABSENT', 'WITHDRAWN'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CHAPERONE_ROLES = ['LEAD', 'CHAPERONE', 'DRIVER'] as const;
export type ChaperoneRole = (typeof CHAPERONE_ROLES)[number];

export const BACKGROUND_CHECK_STATUSES = ['NOT_REQUIRED', 'PENDING', 'CLEARED', 'FAILED'] as const;
export type BackgroundCheckStatus = (typeof BACKGROUND_CHECK_STATUSES)[number];

export class FieldTripParticipantDto {
  @ApiProperty() id!: string;
  @ApiProperty() fieldTripId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName?: string | null;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) attendanceStatus!: AttendanceStatus;
  @ApiPropertyOptional() consentSigned?: boolean;
  @ApiPropertyOptional() consentGiven?: boolean | null;
}

export class FieldTripChaperoneDto {
  @ApiProperty() id!: string;
  @ApiProperty() fieldTripId!: string;
  @ApiProperty() personId!: string;
  @ApiPropertyOptional() personName?: string | null;
  @ApiProperty({ enum: CHAPERONE_ROLES }) role!: ChaperoneRole;
  @ApiProperty({ enum: BACKGROUND_CHECK_STATUSES }) backgroundCheckStatus!: BackgroundCheckStatus;
  @ApiProperty() confirmed!: boolean;
}

export class FieldTripConsentDto {
  @ApiProperty() id!: string;
  @ApiProperty() fieldTripId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() guardianPersonId!: string;
  @ApiPropertyOptional() guardianName?: string | null;
  @ApiProperty() consentGiven!: boolean;
  @ApiProperty() signedAt!: string;
  @ApiPropertyOptional() ipAddress?: string | null;
  @ApiPropertyOptional() emergencyContactOverride?: string | null;
  @ApiPropertyOptional() medicalNotesOverride?: string | null;
  @ApiPropertyOptional() notes?: string | null;
}

export class FieldTripResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() destination!: string;
  @ApiProperty() tripDate!: string;
  @ApiPropertyOptional() departureTime?: string | null;
  @ApiPropertyOptional() returnTime?: string | null;
  @ApiPropertyOptional() gradeLevels?: string[] | null;
  @ApiPropertyOptional() maxParticipants?: number | null;
  @ApiPropertyOptional() costPerStudent?: number | null;
  @ApiProperty() organiserId!: string;
  @ApiPropertyOptional() organiserName?: string | null;
  @ApiProperty({ enum: TRIP_STATUSES }) status!: TripStatus;
  @ApiPropertyOptional() consentDeadline?: string | null;
  @ApiProperty() participantCount!: number;
  @ApiProperty() consentSignedCount!: number;
  @ApiPropertyOptional({ type: [FieldTripParticipantDto] })
  participants?: FieldTripParticipantDto[];
  @ApiPropertyOptional({ type: [FieldTripChaperoneDto] })
  chaperones?: FieldTripChaperoneDto[];
}

export class CreateFieldTripDto {
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

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  destination!: string;

  @ApiProperty()
  @IsDateString()
  tripDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departureTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  returnTime?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  gradeLevels?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxParticipants?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  costPerStudent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  consentDeadline?: string;
}

export class UpdateFieldTripDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  destination?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  tripDate?: string;

  @ApiPropertyOptional({ enum: TRIP_STATUSES })
  @IsOptional()
  @IsIn(TRIP_STATUSES as unknown as string[])
  status?: TripStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxParticipants?: number;
}

export class AddTripParticipantDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;
}

export class SignConsentDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsBoolean()
  consentGiven!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  emergencyContactOverride?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  medicalNotesOverride?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class AddChaperoneDto {
  @ApiProperty()
  @IsUUID()
  personId!: string;

  @ApiPropertyOptional({ enum: CHAPERONE_ROLES })
  @IsOptional()
  @IsIn(CHAPERONE_ROLES as unknown as string[])
  role?: ChaperoneRole;
}

export class UpdateChaperoneDto {
  @ApiPropertyOptional({ enum: BACKGROUND_CHECK_STATUSES })
  @IsOptional()
  @IsIn(BACKGROUND_CHECK_STATUSES as unknown as string[])
  backgroundCheckStatus?: BackgroundCheckStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

// ── Elections ──

export const ELECTION_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'RESULTS_PUBLISHED'] as const;
export type ElectionStatus = (typeof ELECTION_STATUSES)[number];

export class CandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty() electionId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName?: string | null;
  @ApiProperty() position!: string;
  @ApiPropertyOptional() statement?: string | null;
  @ApiPropertyOptional() photoS3Key?: string | null;
  @ApiProperty() isApproved!: boolean;
  @ApiProperty() registeredAt!: string;
  @ApiPropertyOptional() voteCount?: number | null;
}

export class ElectionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() votingStart!: string;
  @ApiProperty() votingEnd!: string;
  @ApiProperty() eligibleVotersFilter!: Record<string, unknown>;
  @ApiProperty({ enum: ELECTION_STATUSES }) status!: ElectionStatus;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() createdByName?: string | null;
  @ApiPropertyOptional({ type: [CandidateDto] }) candidates?: CandidateDto[];
}

export class CreateElectionDto {
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

  @ApiProperty()
  @IsDateString()
  votingStart!: string;

  @ApiProperty()
  @IsDateString()
  votingEnd!: string;

  @ApiProperty({
    description: 'Structured filter: {all:true} | {gradeLevels:[..]} | {studentIds:[..]}',
  })
  @IsObject()
  eligibleVotersFilter!: Record<string, unknown>;
}

export class UpdateElectionDto {
  @ApiPropertyOptional({ enum: ELECTION_STATUSES })
  @IsOptional()
  @IsIn(ELECTION_STATUSES as unknown as string[])
  status?: ElectionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class RegisterCandidateDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  position!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  statement?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  photoS3Key?: string;
}

export class CastVoteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  position!: string;

  @ApiProperty()
  @IsUUID()
  candidateId!: string;
}

export class VoteResultDto {
  @ApiProperty() position!: string;
  @ApiProperty() candidateId!: string;
  @ApiPropertyOptional() candidateName?: string | null;
  @ApiProperty() voteCount!: number;
}

export class ElectionResultsResponseDto {
  @ApiProperty() electionId!: string;
  @ApiProperty({ enum: ELECTION_STATUSES }) status!: ElectionStatus;
  @ApiProperty({ type: [VoteResultDto] }) results!: VoteResultDto[];
  @ApiProperty() totalVotersChecked!: number;
  // P2-H4 ADV-04 — when totalVotersChecked < minVotesForResults the
  // service returns results=[] and resultsSuppressed=true so small
  // cohorts cannot be deanonymised by "you voted last, the remaining
  // tally is yours" attacks.
  @ApiProperty({ default: 5 }) minVotesForResults!: number;
  @ApiProperty({ default: false }) resultsSuppressed!: boolean;
}

export class CanVoteResponseDto {
  @ApiProperty() electionId!: string;
  @ApiProperty() canVote!: boolean;
  @ApiProperty() hasVoted!: boolean;
  @ApiProperty() reason!: string;
}

// ── Service Programmes / Hours ──

export const SERVICE_HOUR_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ServiceHourStatus = (typeof SERVICE_HOUR_STATUSES)[number];

export class ServiceProgrammeDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() targetHours!: number;
  @ApiPropertyOptional() startDate?: string | null;
  @ApiPropertyOptional() endDate?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional() eligibleGradeLevels?: string[] | null;
}

export class CreateServiceProgrammeDto {
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

  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0.1)
  targetHours!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  eligibleGradeLevels?: string[];
}

export class ServiceHourDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName?: string | null;
  @ApiPropertyOptional() programmeId?: string | null;
  @ApiPropertyOptional() programmeName?: string | null;
  @ApiProperty() organisation!: string;
  @ApiProperty() description!: string;
  @ApiProperty() serviceDate!: string;
  @ApiProperty() hours!: number;
  @ApiPropertyOptional() supervisorName?: string | null;
  @ApiPropertyOptional() supervisorContact?: string | null;
  @ApiPropertyOptional() evidenceS3Key?: string | null;
  @ApiPropertyOptional({ enum: SERVICE_HOUR_STATUSES })
  approvalStatus?: ServiceHourStatus | null;
  @ApiPropertyOptional() approvalNotes?: string | null;
  @ApiPropertyOptional() approvedByName?: string | null;
  @ApiPropertyOptional() reviewedAt?: string | null;
  @ApiProperty() createdAt!: string;
}

export class LogServiceHourDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  programmeId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  organisation!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  @ApiProperty()
  @IsDateString()
  serviceDate!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0.1)
  hours!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supervisorName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supervisorContact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  evidenceS3Key?: string;
}

export class ApproveHourDto {
  @ApiProperty({ enum: SERVICE_HOUR_STATUSES })
  @IsIn(SERVICE_HOUR_STATUSES as unknown as string[])
  status!: ServiceHourStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ServiceProgressDto {
  @ApiProperty() id!: string;
  @ApiProperty() programmeId!: string;
  @ApiPropertyOptional() programmeName?: string | null;
  @ApiPropertyOptional() targetHours?: number | null;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName?: string | null;
  @ApiProperty() approvedHours!: number;
  @ApiProperty() pendingHours!: number;
  @ApiProperty() isComplete!: boolean;
}
