import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const INCIDENT_SEVERITIES: IncidentSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export type IncidentStatus = 'ACTIVE' | 'RESOLVED' | 'CANCELLED';
export const INCIDENT_STATUSES: IncidentStatus[] = ['ACTIVE', 'RESOLVED', 'CANCELLED'];

export type ProcedureType =
  | 'FIRE_EVACUATION'
  | 'LOCKDOWN'
  | 'SHELTER_IN_PLACE'
  | 'MEDICAL_EMERGENCY'
  | 'BOMB_THREAT'
  | 'HAZMAT'
  | 'MISSING_STUDENT'
  | 'SAFEGUARDING_CRISIS'
  | 'GENERAL';
export const PROCEDURE_TYPES: ProcedureType[] = [
  'FIRE_EVACUATION',
  'LOCKDOWN',
  'SHELTER_IN_PLACE',
  'MEDICAL_EMERGENCY',
  'BOMB_THREAT',
  'HAZMAT',
  'MISSING_STUDENT',
  'SAFEGUARDING_CRISIS',
  'GENERAL',
];

export type AccountabilityPersonType = 'STUDENT' | 'STAFF' | 'VISITOR';
export const ACCOUNTABILITY_PERSON_TYPES: AccountabilityPersonType[] = [
  'STUDENT',
  'STAFF',
  'VISITOR',
];

export type AccountabilityStatus =
  | 'UNKNOWN'
  | 'ACCOUNTED_FOR'
  | 'EVACUATED'
  | 'MEDICAL_ASSISTANCE'
  | 'MISSING';
export const ACCOUNTABILITY_STATUSES: AccountabilityStatus[] = [
  'UNKNOWN',
  'ACCOUNTED_FOR',
  'EVACUATED',
  'MEDICAL_ASSISTANCE',
  'MISSING',
];

export type DrillStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export const DRILL_STATUSES: DrillStatus[] = ['SCHEDULED', 'COMPLETED', 'CANCELLED'];

export type NonDisciplineIncidentType =
  | 'STUDENT_INJURY'
  | 'STAFF_INJURY'
  | 'MEDICAL_EPISODE'
  | 'PROPERTY_DAMAGE'
  | 'ENVIRONMENTAL'
  | 'SECURITY'
  | 'OTHER';
export const NON_DISCIPLINE_INCIDENT_TYPES: NonDisciplineIncidentType[] = [
  'STUDENT_INJURY',
  'STAFF_INJURY',
  'MEDICAL_EPISODE',
  'PROPERTY_DAMAGE',
  'ENVIRONMENTAL',
  'SECURITY',
  'OTHER',
];

export type NonDisciplineSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export const NON_DISCIPLINE_SEVERITIES: NonDisciplineSeverity[] = ['LOW', 'MEDIUM', 'HIGH'];

export type NonDisciplineStatus = 'OPEN' | 'UNDER_REVIEW' | 'CLOSED';
export const NON_DISCIPLINE_STATUSES: NonDisciplineStatus[] = ['OPEN', 'UNDER_REVIEW', 'CLOSED'];

// ----- Incident type management ---------------------------------------------

export class CreateIncidentTypeDto {
  @ApiProperty() @IsString() @Length(1, 60) code!: string;
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiProperty({ enum: INCIDENT_SEVERITIES })
  @IsIn(INCIDENT_SEVERITIES)
  severity!: IncidentSeverity;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresLockdown?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notificationTemplate?: string;
}

export class UpdateIncidentTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES })
  @IsOptional()
  @IsIn(INCIDENT_SEVERITIES)
  severity?: IncidentSeverity;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresLockdown?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notificationTemplate?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class IncidentTypeDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() schoolId!: string | null;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: INCIDENT_SEVERITIES }) severity!: IncidentSeverity;
  @ApiProperty() requiresLockdown!: boolean;
  @ApiPropertyOptional() notificationTemplate!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

// ----- Procedure management ------------------------------------------------

