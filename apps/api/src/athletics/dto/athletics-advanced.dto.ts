import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

// ── P2-8a Enums ──────────────────────────────────────────────────

export const EQUIPMENT_ITEM_TYPES = [
  'UNIFORM',
  'PROTECTIVE_GEAR',
  'TRAINING_EQUIPMENT',
  'GAME_EQUIPMENT',
  'MEDICAL_EQUIPMENT',
  'OTHER',
] as const;
export type EquipmentItemType = (typeof EQUIPMENT_ITEM_TYPES)[number];

export const EQUIPMENT_CONDITIONS = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'RETIRED'] as const;
export type EquipmentCondition = (typeof EQUIPMENT_CONDITIONS)[number];

export const RETURN_CONDITIONS = ['GOOD', 'DAMAGED', 'LOST'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const SAFETY_EQUIPMENT_TYPES = [
  'HELMET',
  'PADS',
  'MOUTHGUARD',
  'SHIN_GUARDS',
  'GOGGLES',
  'OTHER',
] as const;
export type SafetyEquipmentType = (typeof SAFETY_EQUIPMENT_TYPES)[number];

export const PHOTO_TYPES = ['TEAM_PHOTO', 'ACTION_SHOT', 'INDIVIDUAL'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export const MEDIA_ASSET_TYPES = ['PHOTO', 'VIDEO', 'DOCUMENT', 'LOGO'] as const;
export type MediaAssetType = (typeof MEDIA_ASSET_TYPES)[number];

export const MAINTENANCE_TYPES = ['CLEANING', 'REPAIR', 'INSPECTION', 'RECONDITIONING'] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

// ── Equipment DTOs ──────────────────────────────────────────────

export class CreateEquipmentDto {
  @ApiProperty() @IsUUID() programmeId!: string;

  @ApiProperty({ enum: EQUIPMENT_ITEM_TYPES })
  @IsIn(EQUIPMENT_ITEM_TYPES as unknown as string[])
  itemType!: EquipmentItemType;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) itemName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ enum: EQUIPMENT_CONDITIONS })
  @IsOptional()
  @IsIn(EQUIPMENT_CONDITIONS as unknown as string[])
  condition?: EquipmentCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost?: number;
}

export class UpdateEquipmentDto {
  @ApiPropertyOptional({ enum: EQUIPMENT_ITEM_TYPES })
  @IsOptional()
  @IsIn(EQUIPMENT_ITEM_TYPES as unknown as string[])
  itemType?: EquipmentItemType;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) itemName?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) quantity?: number;

  @ApiPropertyOptional({ enum: EQUIPMENT_CONDITIONS })
  @IsOptional()
  @IsIn(EQUIPMENT_CONDITIONS as unknown as string[])
  condition?: EquipmentCondition;

  @ApiPropertyOptional() @IsOptional() @IsDateString() purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost?: number;
}

export class EquipmentResponseDto {
  id!: string;
  schoolId!: string;
  programmeId!: string;
  programmeName!: string | null;
  itemType!: EquipmentItemType;
  itemName!: string;
  quantity!: number;
  condition!: EquipmentCondition;
  purchaseDate!: string | null;
  unitCost!: number | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Equipment Checkout DTOs ─────────────────────────────────────

export class CheckoutEquipmentDto {
  @ApiProperty() @IsUUID() assignedToPersonId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) itemIdentifier?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() checkedOutAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedReturnDate?: string;
}

export class ReturnEquipmentDto {
  @ApiProperty({ enum: RETURN_CONDITIONS })
  @IsIn(RETURN_CONDITIONS as unknown as string[])
  conditionAtReturn!: ReturnCondition;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) damageNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  replacementCharge?: number;
}

export class EquipmentCheckoutResponseDto {
  id!: string;
  equipmentId!: string;
  equipmentName!: string | null;
  assignedToPersonId!: string;
  assignedToName!: string | null;
  itemIdentifier!: string | null;
  checkedOutAt!: string;
  expectedReturnDate!: string | null;
  returnedAt!: string | null;
  conditionAtReturn!: ReturnCondition | null;
  damageNotes!: string | null;
  replacementCharge!: number | null;
  isOverdue!: boolean;
  createdAt!: string;
  updatedAt!: string;
}

