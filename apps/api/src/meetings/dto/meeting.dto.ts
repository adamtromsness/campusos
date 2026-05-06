import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const CONFERENCE_TYPES = ['PARENT_TEACHER', 'STAFF', 'BOARD', 'IEP', 'TRAINING'] as const;
export type ConferenceType = (typeof CONFERENCE_TYPES)[number];

export const CONFERENCE_STATUSES = ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type ConferenceStatus = (typeof CONFERENCE_STATUSES)[number];

export const MEETING_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const PARTICIPANT_ROLES = ['HOST', 'PRESENTER', 'ATTENDEE', 'OBSERVER'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const ACTION_ITEM_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const RECORDING_STATUSES = ['PROCESSING', 'AVAILABLE', 'FAILED'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

// ── Conference event ──

export class ConferenceEventResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty({ enum: CONFERENCE_TYPES }) conferenceType!: ConferenceType;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty({ enum: CONFERENCE_STATUSES }) status!: ConferenceStatus;
  @ApiPropertyOptional() createdBy?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() meetingCount?: number;
  @ApiPropertyOptional() totalSlots?: number;
  @ApiPropertyOptional() bookedSlots?: number;
}

export class CreateConferenceEventDto {
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

  @ApiProperty({ enum: CONFERENCE_TYPES })
  @IsIn(CONFERENCE_TYPES as unknown as string[])
  conferenceType!: ConferenceType;

  @ApiProperty()
  @IsISO8601({ strict: false })
  startDate!: string;

  @ApiProperty()
  @IsISO8601({ strict: false })
  endDate!: string;
}

export class UpdateConferenceEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: CONFERENCE_STATUSES })
  @IsOptional()
  @IsIn(CONFERENCE_STATUSES as unknown as string[])
  status?: ConferenceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  endDate?: string;
}

// ── Meeting type ──

export class MeetingTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() defaultDurationMinutes!: number;
  @ApiProperty() isVideo!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

// ── Meeting ──

export class MeetingParticipantResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiProperty() participantId!: string;
  @ApiPropertyOptional() participantName?: string | null;
  @ApiProperty({ enum: PARTICIPANT_ROLES }) role!: ParticipantRole;
  @ApiProperty() attended!: boolean;
  @ApiPropertyOptional() joinAt?: string | null;
  @ApiPropertyOptional() leaveAt?: string | null;
  @ApiPropertyOptional() notes?: string | null;
}

