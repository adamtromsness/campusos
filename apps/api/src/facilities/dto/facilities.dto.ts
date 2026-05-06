import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

// ── Enums ──
export type SpaceType =
  | 'CLASSROOM'
  | 'BATHROOM'
  | 'CORRIDOR'
  | 'STAIRWELL'
  | 'MECHANICAL'
  | 'STORAGE'
  | 'OFFICE'
  | 'GROUNDS'
  | 'COMMON_AREA'
  | 'GYM'
  | 'CAFETERIA'
  | 'OTHER';

export const SPACE_TYPES: SpaceType[] = [
  'CLASSROOM',
  'BATHROOM',
  'CORRIDOR',
  'STAIRWELL',
  'MECHANICAL',
  'STORAGE',
  'OFFICE',
  'GROUNDS',
  'COMMON_AREA',
  'GYM',
  'CAFETERIA',
  'OTHER',
];

export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export type WorkOrderType =
  | 'REPAIR'
  | 'INSTALLATION'
  | 'INSPECTION_PREP'
  | 'DEEP_CLEAN'
  | 'RENOVATION';

export type WorkOrderPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type WorkOrderStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'VENDOR_ASSIGNED'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELLED';

export type WorkOrderActivityType = 'STATUS_CHANGE' | 'REASSIGNMENT' | 'COMMENT' | 'ATTACHMENT';

export type PmTargetType = 'BUILDING' | 'SPACE' | 'SYSTEM';
export type PmTaskStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'OVERDUE';

export type InspectionOutcome = 'PENDING' | 'PASSED' | 'PASSED_WITH_CONDITIONS' | 'FAILED';

export type ViolationSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';
export type ZoneShift = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'OVERNIGHT';

// ── Buildings ──
export class CreateBuildingDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  yearBuilt?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  totalFloors?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;
}

export class UpdateBuildingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  yearBuilt?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  totalFloors?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BuildingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() code!: string | null;
  @ApiPropertyOptional() yearBuilt!: number | null;
  @ApiPropertyOptional() totalFloors!: number | null;
  @ApiPropertyOptional() address!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() spaceCount!: number;
  @ApiProperty() openWorkOrders!: number;
}

// ── Spaces ──
export class CreateSpaceDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  floor?: string;

  @ApiProperty({ enum: SPACE_TYPES })
  @IsIn(SPACE_TYPES)
  spaceType!: SpaceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  areaSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  schRoomId?: string | null;
}

export class UpdateSpaceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  floor?: string;

  @ApiPropertyOptional({ enum: SPACE_TYPES })
  @IsOptional()
  @IsIn(SPACE_TYPES)
  spaceType?: SpaceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  areaSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  schRoomId?: string | null;
}

export class SpaceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() buildingId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() floor!: string | null;
  @ApiProperty() spaceType!: SpaceType;
  @ApiPropertyOptional() areaSqft!: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional() schRoomId!: string | null;
  @ApiPropertyOptional() schRoomName!: string | null;
}

// ── Bookings ──
export class CreateBookingDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty()
  @IsISO8601()
  startsAt!: string;

  @ApiProperty()
  @IsISO8601()
  endsAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateBookingDto {
  @ApiPropertyOptional({ enum: ['CONFIRMED', 'CANCELLED', 'COMPLETED'] })
  @IsOptional()
  @IsIn(['CONFIRMED', 'CANCELLED', 'COMPLETED'])
  status?: BookingStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class BookingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() spaceId!: string;
  @ApiProperty() spaceName!: string;
  @ApiProperty() bookedBy!: string;
  @ApiPropertyOptional() bookedByName!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty() startsAt!: string;
  @ApiProperty() endsAt!: string;
  @ApiProperty() status!: BookingStatus;
  @ApiPropertyOptional() notes!: string | null;
}

// ── Closures ──
export class CreateClosureDto {
  @ApiProperty()
  @IsUUID()
  spaceId!: string;

  @ApiProperty()
  @IsString()
  closureReason!: string;

  @ApiProperty()
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  affectsScheduling?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  linkedWorkOrderId?: string;
}

export class UpdateClosureDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  closureReason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  affectsScheduling?: boolean;
}

export class ClosureResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() spaceId!: string;
  @ApiProperty() spaceName!: string;
  @ApiProperty() closureReason!: string;
  @ApiProperty() startsAt!: string;
  @ApiPropertyOptional() endsAt!: string | null;
  @ApiProperty() affectsScheduling!: boolean;
  @ApiPropertyOptional() linkedWorkOrderId!: string | null;
  @ApiProperty() createdBy!: string;
}

// ── Work Orders ──
export const WO_TYPES: WorkOrderType[] = [
  'REPAIR',
  'INSTALLATION',
  'INSPECTION_PREP',
  'DEEP_CLEAN',
  'RENOVATION',
];
export const WO_PRIORITIES: WorkOrderPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const WO_STATUSES: WorkOrderStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'VENDOR_ASSIGNED',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
];