// ── Safety Equipment DTOs ───────────────────────────────────────

export class CreateSafetyEquipmentDto {
  @ApiProperty() @IsUUID() rosterMemberId!: string;

  @ApiProperty({ enum: SAFETY_EQUIPMENT_TYPES })
  @IsIn(SAFETY_EQUIPMENT_TYPES as unknown as string[])
  equipmentType!: SafetyEquipmentType;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() issued?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() meetsSafetyStandard?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() certificationDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() certificationExpiry?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() recallStatus?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateSafetyEquipmentDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() issued?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() meetsSafetyStandard?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() certificationDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() certificationExpiry?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() recallStatus?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class SafetyEquipmentResponseDto {
  id!: string;
  rosterMemberId!: string;
  studentName!: string | null;
  equipmentType!: SafetyEquipmentType;
  issued!: boolean;
  meetsSafetyStandard!: boolean;
  certificationDate!: string | null;
  certificationExpiry!: string | null;
  recallStatus!: boolean;
  notes!: string | null;
  /**
   * Derived compliance bucket. GREEN when issued + meetsSafetyStandard +
   * certification not expired + recallStatus=false. AMBER when expiring
   * within 30 days. ROSE when expired or meetsSafetyStandard=false or
   * recallStatus=true. NEUTRAL when not issued.
   */
  complianceState!: 'GREEN' | 'AMBER' | 'ROSE' | 'NEUTRAL';
  createdAt!: string;
  updatedAt!: string;
}

// ── Conference DTOs ─────────────────────────────────────────────

export class CreateConferenceDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(80) sport!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) region?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) governingBody?: string;
}

export class UpdateConferenceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) sport?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) region?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) governingBody?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ConferenceResponseDto {
  id!: string;
  name!: string;
  sport!: string;
  region!: string | null;
  governingBody!: string | null;
  isActive!: boolean;
  membershipCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateConferenceMembershipDto {
  @ApiProperty() @IsUUID() programmeId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) level?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() joinedDate?: string;
}

export class ConferenceMembershipResponseDto {
  id!: string;
  conferenceId!: string;
  schoolId!: string;
  programmeId!: string;
  programmeName!: string | null;
  joinedDate!: string;
  level!: string | null;
  isActive!: boolean;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateConferenceScheduleDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() seasonId?: string;
  @ApiProperty() @IsUUID() homeSchoolId!: string;
  @ApiProperty() @IsUUID() awaySchoolId!: string;
  @ApiProperty() @IsDateString() scheduledDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() scheduledTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ConferenceScheduleResponseDto {
  id!: string;
  conferenceId!: string;
  seasonId!: string | null;
  homeSchoolId!: string;
  awaySchoolId!: string;
  scheduledDate!: string;
  scheduledTime!: string | null;
  linkedGameId!: string | null;
  notes!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Team Photo + Media Asset DTOs ───────────────────────────────

export class CreateTeamPhotoDto {
  @ApiProperty() @IsUUID() rosterId!: string;

  @ApiProperty({ enum: PHOTO_TYPES })
  @IsIn(PHOTO_TYPES as unknown as string[])
  photoType!: PhotoType;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) s3Key!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) caption?: string;
}

export class TeamPhotoResponseDto {
  id!: string;
  rosterId!: string;
  photoType!: PhotoType;
  s3Key!: string;
  caption!: string | null;
  uploadedBy!: string | null;
  uploadedByName!: string | null;
  uploadedAt!: string;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateMediaAssetDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() programmeId?: string;

  @ApiProperty({ enum: MEDIA_ASSET_TYPES })
  @IsIn(MEDIA_ASSET_TYPES as unknown as string[])
  assetType!: MediaAssetType;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) s3Key!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() seasonId?: string;
}

