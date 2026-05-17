import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ── Vendor Catalogues ─────────────────────────────────────────────

export interface VendorCatalogueDto {
  id: string;
  vendorId: string;
  schoolId: string;
  catalogueName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VendorCatalogueDetailDto extends VendorCatalogueDto {
  items: CatalogueItemDto[];
}

export interface CatalogueItemDto {
  id: string;
  catalogueId: string;
  itemCode: string;
  description: string;
  unit: string | null;
  negotiatedPrice: number;
  category: string | null;
  minOrderQty: number;
  leadTimeDays: number | null;
  isActive: boolean;
}

export class CreateVendorCatalogueDto {
  @IsUUID()
  vendorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  catalogueName!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateVendorCatalogueDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  catalogueName?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreateCatalogueItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  itemCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  negotiatedPrice!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  minOrderQty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  leadTimeDays?: number;
}

export class UpdateCatalogueItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  negotiatedPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  minOrderQty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  leadTimeDays?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ── Contracts ─────────────────────────────────────────────────────

export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRING' | 'RENEWED' | 'TERMINATED';

export interface ContractDto {
  id: string;
  schoolId: string;
  vendorId: string;
  contractNumber: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string;
  totalValue: number | null;
  spentToDate: number;
  status: ContractStatus;
  documentS3Key: string | null;
  renewalReminderDays: number;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDetailDto extends ContractDto {
  amendments: ContractAmendmentDto[];
}

export interface ContractAmendmentDto {
  id: string;
  contractId: string;
  amendmentNumber: number;
  description: string;
  valueChange: number;
  newEndDate: string | null;
  documentS3Key: string | null;
  approvedBy: string | null;
  effectiveDate: string;
  createdAt: string;
}

export class CreateContractDto {
  @IsUUID()
  vendorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  contractNumber!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  documentS3Key?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  renewalReminderDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateContractDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalValue?: number;

  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE', 'EXPIRING', 'RENEWED', 'TERMINATED'])
  status?: ContractStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  documentS3Key?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  renewalReminderDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CreateContractAmendmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  valueChange?: number;

  @IsOptional()
  @IsDateString()
  newEndDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  documentS3Key?: string;

  @IsDateString()
  effectiveDate!: string;
}

// ── Spending Analytics ────────────────────────────────────────────

export interface SpendingAnalyticsRowDto {
  id: string;
  period: string;
  vendorId: string | null;
  category: string | null;
  department: string | null;
  totalSpend: number;
  poCount: number;
  avgLeadTimeDays: number | null;
}

export class SpendingAnalyticsFilterDto {
  @IsOptional()
  @IsDateString()
  fromPeriod?: string;

  @IsOptional()
  @IsDateString()
  toPeriod?: string;

  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  department?: string;
}

// ── Departmental Budgets ──────────────────────────────────────────

export type BudgetCategory =
  | 'PERSONNEL'
  | 'SUPPLIES'
  | 'EQUIPMENT'
  | 'CONTRACTED_SERVICES'
  | 'TRAVEL'
  | 'OTHER';

export interface DepartmentalBudgetDto {
  id: string;
  schoolId: string;
  academicYearId: string;
  department: string;
  budgetCategory: BudgetCategory;
  allocatedAmount: number;
  committedAmount: number;
  spentAmount: number;
  availableAmount: number;
  notes: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateDepartmentalBudgetDto {
  @IsUUID()
  academicYearId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  department!: string;

  @IsIn(['PERSONNEL', 'SUPPLIES', 'EQUIPMENT', 'CONTRACTED_SERVICES', 'TRAVEL', 'OTHER'])
  budgetCategory!: BudgetCategory;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  allocatedAmount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateDepartmentalBudgetDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  allocatedAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ── Budget Transfers ──────────────────────────────────────────────

export type BudgetTransferStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface BudgetTransferDto {
  id: string;
  schoolId: string;
  fromBudgetId: string;
  toBudgetId: string;
  amount: number;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  status: BudgetTransferStatus;
  transferredAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateBudgetTransferDto {
  @IsUUID()
  fromBudgetId!: string;

  @IsUUID()
  toBudgetId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

export class RejectBudgetTransferDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  rejectionReason!: string;
}

// ── Journal Entry Batches ─────────────────────────────────────────

export type JournalBatchStatus = 'DRAFT' | 'POSTED' | 'VOIDED';

export interface JournalBatchDto {
  id: string;
  schoolId: string;
  batchName: string;
  description: string | null;
  entryCount: number;
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
  status: JournalBatchStatus;
  createdBy: string;
  postedBy: string | null;
  postedAt: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalBatchDetailDto extends JournalBatchDto {
  lines: JournalEntryLineDto[];
}

export interface JournalEntryLineDto {
  id: string;
  batchId: string;
  accountId: string;
  debit: number;
  credit: number;
  description: string | null;
  lineOrder: number;
}

export class CreateJournalBatchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  batchName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class AddJournalEntryLineDto {
  @IsUUID()
  accountId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  debit!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  credit!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  lineOrder?: number;
}

export class VoidJournalBatchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  voidReason!: string;
}
