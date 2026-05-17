import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================
// Enum unions — P2-11b Route Generation Pipeline
// ============================================================
export type GenerationRequestType = 'FULL_YEAR' | 'TERM' | 'DATE_RANGE' | 'SINGLE_DATE';
export type GenerationDirections = 'AM_ONLY' | 'PM_ONLY' | 'BOTH';
export type GenerationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type CandidateDirection = 'AM' | 'PM';
export type CandidateVehicleType = 'BUS' | 'MINIBUS' | 'VAN';
export type CandidateReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED';
export type AdhocTripPurpose =
  | 'FIELD_TRIP'
  | 'ATHLETIC_EVENT'
  | 'SPECIAL_EVENT'
  | 'MEDICAL_TRANSPORT'
  | 'OTHER';
export type AdhocTripStatus = 'REQUESTED' | 'APPROVED' | 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export type ContractedRouteFrequency = 'WEEKLY' | 'MONTHLY' | 'TERM';

const TIME_REGEX = /^\d{2}:\d{2}(:\d{2})?$/;

// ============================================================
// Constraint profiles
// ============================================================
export class CreateRouteConstraintDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  constraintName!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRideTimeMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxRouteMileage?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxStudentsPerVehicle?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  requiredArrivalBufferMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxStopsPerRoute?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  walkableRadiusMetres?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateRouteConstraintDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  constraintName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRideTimeMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxRouteMileage?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxStudentsPerVehicle?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  requiredArrivalBufferMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxStopsPerRoute?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  walkableRadiusMetres?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class RouteConstraintResponseDto {
  id!: string;
  schoolId!: string;
  constraintName!: string;
  maxRideTimeMinutes!: number;
  maxRouteMileage!: number | null;
  maxStudentsPerVehicle!: number | null;
  requiredArrivalBufferMinutes!: number;
  maxStopsPerRoute!: number | null;
  walkableRadiusMetres!: number;
  isActive!: boolean;
  notes!: string | null;
  createdBy!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ============================================================
// Generation requests
// ============================================================
export class QueueGenerationRequestDto {
  @IsIn(['FULL_YEAR', 'TERM', 'DATE_RANGE', 'SINGLE_DATE'])
  requestType!: GenerationRequestType;

  @IsUUID()
  constraintId!: string;

  @IsOptional()
  @IsIn(['AM_ONLY', 'PM_ONLY', 'BOTH'])
  directions?: GenerationDirections;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsOptional()
  @IsUUID()
  termId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

export interface GenerationCandidateInline {
  id: string;
  candidateName: string;
  direction: CandidateDirection;
  vehicleTypeRequired: CandidateVehicleType;
  totalStudents: number;
  totalStops: number;
  estimatedRouteMileage: number;
  estimatedDurationMinutes: number;
  maxStudentRideTimeMinutes: number;
  allConstraintsSatisfied: boolean;
  constraintViolations: Record<string, unknown> | null;
  reviewStatus: CandidateReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  approvedRouteId: string | null;
  createdAt: string;
}

export class GenerationRequestResponseDto {
  id!: string;
  schoolId!: string;
  requestedBy!: string;
  requestType!: GenerationRequestType;
  academicYearId!: string | null;
  termId!: string | null;
  dateFrom!: string | null;
  dateTo!: string | null;
  constraintId!: string;
  constraintName!: string | null;
  directions!: GenerationDirections;
  status!: GenerationStatus;
  optimiserRunId!: string | null;
  routesGenerated!: number | null;
  studentsCovered!: number | null;
  studentsUncovered!: number | null;
  errorMessage!: string | null;
  queuedAt!: string;
  startedAt!: string | null;
  completedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
  candidates?: GenerationCandidateInline[];
}

// ============================================================
// Generation candidates
// ============================================================
export class CandidateStopInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  stopName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsInt()
  @Min(1)
  sequenceOrder!: number;

  @IsOptional()
  @IsString()
  @Matches(TIME_REGEX, { message: 'scheduledTime must be HH:MM or HH:MM:SS' })
  scheduledTime?: string;

  @IsArray()
  @IsUUID('all', { each: true })
  studentIds!: string[];
}

export class CreateManualCandidateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  candidateName!: string;

  @IsIn(['AM', 'PM'])
  direction!: CandidateDirection;

  @IsIn(['BUS', 'MINIBUS', 'VAN'])
  vehicleTypeRequired!: CandidateVehicleType;

  @IsNumber()
  @Min(0)
  estimatedRouteMileage!: number;

  @IsInt()
  @Min(0)
  estimatedDurationMinutes!: number;

  @IsInt()
  @Min(0)
  maxStudentRideTimeMinutes!: number;