export class MediaAssetResponseDto {
  id!: string;
  schoolId!: string;
  programmeId!: string | null;
  programmeName!: string | null;
  assetType!: MediaAssetType;
  s3Key!: string;
  title!: string | null;
  description!: string | null;
  seasonId!: string | null;
  uploadedBy!: string | null;
  uploadedByName!: string | null;
  uploadedAt!: string;
  createdAt!: string;
  updatedAt!: string;
}

// ── Equipment Maintenance DTOs ──────────────────────────────────

export class CreateMaintenanceDto {
  @ApiProperty({ enum: MAINTENANCE_TYPES })
  @IsIn(MAINTENANCE_TYPES as unknown as string[])
  maintenanceType!: MaintenanceType;

  @ApiPropertyOptional() @IsOptional() @IsDateString() performedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) performedBy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() nextMaintenanceDate?: string;
}

export class MaintenanceResponseDto {
  id!: string;
  equipmentId!: string;
  maintenanceType!: MaintenanceType;
  performedAt!: string;
  performedBy!: string | null;
  cost!: number | null;
  notes!: string | null;
  nextMaintenanceDate!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── P2-8b Enums ──────────────────────────────────────────────────

export const STREAM_STATUSES = ['SCHEDULED', 'LIVE', 'ENDED', 'FAILED'] as const;
export type StreamStatus = (typeof STREAM_STATUSES)[number];

export const STREAM_ACCESS_LEVELS = [
  'PUBLIC',
  'SCHOOL_ONLY',
  'BOTH_SCHOOLS',
  'COACHES_ONLY',
] as const;
export type StreamAccessLevel = (typeof STREAM_ACCESS_LEVELS)[number];

export const HIGHLIGHT_CONSENT_STATUSES = ['PENDING', 'CONSENTED', 'DECLINED'] as const;
export type HighlightConsentStatus = (typeof HIGHLIGHT_CONSENT_STATUSES)[number];

export const RECORDING_TYPES = ['FULL_GAME', 'HIGHLIGHT_REEL', 'COACHES_FILM'] as const;
export type RecordingType = (typeof RECORDING_TYPES)[number];

export const OFFICIAL_ROLES = [
  'HEAD_REFEREE',
  'ASSISTANT_REFEREE',
  'UMPIRE',
  'LINE_JUDGE',
  'SCORER',
  'TIMER',
  'OTHER',
] as const;
export type OfficialRole = (typeof OFFICIAL_ROLES)[number];

export const OFFICIAL_ASSIGNMENT_STATUSES = [
  'POSTED',
  'ACCEPTED',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type OfficialAssignmentStatus = (typeof OFFICIAL_ASSIGNMENT_STATUSES)[number];

export const OFFICIAL_PAYMENT_STATUSES = ['PENDING', 'PROCESSED', 'PAID'] as const;
export type OfficialPaymentStatus = (typeof OFFICIAL_PAYMENT_STATUSES)[number];

export const RATER_TYPES = ['SCHOOL_RATES_OFFICIAL', 'OFFICIAL_RATES_SCHOOL'] as const;
export type RaterType = (typeof RATER_TYPES)[number];

export const RECRUITING_INTEREST_LEVELS = [
  'EXPLORING',
  'INTERESTED',
  'APPLIED',
  'COMMITTED',
] as const;
export type RecruitingInterestLevel = (typeof RECRUITING_INTEREST_LEVELS)[number];

// ── Game Stream DTOs ─────────────────────────────────────────────

export class CreateGameStreamDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) streamUrl?: string;

  @ApiPropertyOptional({ enum: STREAM_ACCESS_LEVELS })
  @IsOptional()
  @IsIn(STREAM_ACCESS_LEVELS as unknown as string[])
  accessLevel?: StreamAccessLevel;
}

