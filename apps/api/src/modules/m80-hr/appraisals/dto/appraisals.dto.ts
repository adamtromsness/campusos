import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
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
  ValidateIf,
} from 'class-validator';

export const APPRAISAL_RATINGS = [
  'OUTSTANDING',
  'GOOD',
  'REQUIRES_IMPROVEMENT',
  'INADEQUATE',
] as const;
export type AppraisalRating = (typeof APPRAISAL_RATINGS)[number];

export const APPRAISAL_STATUSES = ['DRAFT', 'IN_REVIEW', 'SIGNED_OFF'] as const;
export type AppraisalStatus = (typeof APPRAISAL_STATUSES)[number];

export const CYCLE_TYPES = ['ANNUAL', 'MID_YEAR', 'PROBATIONARY'] as const;
export type CycleType = (typeof CYCLE_TYPES)[number];

export const CYCLE_STATUSES = ['OPEN', 'CLOSED', 'ARCHIVED'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const GOAL_PROGRESSES = ['NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'NOT_ACHIEVED'] as const;
export type GoalProgress = (typeof GOAL_PROGRESSES)[number];

export const EXPENSE_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'PAID'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export class CreateAppraisalFrameworkDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsObject() criteria?: unknown;
}

export class UpdateAppraisalFrameworkDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsObject() criteria?: unknown;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateAppraisalCycleDto {
  @IsUUID() academicYearId!: string;
  @IsUUID() frameworkId!: string;
  @IsIn(CYCLE_TYPES) cycleType!: CycleType;
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsDateString() startsOn!: string;
  @IsDateString() endsOn!: string;
}

export class UpdateAppraisalCycleDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsDateString() startsOn?: string;
  @IsOptional() @IsDateString() endsOn?: string;
  @IsOptional() @IsIn(CYCLE_STATUSES) status?: CycleStatus;
}

export class CreateAppraisalDto {
  @IsUUID() cycleId!: string;
  @IsUUID() employeeId!: string;
  @IsOptional() @IsUUID() appraiserId?: string;
}

export class UpdateAppraisalDto {
  @IsOptional() @IsUUID() appraiserId?: string;
  @IsOptional() @IsIn(APPRAISAL_RATINGS) overallRating?: AppraisalRating;
  @IsOptional() @IsString() @MaxLength(8000) selfReview?: string;
  @IsOptional() @IsString() @MaxLength(8000) appraiserReview?: string;
  @IsOptional() @IsString() @MaxLength(8000) developmentPlan?: string;
  @IsOptional() @IsIn(APPRAISAL_STATUSES) status?: AppraisalStatus;
}

export class CreateAppraisalGoalDto {
  @IsString() @MinLength(2) @MaxLength(2000) goalText!: string;
  @IsOptional() @IsString() @MaxLength(2000) successCriteria?: string;
  @IsOptional() @IsDateString() targetDate?: string;
  @IsOptional() @IsInt() @Min(0) @Max(99) sortOrder?: number;
}

export class UpdateAppraisalGoalDto {
  @IsOptional() @IsString() @MaxLength(2000) goalText?: string;
  @IsOptional() @IsString() @MaxLength(2000) successCriteria?: string;
  @IsOptional() @IsDateString() targetDate?: string;
  @IsOptional() @IsIn(GOAL_PROGRESSES) progress?: GoalProgress;
  @IsOptional() @IsString() @MaxLength(2000) progressNotes?: string;
}

export class CreateLessonObservationDto {
  @IsOptional() @IsUUID() appraisalId?: string;
  @IsUUID() observedEmployeeId!: string;
  @IsDateString() observationDate!: string;
  @IsString() @MinLength(2) @MaxLength(200) observedClassLabel!: string;
  @IsOptional() @IsUUID() observedClassId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(480) durationMinutes?: number;
  @IsOptional() @IsIn(APPRAISAL_RATINGS) overallGrade?: AppraisalRating;
  @IsOptional() @IsString() @MaxLength(8000) strengths?: string;
  @IsOptional() @IsString() @MaxLength(8000) areasForDevelopment?: string;
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
}

