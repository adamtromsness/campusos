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