export class UpdateGameStreamDto {
  @ApiPropertyOptional({ enum: STREAM_STATUSES })
  @IsOptional()
  @IsIn(STREAM_STATUSES as unknown as string[])
  streamStatus?: StreamStatus;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) streamUrl?: string;

  @ApiPropertyOptional({ enum: STREAM_ACCESS_LEVELS })
  @IsOptional()
  @IsIn(STREAM_ACCESS_LEVELS as unknown as string[])
  accessLevel?: StreamAccessLevel;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) recordingS3Key?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) recordingDurationSeconds?: number;
}

export class GameStreamResponseDto {
  id!: string;
  gameId!: string;
  streamUrl!: string | null;
  streamStatus!: StreamStatus;
  accessLevel!: StreamAccessLevel;
  recordingS3Key!: string | null;
  recordingDurationSeconds!: number | null;
  configuredBy!: string;
  startedAt!: string | null;
  endedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Highlight Clip DTOs ──────────────────────────────────────────

export class CreateHighlightClipDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsInt() @Min(0) startTimeSeconds!: number;
  @ApiProperty() @IsInt() @Min(1) endTimeSeconds!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) s3Key!: string;
}

export class RecordHighlightClipConsentDto {
  @ApiProperty({ enum: ['CONSENTED', 'DECLINED'] })
  @IsIn(['CONSENTED', 'DECLINED'])
  consentStatus!: 'CONSENTED' | 'DECLINED';
}

export class HighlightClipResponseDto {
  id!: string;
  streamId!: string;
  studentId!: string;
  studentName!: string | null;
  startTimeSeconds!: number;
  endTimeSeconds!: number;
  title!: string | null;
  description!: string | null;
  s3Key!: string;
  addedToPortfolio!: boolean;
  portfolioItemId!: string | null;
  consentStatus!: HighlightConsentStatus;
  consentRecordedAt!: string | null;
  createdBy!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Game Recording DTOs ──────────────────────────────────────────

export class CreateGameRecordingDto {
  @ApiProperty({ enum: RECORDING_TYPES })
  @IsIn(RECORDING_TYPES as unknown as string[])
  recordingType!: RecordingType;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) s3Key!: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) durationSeconds?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class GameRecordingResponseDto {
  id!: string;
  gameId!: string;
  recordingType!: RecordingType;
  s3Key!: string;
  durationSeconds!: number | null;
  title!: string | null;
  description!: string | null;
  uploadedBy!: string | null;
  uploadedAt!: string;
  createdAt!: string;
  updatedAt!: string;
}

// ── Official Profile DTOs (platform schema) ──────────────────────

export class CreateOfficialProfileDto {
  @ApiProperty() @IsUUID() personId!: string;

  @ApiProperty({ type: [String] })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  sports!: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) certificationLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) certificationBody?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() certificationExpiry?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) yearsExperience?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxTravelMiles?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) baseFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) contactPhone?: string;
}

export class UpdateOfficialProfileDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  sports?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) certificationLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) certificationBody?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() certificationExpiry?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) yearsExperience?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxTravelMiles?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) baseFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) contactPhone?: string;
}

