import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export type VisitorBadgeColor = 'blue' | 'green' | 'amber' | 'rose' | 'purple' | 'gray';
export const BADGE_COLORS: VisitorBadgeColor[] = [
  'blue',
  'green',
  'amber',
  'rose',
  'purple',
  'gray',
];

export type SafeguardingStatus = 'PASSED' | 'FLAGGED' | 'BYPASSED_BY_ADMIN' | 'NOT_REQUIRED';
export const SAFEGUARDING_STATUSES: SafeguardingStatus[] = [
  'PASSED',
  'FLAGGED',
  'BYPASSED_BY_ADMIN',
  'NOT_REQUIRED',
];

export type BanType =
  | 'COURT_ORDER'
  | 'SCHOOL_DECISION'
  | 'SAFEGUARDING'
  | 'RESTRAINING_ORDER'
  | 'OTHER';
export const BAN_TYPES: BanType[] = [
  'COURT_ORDER',
  'SCHOOL_DECISION',
  'SAFEGUARDING',
  'RESTRAINING_ORDER',
  'OTHER',
];

export type DrillType =
  | 'FIRE_DRILL'
  | 'LOCKDOWN'
  | 'EVACUATION'
  | 'BOMB_THREAT'
  | 'WEATHER'
  | 'OTHER';
export const DRILL_TYPES: DrillType[] = [
  'FIRE_DRILL',
  'LOCKDOWN',
  'EVACUATION',
  'BOMB_THREAT',
  'WEATHER',
  'OTHER',
];

export type MusterEntryStatus = 'UNKNOWN' | 'ACCOUNTED_FOR' | 'EVACUATED' | 'ASSISTANCE_NEEDED';
export const MUSTER_ENTRY_STATUSES: MusterEntryStatus[] = [
  'UNKNOWN',
  'ACCOUNTED_FOR',
  'EVACUATED',
  'ASSISTANCE_NEEDED',
];

export type ScheduleDay = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
export const SCHEDULE_DAYS: ScheduleDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// ── Visitor Types ───────────────────────────────────────────────

export class CreateVisitorTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  requiresSafeguardingCheck?: boolean;

  @IsOptional()
  @IsIn(BADGE_COLORS)
  badgeColor?: VisitorBadgeColor;
}

export class UpdateVisitorTypeDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() requiresSafeguardingCheck?: boolean;
  @IsOptional() @IsIn(BADGE_COLORS) badgeColor?: VisitorBadgeColor;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class VisitorTypeDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() requiresSafeguardingCheck!: boolean;
  @ApiProperty() badgeColor!: VisitorBadgeColor;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

// ── Visitors ────────────────────────────────────────────────────

export class CreateVisitorDto {
  @IsUUID() visitorTypeId!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) lastName!: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;

  // Email is required because it is the blind-index lookup key.
  @IsString() @IsNotEmpty() @MaxLength(320) email!: string;

  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateVisitorDto {
  @IsOptional() @IsUUID() visitorTypeId?: string;
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(320) email?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

/**
 * Public projection — no encrypted columns, no hashes. Returned by
 * the kiosk lookup endpoint and by every list endpoint. The admin
 * detail endpoint also returns the decrypted email + phone via
 * VisitorDetailDto.
 */
export class VisitorDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() visitorTypeId!: string;
  @ApiPropertyOptional() visitorTypeName?: string;
  @ApiPropertyOptional() badgeColor?: VisitorBadgeColor;
  @ApiPropertyOptional() requiresSafeguardingCheck?: boolean;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() company?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class VisitorDetailDto extends VisitorDto {
  @ApiPropertyOptional() email?: string | null;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() notes?: string | null;
}

export class VisitorLookupQueryDto {
  @IsString() @IsNotEmpty() @MaxLength(320) email!: string;
}

// ── Sign-in Settings ────────────────────────────────────────────

export class UpdateSignInSettingsDto {
  @IsOptional() @IsBoolean() requirePhotoId?: boolean;
  @IsOptional() @IsBoolean() requirePurpose?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(48) autoSignOutHours?: number;
  @IsOptional() @IsString() @MaxLength(200) safeguardingProvider?: string;
  @IsOptional() @IsIn(['STANDARD', 'COMPACT', 'PHOTO']) badgeTemplate?:
    | 'STANDARD'
    | 'COMPACT'
    | 'PHOTO';
  @IsOptional() @IsString() @MaxLength(500) kioskWelcomeMessage?: string;
}

export class SignInSettingsDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() requirePhotoId!: boolean;
  @ApiProperty() requirePurpose!: boolean;
  @ApiProperty() autoSignOutHours!: number;
  @ApiPropertyOptional() safeguardingProvider?: string | null;
  @ApiProperty() badgeTemplate!: 'STANDARD' | 'COMPACT' | 'PHOTO';
  @ApiPropertyOptional() kioskWelcomeMessage?: string | null;
  @ApiProperty() updatedAt!: string;
}

