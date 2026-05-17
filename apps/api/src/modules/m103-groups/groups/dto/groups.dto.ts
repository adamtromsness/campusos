import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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
  ValidateIf,
} from 'class-validator';

export type GroupScopeType = 'CLASS' | 'YEAR_GROUP' | 'SCHOOL' | 'CUSTOM' | 'ACTIVITY';
export type GroupStatus = 'ACTIVE' | 'ARCHIVED' | 'DISSOLVED';
export type JoinPolicy = 'OPEN' | 'APPROVAL_REQUIRED' | 'INVITE_ONLY';
export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type MemberStatus =
  | 'ACTIVE'
  | 'INVITED'
  | 'PENDING_APPROVAL'
  | 'SUSPENDED'
  | 'LEFT'
  | 'REMOVED';
export type TransferStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
export type EventType =
  | 'PRACTICE'
  | 'MATCH'
  | 'MEETING'
  | 'SOCIAL'
  | 'PERFORMANCE'
  | 'COMPETITION'
  | 'OTHER';
export type RsvpStatus = 'GOING' | 'NOT_GOING' | 'MAYBE';
export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'PUSH' | 'ALL' | 'NONE';

export class CreateGroupDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ['CLASS', 'YEAR_GROUP', 'SCHOOL', 'CUSTOM', 'ACTIVITY'] })
  @IsIn(['CLASS', 'YEAR_GROUP', 'SCHOOL', 'CUSTOM', 'ACTIVITY'])
  scopeType!: GroupScopeType;

  @ApiPropertyOptional()
  @ValidateIf((o) => ['CLASS', 'YEAR_GROUP', 'ACTIVITY'].indexOf(o.scopeType) >= 0)
  @IsUUID()
  scopeId?: string;

  @ApiPropertyOptional({ enum: ['OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY'] })
  @IsOptional()
  @IsIn(['OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY'])
  joinPolicy?: JoinPolicy;

  @ApiPropertyOptional({ description: 'ISO8601 timestamp; group auto-dissolves after this' })
  @IsOptional()
  @IsISO8601()
  autoDissolveAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class UpdateGroupDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED', 'DISSOLVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED', 'DISSOLVED'])
  status?: GroupStatus;

  @ApiPropertyOptional({ enum: ['OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY'] })
  @IsOptional()
  @IsIn(['OPEN', 'APPROVAL_REQUIRED', 'INVITE_ONLY'])
  joinPolicy?: JoinPolicy;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  autoDissolveAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}

export class GroupResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() scopeType!: GroupScopeType;
  @ApiPropertyOptional() scopeId!: string | null;
  @ApiPropertyOptional() scopeLabel!: string | null;
  @ApiProperty() status!: GroupStatus;
  @ApiProperty() joinPolicy!: JoinPolicy;
  @ApiPropertyOptional() autoDissolveAt!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() avatarUrl!: string | null;
  @ApiProperty() memberCount!: number;
  @ApiProperty() pendingCount!: number;
  @ApiPropertyOptional() myMembership!: {
    id: string;
    role: MemberRole;
    status: MemberStatus;
  } | null;
  @ApiProperty() createdAt!: string;
}

export class JoinGroupDto {
  @ApiPropertyOptional({ description: 'Optional message included with join request' })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  message?: string;
}

export class InviteMemberDto {
  @ApiProperty()
  @IsUUID()
  personId!: string;

  @ApiPropertyOptional({ enum: ['ADMIN', 'MEMBER'] })
  @IsOptional()
  @IsIn(['ADMIN', 'MEMBER'])
  role?: 'ADMIN' | 'MEMBER';
}

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: ['ADMIN', 'MEMBER'] })
  @IsIn(['ADMIN', 'MEMBER'])
  role!: 'ADMIN' | 'MEMBER';
}

export class SuspendMemberDto {
  @ApiProperty()
  @IsString()
  @Length(2, 1000)
  reason!: string;
}

export class ApproveJoinDto {
  @ApiPropertyOptional({ enum: ['ADMIN', 'MEMBER'] })
  @IsOptional()
  @IsIn(['ADMIN', 'MEMBER'])
  role?: 'ADMIN' | 'MEMBER';
}

