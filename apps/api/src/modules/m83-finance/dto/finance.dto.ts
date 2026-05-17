import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Enums (kept in sync with the SQL CHECK constraints) ───

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type FundType =
  | 'GENERAL'
  | 'SPECIAL_REVENUE'
  | 'CAPITAL_PROJECTS'
  | 'DEBT_SERVICE'
  | 'PERMANENT'
  | 'ENTERPRISE';
export type PeriodStatus = 'FUTURE' | 'OPEN' | 'CLOSED' | 'LOCKED';
export type BatchType =
  | 'MANUAL'
  | 'AUTO_PAYMENT'
  | 'AUTO_INVOICE'
  | 'AUTO_REFUND'
  | 'ADJUSTMENT'
  | 'AUTO_PAYROLL';
export type BatchStatus = 'DRAFT' | 'POSTED' | 'VOIDED';
export type SupplierType = 'VENDOR' | 'CONTRACTOR' | 'UTILITY' | 'OTHER';
export type BudgetStatus = 'DRAFT' | 'APPROVED' | 'AMENDED';
export type APVoucherStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'VOIDED' | 'ON_HOLD';
export type PaymentMethod = 'CHECK' | 'ACH' | 'WIRE' | 'CREDIT_CARD';
export type ReconciliationStatus = 'IN_PROGRESS' | 'RECONCILED' | 'VARIANCE_FLAGGED';
export type ReportType = 'BALANCE_SHEET' | 'INCOME_STATEMENT' | 'BUDGET_VS_ACTUAL' | 'CASH_FLOW';
export type GrantStatus = 'ACTIVE' | 'CLOSED' | 'REPORTING';

const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const NORMAL_BALANCES: NormalBalance[] = ['DEBIT', 'CREDIT'];
const FUND_TYPES: FundType[] = [
  'GENERAL',
  'SPECIAL_REVENUE',
  'CAPITAL_PROJECTS',
  'DEBT_SERVICE',
  'PERMANENT',
  'ENTERPRISE',
];
const PERIOD_STATUSES: PeriodStatus[] = ['FUTURE', 'OPEN', 'CLOSED', 'LOCKED'];
const BATCH_TYPES: BatchType[] = [
  'MANUAL',
  'AUTO_PAYMENT',
  'AUTO_INVOICE',
  'AUTO_REFUND',
  'ADJUSTMENT',
  'AUTO_PAYROLL',
];
const SUPPLIER_TYPES: SupplierType[] = ['VENDOR', 'CONTRACTOR', 'UTILITY', 'OTHER'];
const BUDGET_STATUSES: BudgetStatus[] = ['DRAFT', 'APPROVED', 'AMENDED'];
const AP_VOUCHER_STATUSES: APVoucherStatus[] = ['PENDING', 'APPROVED', 'PAID', 'VOIDED', 'ON_HOLD'];
const PAYMENT_METHODS: PaymentMethod[] = ['CHECK', 'ACH', 'WIRE', 'CREDIT_CARD'];
const RECONCILIATION_STATUSES: ReconciliationStatus[] = [
  'IN_PROGRESS',
  'RECONCILED',
  'VARIANCE_FLAGGED',
];
const REPORT_TYPES: ReportType[] = [
  'BALANCE_SHEET',
  'INCOME_STATEMENT',
  'BUDGET_VS_ACTUAL',
  'CASH_FLOW',
];
const GRANT_STATUSES: GrantStatus[] = ['ACTIVE', 'CLOSED', 'REPORTING'];

// ─── DTOs ───

