import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * P2-21b Internal Ops + Pricing DTOs.
 *
 * Routes mount under /api/v1/internal/ops/* + /api/v1/internal/pricing/*
 * and are platform-scoped (no tenant header). Gated on OPS-001..006
 * read/write tiers; admin tier is implicit via Platform Admin's
 * everyFunction grant.
 */

// ── Enum catalogues ──────────────────────────────────────────────────

export const OPS_DEPARTMENTS = [
  'ENGINEERING',
  'PRODUCT',
  'SALES',
  'CUSTOMER_SUCCESS',
  'SUPPORT',
  'OPERATIONS',
] as const;
export type OpsDepartment = (typeof OPS_DEPARTMENTS)[number];

export const OPS_PERMISSION_SCOPES = [
  'CRM_READ',
  'CRM_WRITE',
  'TENANT_ACCESS',
  'INTERNAL_ADMIN',
  'SUPPORT',
] as const;
export type OpsPermissionScope = (typeof OPS_PERMISSION_SCOPES)[number];

export const ASSIGNMENT_ROLES = ['CSM', 'TAM', 'AE'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const TENANT_ACCESS_TYPES = ['READ_ONLY', 'READ_WRITE'] as const;
export type TenantAccessType = (typeof TENANT_ACCESS_TYPES)[number];

export const TICKET_CATEGORIES = [
  'BUG',
  'FEATURE_REQUEST',
  'DATA_FIX',
  'INFRASTRUCTURE',
  'OTHER',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// ── Ops employees ────────────────────────────────────────────────────

export class CreateOpsEmployeeDto {
  @IsUUID()
  personId!: string;

  @IsIn(OPS_DEPARTMENTS as unknown as string[])
  department!: OpsDepartment;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  role!: string;

  @IsISO8601({ strict: false })
  hireDate!: string;
}

export class PatchOpsEmployeeDto {
  @IsOptional()
  @IsIn(OPS_DEPARTMENTS as unknown as string[])
  department?: OpsDepartment;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class GrantPermissionDto {
  @IsIn(OPS_PERMISSION_SCOPES as unknown as string[])
  scope!: OpsPermissionScope;
}

// ── Account assignments ──────────────────────────────────────────────

export class CreateAccountAssignmentDto {
  @IsUUID()
  accountId!: string;

  @IsUUID()
  employeeId!: string;

  @IsIn(ASSIGNMENT_ROLES as unknown as string[])
  assignmentRole!: AssignmentRole;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

// ── Tenant access grants ─────────────────────────────────────────────

export class CreateTenantAccessGrantDto {
  @IsUUID()
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  tenantSchema!: string;

  /**
   * Mandatory justification. Schema also enforces length >= 20 after
   * trim via CHECK, but the DTO catches the common case earlier.
   */
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  justification!: string;

  @IsIn(TENANT_ACCESS_TYPES as unknown as string[])
  accessType!: TenantAccessType;

  /**
   * Window in hours from now until expiry. Capped at 4 server-side
   * (schema enforces duration_chk too). Defaults to 4 if omitted.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  durationHours?: number;

  /**
   * Approver employee. Required at the service layer; if the caller
   * omits it, the service rejects with 400. Approver must have the
   * INTERNAL_ADMIN ops permission.
   */
  @IsUUID()
  approvedBy!: string;
}

// ── Internal tickets ─────────────────────────────────────────────────

export class CreateInternalTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description!: string;

  @IsIn(TICKET_CATEGORIES as unknown as string[])
  category!: TicketCategory;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES as unknown as string[])
  priority?: TicketPriority;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @IsOptional()
  @IsUUID()
  relatedAccountId?: string;
}

export class PatchInternalTicketDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsIn(TICKET_CATEGORIES as unknown as string[])
  category?: TicketCategory;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES as unknown as string[])
  priority?: TicketPriority;

  @IsOptional()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status?: TicketStatus;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @IsOptional()
  @IsUUID()
  relatedAccountId?: string;
}

export class CreateTicketCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  commentText!: string;
}

export class ListInternalTicketsArgs {
  @IsOptional()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status?: TicketStatus;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES as unknown as string[])
  priority?: TicketPriority;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}

// ── Pricing ──────────────────────────────────────────────────────────

export class CreatePricingBandDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsInt()
  @Min(0)
  studentRangeMin!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  studentRangeMax?: number;

  @IsInt()
  @Min(0)
  monthlyPriceCents!: number;

  @IsInt()
  @Min(0)
  annualPriceCents!: number;
}

export class UpdatePricingBandDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  studentRangeMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  studentRangeMax?: number;

  /** Either or both must be supplied; the service writes a history row when any cents value changes. */
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyPriceCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  annualPriceCents?: number;

  @IsOptional()
  @IsISO8601({ strict: false })
  effectiveDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Required when monthlyPriceCents or annualPriceCents change — the
   * employee triggering the change. Logged in platform_pricing_history.
   */
  @IsOptional()
  @IsUUID()
  changedBy?: string;
}

export class CreateSupportTierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsInt()
  @Min(1)
  responseTimeHours!: number;

  @IsOptional()
  @IsBoolean()
  includesPhone?: boolean;

  @IsOptional()
  @IsBoolean()
  includesDedicatedCsm?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyAddonCents?: number;
}

export class PatchSupportTierDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  responseTimeHours?: number;

  @IsOptional()
  @IsBoolean()
  includesPhone?: boolean;

  @IsOptional()
  @IsBoolean()
  includesDedicatedCsm?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyAddonCents?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ── Response DTOs ────────────────────────────────────────────────────

export interface OpsEmployeeDto {
  id: string;
  personId: string;
  department: OpsDepartment;
  role: string;
  hireDate: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpsPermissionDto {
  id: string;
  employeeId: string;
  scope: OpsPermissionScope;
  grantedBy: string;
  grantedAt: string;
}

export interface AccountAssignmentDto {
  id: string;
  accountId: string;
  employeeId: string;
  assignmentRole: AssignmentRole;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantAccessGrantDto {
  id: string;
  employeeId: string;
  tenantSchema: string;
  justification: string;
  accessType: TenantAccessType;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  approvedBy: string;
  isActive: boolean;
  remainingMinutes: number;
}

export interface InternalTicketDto {
  id: string;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  createdBy: string;
  assignedTo: string | null;
  relatedAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InternalTicketCommentDto {
  id: string;
  ticketId: string;
  authorId: string;
  commentText: string;
  createdAt: string;
}

export interface PricingBandDto {
  id: string;
  name: string;
  studentRangeMin: number;
  studentRangeMax: number | null;
  monthlyPriceCents: number;
  annualPriceCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PricingHistoryDto {
  id: string;
  bandId: string;
  previousMonthlyCents: number | null;
  newMonthlyCents: number;
  previousAnnualCents: number | null;
  newAnnualCents: number;
  effectiveDate: string;
  changedBy: string;
  createdAt: string;
}

export interface SupportTierDto {
  id: string;
  name: string;
  responseTimeHours: number;
  includesPhone: boolean;
  includesDedicatedCsm: boolean;
  monthlyAddonCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