// ── Sign-Ins ────────────────────────────────────────────────────

export class CreateSignInDto {
  // The kiosk passes either visitorId (if returning + auto-filled)
  // or full visitor details (new). When visitorId is supplied the
  // service skips the create-visitor branch and uses the existing
  // record.
  @IsOptional() @IsUUID() visitorId?: string;

  @IsOptional() @IsUUID() visitorTypeId?: string;
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(320) email?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;

  // Optional date of birth — used by the banned-persons check
  // when supplied. The kiosk does not require it for normal sign-in.
  @IsOptional() @IsDateString() dateOfBirth?: string;

  @IsOptional() @IsUUID() hostId?: string;
  @IsOptional() @IsString() @MaxLength(500) purpose?: string;
  @IsOptional() @IsUUID() buildingId?: string;
  @IsOptional() @IsString() @MaxLength(50) badgeNumber?: string;

  // Optional safeguarding reference if the staff has already
  // verified the visitor against the third-party provider.
  @IsOptional() @IsString() @MaxLength(100) safeguardingCheckRef?: string;
}

export class BypassSafeguardingDto {
  @IsString()
  @MinLength(11, { message: 'bypassReason must be more than 10 characters' })
  @MaxLength(2000)
  reason!: string;
}

export class SignInDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() visitorId!: string;
  @ApiProperty() visitorName!: string;
  @ApiPropertyOptional() visitorCompany?: string | null;
  @ApiProperty() visitorTypeName!: string;
  @ApiProperty() badgeColor!: VisitorBadgeColor;
  @ApiProperty() signedInAt!: string;
  @ApiPropertyOptional() signedOutAt?: string | null;
  @ApiPropertyOptional() hostId?: string | null;
  @ApiPropertyOptional() hostName?: string | null;
  @ApiPropertyOptional() purpose?: string | null;
  @ApiPropertyOptional() buildingId?: string | null;
  @ApiPropertyOptional() preRegistrationId?: string | null;
  @ApiPropertyOptional() badgeNumber?: string | null;
  @ApiProperty({ enum: SAFEGUARDING_STATUSES }) safeguardingCheckStatus!: SafeguardingStatus;
  @ApiPropertyOptional() safeguardingCheckRef?: string | null;
  @ApiPropertyOptional() bypassAdminId?: string | null;
  @ApiPropertyOptional() bypassAdminName?: string | null;
  @ApiPropertyOptional() bypassReason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class SignInListQueryDto {
  @IsOptional() @IsString() fromDate?: string;
  @IsOptional() @IsString() toDate?: string;
  @IsOptional() @IsUUID() hostId?: string;
  @IsOptional() @IsUUID() visitorId?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) onSiteOnly?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(500) @Type(() => Number) limit?: number;
}

// ── Pre-Registrations ───────────────────────────────────────────

export class CreatePreRegistrationDto {
  @IsOptional() @IsUUID() visitorId?: string;

  // When visitorId is omitted, the service creates the visitor.
  @IsOptional() @IsUUID() visitorTypeId?: string;
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(320) email?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;

  @IsISO8601() expectedAt!: string;
  @IsOptional() @IsString() @MaxLength(500) purpose?: string;
  @IsOptional() @IsUUID() hostId?: string;

  @IsOptional() @IsInt() @Min(1) @Max(60) expiresInDays?: number;
}

export class PreRegistrationDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() visitorId!: string;
  @ApiProperty() visitorName!: string;
  @ApiPropertyOptional() visitorCompany?: string | null;
  @ApiProperty() expectedAt!: string;
  @ApiPropertyOptional() purpose?: string | null;
  @ApiPropertyOptional() hostId?: string | null;
  @ApiPropertyOptional() hostName?: string | null;
  @ApiProperty() qrCodeToken!: string;
  @ApiProperty() expiresAt!: string;
  @ApiPropertyOptional() usedAt?: string | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
}

export class PreRegistrationScanDto {
  @IsString()
  @IsNotEmpty()
  @Length(64, 64, { message: 'qrCodeToken must be 32-byte hex (64 chars)' })
  qrCodeToken!: string;
}

// ── Recurring Visitors ──────────────────────────────────────────

export class AccessScheduleDto {
  @IsArray()
  @IsIn(SCHEDULE_DAYS, { each: true })
  @ArrayMaxSize(7)
  days!: ScheduleDay[];

  @IsString()
  @IsNotEmpty()
  timeStart!: string;

  @IsString()
  @IsNotEmpty()
  timeEnd!: string;
}

export class CreateRecurringVisitorDto {
  @IsUUID() visitorId!: string;

  @Type(() => AccessScheduleDto)
  accessSchedule!: AccessScheduleDto;