export class FundDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() fundCode!: string;
  @ApiProperty() fundName!: string;
  @ApiProperty({ enum: FUND_TYPES }) fundType!: FundType;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateFundDto {
  @IsString() @Length(1, 32) fundCode!: string;
  @IsString() @Length(1, 200) fundName!: string;
  @IsIn(FUND_TYPES) fundType!: FundType;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class UpdateFundDto {
  @IsOptional() @IsString() @Length(1, 200) fundName?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ChartAccountDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() accountCode!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty({ enum: ACCOUNT_TYPES }) accountType!: AccountType;
  @ApiProperty({ enum: NORMAL_BALANCES }) normalBalance!: NormalBalance;
  @ApiPropertyOptional({ nullable: true }) parentAccountId!: string | null;
  @ApiPropertyOptional({ nullable: true }) parentAccountCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) fundId!: string | null;
  @ApiPropertyOptional({ nullable: true }) fundCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() runningBalance!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateChartAccountDto {
  @IsString() @Length(1, 32) accountCode!: string;
  @IsString() @Length(1, 200) accountName!: string;
  @IsIn(ACCOUNT_TYPES) accountType!: AccountType;
  @IsIn(NORMAL_BALANCES) normalBalance!: NormalBalance;
  @IsOptional() @IsUUID() parentAccountId?: string;
  @IsOptional() @IsUUID() fundId?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isSystem?: boolean;
}

export class UpdateChartAccountDto {
  @IsOptional() @IsString() @Length(1, 200) accountName?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsUUID() parentAccountId?: string;
  @IsOptional() @IsUUID() fundId?: string;
}

export class PeriodDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() fiscalYear!: string;
  @ApiProperty() periodNumber!: number;
  @ApiProperty() periodName!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty({ enum: PERIOD_STATUSES }) status!: PeriodStatus;
  @ApiPropertyOptional({ nullable: true }) closedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) closedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) lockedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) lockedBy!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreatePeriodDto {
  @IsString() fiscalYear!: string;
  @IsInt() @Min(1) @Max(12) periodNumber!: number;
  @IsString() @Length(1, 64) periodName!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
}

export class CreatePeriodSeriesDto {
  @IsString() fiscalYear!: string;
  @IsDateString() yearStart!: string; // e.g. 2025-07-01 — generates 12 monthly periods
}

export class UpdatePeriodStatusDto {
  @IsIn(PERIOD_STATUSES) status!: PeriodStatus;
}

export class TrialBalanceLineDto {
  @ApiProperty() accountId!: string;
  @ApiProperty() accountCode!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty({ enum: ACCOUNT_TYPES }) accountType!: AccountType;
  @ApiProperty({ enum: NORMAL_BALANCES }) normalBalance!: NormalBalance;
  @ApiProperty() debitTotal!: number;
  @ApiProperty() creditTotal!: number;
  @ApiProperty() balance!: number; // signed per normal_balance (DEBIT positive, CREDIT positive too on the credit side)
}

export class TrialBalanceResponseDto {
  @ApiProperty({ type: [TrialBalanceLineDto] }) lines!: TrialBalanceLineDto[];
  @ApiProperty() totalDebit!: number;
  @ApiProperty() totalCredit!: number;
  @ApiProperty() balanced!: boolean;
}

export class GLEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() batchId!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty() accountCode!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty() fundId!: string;
  @ApiProperty() fundCode!: string;
  @ApiProperty() debit!: number;
  @ApiProperty() credit!: number;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) referenceType!: string | null;
  @ApiPropertyOptional({ nullable: true }) referenceId!: string | null;
  @ApiProperty() lineOrder!: number;
}

export class JournalBatchDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() batchNumber!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: BATCH_TYPES }) batchType!: BatchType;
  @ApiPropertyOptional({ nullable: true }) sourceModule!: string | null;
  @ApiPropertyOptional({ nullable: true }) sourceEventId!: string | null;
  @ApiProperty() accountingPeriodId!: string;
  @ApiProperty() periodName!: string;
  @ApiPropertyOptional({ nullable: true }) postedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) postedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) postedAt!: string | null;
  @ApiProperty() status!: BatchStatus;
  @ApiPropertyOptional({ nullable: true }) voidedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) voidedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) voidReason!: string | null;
  @ApiProperty() totalDebit!: number;
  @ApiProperty() totalCredit!: number;
  @ApiProperty() entries!: GLEntryDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateGLEntryLineDto {
  @IsUUID() accountId!: string;
  @IsUUID() fundId!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) debit!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) credit!: number;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(50) referenceType?: string;
  @IsOptional() @IsUUID() referenceId?: string;
}

