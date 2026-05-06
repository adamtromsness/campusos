import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'REPAIR' | 'LOST' | 'RETIRED';
export const ASSET_STATUSES: readonly AssetStatus[] = [
  'AVAILABLE',
  'ASSIGNED',
  'REPAIR',
  'LOST',
  'RETIRED',
] as const;

export type AssetCondition = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'DAMAGED';
export const ASSET_CONDITIONS: readonly AssetCondition[] = [
  'EXCELLENT',
  'GOOD',
  'FAIR',
  'DAMAGED',
] as const;

export type AssetDocumentType = 'WARRANTY' | 'INVOICE' | 'MANUAL' | 'OTHER';
export const ASSET_DOC_TYPES: readonly AssetDocumentType[] = [
  'WARRANTY',
  'INVOICE',
  'MANUAL',
  'OTHER',
] as const;

export type DamageSeverity = 'MINOR' | 'MODERATE' | 'SEVERE' | 'TOTAL_LOSS';
export const DAMAGE_SEVERITIES: readonly DamageSeverity[] = [
  'MINOR',
  'MODERATE',
  'SEVERE',
  'TOTAL_LOSS',
] as const;

export type RepairType = 'INTERNAL' | 'VENDOR' | 'WARRANTY_CLAIM';
export const REPAIR_TYPES: readonly RepairType[] = [
  'INTERNAL',
  'VENDOR',
  'WARRANTY_CLAIM',
] as const;

export type RepairStatus = 'PENDING' | 'IN_REPAIR' | 'COMPLETED' | 'UNREPAIRABLE';
export const REPAIR_STATUSES: readonly RepairStatus[] = [
  'PENDING',
  'IN_REPAIR',
  'COMPLETED',
  'UNREPAIRABLE',
] as const;

export type LicenceType = 'PER_SEAT' | 'SITE' | 'SUBSCRIPTION';
export const LICENCE_TYPES: readonly LicenceType[] = ['PER_SEAT', 'SITE', 'SUBSCRIPTION'] as const;

export type CredentialType =
  | 'VENDOR_PORTAL'
  | 'SERVICE_ACCOUNT'
  | 'API_KEY'
  | 'SSL_CERTIFICATE'
  | 'WIFI_CREDENTIAL'
  | 'ADMIN_SHARED'
  | 'OTHER';
export const CREDENTIAL_TYPES: readonly CredentialType[] = [
  'VENDOR_PORTAL',
  'SERVICE_ACCOUNT',
  'API_KEY',
  'SSL_CERTIFICATE',
  'WIFI_CREDENTIAL',
  'ADMIN_SHARED',
  'OTHER',
] as const;

export type AccessTier = 'STANDARD' | 'ELEVATED' | 'CRITICAL';
export const ACCESS_TIERS: readonly AccessTier[] = ['STANDARD', 'ELEVATED', 'CRITICAL'] as const;

export type CredentialAccessType = 'VIEW' | 'COPY' | 'MODIFY' | 'CREATE' | 'DELETE';

export type MdmProvider = 'GOOGLE' | 'APPLE' | 'INTUNE' | 'JAMF';
export const MDM_PROVIDERS: readonly MdmProvider[] = ['GOOGLE', 'APPLE', 'INTUNE', 'JAMF'] as const;

export type MdmAlertType =
  | 'NON_COMPLIANT'
  | 'STALE_CHECKIN'
  | 'OS_OUTDATED'
  | 'POLICY_VIOLATION'
  | 'JAILBREAK_DETECTED'
  | 'OTHER';
export const MDM_ALERT_TYPES: readonly MdmAlertType[] = [
  'NON_COMPLIANT',
  'STALE_CHECKIN',
  'OS_OUTDATED',
  'POLICY_VIOLATION',
  'JAILBREAK_DETECTED',
  'OTHER',
] as const;

export type InfraItemType =
  | 'SWITCH'
  | 'ROUTER'
  | 'ACCESS_POINT'
  | 'FIREWALL'
  | 'SERVER'
  | 'STORAGE_ARRAY'
  | 'UPS'
  | 'PRINTER'
  | 'OTHER';