  @IsDateString() validFrom!: string;
  @IsOptional() @IsDateString() validTo?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateRecurringVisitorDto {
  @IsOptional() @Type(() => AccessScheduleDto) accessSchedule?: AccessScheduleDto;
  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validTo?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class RecurringVisitorDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() visitorId!: string;
  @ApiProperty() visitorName!: string;
  @ApiPropertyOptional() visitorCompany?: string | null;
  @ApiProperty() accessSchedule!: AccessScheduleDto;
  @ApiProperty() validFrom!: string;
  @ApiPropertyOptional() validTo?: string | null;
  @ApiProperty() approvedBy!: string;
  @ApiPropertyOptional() approvedByName?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() isActive!: boolean;
}

// ── Banned Persons ──────────────────────────────────────────────

export class CreateBannedPersonDto {
  @IsString() @IsNotEmpty() @MaxLength(100) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) lastName!: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
  @IsOptional() @IsString() @MaxLength(500) photoS3Key?: string;
  @IsString()
  @MinLength(10, { message: 'banReason must be more than 10 characters' })
  @MaxLength(4000)
  banReason!: string;
  @IsIn(BAN_TYPES) banType!: BanType;
  @IsOptional() @IsString() @MaxLength(500) banOrderS3Key?: string;
  @IsDateString() effectiveFrom!: string;
  @IsOptional() @IsDateString() effectiveTo?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateBannedPersonDto {
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsDateString() dateOfBirth?: string | null;
  @IsOptional() @IsString() @MaxLength(500) photoS3Key?: string | null;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(4000) banReason?: string;
  @IsOptional() @IsIn(BAN_TYPES) banType?: BanType;
  @IsOptional() @IsString() @MaxLength(500) banOrderS3Key?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsDateString() effectiveFrom?: string;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() markReviewed?: boolean;
}

export class BannedPersonDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() dateOfBirth?: string | null;
  @ApiPropertyOptional() photoS3Key?: string | null;
  @ApiProperty() banReason!: string;
  @ApiProperty({ enum: BAN_TYPES }) banType!: BanType;
  @ApiPropertyOptional() banOrderS3Key?: string | null;
  @ApiProperty() addedBy!: string;
  @ApiPropertyOptional() addedByName?: string | null;
  @ApiPropertyOptional() reviewedBy?: string | null;
  @ApiPropertyOptional() reviewedByName?: string | null;
  @ApiPropertyOptional() lastReviewedAt?: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional() effectiveTo?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() createdAt!: string;
}

export class BannedPersonCheckDto {
  @IsString() @IsNotEmpty() @MaxLength(100) firstName!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) lastName!: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
}

export class BannedPersonCheckResultDto {
  @ApiProperty() blocked!: boolean;
  // The kiosk never sees the matched ban detail; only safeguarding
  // officers via the admin endpoint do. blocked=true is enough for
  // the kiosk to render the neutral message.
  @ApiPropertyOptional() detectedAt?: string;
}

// ── Emergency Muster ────────────────────────────────────────────

export class CreateMusterDto {
  @IsOptional() @IsIn(DRILL_TYPES) drillType?: DrillType;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsUUID() incidentId?: string;
}

export class UpdateMusterEntryDto {
  @IsIn(MUSTER_ENTRY_STATUSES) status!: MusterEntryStatus;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class MusterDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: DRILL_TYPES }) drillType!: DrillType;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional() incidentId?: string | null;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() createdByName?: string | null;
  @ApiProperty() totalOnSiteAtSnapshot!: number;
  @ApiPropertyOptional() closedAt?: string | null;
  @ApiPropertyOptional() closedBy?: string | null;
  @ApiProperty() createdAt!: string;
}

export class MusterEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() musterId!: string;
  @ApiProperty() signInId!: string;
  @ApiProperty() visitorName!: string;
  @ApiProperty() visitorType!: string;
  @ApiPropertyOptional() visitorCompany?: string | null;
  @ApiPropertyOptional() building?: string | null;
  @ApiProperty({ enum: MUSTER_ENTRY_STATUSES }) status!: MusterEntryStatus;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() markedBy?: string | null;
  @ApiPropertyOptional() markedByName?: string | null;
  @ApiPropertyOptional() markedAt?: string | null;
  @ApiProperty() createdAt!: string;
}

export class MusterSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty() unknown!: number;
  @ApiProperty() accountedFor!: number;
  @ApiProperty() evacuated!: number;
  @ApiProperty() assistanceNeeded!: number;
}

export class MusterDetailDto {
  @ApiProperty() muster!: MusterDto;
  @ApiProperty({ type: [MusterEntryDto] }) entries!: MusterEntryDto[];
  @ApiProperty() summary!: MusterSummaryDto;
}