export class CreateJournalBatchDto {
  @IsString() @MaxLength(50) batchNumber!: string;
  @IsString() @MaxLength(500) description!: string;
  @IsIn(BATCH_TYPES) batchType!: BatchType;
  @IsOptional() @IsString() @MaxLength(50) sourceModule?: string;
  @IsUUID() accountingPeriodId!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateGLEntryLineDto)
  entries!: CreateGLEntryLineDto[];
}

export class VoidJournalBatchDto {
  @IsString() @MaxLength(500) reason!: string;
}

// ─── Suppliers ───

export class SupplierContactDto {
  @ApiProperty() id!: string;
  @ApiProperty() supplierId!: string;
  @ApiProperty() contactName!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiPropertyOptional({ nullable: true }) role!: string | null;
  @ApiProperty() isPrimary!: boolean;
}

export class SupplierDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() supplierCode!: string;
  @ApiProperty() supplierName!: string;
  @ApiProperty({ enum: SUPPLIER_TYPES }) supplierType!: SupplierType;
  @ApiPropertyOptional({ nullable: true }) taxId!: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine1!: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine2!: string | null;
  @ApiPropertyOptional({ nullable: true }) city!: string | null;
  @ApiPropertyOptional({ nullable: true }) region!: string | null;
  @ApiPropertyOptional({ nullable: true }) postalCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) country!: string | null;
  @ApiPropertyOptional({ nullable: true }) paymentTerms!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() contacts!: SupplierContactDto[];
}

export class CreateSupplierDto {
  @IsString() @Length(1, 32) supplierCode!: string;
  @IsString() @Length(1, 200) supplierName!: string;
  @IsOptional() @IsIn(SUPPLIER_TYPES) supplierType?: SupplierType;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsString() addressLine1?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() postalCode?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() paymentTerms?: string;
  @IsOptional() @IsString() notes?: string;
}

// ─── Budgets ───

export class BudgetLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() budgetId!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty() accountCode!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty() budgetedAmount!: number;
  @ApiProperty() actualAmount!: number;
  @ApiProperty() encumberedAmount!: number;
  @ApiProperty() remainingAmount!: number;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class BudgetDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() fiscalYear!: string;
  @ApiProperty() fundId!: string;
  @ApiProperty() fundCode!: string;
  @ApiProperty() name!: string;
  @ApiProperty() totalRevenue!: number;
  @ApiProperty() totalExpense!: number;
  @ApiProperty({ enum: BUDGET_STATUSES }) status!: BudgetStatus;
  @ApiPropertyOptional({ nullable: true }) approvedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) approvedAt!: string | null;
  @ApiProperty() lines!: BudgetLineDto[];
}

export class CreateBudgetDto {
  @IsString() fiscalYear!: string;
  @IsUUID() fundId!: string;
  @IsString() @Length(1, 200) name!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalRevenue!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalExpense!: number;
}

export class UpdateBudgetDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsIn(BUDGET_STATUSES) status?: BudgetStatus;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalRevenue?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalExpense?: number;
}

export class CreateBudgetLineDto {
  @IsUUID() accountId!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) budgetedAmount!: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

// ─── AP ───

export class APVoucherDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() supplierId!: string;
  @ApiProperty() supplierName!: string;
  @ApiProperty() voucherNumber!: string;
  @ApiPropertyOptional({ nullable: true }) invoiceNumber!: string | null;
  @ApiProperty() invoiceDate!: string;
  @ApiProperty() dueDate!: string;
  @ApiProperty() totalAmount!: number;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) glAccountId!: string | null;
  @ApiPropertyOptional({ nullable: true }) glAccountCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) fundId!: string | null;
  @ApiProperty({ enum: AP_VOUCHER_STATUSES }) status!: APVoucherStatus;
  @ApiPropertyOptional({ nullable: true }) approvedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) approvedByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) approvedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) voidedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) voidReason!: string | null;
  @ApiProperty() amountPaid!: number;
  @ApiProperty() balanceDue!: number;
}

