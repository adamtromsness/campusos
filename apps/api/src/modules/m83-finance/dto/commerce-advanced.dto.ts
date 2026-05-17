import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

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
