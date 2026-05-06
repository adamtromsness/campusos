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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Enums ──
export type RouteDirection = 'AM' | 'PM';
export type RouteStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type AssignmentDirection = 'AM' | 'PM' | 'BOTH';
export type ChangeRequestType = 'DIFFERENT_STOP' | 'NO_BUS' | 'DIFFERENT_ROUTE';
export type ChangeRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type RouteChangeLogType =
  | 'STOP_ADDED'
  | 'STOP_REMOVED'
  | 'STOP_REORDERED'
  | 'STOP_TIME_CHANGED'
  | 'STUDENT_ADDED'
  | 'STUDENT_REMOVED'
  | 'ROUTE_ACTIVATED'
  | 'ROUTE_DEACTIVATED';
export type VehicleType = 'BUS' | 'MINIBUS' | 'VAN';
export type VehicleStatus = 'ACTIVE' | 'MAINTENANCE' | 'RETIRED';
export type DocumentType = 'INSURANCE' | 'REGISTRATION' | 'MOT' | 'INSPECTION';
export type InspectionStatus = 'PASS' | 'FAIL' | 'CONDITIONAL';
export type InspectionItemStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export type MaintenanceStatus = 'ON_SCHEDULE' | 'DUE_SOON' | 'OVERDUE';
export type CredentialType = 'CDL' | 'MEDICAL_CERTIFICATE' | 'BACKGROUND_CHECK' | 'FIRST_AID';
export type CredentialStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';
export type ScanDirection = 'BOARDING' | 'ALIGHTING';
export type ScanMethod = 'QR_CODE' | 'MANUAL' | 'RFID';
export type PassType = 'ANNUAL' | 'TERM' | 'DAILY';
export type RunStatus = 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type NoShowResolution =
  | 'ABSENT_CONFIRMED'
  | 'LATE_ARRIVAL'
  | 'PARENT_NOTIFIED'
  | 'FALSE_ALARM';

// ── Routes ──
export class CreateRouteDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ['AM', 'PM'] })
  @IsIn(['AM', 'PM'])
  direction!: RouteDirection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class UpdateRouteDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'ARCHIVED'])
  status?: RouteStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vehicleId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  driverId?: string | null;
}

export class StopResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() routeId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() address!: string | null;
  @ApiPropertyOptional() latitude!: number | null;
  @ApiPropertyOptional() longitude!: number | null;
  @ApiProperty() sequenceOrder!: number;
  @ApiPropertyOptional() scheduledTime!: string | null;
  @ApiPropertyOptional() notes!: string | null;
}

export class RouteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() direction!: RouteDirection;
  @ApiProperty() status!: RouteStatus;
  @ApiPropertyOptional() vehicleId!: string | null;
  @ApiPropertyOptional() vehicleRegistration!: string | null;
  @ApiPropertyOptional() driverId!: string | null;
  @ApiPropertyOptional() driverName!: string | null;
  @ApiPropertyOptional() academicYearId!: string | null;
  @ApiPropertyOptional() academicYearName!: string | null;
  @ApiProperty() stopCount!: number;
  @ApiProperty() studentCount!: number;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() stops?: StopResponseDto[];
}

// ── Stops ──
export class CreateStopDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  longitude?: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  sequenceOrder!: number;

  @ApiPropertyOptional({ description: 'HH:MM 24h time' })
  @IsOptional()
  @IsString()
  scheduledTime?: string;
}

export class UpdateStopDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  sequenceOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  scheduledTime?: string;
}

export class ReorderStopsItem {
  @ApiProperty()
  @IsUUID()
  stopId!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  sequenceOrder!: number;
}

export class ReorderStopsDto {
  @ApiProperty({ type: [ReorderStopsItem] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderStopsItem)
  stops!: ReorderStopsItem[];
}

// ── Student Assignments ──
export class CreateStudentAssignmentDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsUUID()
  stopId!: string;