export class MemberResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() personId!: string;
  @ApiPropertyOptional() personName!: string | null;
  @ApiProperty() role!: MemberRole;
  @ApiProperty() status!: MemberStatus;
  @ApiPropertyOptional() joinedAt!: string | null;
  @ApiPropertyOptional() invitedBy!: string | null;
  @ApiPropertyOptional() leftAt!: string | null;
  @ApiPropertyOptional() suspensionReason!: string | null;
}

export class UpdateNotificationPrefsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyAnnouncements?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyEvents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyMembershipChanges?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyResults?: boolean;

  @ApiPropertyOptional({ enum: ['IN_APP', 'EMAIL', 'PUSH', 'ALL', 'NONE'] })
  @IsOptional()
  @IsIn(['IN_APP', 'EMAIL', 'PUSH', 'ALL', 'NONE'])
  preferredChannel?: NotificationChannel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  quietHoursOverride?: boolean;
}

export class NotificationPrefsDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() notifyAnnouncements!: boolean;
  @ApiProperty() notifyEvents!: boolean;
  @ApiProperty() notifyMembershipChanges!: boolean;
  @ApiProperty() notifyResults!: boolean;
  @ApiProperty() preferredChannel!: NotificationChannel;
  @ApiProperty() quietHoursOverride!: boolean;
}

export class InitiateTransferDto {
  @ApiProperty()
  @IsUUID()
  toMemberId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  reason?: string;

  @ApiPropertyOptional({ description: 'Hours before transfer expires (default 168 = 7 days)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expiryHours?: number;
}

export class TransferResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() fromMemberId!: string;
  @ApiPropertyOptional() fromName!: string | null;
  @ApiProperty() toMemberId!: string;
  @ApiPropertyOptional() toName!: string | null;
  @ApiPropertyOptional() reason!: string | null;
  @ApiProperty() status!: TransferStatus;
  @ApiProperty() initiatedAt!: string;
  @ApiProperty() expiresAt!: string;
  @ApiPropertyOptional() respondedAt!: string | null;
}

export class CreateAnnouncementDto {
  @ApiProperty()
  @IsString()
  @Length(2, 300)
  title!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 10000)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  attachments?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class UpdateAnnouncementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 10000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class AnnouncementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() authorId!: string;
  @ApiPropertyOptional() authorName!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() pinned!: boolean;
  @ApiPropertyOptional() attachments!: unknown[] | null;
  @ApiProperty() publishAt!: string;
  @ApiPropertyOptional() expiresAt!: string | null;
  @ApiProperty() readCount!: number;
  @ApiProperty() iHaveRead!: boolean;
  @ApiProperty() createdAt!: string;
}

export class CreateEventDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty()
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiProperty({
    enum: ['PRACTICE', 'MATCH', 'MEETING', 'SOCIAL', 'PERFORMANCE', 'COMPETITION', 'OTHER'],
  })
  @IsIn(['PRACTICE', 'MATCH', 'MEETING', 'SOCIAL', 'PERFORMANCE', 'COMPETITION', 'OTHER'])
  eventType!: EventType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresRsvp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  rsvpDeadline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAttendees?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateEventDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() location?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() endsAt?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['PRACTICE', 'MATCH', 'MEETING', 'SOCIAL', 'PERFORMANCE', 'COMPETITION', 'OTHER'])
  eventType?: EventType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresRsvp?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() rsvpDeadline?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxAttendees?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublic?: boolean;
}

export class EventResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() createdByName!: string | null;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiPropertyOptional() location!: string | null;
  @ApiProperty() startsAt!: string;
  @ApiPropertyOptional() endsAt!: string | null;
  @ApiProperty() eventType!: EventType;
  @ApiProperty() requiresRsvp!: boolean;
  @ApiPropertyOptional() rsvpDeadline!: string | null;
  @ApiPropertyOptional() maxAttendees!: number | null;
  @ApiProperty() isPublic!: boolean;
  @ApiProperty() goingCount!: number;
  @ApiProperty() maybeCount!: number;
  @ApiProperty() notGoingCount!: number;
  @ApiPropertyOptional() myRsvp!: RsvpStatus | null;
  @ApiProperty() createdAt!: string;
}

export class RsvpDto {
  @ApiProperty({ enum: ['GOING', 'NOT_GOING', 'MAYBE'] })
  @IsIn(['GOING', 'NOT_GOING', 'MAYBE'])
  status!: RsvpStatus;
}