  @IsOptional()
  @IsBoolean()
  allConstraintsSatisfied?: boolean;

  @IsOptional()
  @IsObject()
  constraintViolations?: Record<string, unknown>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CandidateStopInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  stops!: CandidateStopInputDto[];
}

export class GenerationCandidateStopResponseDto {
  id!: string;
  candidateId!: string;
  stopName!: string;
  address!: string | null;
  latitude!: number;
  longitude!: number;
  sequenceOrder!: number;
  scheduledTime!: string | null;
  studentIds!: string[];
  studentCount!: number;
}

export class GenerationCandidateResponseDto {
  id!: string;
  requestId!: string;
  candidateName!: string;
  direction!: CandidateDirection;
  vehicleTypeRequired!: CandidateVehicleType;
  totalStudents!: number;
  totalStops!: number;
  estimatedRouteMileage!: number;
  estimatedDurationMinutes!: number;
  maxStudentRideTimeMinutes!: number;
  allConstraintsSatisfied!: boolean;
  constraintViolations!: Record<string, unknown> | null;
  reviewStatus!: CandidateReviewStatus;
  reviewedBy!: string | null;
  reviewedAt!: string | null;
  reviewNotes!: string | null;
  approvedRouteId!: string | null;
  createdAt!: string;
  updatedAt!: string;
  stops?: GenerationCandidateStopResponseDto[];
}

export class ApproveCandidateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  routeName!: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNotes?: string;
}

export class RejectCandidateDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(2000)
  reviewNotes!: string;
}

// ============================================================
// Ad-hoc trip requests
// ============================================================
export class CreateAdhocTripDto {
  @IsIn(['FIELD_TRIP', 'ATHLETIC_EVENT', 'SPECIAL_EVENT', 'MEDICAL_TRANSPORT', 'OTHER'])
  tripPurpose!: AdhocTripPurpose;

  @IsDateString()
  tripDate!: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_REGEX, { message: 'departureTime must be HH:MM or HH:MM:SS' })
  departureTime?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_REGEX, { message: 'returnTime must be HH:MM or HH:MM:SS' })
  returnTime?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  pickupLocation!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  destination!: string;

  @IsInt()
  @Min(1)
  estimatedPassengers!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specialRequirements?: string;

  @IsOptional()
  @IsUUID()
  linkedEventId?: string;
}

export class AssignAdhocTripDto {
  @IsUUID()
  vehicleId!: string;

  @IsUUID()
  driverId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  approvalNotes?: string;
}

export class CancelAdhocTripDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(2000)
  cancellationReason!: string;
}

export class AdhocTripResponseDto {
  id!: string;
  schoolId!: string;
  requestedBy!: string;
  requestedByName!: string | null;
  tripPurpose!: AdhocTripPurpose;
  tripDate!: string;
  departureTime!: string | null;
  returnTime!: string | null;
  pickupLocation!: string;
  destination!: string;
  estimatedPassengers!: number;
  specialRequirements!: string | null;
  linkedEventId!: string | null;
  assignedVehicleId!: string | null;
  assignedVehicleName!: string | null;
  assignedDriverId!: string | null;
  assignedDriverName!: string | null;
  status!: AdhocTripStatus;
  linkedApprovalId!: string | null;
  approvalNotes!: string | null;
  cancellationReason!: string | null;
  scheduledAt!: string | null;
  completedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

// ============================================================
// Contracted routes
// ============================================================
export class CreateContractedRouteDto {
  @IsUUID()
  routeId!: string;

  @IsOptional()
  @IsUUID()
  contractorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractReference?: string;

  @IsDateString()
  contractStartDate!: string;

  @IsDateString()
  contractEndDate!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyRate?: number;

  @IsOptional()
  @IsIn(['WEEKLY', 'MONTHLY', 'TERM'])
  paymentFrequency?: ContractedRouteFrequency;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateContractedRouteDto {
  @IsOptional()
  @IsUUID()
  contractorId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractReference?: string | null;

  @IsOptional()
  @IsDateString()
  contractEndDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyRate?: number | null;

  @IsOptional()
  @IsIn(['WEEKLY', 'MONTHLY', 'TERM'])
  paymentFrequency?: ContractedRouteFrequency;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  performanceRating?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class ContractedRouteResponseDto {
  id!: string;
  routeId!: string;
  routeName!: string | null;
  contractorId!: string | null;
  contractReference!: string | null;
  contractStartDate!: string;
  contractEndDate!: string;
  dailyRate!: number | null;
  paymentFrequency!: ContractedRouteFrequency;
  performanceRating!: number | null;
  notes!: string | null;
  isActive!: boolean;
  createdBy!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