  @ApiProperty({ enum: ['AM', 'PM', 'BOTH'] })
  @IsIn(['AM', 'PM', 'BOTH'])
  direction!: AssignmentDirection;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isOverride?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class StudentAssignmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() routeId!: string;
  @ApiProperty() stopId!: string;
  @ApiPropertyOptional() stopName!: string | null;
  @ApiPropertyOptional() stopSequence!: number | null;
  @ApiProperty() direction!: AssignmentDirection;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional() effectiveTo!: string | null;
  @ApiProperty() isOverride!: boolean;
  @ApiPropertyOptional() parentRequestId!: string | null;
  @ApiProperty() createdAt!: string;
}

// ── Route Change Requests ──
export class CreateRouteChangeRequestDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsISO8601()
  changeDate!: string;

  @ApiProperty({ enum: ['DIFFERENT_STOP', 'NO_BUS', 'DIFFERENT_ROUTE'] })
  @IsIn(['DIFFERENT_STOP', 'NO_BUS', 'DIFFERENT_ROUTE'])
  changeType!: ChangeRequestType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  requestedRouteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  requestedStopId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  reason?: string;
}

export class ApproveChangeRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewNotes?: string;
}

export class RejectChangeRequestDto {
  @ApiProperty()
  @IsString()
  @Length(2, 2000)
  reviewNotes!: string;
}

export class RouteChangeRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() submittedBy!: string;
  @ApiPropertyOptional() submittedByName!: string | null;
  @ApiProperty() changeDate!: string;
  @ApiProperty() changeType!: ChangeRequestType;
  @ApiPropertyOptional() requestedRouteId!: string | null;
  @ApiPropertyOptional() requestedStopId!: string | null;
  @ApiPropertyOptional() reason!: string | null;
  @ApiProperty() status!: ChangeRequestStatus;
  @ApiPropertyOptional() reviewedBy!: string | null;
  @ApiPropertyOptional() reviewedAt!: string | null;
  @ApiPropertyOptional() reviewNotes!: string | null;
  @ApiPropertyOptional() overrideAssignmentId!: string | null;
  @ApiProperty() createdAt!: string;
}

// ── Route Change Log ──
export class RouteChangeLogResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() routeId!: string;
  @ApiProperty() changedBy!: string;
  @ApiPropertyOptional() changedByName!: string | null;
  @ApiProperty() changedAt!: string;
  @ApiProperty() changeType!: RouteChangeLogType;
  @ApiPropertyOptional() stopId!: string | null;
  @ApiPropertyOptional() studentId!: string | null;
  @ApiPropertyOptional() oldValue!: Record<string, unknown> | null;
  @ApiPropertyOptional() newValue!: Record<string, unknown> | null;
  @ApiPropertyOptional() reason!: string | null;
}

// ── Vehicles ──
export class CreateVehicleDto {
  @ApiProperty()
  @IsString()
  @Length(1, 50)
  registration!: string;

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
  @IsInt()
  year?: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  capacity!: number;

  @ApiProperty({ enum: ['BUS', 'MINIBUS', 'VAN'] })
  @IsIn(['BUS', 'MINIBUS', 'VAN'])
  vehicleType!: VehicleType;
}

export class UpdateVehicleDto {
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
  @IsInt()
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'MAINTENANCE', 'RETIRED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'MAINTENANCE', 'RETIRED'])
  status?: VehicleStatus;
}

export class VehicleDocumentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() documentType!: DocumentType;
  @ApiPropertyOptional() documentNumber!: string | null;
  @ApiPropertyOptional() s3Key!: string | null;
  @ApiPropertyOptional() issuedDate!: string | null;
  @ApiProperty() expiryDate!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() expiryStatus!: 'CURRENT' | 'EXPIRING_SOON' | 'EXPIRED';
  @ApiProperty() daysUntilExpiry!: number;
}