export class ProcedureStepDto {
  @ApiProperty() @IsInt() @Min(1) stepNumber!: number;
  @ApiProperty() @IsString() @Length(3, 1000) action!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) responsibleRole?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) timeTargetSeconds?: number;
}

export class ExternalContactDto {
  @ApiProperty() @IsString() @Length(1, 100) agency!: string;
  @ApiProperty() @IsString() @Length(1, 60) phone!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class AssemblyPointDto {
  @ApiProperty() @IsString() @Length(1, 200) name!: string;
  @ApiProperty() @IsInt() @Min(1) priority!: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) capacity?: number;
}

export class CreateProcedureDto {
  @ApiProperty({ enum: PROCEDURE_TYPES }) @IsIn(PROCEDURE_TYPES) procedureType!: ProcedureType;
  @ApiProperty() @IsString() @Length(1, 200) title!: string;
  @ApiProperty({ type: [ProcedureStepDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProcedureStepDto)
  @ArrayMaxSize(50)
  procedureSteps!: ProcedureStepDto[];
  @ApiProperty() @IsUUID() primaryContactId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() secondaryContactId?: string;
  @ApiPropertyOptional({ type: [ExternalContactDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalContactDto)
  @ArrayMaxSize(20)
  externalContacts?: ExternalContactDto[];
  @ApiPropertyOptional({ type: [AssemblyPointDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssemblyPointDto)
  @ArrayMaxSize(20)
  assemblyPoints?: AssemblyPointDto[];
  @ApiProperty() @IsString() lastReviewedAt!: string;
  @ApiProperty() @IsString() nextReviewDate!: string;
  @ApiProperty() @IsUUID() reviewedBy!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) procedureDocumentS3Key?: string;
}

export class UpdateProcedureDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) title?: string;
  @ApiPropertyOptional({ type: [ProcedureStepDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProcedureStepDto)
  @ArrayMaxSize(50)
  procedureSteps?: ProcedureStepDto[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() primaryContactId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() secondaryContactId?: string;
  @ApiPropertyOptional({ type: [ExternalContactDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalContactDto)
  @ArrayMaxSize(20)
  externalContacts?: ExternalContactDto[];
  @ApiPropertyOptional({ type: [AssemblyPointDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssemblyPointDto)
  @ArrayMaxSize(20)
  assemblyPoints?: AssemblyPointDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() lastReviewedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() nextReviewDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reviewedBy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) procedureDocumentS3Key?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ProcedureDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: PROCEDURE_TYPES }) procedureType!: ProcedureType;
  @ApiProperty() title!: string;
  @ApiProperty() procedureSteps!: ProcedureStepDto[];
  @ApiProperty() primaryContactId!: string;
  @ApiPropertyOptional() secondaryContactId!: string | null;
  @ApiPropertyOptional() externalContacts!: ExternalContactDto[] | null;
  @ApiPropertyOptional() assemblyPoints!: AssemblyPointDto[] | null;
  @ApiProperty() lastReviewedAt!: string;
  @ApiProperty() reviewedBy!: string;
  @ApiProperty() nextReviewDate!: string;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional() procedureDocumentS3Key!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

// ----- Incident lifecycle ---------------------------------------------------

export class DeclareIncidentDto {
  @ApiProperty() @IsUUID() incidentTypeId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class ResolveIncidentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(10, 4000) resolutionNotes?: string;
}

export class IncidentDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional() incidentTypeId!: string | null;
  @ApiPropertyOptional() incidentTypeCode!: string | null;
  @ApiPropertyOptional() incidentTypeName!: string | null;
  @ApiPropertyOptional() severity!: IncidentSeverity | null;
  @ApiProperty() declaredBy!: string;
  @ApiPropertyOptional() declaredByName!: string | null;
  @ApiProperty() declaredAt!: string;
  @ApiPropertyOptional() title!: string | null;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty({ enum: INCIDENT_STATUSES }) status!: IncidentStatus;
  @ApiPropertyOptional() resolvedAt!: string | null;
  @ApiPropertyOptional() resolvedBy!: string | null;
  @ApiPropertyOptional() resolutionNotes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() requiresLockdown!: boolean | null;
  @ApiPropertyOptional() outboxStatus!: OutboxStatusDto | null;
}

export class OutboxStatusDto {
  @ApiProperty() id!: string;
  @ApiProperty() incidentId!: string;
  @ApiProperty() declaredAt!: string;
  @ApiPropertyOptional() tasksCreatedAt!: string | null;
  @ApiPropertyOptional() musterTakenAt!: string | null;
  @ApiPropertyOptional() alertSentAt!: string | null;
  @ApiPropertyOptional() lastAttemptAt!: string | null;
  @ApiProperty() attemptCount!: number;
  @ApiPropertyOptional() lastError!: string | null;
}

export class ListIncidentsQueryDto {
  @ApiPropertyOptional({ enum: INCIDENT_STATUSES })
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: IncidentStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}

// ----- Timeline -------------------------------------------------------------

export class CreateTimelineEntryDto {
  @ApiProperty() @IsString() @Length(1, 100) eventType!: string;
  @ApiProperty() @IsString() @Length(1, 4000) description!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class TimelineEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() incidentId!: string;
  @ApiProperty() recordedBy!: string;
  @ApiPropertyOptional() recordedByName!: string | null;
  @ApiProperty() eventType!: string;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() metadata!: Record<string, unknown> | null;
  @ApiProperty() recordedAt!: string;
}

// ----- Accountability -------------------------------------------------------

export class UpdateAccountabilityDto {
  @ApiProperty({ enum: ACCOUNTABILITY_STATUSES })
  @IsIn(ACCOUNTABILITY_STATUSES)
  status!: AccountabilityStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class BulkUpdateAccountabilityDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(500)
  recordIds!: string[];
  @ApiProperty({ enum: ACCOUNTABILITY_STATUSES })
  @IsIn(ACCOUNTABILITY_STATUSES)
  status!: AccountabilityStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class AccountabilityRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() incidentId!: string;
  @ApiProperty() personId!: string;
  @ApiProperty({ enum: ACCOUNTABILITY_PERSON_TYPES }) personType!: AccountabilityPersonType;
  @ApiProperty({ enum: ACCOUNTABILITY_STATUSES }) status!: AccountabilityStatus;
  @ApiPropertyOptional() lastUpdatedBy!: string | null;
  @ApiPropertyOptional() lastUpdatedAt!: string | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional() personName!: string | null;
}

export class AccountabilitySummaryDto {
  @ApiProperty() incidentId!: string;
  @ApiProperty() totalPeople!: number;
  @ApiProperty() accountedFor!: number;
  @ApiProperty() unknown!: number;
  @ApiProperty() evacuated!: number;
  @ApiProperty() medicalAssistance!: number;
  @ApiProperty() missing!: number;
  @ApiProperty() lastUpdatedAt!: string;
}

// ----- Reunification --------------------------------------------------------

export class CreateReunificationDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsUUID() releasedToId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CorrectReunificationDto {
  @ApiProperty() @IsString() @Length(20, 4000) correctionReason!: string;
}

export class ReunificationRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() incidentId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() releasedToId!: string;
  @ApiPropertyOptional() releasedToName!: string | null;
  @ApiProperty() releasedBy!: string;
  @ApiPropertyOptional() releasedByName!: string | null;
  @ApiProperty() releasedAt!: string;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty() corrections!: ReunificationCorrectionDto[];
}

export class ReunificationCorrectionDto {
  @ApiProperty() id!: string;
  @ApiProperty() reunificationRecordId!: string;
  @ApiProperty() correctedBy!: string;
  @ApiPropertyOptional() correctedByName!: string | null;
  @ApiProperty() correctionReason!: string;
  @ApiProperty() correctedAt!: string;
}

// ----- Drills ---------------------------------------------------------------

export class CreateDrillDto {
  @ApiProperty({ enum: PROCEDURE_TYPES }) @IsIn(PROCEDURE_TYPES) procedureType!: ProcedureType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() incidentTypeId?: string;
  @ApiProperty() @IsString() scheduledAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CompleteDrillDto {
  @ApiProperty() @IsString() completedAt!: string;
  @ApiProperty() @IsInt() @Min(1) durationSeconds!: number;
  @ApiProperty() @IsNumber() @Min(0) @Max(1) participationRate!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CancelDrillDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class DrillDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional() incidentTypeId!: string | null;
  @ApiProperty({ enum: PROCEDURE_TYPES }) procedureType!: ProcedureType;
  @ApiProperty() scheduledAt!: string;
  @ApiPropertyOptional() completedAt!: string | null;
  @ApiPropertyOptional() durationSeconds!: number | null;
  @ApiPropertyOptional() participationRate!: number | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty({ enum: DRILL_STATUSES }) status!: DrillStatus;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class OverdueDrillDto {
  @ApiProperty({ enum: PROCEDURE_TYPES }) procedureType!: ProcedureType;
  @ApiPropertyOptional() lastCompletedAt!: string | null;
  @ApiProperty() daysSinceLastDrill!: number;
}

// ----- Non-discipline incident reports --------------------------------------

export class CreateNonDisciplineDto {
  @ApiProperty({ enum: NON_DISCIPLINE_INCIDENT_TYPES })
  @IsIn(NON_DISCIPLINE_INCIDENT_TYPES)
  incidentType!: NonDisciplineIncidentType;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) location?: string;
  @ApiProperty() @IsString() incidentDate!: string;
  @ApiProperty() @IsString() @Length(10, 8000) description!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(50)
  studentsInvolved?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(50)
  staffInvolved?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) witnesses?: string;
  @ApiProperty({ enum: NON_DISCIPLINE_SEVERITIES })
  @IsIn(NON_DISCIPLINE_SEVERITIES)
  severity!: NonDisciplineSeverity;
  @ApiPropertyOptional() @IsOptional() @IsUUID() followUpTicketId?: string;
}

export class UpdateNonDisciplineDto {
  @ApiPropertyOptional({ enum: NON_DISCIPLINE_STATUSES })
  @IsOptional()
  @IsIn(NON_DISCIPLINE_STATUSES)
  status?: NonDisciplineStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8000) resolution?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() followUpTicketId?: string;
}

export class NonDisciplineIncidentDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: NON_DISCIPLINE_INCIDENT_TYPES }) incidentType!: NonDisciplineIncidentType;
  @ApiPropertyOptional() location!: string | null;
  @ApiProperty() incidentDate!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: [String] }) studentsInvolved!: string[];
  @ApiProperty({ type: [String] }) staffInvolved!: string[];
  @ApiPropertyOptional() witnesses!: string | null;
  @ApiProperty() reportedBy!: string;
  @ApiPropertyOptional() reportedByName!: string | null;
  @ApiProperty({ enum: NON_DISCIPLINE_SEVERITIES }) severity!: NonDisciplineSeverity;
  @ApiPropertyOptional() followUpTicketId!: string | null;
  @ApiPropertyOptional() resolution!: string | null;
  @ApiProperty({ enum: NON_DISCIPLINE_STATUSES }) status!: NonDisciplineStatus;
  @ApiPropertyOptional() reviewedBy!: string | null;
  @ApiPropertyOptional() reviewedAt!: string | null;
  @ApiPropertyOptional() closedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ListNonDisciplineQueryDto {
  @ApiPropertyOptional({ enum: NON_DISCIPLINE_STATUSES })
  @IsOptional()
  @IsIn(NON_DISCIPLINE_STATUSES)
  status?: NonDisciplineStatus;
  @ApiPropertyOptional({ enum: NON_DISCIPLINE_INCIDENT_TYPES })
  @IsOptional()
  @IsIn(NON_DISCIPLINE_INCIDENT_TYPES)
  incidentType?: NonDisciplineIncidentType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() @Type(() => Boolean) mineOnly?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  limit?: number;
}
