import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const PAY_GRADE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export const PAY_PERIOD_STATUSES = ['OPEN', 'PROCESSING', 'PAID', 'CLOSED'] as const;
export type PayPeriodStatus = (typeof PAY_PERIOD_STATUSES)[number];

export const PAYROLL_RECORD_STATUSES = ['DRAFT', 'APPROVED', 'PAID'] as const;
export type PayrollRecordStatus = (typeof PAYROLL_RECORD_STATUSES)[number];

export const DEDUCTION_TYPES = [
  'FEDERAL_TAX',
  'STATE_TAX',
  'SOCIAL_SECURITY',
  'MEDICARE',
  'HEALTH_INSURANCE',
  'RETIREMENT',
  'OTHER',
] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

export const ADJUSTMENT_TYPES = [
  'RETROACTIVE_PAY',
  'BONUS',
  'BACK_PAY',
  'OVERPAYMENT_RECOVERY',
  'SIGNING_BONUS',
  'SEVERANCE',
  'OTHER',
] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export const ADJUSTMENT_STATUSES = ['PENDING', 'APPROVED', 'APPLIED', 'REJECTED'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

export const SALARY_REVIEW_TYPES = [
  'ANNUAL_INCREMENT',
  'PROMOTION',
  'MARKET_ADJUSTMENT',
  'PERFORMANCE_BONUS',
  'RETENTION',
] as const;
export type SalaryReviewType = (typeof SALARY_REVIEW_TYPES)[number];

export const SALARY_REVIEW_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type SalaryReviewStatus = (typeof SALARY_REVIEW_STATUSES)[number];

// ----- Pay grades + scales -------------------------------------------------

export class CreatePayGradeDto {
  @ApiProperty() @IsString() @MaxLength(120) gradeName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) minSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxSalary?: number;
}

export class UpdatePayGradeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) gradeName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) minSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export interface PayGradeDto {
  id: string;
  schoolId: string;
  gradeName: string;
  description: string | null;
  minSalary: number | null;
  maxSalary: number | null;
  isActive: boolean;
  scales: SalaryScaleDto[];
}

export class CreateSalaryScaleDto {
  @ApiProperty() @IsInt() @Min(1) step!: number;
  @ApiProperty() @IsNumber() @Min(0) annualSalary!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateSalaryScaleDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) step?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) annualSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export interface SalaryScaleDto {
  id: string;
  payGradeId: string;
  step: number;
  annualSalary: number;
  notes: string | null;
}

// ----- Pay periods + records + deductions ---------------------------------

export class CreatePayPeriodDto {
  @ApiProperty() @IsString() @MaxLength(120) periodLabel!: string;
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiProperty() @IsDateString() endDate!: string;
  @ApiProperty() @IsDateString() payDate!: string;
}

export interface PayPeriodDto {
  id: string;
  schoolId: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  payDate: string;
  status: PayPeriodStatus;
  processedAt: string | null;
  paidAt: string | null;
  recordCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
}

export class ListPayPeriodsQueryDto {
  @ApiPropertyOptional({ enum: PAY_PERIOD_STATUSES })
  @IsOptional()
  @IsIn([...PAY_PERIOD_STATUSES])
  status?: PayPeriodStatus;
}

export interface PayrollDeductionDto {
  id: string;
  payrollRecordId: string;
  deductionType: DeductionType;
  description: string | null;
  amount: number;
  isPretax: boolean;
}

export interface PayrollRecordDto {
  id: string;
  schoolId: string;
  employeeId: string;
  employeeName: string | null;
  payPeriodId: string;
  payPeriodLabel: string;
  payDate: string;
  salaryScaleId: string | null;
  grossPay: number;
  totalDeductions: number;
  totalAdjustments: number;
  netPay: number;
  status: PayrollRecordStatus;
  notes: string | null;
  deductions: PayrollDeductionDto[];
  createdAt: string;
}

export class ListPayrollRecordsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() payPeriodId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional({ enum: PAYROLL_RECORD_STATUSES })
  @IsOptional()
  @IsIn([...PAYROLL_RECORD_STATUSES])
  status?: PayrollRecordStatus;
}