export const INFRA_ITEM_TYPES: readonly InfraItemType[] = [
  'SWITCH',
  'ROUTER',
  'ACCESS_POINT',
  'FIREWALL',
  'SERVER',
  'STORAGE_ARRAY',
  'UPS',
  'PRINTER',
  'OTHER',
] as const;

export type ProcurementStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'ORDERED'
  | 'DELIVERED'
  | 'CANCELLED';
export const PROCUREMENT_STATUSES: readonly ProcurementStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'ORDERED',
  'DELIVERED',
  'CANCELLED',
] as const;

export type DeviceType = 'LAPTOP' | 'DESKTOP' | 'TABLET' | 'PHONE' | 'OTHER';
export const DEVICE_TYPES: readonly DeviceType[] = [
  'LAPTOP',
  'DESKTOP',
  'TABLET',
  'PHONE',
  'OTHER',
] as const;

export type SelectionContext = 'ENROLMENT' | 'REFRESH' | 'REPLACEMENT';
export const SELECTION_CONTEXTS: readonly SelectionContext[] = [
  'ENROLMENT',
  'REFRESH',
  'REPLACEMENT',
] as const;

export type SelectionStatus = 'PENDING' | 'SELECTED' | 'APPROVED' | 'PROVISIONED' | 'REJECTED';
export const SELECTION_STATUSES: readonly SelectionStatus[] = [
  'PENDING',
  'SELECTED',
  'APPROVED',
  'PROVISIONED',
  'REJECTED',
] as const;

// ── Assets ─────────────────────────────────────────────────────

export class CreateAssetCategoryDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  depreciationYears?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maintenanceIntervalMonths?: number;
}

export class UpdateAssetCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  depreciationYears?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maintenanceIntervalMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AssetCategoryDto {
  id!: string;
  schoolId!: string;
  name!: string;
  description!: string | null;
  depreciationYears!: number | null;
  maintenanceIntervalMonths!: number | null;
  isActive!: boolean;
  assetCount!: number;
}

export class CreateAssetDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 100)
  assetTag!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  make?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  warrantyExpiry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateAssetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assetTag?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  make?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  warrantyExpiry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(ASSET_STATUSES as unknown as string[])
  status?: AssetStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class AssetDto {
  id!: string;
  schoolId!: string;
  categoryId!: string;
  categoryName!: string;
  assetTag!: string;
  serialNumber!: string | null;
  make!: string | null;
  model!: string | null;
  purchaseDate!: string | null;
  purchaseCost!: number | null;
  warrantyExpiry!: string | null;
  status!: AssetStatus;
  notes!: string | null;
  currentAssigneeId!: string | null;
  currentAssigneeName!: string | null;
}

export class AssignAssetDto {
  @ApiProperty()
  @IsUUID()
  assigneeId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(ASSET_CONDITIONS as unknown as string[])
  conditionAtAssign?: AssetCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ReturnAssetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(ASSET_CONDITIONS as unknown as string[])
  conditionAtReturn?: AssetCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class AssignmentDto {
  id!: string;
  assetId!: string;
  assetTag!: string;
  assigneeId!: string;
  assigneeName!: string;
  assignedBy!: string;
  assignedAt!: string;
  returnedAt!: string | null;
  conditionAtAssign!: AssetCondition | null;
  conditionAtReturn!: AssetCondition | null;
  notes!: string | null;
}

export class CreateAssetDocumentDto {
  @ApiProperty()
  @IsIn(ASSET_DOC_TYPES as unknown as string[])
  documentType!: AssetDocumentType;

  @ApiProperty()
  @IsString()
  s3Key!: string;

  @ApiProperty()
  @IsString()
  fileName!: string;
}

export class AssetDocumentDto {
  id!: string;
  assetId!: string;
  documentType!: AssetDocumentType;
  s3Key!: string;
  fileName!: string;
  uploadedBy!: string;
  uploadedAt!: string;
}

export class CreateDamageReportDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string;

  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty()
  @IsIn(DAMAGE_SEVERITIES as unknown as string[])
  severity!: DamageSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoS3Keys?: string[];
}

