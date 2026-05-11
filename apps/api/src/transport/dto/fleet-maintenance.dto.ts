import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ============================================================
// Enum unions
// ============================================================
export type RepairPerformedByType = 'INTERNAL' | 'EXTERNAL_VENDOR';
export type RepairStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type ComponentType =
  | 'TYRE'
  | 'BRAKE'
  | 'BATTERY'
  | 'BELT'
  | 'HOSE'
  | 'ALTERNATOR'
  | 'STARTER'
  | 'TRANSMISSION'
  | 'OTHER';
export type ComponentStatus = 'ACTIVE' | 'REPLACED' | 'FAILED';
export type FuelType = 'DIESEL' | 'PETROL' | 'ELECTRIC' | 'HYBRID' | 'LPG';
export type DepreciationMethod = 'STRAIGHT_LINE' | 'DECLINING_BALANCE';
export type DisposalMethod = 'SOLD' | 'SCRAPPED' | 'TRADED_IN' | 'DONATED';

// ============================================================
// Repair categories
// ============================================================
export class CreateRepairCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsBoolean()
  isSafetyCritical?: boolean;
}

export class UpdateRepairCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isSafetyCritical?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RepairCategoryResponseDto {
  id!: string;
  schoolId!: string;
  name!: string;
  isSafetyCritical!: boolean;
  isActive!: boolean;
}

// ============================================================
// Vehicle repairs
// ============================================================
export class CreateRepairDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsDateString()
  repairDate!: string;

  @IsInt()
  @Min(0)
  mileageAtRepair!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  problemDescription!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  workPerformed!: string;

  @IsOptional()
  @IsObject()
  partsUsed?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(0)
  labourHours?: number;

  @IsNumber()
  @Min(0)
  totalCost!: number;

  @IsIn(['INTERNAL', 'EXTERNAL_VENDOR'])
  performedByType!: RepairPerformedByType;

  @IsOptional()
  @IsUUID()
  vendorAccountId?: string;

  @IsOptional()
  @IsBoolean()
  warrantyClaim?: boolean;

  @IsOptional()
  @IsString()
  invoiceS3Key?: string;

  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'])
  status?: RepairStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateRepairDto {
  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
  status?: RepairStatus;

  @IsOptional()
  @IsString()
  workPerformed?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  labourHours?: number;

  @IsOptional()
  @IsBoolean()
  warrantyClaim?: boolean;

  @IsOptional()
  @IsObject()
  partsUsed?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class RepairResponseDto {
  id!: string;
  vehicleId!: string;
  categoryId!: string | null;
  categoryName!: string | null;
  isSafetyCritical!: boolean;
  repairDate!: string;
  mileageAtRepair!: number;
  problemDescription!: string;
  workPerformed!: string;
  partsUsed!: Record<string, unknown> | null;
  labourHours!: number | null;
  totalCost!: number;
  performedByType!: RepairPerformedByType;
  vendorAccountId!: string | null;
  warrantyClaim!: boolean;
  invoiceS3Key!: string | null;
  status!: RepairStatus;
  scheduledAt!: string | null;
  startedAt!: string | null;
  completedAt!: string | null;
  notes!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ============================================================
// Parts inventory
// ============================================================
export class CreatePartDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  partName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  partNumber?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantityOnHand?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStockLevel?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  supplier?: string;
}

export class UpdatePartDto {
  @IsOptional()
  @IsString()
  partName?: string;

  @IsOptional()
  @IsString()
  partNumber?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStockLevel?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  supplier?: string;
}

export class RestockPartDto {
  @IsInt()
  @Min(1)
  quantityDelta!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  supplier?: string;
}

export class PartResponseDto {
  id!: string;
  schoolId!: string;
  partName!: string;
  partNumber!: string | null;
  quantityOnHand!: number;
  minStockLevel!: number;
  unitCost!: number | null;
  supplier!: string | null;
  lastRestockedAt!: string | null;
  belowThreshold!: boolean;
}

// ============================================================
// Vehicle components
// ============================================================
export class CreateComponentDto {
  @IsIn([
    'TYRE',
    'BRAKE',
    'BATTERY',
    'BELT',
    'HOSE',
    'ALTERNATOR',
    'STARTER',
    'TRANSMISSION',
    'OTHER',
  ])
  componentType!: ComponentType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsDateString()
  installedDate!: string;

  @IsInt()
  @Min(0)
  installedMileage!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedLifeMiles?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedLifeMonths?: number;

  @IsOptional()
  @IsString()
  warrantyProvider?: string;

  @IsOptional()
  @IsDateString()
  warrantyExpiryDate?: string;
}

export class UpdateComponentDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'REPLACED', 'FAILED'])
  status?: ComponentStatus;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsUUID()
  replacedByComponentId?: string;
}

export class ComponentResponseDto {
  id!: string;
  vehicleId!: string;
  componentType!: ComponentType;
  description!: string | null;
  installedDate!: string;
  installedMileage!: number;
  expectedLifeMiles!: number | null;
  expectedLifeMonths!: number | null;
  warrantyProvider!: string | null;
  warrantyExpiryDate!: string | null;
  status!: ComponentStatus;
  replacedAt!: string | null;
  replacedByComponentId!: string | null;
  notes!: string | null;
  // Computed
  ageDays!: number | null;
  monthsRemaining!: number | null;
  approachingEndOfLife!: boolean;
}

