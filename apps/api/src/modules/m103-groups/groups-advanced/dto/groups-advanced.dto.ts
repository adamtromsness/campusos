import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

export type PollType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'RANKED';
export type PollStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
export type ResourceType = 'DOCUMENT' | 'LINK' | 'IMAGE' | 'VIDEO' | 'TEMPLATE';
export type RsvpStatus = 'CONFIRMED' | 'DECLINED' | 'PENDING';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED';

/* ── Polls ── */

export class CreatePollDto {
  @ApiProperty()
  @IsString()
  @Length(2, 500)
  question!: string;

  @ApiProperty({ enum: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'RANKED'] })
  @IsIn(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'RANKED'])
  pollType!: PollType;

  @ApiProperty({ type: [String], minItems: 2, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  options!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowsAnonymous?: boolean;

  @ApiPropertyOptional({ description: 'ISO8601 — poll auto-closes after this' })
  @IsOptional()
  @IsISO8601()
  closesAt?: string;
}

export class VotePollDto {
  @ApiProperty({
    type: [String],
    description:
      'Option IDs. SINGLE_CHOICE = 1 entry, MULTIPLE_CHOICE = N entries, RANKED = ordered preference',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  optionIds!: string[];
}

export class PollOptionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() optionText!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() voteCount!: number;
}

export class PollResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() question!: string;
  @ApiProperty({ enum: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'RANKED'] }) pollType!: PollType;
  @ApiProperty() allowsAnonymous!: boolean;
  @ApiProperty({ enum: ['OPEN', 'CLOSED', 'CANCELLED'] }) status!: PollStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) closesAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) closedAt!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty({ type: () => [PollOptionResponseDto] }) options!: PollOptionResponseDto[];
  @ApiProperty() totalVotes!: number;
  @ApiProperty({ description: 'true if the caller has already voted (server-side dedup)' })
  hasVoted!: boolean;
  @ApiProperty() createdAt!: string;
}

/* ── Group meetups (informal events) ── */

export class CreateGroupMeetupDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsISO8601()
  eventDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAttendees?: number;
}

export class UpdateGroupMeetupDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  eventDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAttendees?: number;
}

export class RsvpMeetupDto {
  @ApiProperty({ enum: ['CONFIRMED', 'DECLINED', 'PENDING'] })
  @IsIn(['CONFIRMED', 'DECLINED', 'PENDING'])
  status!: RsvpStatus;
}

export class MeetupResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  @ApiProperty() eventDate!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) location!: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) maxAttendees!: number | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty() confirmedCount!: number;
  @ApiProperty() declinedCount!: number;
  @ApiProperty() pendingCount!: number;
  @ApiPropertyOptional({ enum: ['CONFIRMED', 'DECLINED', 'PENDING'], nullable: true })
  myRsvp!: RsvpStatus | null;
  @ApiProperty() createdAt!: string;
}

/* ── Resource library ── */

export class CreateResourceDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ['DOCUMENT', 'LINK', 'IMAGE', 'VIDEO', 'TEMPLATE'] })
  @IsIn(['DOCUMENT', 'LINK', 'IMAGE', 'VIDEO', 'TEMPLATE'])
  resourceType!: ResourceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

export class UpdateResourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

export class CreateResourceVersionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  changeNotes?: string;
}

export class ResourceVersionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) s3Key!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) url!: string | null;
  @ApiProperty() uploadedBy!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) changeNotes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ResourceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DOCUMENT', 'LINK', 'IMAGE', 'VIDEO', 'TEMPLATE'] })
  resourceType!: ResourceType;
  @ApiPropertyOptional({ type: String, nullable: true }) s3Key!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) url!: string | null;
  @ApiProperty() uploadedBy!: string;
  @ApiProperty() version!: number;
  @ApiProperty() isPinned!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/* ── Invitations ── */

export class CreateInvitationDto {
  @ApiProperty()
  @IsUUID()
  invitedUserId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  message?: string;
}

export class RespondInvitationDto {
  @ApiProperty({ enum: ['ACCEPTED', 'DECLINED'] })
  @IsIn(['ACCEPTED', 'DECLINED'])
  status!: 'ACCEPTED' | 'DECLINED';
}

export class InvitationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) groupName!: string | null;
  @ApiProperty() invitedUserId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) invitedUserName!: string | null;
  @ApiProperty() invitedBy!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) invitedByName!: string | null;
  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'DECLINED'] }) status!: InvitationStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) message!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) respondedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

/* ── Analytics ── */

export class GroupAnalyticsRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty({ description: 'First day of the month (YYYY-MM-01)' }) period!: string;
  @ApiProperty() totalMembers!: number;
  @ApiProperty() activeMembers!: number;
  @ApiProperty() postsCount!: number;
  @ApiProperty() commentsCount!: number;
  @ApiProperty() pollsCreated!: number;
  @ApiProperty() eventsHeld!: number;
  @ApiProperty() resourcesShared!: number;
  @ApiProperty() engagementRate!: number;
  @ApiProperty() computedAt!: string;
}

export class RecomputeAnalyticsDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-01; defaults to first of current month' })
  @IsOptional()
  @IsString()
  period?: string;
}