export class DamageReportDto {
  id!: string;
  assetId!: string;
  assetTag!: string;
  reportedBy!: string;
  reportedByName!: string;
  description!: string;
  severity!: DamageSeverity;
  photoS3Keys!: string[];
  reportedAt!: string;
  repairRecordId!: string | null;
}

export class CreateRepairDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  damageReportId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty()
  @IsIn(REPAIR_TYPES as unknown as string[])
  repairType!: RepairType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  estimatedReturnDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  costEstimate?: number;
}

export class UpdateRepairDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(REPAIR_STATUSES as unknown as string[])
  status?: RepairStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  estimatedReturnDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  returnedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  finalCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RepairRecordDto {
  id!: string;
  assetId!: string;
  assetTag!: string;
  damageReportId!: string | null;
  vendorId!: string | null;
  vendorName!: string | null;
  repairType!: RepairType;
  sentForRepairAt!: string | null;
  estimatedReturnDate!: string | null;
  returnedAt!: string | null;
  costEstimate!: number | null;
  finalCost!: number | null;
  status!: RepairStatus;
  notes!: string | null;
}

// ── Licences + Vault ──────────────────────────────────────────

export class CreateLicenceDto {
  @ApiProperty()
  @IsString()
  softwareName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiProperty()
  @IsIn(LICENCE_TYPES as unknown as string[])
  licenceType!: LicenceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  totalSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  annualCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateLicenceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  softwareName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  totalSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  annualCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LicenceDto {
  id!: string;
  schoolId!: string;
  softwareName!: string;
  vendor!: string | null;
  licenceType!: LicenceType;
  totalSeats!: number | null;
  usedSeats!: number;
  utilisationPct!: number | null;
  expiryDate!: string | null;
  annualCost!: number | null;
  notes!: string | null;
  isActive!: boolean;
}

export class AssignLicenceDto {
  @ApiProperty()
  @IsUUID()
  assigneeId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class LicenceAssignmentDto {
  id!: string;
  licenceId!: string;
  softwareName!: string;
  assigneeId!: string;
  assigneeName!: string;
  assignedBy!: string;
  assignedAt!: string;
  lastUsedAt!: string | null;
  notes!: string | null;
}

export class CreateCredentialDto {
  @ApiProperty()
  @IsString()
  serviceName!: string;

  @ApiProperty()
  @IsIn(CREDENTIAL_TYPES as unknown as string[])
  credentialType!: CredentialType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;

  @ApiProperty()
  @IsString()
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  rotationDueAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(ACCESS_TIERS as unknown as string[])
  accessTier?: AccessTier;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateCredentialDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serviceName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  rotationDueAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(ACCESS_TIERS as unknown as string[])
  accessTier?: AccessTier;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CredentialSummaryDto {
  id!: string;
  schoolId!: string;
  serviceName!: string;
  credentialType!: CredentialType;
  username!: string | null;
  url!: string | null;
  accessTier!: AccessTier;
  lastRotatedAt!: string | null;
  rotationDueAt!: string | null;
  expiryDate!: string | null;
  notes!: string | null;
  hasPassword!: boolean;
  createdAt!: string;
  updatedAt!: string;
}

export class CredentialDetailDto extends CredentialSummaryDto {
  password!: string;
}

export class CredentialAccessLogDto {
  id!: string;
  credentialId!: string;
  serviceName!: string;
  accessedBy!: string;
  accessedByName!: string;
  accessType!: CredentialAccessType;
  accessedAt!: string;
}

// ── MDM ────────────────────────────────────────────────────────

export class CreateMdmSyncDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string;

  @ApiProperty()
  @IsIn(MDM_PROVIDERS as unknown as string[])
  mdmProvider!: MdmProvider;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  osVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  lastCheckIn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCompliant?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  complianceDetails?: Record<string, unknown>;
}

export class MdmSyncDto {
  id!: string;
  assetId!: string;
  assetTag!: string;
  mdmProvider!: MdmProvider;
  syncAt!: string;
  deviceName!: string | null;
  osVersion!: string | null;
  lastCheckIn!: string | null;
  isCompliant!: boolean;
  complianceDetails!: Record<string, unknown> | null;
}

export class CreateMdmAlertDto {
  @ApiProperty()
  @IsUUID()
  assetId!: string;