// ============================================================
// Fuel logs
// ============================================================
export class CreateFuelLogDto {
  @IsUUID()
  loggedBy!: string;

  @IsDateString()
  logDate!: string;

  @IsNumber()
  @Min(0)
  odometerReading!: number;

  @IsNumber()
  @Min(0.01)
  fuelQuantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fuelCost?: number;

  @IsIn(['DIESEL', 'PETROL', 'ELECTRIC', 'HYBRID', 'LPG'])
  fuelType!: FuelType;

  @IsOptional()
  @IsString()
  refuelLocation?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class FuelLogResponseDto {
  id!: string;
  vehicleId!: string;
  loggedBy!: string | null;
  loggedByName!: string | null;
  logDate!: string;
  odometerReading!: number;
  fuelQuantity!: number;
  fuelCost!: number | null;
  fuelType!: FuelType;
  refuelLocation!: string | null;
  // Computed: miles per unit since previous log (null on first row)
  efficiency!: number | null;
  milesSincePrevious!: number | null;
  createdAt!: string;
}

export class FleetFuelSummaryRowDto {
  vehicleId!: string;
  vehicleRegistration!: string;
  periodLabel!: string;
  totalQuantity!: number;
  totalCost!: number;
  averageEfficiency!: number | null;
  logCount!: number;
}

// ============================================================
// Driver hours
// ============================================================
export class CreateDriverHoursDto {
  @IsOptional()
  @IsUUID()
  runId?: string;

  @IsDateString()
  logDate!: string;

  @IsDateString()
  dutyStartAt!: string;
}

export class CompleteDriverHoursDto {
  @IsDateString()
  dutyEndAt!: string;

  @IsInt()
  @Min(0)
  drivingMinutes!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class DriverHoursResponseDto {
  id!: string;
  driverId!: string | null;
  runId!: string | null;
  logDate!: string;
  dutyStartAt!: string;
  dutyEndAt!: string | null;
  drivingMinutes!: number | null;
  breakMinutes!: number;
  cumulativeWeeklyMinutes!: number | null;
  notes!: string | null;
  createdAt!: string;
}

export class DriverHoursWeeklySummaryDto {
  driverId!: string;
  weekStartDate!: string;
  totalDrivingMinutes!: number;
  weeklyLimitMinutes!: number;
  remainingMinutes!: number;
  thresholdPct!: number;
  approachingLimit!: boolean;
  overLimit!: boolean;
}

export class DriverApproachingLimitRowDto {
  driverId!: string;
  driverName!: string | null;
  drivingMinutes!: number;
  weeklyLimitMinutes!: number;
  percentOfLimit!: number;
}

export class UpdateDriverHoursLimitDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  weeklyDrivingLimitMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  dailyDrivingLimitMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  mandatoryBreakAfterMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(100)
  approachingLimitThresholdPct?: number;

  @IsOptional()
  @IsString()
  jurisdiction?: string;
}

export class DriverHoursLimitResponseDto {
  id!: string;
  schoolId!: string;
  weeklyDrivingLimitMinutes!: number;
  dailyDrivingLimitMinutes!: number;
  mandatoryBreakAfterMinutes!: number;
  approachingLimitThresholdPct!: number;
  jurisdiction!: string;
}

// ============================================================
// Vehicle lifecycle
// ============================================================
export class UpdateVehicleLifecycleDto {
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  purchasePrice?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedLifeYears?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedLifeMiles?: number;

  @IsOptional()
  @IsIn(['STRAIGHT_LINE', 'DECLINING_BALANCE'])
  depreciationMethod?: DepreciationMethod;

  @IsOptional()
  @IsNumber()
  @Min(0)
  currentBookValue?: number;
}

export class RecordDisposalDto {
  @IsDateString()
  disposalDate!: string;

  @IsIn(['SOLD', 'SCRAPPED', 'TRADED_IN', 'DONATED'])
  disposalMethod!: DisposalMethod;

  @IsOptional()
  @IsNumber()
  @Min(0)
  disposalValue?: number;

  @IsOptional()
  @IsString()
  disposalNotes?: string;
}

export class VehicleLifecycleResponseDto {
  id!: string;
  vehicleId!: string;
  vehicleRegistration!: string;
  purchaseDate!: string | null;
  purchasePrice!: number | null;
  expectedLifeYears!: number | null;
  expectedLifeMiles!: number | null;
  depreciationMethod!: DepreciationMethod;
  currentBookValue!: number | null;
  bookValueComputedAt!: string | null;
  disposalDate!: string | null;
  disposalValue!: number | null;
  disposalMethod!: DisposalMethod | null;
  disposalNotes!: string | null;
  // Computed
  ageYears!: number | null;
  remainingLifeYears!: number | null;
  approachingReplacement!: boolean;
}

export class FleetReplacementRowDto {
  vehicleId!: string;
  vehicleRegistration!: string;
  ageYears!: number | null;
  expectedLifeYears!: number | null;
  remainingLifeYears!: number | null;
  currentBookValue!: number | null;
  approachingReplacement!: boolean;
}
