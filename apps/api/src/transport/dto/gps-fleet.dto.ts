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
export type VehiclePositionSource = 'GPS' | 'MANUAL' | 'SIMULATED';
export const VEHICLE_POSITION_SOURCES: VehiclePositionSource[] = ['GPS', 'MANUAL', 'SIMULATED'];

export type GeofenceType = 'SCHOOL' | 'STOP' | 'SPEED_ZONE' | 'RESTRICTED_AREA';
export const GEOFENCE_TYPES: GeofenceType[] = ['SCHOOL', 'STOP', 'SPEED_ZONE', 'RESTRICTED_AREA'];

export type GeofenceEventType = 'ENTER' | 'EXIT';

export type ETAConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export const ETA_CONFIDENCES: ETAConfidence[] = ['HIGH', 'MEDIUM', 'LOW'];

export type DispatchEventType =
  | 'ROUTE_STARTED'
  | 'ROUTE_COMPLETED'
  | 'DELAY_REPORTED'
  | 'BREAKDOWN_REPORTED'
  | 'STUDENT_NO_SHOW'
  | 'EMERGENCY_STOP'
  | 'DETOUR'
  | 'DRIVER_SWAP';
export const DISPATCH_EVENT_TYPES: DispatchEventType[] = [
  'ROUTE_STARTED',
  'ROUTE_COMPLETED',
  'DELAY_REPORTED',
  'BREAKDOWN_REPORTED',
  'STUDENT_NO_SHOW',
  'EMERGENCY_STOP',
  'DETOUR',
  'DRIVER_SWAP',
];

// ============================================================
// Vehicle positions
// ============================================================
export class IngestVehiclePositionDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  speedKmh?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number;

  @IsOptional()
  @IsDateString()
  recordedAt?: string;

  @IsOptional()
  @IsIn(VEHICLE_POSITION_SOURCES)
  source?: VehiclePositionSource;
}

export interface VehiclePositionResponseDto {
  id: string;
  vehicleId: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  heading: number | null;
  recordedAt: string;
  source: VehiclePositionSource;
}

// ============================================================
// Geofences
// ============================================================
export interface GeofenceBoundary {
  type: 'circle' | 'polygon';
  center?: { lat: number; lng: number };
  radius_metres?: number;
  coordinates?: number[][];
}

export class CreateGeofenceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsIn(GEOFENCE_TYPES)
  geofenceType!: GeofenceType;

  @IsObject()
  boundary!: GeofenceBoundary;

  @IsOptional()
  @IsInt()
  @Min(0)
  speedLimitKmh?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateGeofenceDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsObject()
  boundary?: GeofenceBoundary;

  @IsOptional()
  @IsInt()
  @Min(0)
  speedLimitKmh?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export interface GeofenceResponseDto {
  id: string;
  schoolId: string;
  name: string;
  geofenceType: GeofenceType;
  boundary: GeofenceBoundary;
  speedLimitKmh: number | null;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GeofenceEventResponseDto {
  id: string;
  geofenceId: string;
  geofenceName: string | null;
  vehicleId: string;
  vehicleRegistration: string | null;
  eventType: GeofenceEventType;
  recordedAt: string;
  speedAtEvent: number | null;
  latitude: number | null;
  longitude: number | null;
}

// ============================================================
// ETA
// ============================================================
export interface VehicleETAResponseDto {
  id: string;
  vehicleId: string;
  vehicleRegistration: string | null;
  stopId: string;
  stopName: string | null;
  eta: string;
  computedAt: string;
  confidence: ETAConfidence;
  distanceMetres: number | null;
  minutesUntilEta: number;
}

// ============================================================
// Dispatch events
// ============================================================
export class CreateDispatchEventDto {
  @IsIn(DISPATCH_EVENT_TYPES)
  eventType!: DispatchEventType;

  @IsOptional()
  @IsUUID('all')
  vehicleId?: string;

  @IsOptional()
  @IsUUID('all')
  routeId?: string;

  @IsOptional()
  @IsUUID('all')
  driverId?: string;

  @IsOptional()
  @IsObject()
  eventData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  recordedAt?: string;
}

export interface DispatchEventResponseDto {
  id: string;
  schoolId: string;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  routeId: string | null;
  routeName: string | null;
  driverId: string | null;
  eventType: DispatchEventType;
  eventData: Record<string, unknown> | null;
  recordedAt: string;
  recordedBy: string | null;
  notes: string | null;
  createdAt: string;
}

// ============================================================
// Parent tracking tokens
// ============================================================
export class CreateParentTrackingTokenDto {
  @IsUUID('all')
  studentId!: string;

  @IsUUID('all')
  routeId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

export interface ParentTrackingTokenResponseDto {
  id: string;
  studentId: string;
  routeId: string;
  token: string;
  expiresAt: string;
  isActive: boolean;
  revokedAt: string | null;
  createdAt: string;
}

export interface ParentTrackingViewDto {
  // Public-facing payload — NO student PII, NO route metadata beyond
  // the matching stop. Token-scoped to a single (student, route) pair.
  routeId: string;
  routeName: string;
  routeDirection: string;
  vehicle: {
    id: string;
    registration: string;
    latitude: number | null;
    longitude: number | null;
    speedKmh: number | null;
    heading: number | null;
    lastUpdatedAt: string | null;
  } | null;
  stopEta: {
    stopId: string;
    stopName: string;
    eta: string;
    confidence: ETAConfidence;
    minutesUntilEta: number;
  } | null;
  expiresAt: string;
}

// ============================================================
// Fleet status (rpt_fleet_status)
// ============================================================
export interface FleetStatusRowDto {
  id: string;
  vehicleId: string;
  schoolId: string;
  vehicleRegistration: string;
  vehicleStatus: string;
  daysUntilInsuranceExpiry: number | null;
  daysUntilRegistrationExpiry: number | null;
  daysUntilMotExpiry: number | null;
  daysUntilLicenceExpiry: number | null;
  maintenanceOverdue: boolean;
  lastIncidentDate: string | null;
  totalIncidentsThisYear: number;
  currentRouteAssignment: string | null;
  currentRouteId: string | null;
  lastPositionAt: string | null;
  fuelEfficiencyLastMonth: number | null;
  openSafetyCriticalRepairCount: number;
  materialisedAt: string;
}