export class VehicleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() registration!: string;
  @ApiPropertyOptional() make!: string | null;
  @ApiPropertyOptional() model!: string | null;
  @ApiPropertyOptional() year!: number | null;
  @ApiProperty() capacity!: number;
  @ApiProperty() vehicleType!: VehicleType;
  @ApiProperty() status!: VehicleStatus;
  @ApiProperty() documentSummary!: {
    total: number;
    current: number;
    expiringSoon: number;
    expired: number;
  };
  @ApiProperty() createdAt!: string;
}

export class CreateVehicleDocumentDto {
  @ApiProperty({ enum: ['INSURANCE', 'REGISTRATION', 'MOT', 'INSPECTION'] })
  @IsIn(['INSURANCE', 'REGISTRATION', 'MOT', 'INSPECTION'])
  documentType!: DocumentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  issuedDate?: string;

  @ApiProperty()
  @IsISO8601()
  expiryDate!: string;
}

// ── Inspections ──
export class CreateInspectionItemDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  itemName!: string;

  @ApiProperty({ enum: ['PASS', 'FAIL', 'NOT_APPLICABLE'] })
  @IsIn(['PASS', 'FAIL', 'NOT_APPLICABLE'])
  status!: InspectionItemStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateInspectionDto {
  @ApiProperty()
  @IsISO8601()
  inspectionDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ type: [CreateInspectionItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInspectionItemDto)
  items!: CreateInspectionItemDto[];
}

export class InspectionItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() inspectionId!: string;
  @ApiProperty() itemName!: string;
  @ApiProperty() status!: InspectionItemStatus;
  @ApiPropertyOptional() notes!: string | null;
}

export class InspectionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() driverId!: string;
  @ApiPropertyOptional() driverName!: string | null;
  @ApiProperty() inspectionDate!: string;
  @ApiProperty() overallStatus!: InspectionStatus;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty() completedAt!: string;
  @ApiPropertyOptional() items?: InspectionItemResponseDto[];
}

// ── Driver Credentials ──
export class CreateDriverCredentialDto {
  @ApiProperty({ enum: ['CDL', 'MEDICAL_CERTIFICATE', 'BACKGROUND_CHECK', 'FIRST_AID'] })
  @IsIn(['CDL', 'MEDICAL_CERTIFICATE', 'BACKGROUND_CHECK', 'FIRST_AID'])
  credentialType!: CredentialType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  credentialNumber?: string;

  @ApiProperty()
  @IsISO8601()
  issuedDate!: string;

  @ApiProperty()
  @IsISO8601()
  expiryDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;
}

export class UpdateDriverCredentialDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  credentialNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  issuedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  s3Key?: string;

  @ApiPropertyOptional({ description: 'Mark credential as verified' })
  @IsOptional()
  @IsBoolean()
  verify?: boolean;
}

export class DriverCredentialResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty() credentialType!: CredentialType;
  @ApiPropertyOptional() credentialNumber!: string | null;
  @ApiProperty() issuedDate!: string;
  @ApiProperty() expiryDate!: string;
  @ApiPropertyOptional() s3Key!: string | null;
  @ApiProperty() status!: CredentialStatus;
  @ApiProperty() daysUntilExpiry!: number;
  @ApiPropertyOptional() verifiedBy!: string | null;
  @ApiPropertyOptional() verifiedAt!: string | null;
}

export class DriverResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name!: string | null;
  @ApiProperty() credentials!: DriverCredentialResponseDto[];
}

// ── Bus Passes ──
export class CreateBusPassDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: ['ANNUAL', 'TERM', 'DAILY'] })
  @IsIn(['ANNUAL', 'TERM', 'DAILY'])
  passType!: PassType;

  @ApiProperty()
  @IsISO8601()
  validFrom!: string;

  @ApiProperty()
  @IsISO8601()
  validTo!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class UpdateBusPassDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BusPassResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() passType!: PassType;
  @ApiProperty() qrCodeToken!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() validFrom!: string;
  @ApiProperty() validTo!: string;
  @ApiProperty() issuedAt!: string;
}

// ── Ridership ──
export class ScanRidershipDto {
  @ApiProperty()
  @IsString()
  qrCodeToken!: string;