export class CreateAPVoucherDto {
  @IsUUID() supplierId!: string;
  @IsString() @MaxLength(50) voucherNumber!: string;
  @IsOptional() @IsString() @MaxLength(100) invoiceNumber?: string;
  @IsDateString() invoiceDate!: string;
  @IsDateString() dueDate!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) totalAmount!: number;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsUUID() glAccountId?: string;
  @IsOptional() @IsUUID() fundId?: string;
}

export class APVoucherTransitionDto {
  @IsIn(['APPROVE', 'HOLD', 'RELEASE', 'VOID']) action!: 'APPROVE' | 'HOLD' | 'RELEASE' | 'VOID';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class APPaymentDto {
  @ApiProperty() id!: string;
  @ApiProperty() voucherId!: string;
  @ApiProperty({ enum: PAYMENT_METHODS }) paymentMethod!: PaymentMethod;
  @ApiPropertyOptional({ nullable: true }) paymentReference!: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() paidAt!: string;
  @ApiProperty() paidBy!: string;
  @ApiPropertyOptional({ nullable: true }) paidByName!: string | null;
  @ApiPropertyOptional({ nullable: true }) journalBatchId!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class CreateAPPaymentDto {
  @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(100) paymentReference?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

// ─── Reconciliation ───

export class ReconciliationDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty() accountCode!: string;
  @ApiProperty() accountName!: string;
  @ApiProperty() periodId!: string;
  @ApiProperty() periodName!: string;
  @ApiProperty() glBalance!: number;
  @ApiProperty() bankBalance!: number;
  @ApiProperty() difference!: number;
  @ApiProperty() outstandingItems!: unknown;
  @ApiProperty({ enum: RECONCILIATION_STATUSES }) status!: ReconciliationStatus;
  @ApiPropertyOptional({ nullable: true }) reconciledBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) reconciledAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class CreateReconciliationDto {
  @IsUUID() accountId!: string;
  @IsUUID() periodId!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) bankBalance!: number;
  @IsOptional() @IsArray() outstandingItems?: unknown[];
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class FinalizeReconciliationDto {
  @IsArray()
  @IsOptional()
  outstandingItems?: unknown[];
  @IsNumber({ maxDecimalPlaces: 2 }) bankBalance!: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

// ─── Board Reports ───

export class BoardReportDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: REPORT_TYPES }) reportType!: ReportType;
  @ApiPropertyOptional({ nullable: true }) periodId!: string | null;
  @ApiPropertyOptional({ nullable: true }) periodName!: string | null;
  @ApiProperty() generatedAt!: string;
  @ApiProperty() generatedBy!: string;
  @ApiPropertyOptional({ nullable: true }) generatedByName!: string | null;
  @ApiProperty() reportData!: unknown;
  @ApiPropertyOptional({ nullable: true }) s3Key!: string | null;
}

export class CreateBoardReportDto {
  @IsIn(REPORT_TYPES) reportType!: ReportType;
  @IsOptional() @IsUUID() periodId?: string;
}

// ─── Grants ───

export class GrantDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) fundId!: string | null;
  @ApiPropertyOptional({ nullable: true }) fundCode!: string | null;
  @ApiProperty() grantName!: string;
  @ApiProperty() grantor!: string;
  @ApiPropertyOptional({ nullable: true }) grantNumber!: string | null;
  @ApiProperty() awardAmount!: number;
  @ApiProperty() drawnAmount!: number;
  @ApiProperty() remainingAmount!: number;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty({ enum: GRANT_STATUSES }) status!: GrantStatus;
  @ApiPropertyOptional({ nullable: true }) reportingDueDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class CreateGrantDto {
  @IsOptional() @IsUUID() fundId?: string;
  @IsString() @Length(1, 200) grantName!: string;
  @IsString() @Length(1, 200) grantor!: string;
  @IsOptional() @IsString() @MaxLength(100) grantNumber?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) awardAmount!: number;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsDateString() reportingDueDate?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateGrantDto {
  @IsOptional() @IsString() @Length(1, 200) grantName?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) drawnAmount?: number;
  @IsOptional() @IsIn(GRANT_STATUSES) status?: GrantStatus;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsDateString() reportingDueDate?: string;
}