export class CreateWorkOrderDto {
  @ApiProperty({ enum: WO_TYPES })
  @IsIn(WO_TYPES)
  workOrderType!: WorkOrderType;

  @ApiProperty({ enum: WO_PRIORITIES })
  @IsIn(WO_PRIORITIES)
  priority!: WorkOrderPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduledDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tktTicketId?: string;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional({ enum: WO_STATUSES })
  @IsOptional()
  @IsIn(WO_STATUSES)
  status?: WorkOrderStatus;

  @ApiPropertyOptional({ enum: WO_PRIORITIES })
  @IsOptional()
  @IsIn(WO_PRIORITIES)
  priority?: WorkOrderPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedToId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vendorId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduledDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  cost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class WorkOrderActivityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() workOrderId!: string;
  @ApiProperty() actorId!: string;
  @ApiPropertyOptional() actorName!: string | null;
  @ApiProperty() activityType!: WorkOrderActivityType;
  @ApiProperty() metadata!: unknown;
  @ApiProperty() createdAt!: string;
}

export class WorkOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() workOrderType!: WorkOrderType;
  @ApiProperty() priority!: WorkOrderPriority;
  @ApiPropertyOptional() spaceId!: string | null;
  @ApiPropertyOptional() spaceName!: string | null;
  @ApiPropertyOptional() buildingId!: string | null;
  @ApiPropertyOptional() buildingName!: string | null;
  @ApiPropertyOptional() assignedToId!: string | null;
  @ApiPropertyOptional() assignedToName!: string | null;
  @ApiPropertyOptional() vendorId!: string | null;
  @ApiPropertyOptional() vendorName!: string | null;
  @ApiPropertyOptional() scheduledDate!: string | null;
  @ApiPropertyOptional() completedAt!: string | null;
  @ApiProperty() status!: WorkOrderStatus;
  @ApiPropertyOptional() tktTicketId!: string | null;
  @ApiPropertyOptional() cost!: number | null;
  @ApiPropertyOptional() description!: string | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ type: [WorkOrderActivityResponseDto] })
  activity?: WorkOrderActivityResponseDto[];
}

export class AddWorkOrderCommentDto {
  @ApiProperty()
  @IsString()
  @Length(1, 4000)
  body!: string;
}

// ── PM Plans ──
export class CreatePmChecklistItemDto {
  @ApiProperty()
  @IsString()
  itemName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreatePmPlanDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  frequencyMonths!: number;

  @ApiProperty({ enum: ['BUILDING', 'SPACE', 'SYSTEM'] })
  @IsIn(['BUILDING', 'SPACE', 'SYSTEM'])
  targetType!: PmTargetType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ type: [CreatePmChecklistItemDto] })
  @IsOptional()
  @IsArray()
  items?: CreatePmChecklistItemDto[];
}

export class UpdatePmPlanDto {
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
  frequencyMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PmChecklistItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() planId!: string;
  @ApiProperty() itemName!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() sortOrder!: number;
}

export class PmPlanResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() frequencyMonths!: number;
  @ApiProperty() targetType!: PmTargetType;
  @ApiPropertyOptional() targetId!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: [PmChecklistItemResponseDto] })
  items!: PmChecklistItemResponseDto[];
}

export class GeneratePmTasksDto {
  @ApiProperty()
  @IsISO8601()
  fromDate!: string;

  @ApiProperty()
  @IsISO8601()
  toDate!: string;
}

export class UpdatePmTaskDto {
  @ApiPropertyOptional({ enum: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] })
  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'])
  status?: PmTaskStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class PmTaskResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() planId!: string;
  @ApiProperty() planName!: string;
  @ApiProperty() scheduledDate!: string;
  @ApiPropertyOptional() assignedTo!: string | null;
  @ApiPropertyOptional() assignedToName!: string | null;
  @ApiProperty() status!: PmTaskStatus;
  @ApiPropertyOptional() completedAt!: string | null;
  @ApiPropertyOptional() completedBy!: string | null;
  @ApiPropertyOptional() notes!: string | null;
}

export class SubmitChecklistResultDto {
  @ApiProperty()
  @IsUUID()
  checklistItemId!: string;

  @ApiProperty()
  @IsBoolean()
  passed!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  photoS3Keys?: string[];
}

export class SubmitChecklistResultsDto {
  @ApiProperty({ type: [SubmitChecklistResultDto] })
  @IsArray()
  results!: SubmitChecklistResultDto[];
}

export class ChecklistResultResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() taskId!: string;
  @ApiProperty() checklistItemId!: string;
  @ApiProperty() itemName!: string;
  @ApiProperty() passed!: boolean;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty() photoS3Keys!: string[];
  @ApiPropertyOptional() followUpWorkOrderId!: string | null;
  @ApiProperty() submittedBy!: string;
  @ApiProperty() submittedAt!: string;
}