export class AssignSalaryScaleDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiProperty() @IsUUID() salaryScaleId!: string;
}

// ----- Salary reviews -----------------------------------------------------

export class CreateSalaryReviewDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiProperty({ enum: SALARY_REVIEW_TYPES })
  @IsIn([...SALARY_REVIEW_TYPES])
  reviewType!: SalaryReviewType;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) currentSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) recommendedSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() effectiveDate?: string;
  @ApiProperty() @IsString() @MaxLength(2000) justification!: string;
}

export class UpdateSalaryReviewDto {
  @ApiPropertyOptional({ enum: SALARY_REVIEW_STATUSES })
  @IsOptional()
  @IsIn([...SALARY_REVIEW_STATUSES])
  status?: SalaryReviewStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) decisionNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) recommendedSalary?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) justification?: string;
}

export interface SalaryReviewDto {
  id: string;
  schoolId: string;
  employeeId: string;
  employeeName: string | null;
  requestedBy: string;
  requestedByName: string | null;
  reviewType: SalaryReviewType;
  currentSalary: number | null;
  recommendedSalary: number | null;
  effectiveDate: string | null;
  justification: string;
  status: SalaryReviewStatus;
  decisionNotes: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export class ListSalaryReviewsQueryDto {
  @ApiPropertyOptional({ enum: SALARY_REVIEW_STATUSES })
  @IsOptional()
  @IsIn([...SALARY_REVIEW_STATUSES])
  status?: SalaryReviewStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
}

// ----- Adjustments --------------------------------------------------------

export class CreateAdjustmentDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiProperty({ enum: ADJUSTMENT_TYPES })
  @IsIn([...ADJUSTMENT_TYPES])
  adjustmentType!: AdjustmentType;
  @ApiProperty() @IsNumber() amount!: number;
  @ApiProperty() @IsString() @MaxLength(1000) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() effectivePayPeriodId?: string;
}

export interface AdjustmentDto {
  id: string;
  employeeId: string;
  employeeName: string | null;
  effectivePayPeriodId: string | null;
  adjustmentType: AdjustmentType;
  amount: number;
  reason: string;
  status: AdjustmentStatus;
  createdAt: string;
}

// ----- Worker payload -----------------------------------------------------

export class ProcessPayPeriodDto {
  @ApiPropertyOptional({
    description:
      'Optional explicit employee subset; default = all active employees with a salary scale',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  employeeIds?: string[];
}

// ----- Tax info + benefits (read-only DTOs for now; CRUD lands in P2-4c) --

export interface EmployeeTaxInfoDto {
  id: string;
  employeeId: string;
  filingStatus: string | null;
  federalAllowances: number;
  stateAllowances: number;
  additionalWithholding: number;
  stateCode: string | null;
}

export interface EmployeeBenefitDto {
  id: string;
  employeeId: string;
  benefitType: string;
  planName: string | null;
  employeeContribution: number;
  employerContribution: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export class UpsertTaxInfoDto {
  @ApiPropertyOptional() @IsOptional() @IsString() filingStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) federalAllowances?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) stateAllowances?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) additionalWithholding?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() stateCode?: string;
}

export class CreateBenefitDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiProperty()
  @IsIn(['HEALTH', 'DENTAL', 'VISION', 'LIFE', 'RETIREMENT'])
  benefitType!: 'HEALTH' | 'DENTAL' | 'VISION' | 'LIFE' | 'RETIREMENT';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) planName?: string;
  @ApiProperty() @IsNumber() @Min(0) employeeContribution!: number;
  @ApiProperty() @IsNumber() @Min(0) employerContribution!: number;
  @ApiProperty() @IsDateString() effectiveFrom!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() effectiveTo?: string;
}

// dummy to silence unused-import warnings if class-transformer not used yet
const _t: typeof Type | undefined = undefined;
const _v: typeof ValidateNested | undefined = undefined;
const _i: typeof IsPositive | undefined = undefined;
void _t;
void _v;
void _i;