  @ApiProperty()
  @IsUUID()
  stopId!: string;

  @ApiProperty({ enum: ['BOARDING', 'ALIGHTING'] })
  @IsIn(['BOARDING', 'ALIGHTING'])
  scanDirection!: ScanDirection;
}

export class RidershipResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() routeId!: string;
  @ApiProperty() stopId!: string;
  @ApiPropertyOptional() stopName!: string | null;
  @ApiProperty() scanDirection!: ScanDirection;
  @ApiProperty() scannedAt!: string;
  @ApiProperty() scanMethod!: ScanMethod;
}

// ── Run Logs ──
export class CreateRunLogDto {
  @ApiProperty()
  @IsUUID()
  routeId!: string;

  @ApiProperty()
  @IsISO8601()
  runDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  odometerStart?: number;
}

export class CompleteRunLogDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  odometerEnd?: number;

  @ApiPropertyOptional({ enum: ['COMPLETED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['COMPLETED', 'CANCELLED'])
  status?: 'COMPLETED' | 'CANCELLED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RunLogResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() routeId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty() runDate!: string;
  @ApiPropertyOptional() departureTime!: string | null;
  @ApiPropertyOptional() arrivalTime!: string | null;
  @ApiPropertyOptional() odometerStart!: number | null;
  @ApiPropertyOptional() odometerEnd!: number | null;
  @ApiProperty() studentsBoarded!: number;
  @ApiProperty() status!: RunStatus;
}

// ── No-Show Alerts ──
export class ResolveNoShowDto {
  @ApiProperty({
    enum: ['ABSENT_CONFIRMED', 'LATE_ARRIVAL', 'PARENT_NOTIFIED', 'FALSE_ALARM'],
  })
  @IsIn(['ABSENT_CONFIRMED', 'LATE_ARRIVAL', 'PARENT_NOTIFIED', 'FALSE_ALARM'])
  resolution!: NoShowResolution;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resolutionNotes?: string;
}

export class NoShowAlertResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() routeId!: string;
  @ApiProperty() expectedDate!: string;
  @ApiProperty() expectedStopId!: string;
  @ApiPropertyOptional() expectedStopName!: string | null;
  @ApiProperty() alertTime!: string;
  @ApiPropertyOptional() resolution!: NoShowResolution | null;
  @ApiPropertyOptional() resolvedBy!: string | null;
  @ApiPropertyOptional() resolvedAt!: string | null;
  @ApiPropertyOptional() parentNotifiedAt!: string | null;
  @ApiPropertyOptional() resolutionNotes!: string | null;
}

// ── Delays ──
export class CreateDelayReportDto {
  @ApiProperty()
  @IsUUID()
  routeId!: string;

  @ApiProperty()
  @IsISO8601()
  runDate!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  delayMinutes!: number;

  @ApiProperty()
  @IsString()
  @Length(2, 2000)
  reason!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedStops?: string[];
}

export class DelayReportResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() routeId!: string;
  @ApiProperty() runDate!: string;
  @ApiProperty() reportedBy!: string;
  @ApiProperty() delayMinutes!: number;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional() affectedStops!: string[] | null;
  @ApiProperty() parentNotificationSent!: boolean;
  @ApiProperty() reportedAt!: string;
}

// ── Maintenance ──
export class CreateMaintenanceDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  serviceType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMiles?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  nextDueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  nextDueMileage?: number;
}

export class MaintenanceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() serviceType!: string;
  @ApiPropertyOptional() intervalMiles!: number | null;
  @ApiPropertyOptional() intervalMonths!: number | null;
  @ApiPropertyOptional() lastServiceDate!: string | null;
  @ApiPropertyOptional() lastServiceMileage!: number | null;
  @ApiPropertyOptional() nextDueDate!: string | null;
  @ApiPropertyOptional() nextDueMileage!: number | null;
  @ApiProperty() status!: MaintenanceStatus;
}