export class UpdateLessonObservationDto {
  @IsOptional() @IsString() @MaxLength(200) observedClassLabel?: string;
  @IsOptional() @IsInt() @Min(1) @Max(480) durationMinutes?: number;
  @IsOptional() @IsIn(APPRAISAL_RATINGS) overallGrade?: AppraisalRating;
  @IsOptional() @IsString() @MaxLength(8000) strengths?: string;
  @IsOptional() @IsString() @MaxLength(8000) areasForDevelopment?: string;
  @IsOptional() @IsString() @MaxLength(8000) notes?: string;
}

export class CreateAppraisalCommentDto {
  @IsString() @MinLength(2) @MaxLength(8000) commentText!: string;
  @IsOptional() @IsBoolean() isVisibleToEmployee?: boolean;
}

export class CreateExpenseClaimDto {
  @IsString() @MinLength(2) @MaxLength(200) claimTitle!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsDateString() incurredOn!: string;
  @IsNumber() @Min(0.01) totalAmount!: number;
  @IsOptional() @IsArray() @IsString({ each: true }) receiptS3Keys?: string[];
}

export class DecideExpenseClaimDto {
  @IsIn(['APPROVED', 'REJECTED'] as const) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional()
  @ValidateIf((o) => o.decision === 'REJECTED')
  @IsString()
  @Matches(/\S/, { message: 'rejectionReason is required when REJECTED.' })
  @MaxLength(1000)
  rejectionReason?: string;
}

export class MarkExpensePaidDto {
  @IsOptional() @IsDateString() paidAt?: string;
}

// DTO output shapes

export interface AppraisalFrameworkDto {
  id: string;
  schoolId: string;
  name: string;
  description: string | null;
  criteria: unknown;
  isActive: boolean;
  createdAt: string;
}

export interface AppraisalCycleDto {
  id: string;
  schoolId: string;
  academicYearId: string;
  frameworkId: string;
  frameworkName: string | null;
  cycleType: CycleType;
  name: string;
  startsOn: string;
  endsOn: string;
  status: CycleStatus;
  closedAt: string | null;
  createdAt: string;
}

export interface AppraisalGoalDto {
  id: string;
  appraisalId: string;
  goalText: string;
  successCriteria: string | null;
  targetDate: string | null;
  progress: GoalProgress;
  progressNotes: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface AppraisalCommentDto {
  id: string;
  appraisalId: string;
  authorId: string;
  authorName: string | null;
  commentText: string;
  isVisibleToEmployee: boolean;
  createdAt: string;
}

export interface LessonObservationDto {
  id: string;
  appraisalId: string | null;
  schoolId: string;
  observerId: string;
  observerName: string | null;
  observedEmployeeId: string;
  observedEmployeeName: string | null;
  observationDate: string;
  observedClassLabel: string;
  observedClassId: string | null;
  durationMinutes: number | null;
  overallGrade: AppraisalRating | null;
  strengths: string | null;
  areasForDevelopment: string | null;
  notes: string | null;
  isLocked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
}

export interface AppraisalDto {
  id: string;
  cycleId: string;
  cycleName: string | null;
  cycleType: CycleType | null;
  employeeId: string;
  employeeName: string | null;
  appraiserId: string | null;
  appraiserName: string | null;
  schoolId: string;
  overallRating: AppraisalRating | null;
  selfReview: string | null;
  appraiserReview: string | null;
  developmentPlan: string | null;
  status: AppraisalStatus;
  signedOffAt: string | null;
  signedOffBy: string | null;
  signedOffByName: string | null;
  linkedApprovalId: string | null;
  goals: AppraisalGoalDto[];
  observations: LessonObservationDto[];
  comments: AppraisalCommentDto[];
  createdAt: string;
}

export interface ExpenseClaimDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  schoolId: string;
  claimTitle: string;
  description: string | null;
  incurredOn: string;
  totalAmount: number;
  receiptS3Keys: string[];
  status: ExpenseStatus;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

// Eslint helper to silence unused Type import — kept for symmetry
// with other DTO modules that nest @Type() decorators.
void Type;
