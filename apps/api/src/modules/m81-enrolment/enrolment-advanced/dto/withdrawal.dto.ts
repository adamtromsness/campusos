import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const WITHDRAWAL_REASONS = [
  'FAMILY_RELOCATION',
  'TRANSFER_TO_OTHER_SCHOOL',
  'HOME_EDUCATION',
  'EXCLUSION',
  'MEDICAL',
  'FEE_DEFAULT',
  'SAFEGUARDING',
  'GRADUATION',
  'DECEASED',
  'OTHER',
] as const;
export type WithdrawalReason = (typeof WITHDRAWAL_REASONS)[number];

export const INITIATED_BY = ['FAMILY', 'SCHOOL'] as const;
export type InitiatedBy = (typeof INITIATED_BY)[number];

export const WITHDRAWAL_STATUSES = ['REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const TASK_CATEGORIES = [
  'ADMINISTRATIVE',
  'FINANCE',
  'IT',
  'FACILITIES',
  'TRANSPORT',
  'RECORDS',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_STATUSES = ['PENDING', 'COMPLETED', 'WAIVED', 'NOT_APPLICABLE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MID_YEAR_REASONS = [
  'FAMILY_RELOCATION',
  'TRANSFER_FROM_OTHER_SCHOOL',
  'RETURNING_FROM_ABROAD',
  'HOME_EDUCATION_ENDING',
  'LOOKED_AFTER_CHILD',
  'OTHER',
] as const;
export type MidYearReason = (typeof MID_YEAR_REASONS)[number];

export const MID_YEAR_STATUSES = [
  'RECEIVED',
  'CAPACITY_CHECKED',
  'OFFER_MADE',
  'ENROLLED',
  'DECLINED',
  'WITHDRAWN',
] as const;
export type MidYearStatus = (typeof MID_YEAR_STATUSES)[number];

export class CreateWithdrawalDto {
  @IsUUID()
  studentId!: string;

  @IsIn(INITIATED_BY as unknown as string[])
  initiatedBy!: InitiatedBy;

  @IsIn(WITHDRAWAL_REASONS as unknown as string[])
  withdrawalReasonCategory!: WithdrawalReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  withdrawalReasonDetail?: string;

  @IsISO8601()
  lastAttendanceDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  destinationSchoolName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  destinationSchoolCountry?: string;

  @IsOptional()
  @IsBoolean()
  recordsReleaseConsented?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CompleteWithdrawalDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CancelWithdrawalDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class PlaceReenrolHoldDto {
  @IsBoolean()
  hold!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class UpdateExitTaskDto {
  @IsIn(['COMPLETED', 'WAIVED', 'NOT_APPLICABLE', 'PENDING'] as string[])
  status!: TaskStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export interface ExitTaskResponseDto {
  id: string;
  withdrawalId: string;
  taskName: string;
  taskCategory: TaskCategory;
  status: TaskStatus;
  completedBy: string | null;
  completedByName: string | null;
  completedAt: string | null;
  notes: string | null;
  sortOrder: number;
}

export interface WithdrawalResponseDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  initiatedBy: InitiatedBy;
  requestedBy: string;
  requestedByName: string | null;
  withdrawalReasonCategory: WithdrawalReason;
  withdrawalReasonDetail: string | null;
  lastAttendanceDate: string;
  requestedAt: string;
  destinationSchoolName: string | null;
  destinationSchoolCountry: string | null;
  recordsReleaseConsented: boolean;
  recordsSentAt: string | null;
  status: WithdrawalStatus;
  completedAt: string | null;
  completedBy: string | null;
  completedByName: string | null;
  reEnrollmentHoldPlaced: boolean;
  reEnrollmentHoldReason: string | null;
  notes: string | null;
  exitTasks: ExitTaskResponseDto[];
  exitTaskSummary: {
    pending: number;
    completed: number;
    waived: number;
    notApplicable: number;
    total: number;
  };
  createdAt: string;
  updatedAt: string;
}

export class CreateReenrolDto {
  @IsUUID()
  studentId!: string;

  @IsUUID()
  academicYearId!: string;

  @IsBoolean()
  confirmedContinuing!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  withdrawalReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export interface ReenrolResponseDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  academicYearId: string;
  academicYearName: string | null;
  submittedBy: string;
  submittedByName: string | null;
  confirmedContinuing: boolean;
  withdrawalReason: string | null;
  submittedAt: string;
  processedBy: string | null;
  processedByName: string | null;
  processedAt: string | null;
  linkedWithdrawalId: string | null;
  notes: string | null;
}

export interface ReenrolSummaryDto {
  academicYearId: string;
  academicYearName: string | null;
  totalStudents: number;
  totalConfirmed: number;
  continuing: number;
  departing: number;
  outstanding: number;
  perGrade: Array<{
    gradeLevel: string;
    continuing: number;
    departing: number;
    outstanding: number;
    total: number;
  }>;
}

export class CreateMidYearAdmissionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  studentFirstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  studentLastName!: string;

  @IsISO8601()
  studentDateOfBirth!: string;

  @IsString()
  @MaxLength(20)
  applyingForGradeLevel!: string;

  @IsISO8601()
  requestedStartDate!: string;

  @IsIn(MID_YEAR_REASONS as unknown as string[])
  admissionReason!: MidYearReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  admissionReasonDetail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  previousSchoolName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  previousSchoolCountry?: string;

  @IsOptional()
  @IsBoolean()
  recordsRequested?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateMidYearAdmissionDto {
  @IsOptional()
  @IsIn(MID_YEAR_STATUSES as unknown as string[])
  status?: MidYearStatus;

  @IsOptional()
  @IsBoolean()
  capacityAvailable?: boolean;

  @IsOptional()
  @IsUUID()
  linkedApplicationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export interface MidYearAdmissionResponseDto {
  id: string;
  schoolId: string;
  requestedBy: string;
  requestedByName: string | null;
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  applyingForGradeLevel: string;
  requestedStartDate: string;
  admissionReason: MidYearReason;
  admissionReasonDetail: string | null;
  previousSchoolName: string | null;
  previousSchoolCountry: string | null;
  recordsRequested: boolean;
  status: MidYearStatus;
  capacityAvailable: boolean | null;
  capacityCheckedAt: string | null;
  capacityCheckedBy: string | null;
  capacityCheckedByName: string | null;
  linkedApplicationId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ----- Step 8 task template DTOs -----

export class TaskTemplateRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  taskName!: string;

  @IsIn(TASK_CATEGORIES as unknown as string[])
  taskCategory!: TaskCategory;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpsertTaskTemplateDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskTemplateRowDto)
  tasks!: TaskTemplateRowDto[];
}

export interface TaskTemplateResponseDto {
  id: string;
  schoolId: string;
  templateName: string;
  taskName: string;
  taskCategory: TaskCategory;
  sortOrder: number;
  isActive: boolean;
  isRequired: boolean;
}