export class OfficialProfileResponseDto {
  id!: string;
  personId!: string;
  personName!: string | null;
  sports!: string[];
  certificationLevel!: string | null;
  certificationBody!: string | null;
  certificationExpiry!: string | null;
  yearsExperience!: number | null;
  maxTravelMiles!: number | null;
  baseFee!: number | null;
  isAvailable!: boolean;
  bio!: string | null;
  contactEmail!: string | null;
  contactPhone!: string | null;
  averageOverallRating!: number | null;
  ratingCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateOfficialAvailabilityDto {
  @ApiProperty() @IsDateString() availableDate!: string;

  @ApiPropertyOptional({ description: 'HH:MM:SS time format (24-hour)' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  startTime?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8) endTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class OfficialAvailabilityResponseDto {
  id!: string;
  officialProfileId!: string;
  availableDate!: string;
  startTime!: string | null;
  endTime!: string | null;
  isAvailable!: boolean;
  notes!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Official Assignment DTOs ─────────────────────────────────────

export class CreateOfficialAssignmentDto {
  @ApiProperty() @IsUUID() officialProfileId!: string;

  @ApiProperty({ enum: OFFICIAL_ROLES })
  @IsIn(OFFICIAL_ROLES as unknown as string[])
  role!: OfficialRole;

  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) fee!: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class TransitionOfficialAssignmentDto {
  @ApiProperty({ enum: ['ACCEPTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] })
  @IsIn(['ACCEPTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
  status!: 'ACCEPTED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) cancellationReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class OfficialAssignmentResponseDto {
  id!: string;
  gameId!: string;
  officialProfileId!: string;
  officialName!: string | null;
  role!: OfficialRole;
  fee!: number;
  status!: OfficialAssignmentStatus;
  paymentStatus!: OfficialPaymentStatus;
  acceptedAt!: string | null;
  confirmedAt!: string | null;
  completedAt!: string | null;
  cancelledAt!: string | null;
  cancellationReason!: string | null;
  notes!: string | null;
  assignedBy!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ── Official Rating DTOs ─────────────────────────────────────────

export class CreateOfficialRatingDto {
  @ApiProperty({ enum: RATER_TYPES })
  @IsIn(RATER_TYPES as unknown as string[])
  raterType!: RaterType;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) professionalism?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) knowledge?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) communication?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) punctuality?: number;
  @ApiProperty() @IsInt() @Min(1) overall!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) comments?: string;
}

export class OfficialRatingResponseDto {
  id!: string;
  assignmentId!: string;
  raterType!: RaterType;
  professionalism!: number | null;
  knowledge!: number | null;
  communication!: number | null;
  punctuality!: number | null;
  overall!: number;
  comments!: string | null;
  ratedBy!: string | null;
  ratedAt!: string;
  createdAt!: string;
  updatedAt!: string;
}

// ── Recruiting Profile DTOs ──────────────────────────────────────

export class CreateRecruitingProfileDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(50) sport!: string;
  @ApiProperty() @IsInt() @Min(2024) graduationYear!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) position?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) heightInches?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) weightLbs?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) highlightReelS3Key?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) achievements?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
}

export class UpdateRecruitingProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) sport?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(2024) graduationYear?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) position?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) heightInches?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) weightLbs?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) highlightReelS3Key?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) coachRecommendation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) achievements?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
}

export class RecruitingProfileResponseDto {
  id!: string;
  studentId!: string;
  studentName!: string | null;
  sport!: string;
  graduationYear!: number;
  position!: string | null;
  heightInches!: number | null;
  weightLbs!: number | null;
  gpa!: number | null;
  gpaSnapshotAt!: string | null;
  highlightReelS3Key!: string | null;
  isPublished!: boolean;
  publishedAt!: string | null;
  coachRecommendation!: string | null;
  achievements!: string | null;
  contactEmail!: string | null;
  interestCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateRecruitingInterestDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) collegeName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) contactPhone?: string;

  @ApiPropertyOptional({ enum: RECRUITING_INTEREST_LEVELS })
  @IsOptional()
  @IsIn(RECRUITING_INTEREST_LEVELS as unknown as string[])
  interestLevel?: RecruitingInterestLevel;

  @ApiPropertyOptional() @IsOptional() @IsDateString() lastContactDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateRecruitingInterestDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) collegeName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) contactPhone?: string;

  @ApiPropertyOptional({ enum: RECRUITING_INTEREST_LEVELS })
  @IsOptional()
  @IsIn(RECRUITING_INTEREST_LEVELS as unknown as string[])
  interestLevel?: RecruitingInterestLevel;

  @ApiPropertyOptional() @IsOptional() @IsDateString() lastContactDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class RecruitingInterestResponseDto {
  id!: string;
  recruitingProfileId!: string;
  collegeName!: string;
  contactName!: string | null;
  contactEmail!: string | null;
  contactPhone!: string | null;
  interestLevel!: RecruitingInterestLevel;
  lastContactDate!: string | null;
  notes!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