// ── Inspection Types ──
export class CreateInspectionTypeDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsString()
  authority!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  frequencyMonths!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  failureEscalationDays?: number;
}

export class InspectionTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() authority!: string;
  @ApiProperty() frequencyMonths!: number;
  @ApiProperty() isMandatory!: boolean;
  @ApiPropertyOptional() failureEscalationDays!: number | null;
}

// ── Inspections ──
export class CreateInspectionDto {
  @ApiProperty()
  @IsUUID()
  inspectionTypeId!: string;

  @ApiProperty()
  @IsUUID()
  buildingId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduledDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  conductedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  inspectorName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  inspectorAgency?: string;

  @ApiProperty({ enum: ['PENDING', 'PASSED', 'PASSED_WITH_CONDITIONS', 'FAILED'] })
  @IsIn(['PENDING', 'PASSED', 'PASSED_WITH_CONDITIONS', 'FAILED'])
  outcome!: InspectionOutcome;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  certificateS3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  nextDueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class InspectionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() inspectionTypeId!: string;
  @ApiProperty() inspectionTypeName!: string;
  @ApiProperty() authority!: string;
  @ApiProperty() buildingId!: string;
  @ApiProperty() buildingName!: string;
  @ApiPropertyOptional() scheduledDate!: string | null;
  @ApiPropertyOptional() conductedDate!: string | null;
  @ApiPropertyOptional() inspectorName!: string | null;
  @ApiPropertyOptional() inspectorAgency!: string | null;
  @ApiProperty() outcome!: InspectionOutcome;
  @ApiPropertyOptional() certificateS3Key!: string | null;
  @ApiPropertyOptional() nextDueDate!: string | null;
  @ApiPropertyOptional() notes!: string | null;
}

// ── Violations ──
export class CreateViolationDto {
  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty({ enum: ['MINOR', 'MAJOR', 'CRITICAL'] })
  @IsIn(['MINOR', 'MAJOR', 'CRITICAL'])
  severity!: ViolationSeverity;

  @ApiProperty()
  @IsISO8601()
  dueDate!: string;
}

export class ResolveViolationDto {
  @ApiProperty()
  @IsString()
  resolutionNotes!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  linkedWorkOrderId?: string;
}

export class ViolationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() inspectionId!: string;
  @ApiProperty() description!: string;
  @ApiProperty() severity!: ViolationSeverity;
  @ApiProperty() dueDate!: string;
  @ApiPropertyOptional() resolvedAt!: string | null;
  @ApiPropertyOptional() resolvedBy!: string | null;
  @ApiPropertyOptional() resolvedByName!: string | null;
  @ApiPropertyOptional() resolutionNotes!: string | null;
  @ApiPropertyOptional() linkedWorkOrderId!: string | null;
}

// ── Zones ──
export class CreateZoneDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  color?: string;
}

export class CreateZoneAssignmentDto {
  @ApiProperty()
  @IsUUID()
  employeeId!: string;

  @ApiProperty()
  @IsISO8601()
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;

  @ApiProperty({ enum: ['MORNING', 'AFTERNOON', 'EVENING', 'OVERNIGHT'] })
  @IsIn(['MORNING', 'AFTERNOON', 'EVENING', 'OVERNIGHT'])
  shift!: ZoneShift;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateZoneAssignmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;

  @ApiPropertyOptional({ enum: ['MORNING', 'AFTERNOON', 'EVENING', 'OVERNIGHT'] })
  @IsOptional()
  @IsIn(['MORNING', 'AFTERNOON', 'EVENING', 'OVERNIGHT'])
  shift?: ZoneShift;
}

export class ZoneAssignmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() zoneId!: string;
  @ApiProperty() employeeId!: string;
  @ApiPropertyOptional() employeeName!: string | null;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional() effectiveTo!: string | null;
  @ApiProperty() shift!: ZoneShift;
  @ApiPropertyOptional() notes!: string | null;
}

export class ZoneResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiPropertyOptional() color!: string | null;
  @ApiProperty({ type: [ZoneAssignmentResponseDto] })
  assignments!: ZoneAssignmentResponseDto[];
}

// ── Supply ──
export class CreateSupplyDto {
  @ApiProperty()
  @IsUUID()
  buildingId!: string;

  @ApiProperty()
  @IsString()
  itemName!: string;

  @ApiProperty()
  @IsString()
  unit!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  currentQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  reorderThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preferredSupplier?: string;
}

export class AdjustSupplyDto {
  @ApiProperty()
  @IsNumber()
  @Min(0)
  currentQuantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  reorderThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class SupplyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() buildingId!: string;
  @ApiProperty() itemName!: string;
  @ApiProperty() unit!: string;
  @ApiProperty() currentQuantity!: number;
  @ApiPropertyOptional() reorderThreshold!: number | null;
  @ApiPropertyOptional() preferredSupplier!: string | null;
  @ApiPropertyOptional() lastRestockedAt!: string | null;
  @ApiProperty() belowThreshold!: boolean;
}