export class MeetingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() meetingTypeId!: string;
  @ApiPropertyOptional() meetingTypeName?: string | null;
  @ApiPropertyOptional() conferenceEventId?: string | null;
  @ApiPropertyOptional() conferenceEventTitle?: string | null;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() scheduledAt!: string;
  @ApiProperty() durationMinutes!: number;
  @ApiPropertyOptional() meetingUrl?: string | null;
  @ApiProperty({ enum: MEETING_STATUSES }) status!: MeetingStatus;
  @ApiProperty() organiserId!: string;
  @ApiPropertyOptional() organiserName?: string | null;
  @ApiPropertyOptional() startedAt?: string | null;
  @ApiPropertyOptional() completedAt?: string | null;
  @ApiPropertyOptional({ type: [MeetingParticipantResponseDto] })
  participants?: MeetingParticipantResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateMeetingDto {
  @ApiProperty()
  @IsUUID()
  meetingTypeId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conferenceEventId?: string;

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
  @IsISO8601({ strict: false })
  scheduledAt!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingUrl?: string;

  @ApiPropertyOptional({ description: 'Optional initial participant ids' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  participantIds?: string[];
}

export class UpdateMeetingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingUrl?: string;

  @ApiPropertyOptional({ enum: MEETING_STATUSES })
  @IsOptional()
  @IsIn(MEETING_STATUSES as unknown as string[])
  status?: MeetingStatus;
}

export class AddParticipantDto {
  @ApiProperty()
  @IsUUID()
  participantId!: string;

  @ApiPropertyOptional({ enum: PARTICIPANT_ROLES })
  @IsOptional()
  @IsIn(PARTICIPANT_ROLES as unknown as string[])
  role?: ParticipantRole;
}

// ── Slot ──

export class MeetingSlotResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiProperty() isBooked!: boolean;
  @ApiPropertyOptional() bookedBy?: string | null;
  @ApiPropertyOptional() bookedByName?: string | null;
  @ApiPropertyOptional() bookedAt?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class SlotInputDto {
  @ApiProperty()
  @IsISO8601({ strict: false })
  startTime!: string;

  @ApiProperty()
  @IsISO8601({ strict: false })
  endTime!: string;
}

export class CreateSlotsDto {
  @ApiProperty({ type: [SlotInputDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SlotInputDto)
  slots!: SlotInputDto[];
}

// ── Notes ──

export class MeetingNotesResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiPropertyOptional() notesText?: string | null;
  @ApiProperty() isApproved!: boolean;
  @ApiPropertyOptional() approvedBy?: string | null;
  @ApiPropertyOptional() approvedByName?: string | null;
  @ApiPropertyOptional() approvedAt?: string | null;
  @ApiProperty() isParentVisible!: boolean;
  @ApiPropertyOptional() parentVisibleSummary?: string | null;
  @ApiPropertyOptional() createdBy?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateMeetingNotesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  notesText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isParentVisible?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  parentVisibleSummary?: string;
}

export class UpdateMeetingNotesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  notesText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isParentVisible?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  parentVisibleSummary?: string;
}

// ── Agenda ──

export class AgendaItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() presenterId?: string | null;
  @ApiPropertyOptional() presenterName?: string | null;
  @ApiPropertyOptional() durationMinutes?: number | null;
  @ApiProperty() sortOrder!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateAgendaItemDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  presenterId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateAgendaItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  presenterId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ── Action items ──

export class ActionItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiPropertyOptional() meetingTitle?: string | null;
  @ApiProperty() assigneeId!: string;
  @ApiPropertyOptional() assigneeName?: string | null;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() dueDate?: string | null;
  @ApiProperty({ enum: ACTION_ITEM_STATUSES }) status!: ActionItemStatus;
  @ApiPropertyOptional() completedAt?: string | null;
  @ApiPropertyOptional() createdBy?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateActionItemDto {
  @ApiProperty()
  @IsUUID()
  assigneeId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  dueDate?: string;
}

export class UpdateActionItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  dueDate?: string;

  @ApiPropertyOptional({ enum: ACTION_ITEM_STATUSES })
  @IsOptional()
  @IsIn(ACTION_ITEM_STATUSES as unknown as string[])
  status?: ActionItemStatus;
}

// ── Recording ──

export class RecordingConsentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() recordingId!: string;
  @ApiProperty() participantId!: string;
  @ApiPropertyOptional() participantName?: string | null;
  @ApiProperty() consentGiven!: boolean;
  @ApiProperty() consentedAt!: string;
  @ApiPropertyOptional() notes?: string | null;
}

export class RecordingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiPropertyOptional() s3Key?: string | null;
  @ApiPropertyOptional() signedUrl?: string | null;
  @ApiPropertyOptional() durationSeconds?: number | null;
  @ApiPropertyOptional() fileSizeBytes?: number | null;
  @ApiProperty({ enum: RECORDING_STATUSES }) status!: RecordingStatus;
  @ApiProperty() consentConfirmed!: boolean;
  @ApiPropertyOptional({ type: [RecordingConsentResponseDto] })
  consents?: RecordingConsentResponseDto[];
  @ApiPropertyOptional() consentedCount?: number;
  @ApiPropertyOptional() totalParticipants?: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateRecordingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  s3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;
}

export class GiveConsentDto {
  @ApiProperty()
  @IsBoolean()
  consentGiven!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ── IEP meeting record ──

export class IepMeetingRecordResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() meetingId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName?: string | null;
  @ApiPropertyOptional() iepPlanId?: string | null;
  @ApiPropertyOptional() iepPlanType?: string | null;
  @ApiPropertyOptional() iepPlanStatus?: string | null;
  @ApiProperty() attendeeRoles!: Array<{ personId: string; role: string; name: string }>;
  @ApiPropertyOptional() outcomesSummary?: string | null;
  @ApiPropertyOptional() nextReviewDate?: string | null;
  @ApiPropertyOptional() recordedBy?: string | null;
  @ApiPropertyOptional() recordedByName?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateIepMeetingRecordDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  iepPlanId?: string;

  @ApiPropertyOptional({ description: 'Structured attendee role array' })
  @IsOptional()
  @IsArray()
  attendeeRoles?: Array<{ personId: string; role: string; name: string }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  outcomesSummary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  nextReviewDate?: string;
}

export class UpdateIepMeetingRecordDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  iepPlanId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  attendeeRoles?: Array<{ personId: string; role: string; name: string }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  outcomesSummary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: false })
  nextReviewDate?: string;
}