  @ApiProperty()
  @IsIn(MDM_ALERT_TYPES as unknown as string[])
  alertType!: MdmAlertType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  alertDetail?: string;
}

export class ResolveMdmAlertDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resolutionNotes?: string;
}

export class MdmAlertDto {
  id!: string;
  assetId!: string;
  assetTag!: string;
  alertType!: MdmAlertType;
  alertDetail!: string | null;
  firstDetectedAt!: string;
  lastDetectedAt!: string;
  isResolved!: boolean;
  resolvedAt!: string | null;
  resolvedBy!: string | null;
  resolutionNotes!: string | null;
}

// ── Infrastructure ────────────────────────────────────────────

export class CreateInfrastructureItemDto {
  @ApiProperty()
  @IsString()
  itemName!: string;

  @ApiProperty()
  @IsIn(INFRA_ITEM_TYPES as unknown as string[])
  itemType!: InfraItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  macAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  make?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  warrantyExpiry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateInfrastructureItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  itemName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  macAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class InfrastructureItemDto {
  id!: string;
  schoolId!: string;
  itemName!: string;
  itemType!: InfraItemType;
  location!: string | null;
  ipAddress!: string | null;
  macAddress!: string | null;
  make!: string | null;
  model!: string | null;
  serialNumber!: string | null;
  purchaseDate!: string | null;
  warrantyExpiry!: string | null;
  status!: string;
  notes!: string | null;
}

// ── Procurement ───────────────────────────────────────────────

export class CreateProcurementOrderDto {
  @ApiProperty()
  @IsString()
  orderTitle!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  purchaseOrderNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedDeliveryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateProcurementOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(PROCUREMENT_STATUSES as unknown as string[])
  status?: ProcurementStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedDeliveryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class MarkDeliveredDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  deliveredAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ProcurementOrderDto {
  id!: string;
  schoolId!: string;
  orderTitle!: string;
  vendorId!: string | null;
  vendorName!: string | null;
  purchaseOrderNumber!: string | null;
  orderedBy!: string | null;
  orderedByName!: string | null;
  orderDate!: string | null;
  expectedDeliveryDate!: string | null;
  deliveredAt!: string | null;
  totalCost!: number | null;
  status!: ProcurementStatus;
  notes!: string | null;
}

// ── Device Selection ──────────────────────────────────────────

export class CreateDeviceOptionDto {
  @ApiProperty()
  @IsString()
  optionName!: string;

  @ApiProperty()
  @IsIn(DEVICE_TYPES as unknown as string[])
  deviceType!: DeviceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  operatingSystem?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  specifications?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  softwareAvailable?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  costDifference?: number;
}

export class UpdateDeviceOptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  optionName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  operatingSystem?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  specifications?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  softwareAvailable?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  costDifference?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class DeviceOptionDto {
  id!: string;
  schoolId!: string;
  optionName!: string;
  deviceType!: DeviceType;
  operatingSystem!: string | null;
  specifications!: string | null;
  softwareAvailable!: string[];
  costDifference!: number | null;
  isActive!: boolean;
}

export class CreateDeviceSelectionDto {
  @ApiProperty()
  @IsUUID()
  personId!: string;

  @ApiProperty()
  @IsUUID()
  optionId!: string;

  @ApiProperty()
  @IsIn(SELECTION_CONTEXTS as unknown as string[])
  selectionContext!: SelectionContext;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ApproveSelectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class DeviceSelectionDto {
  id!: string;
  personId!: string;
  personName!: string;
  optionId!: string;
  optionName!: string;
  selectionContext!: SelectionContext;
  selectedAt!: string;
  status!: SelectionStatus;
  approvedBy!: string | null;
  approvedByName!: string | null;
  approvedAt!: string | null;
  assetId!: string | null;
  assetTag!: string | null;
  notes!: string | null;
}
