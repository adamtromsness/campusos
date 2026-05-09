import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const EVENT_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const CERTIFICATION_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

export class CreateTrainingProgrammeDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isMandatory?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(120) renewalMonths?: number;
}

export class UpdateTrainingProgrammeDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isMandatory?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(120) renewalMonths?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateTrainingEventDto {
  @IsUUID() programmeId!: string;
  @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @IsDateString() scheduledAt!: string;
  @IsOptional() @IsInt() @Min(1) @Max(2880) durationMinutes?: number;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(200) facilitator?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxParticipants?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateTrainingEventDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(2880) durationMinutes?: number;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(200) facilitator?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxParticipants?: number;
  @IsOptional() @IsIn(EVENT_STATUSES) status?: EventStatus;
  @IsOptional()
  @ValidateIf((o) => o.status === 'CANCELLED')
  @IsString()
  @Matches(/\S/, { message: 'cancellationReason must not be empty when CANCELLED' })
  @MaxLength(500)
  cancellationReason?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class RecordCompletionDto {
  @IsUUID() employeeId!: string;
  @IsOptional() @IsDateString() completedAt?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) score?: number;
  @IsOptional() @IsBoolean() passed?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CreateCertificationTypeDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(200) issuingBody?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) validityMonths?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
}

export class UpdateCertificationTypeDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) issuingBody?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) validityMonths?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateEmployeeCertificationDto {
  @IsUUID() employeeId!: string;
  @IsUUID() certificationTypeId!: string;
  @IsDateString() issuedAt!: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(500) documentS3Key?: string;
  @IsOptional() @IsString() @MaxLength(200) referenceNumber?: string;
}

export class RevokeEmployeeCertificationDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

export interface TrainingProgrammeDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  isMandatory: boolean;
  renewalMonths: number | null;
  isActive: boolean;
  createdAt: string;
}

export interface TrainingEventDto {
  id: string;
  programmeId: string;
  programmeName: string | null;
  schoolId: string;
  title: string;
  scheduledAt: string;
  durationMinutes: number | null;
  location: string | null;
  facilitator: string | null;
  maxParticipants: number | null;
  status: EventStatus;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  completionCount: number;
  createdAt: string;
}

export interface TrainingCompletionDto {
  id: string;
  eventId: string;
  eventTitle: string | null;
  programmeId: string | null;
  programmeName: string | null;
  employeeId: string;
  employeeName: string | null;
  schoolId: string;
  completedAt: string;
  score: number | null;
  passed: boolean;
  notes: string | null;
  createdAt: string;
}

export interface CertificationTypeDto {
  id: string;
  schoolId: string;
  name: string;
  issuingBody: string | null;
  description: string | null;
  validityMonths: number | null;
  isRequired: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface EmployeeCertificationDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  certificationTypeId: string;
  certificationTypeName: string | null;
  schoolId: string;
  issuedAt: string;
  expiresAt: string | null;
  documentS3Key: string | null;
  referenceNumber: string | null;
  status: CertificationStatus;
  revokedAt: string | null;
  revokedReason: string | null;
  daysUntilExpiry: number | null;
  createdAt: string;
}
