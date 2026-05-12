import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * P2-21a CRM DTOs — internal-only customer-management surface.
 *
 * All routes mount under /api/v1/internal/crm/* and are platform-scoped
 * (no tenant header). Gated on CRM-001..006 read/write tiers; admin tier
 * is implicit via Platform Admin's everyFunction grant.
 */

// ── Account lifecycle enums ──────────────────────────────────────────

export const ACCOUNT_STATUSES = [
  'PROSPECT',
  'PILOT',
  'ONBOARDING',
  'ACTIVE',
  'CHURNED',
  'SUSPENDED',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const SUBSCRIPTION_INTERVALS = ['MONTHLY', 'ANNUAL'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const CONTACT_ROLES = [
  'DECISION_MAKER',
  'CHAMPION',
  'ADMIN_CONTACT',
  'BILLING_CONTACT',
  'TECHNICAL_CONTACT',
  'OTHER',
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const INTERACTION_TYPES = [
  'CALL',
  'EMAIL',
  'MEETING',
  'DEMO',
  'SUPPORT',
  'NOTE',
  'OTHER',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const CHECKLIST_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export const TASK_CATEGORIES = [
  'TECHNICAL',
  'DATA_MIGRATION',
  'TRAINING',
  'CONFIGURATION',
  'GO_LIVE',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_STATUSES = ['PENDING', 'COMPLETED', 'SKIPPED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RISK_LEVELS = ['HEALTHY', 'AT_RISK', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RENEWAL_STAGES = [
  'UPCOMING',
  'IN_DISCUSSION',
  'PROPOSAL_SENT',
  'COMMITTED',
  'CHURNING',
] as const;
export type RenewalStage = (typeof RENEWAL_STAGES)[number];

export const INVOICE_STATUSES = ['DRAFT', 'OPEN', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// ── Accounts ─────────────────────────────────────────────────────────

export class CreateAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  accountName!: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsUUID()
  organisationId?: string;

  @IsEmail()
  billingEmail!: string;

  @IsOptional()
  @IsUUID()
  pricingBandId?: string;

  @IsOptional()
  @IsUUID()
  schoolChampionPersonId?: string;

  @IsOptional()
  billingAddressJson?: Record<string, unknown>;
}

export class PatchAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accountName?: string;

  @IsOptional()
  @IsEmail()
  billingEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  stripeCustomerId?: string;

  @IsOptional()
  @IsUUID()
  pricingBandId?: string;

  @IsOptional()
  @IsUUID()
  schoolChampionPersonId?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  signedDate?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  goLiveDate?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  renewalDate?: string;

  @IsOptional()
  billingAddressJson?: Record<string, unknown>;
}

export class TransitionAccountStatusDto {
  @IsIn(ACCOUNT_STATUSES as unknown as string[])
  status!: AccountStatus;
}

export class ListAccountsArgs {
  @IsOptional()
  @IsIn(ACCOUNT_STATUSES as unknown as string[])
  status?: AccountStatus;

  @IsOptional()
  @IsISO8601({ strict: false })
  renewalAfter?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  renewalBefore?: string;
}

// ── Subscriptions ────────────────────────────────────────────────────

export class CreateSubscriptionDto {
  @IsUUID()
  accountId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  planName!: string;

  @IsIn(SUBSCRIPTION_INTERVALS as unknown as string[])
  billingInterval!: SubscriptionInterval;

  @IsInt()
  @Min(0)
  mrrCents!: number;

  @IsIn(SUBSCRIPTION_STATUSES as unknown as string[])
  status!: SubscriptionStatus;

  @IsOptional()
  @IsString()
  stripeSubscriptionId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  studentCountAtSign?: number;

  @IsOptional()
  @IsISO8601({ strict: false })
  currentPeriodStart?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  currentPeriodEnd?: string;

  @IsOptional()
  @IsBoolean()
  cancelAtPeriodEnd?: boolean;
}

export class PatchSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  planName?: string;

  @IsOptional()
  @IsIn(SUBSCRIPTION_INTERVALS as unknown as string[])
  billingInterval?: SubscriptionInterval;

  @IsOptional()
  @IsInt()
  @Min(0)
  mrrCents?: number;

  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES as unknown as string[])
  status?: SubscriptionStatus;

  @IsOptional()
  @IsString()
  stripeSubscriptionId?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  currentPeriodStart?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  currentPeriodEnd?: string;

  @IsOptional()
  @IsBoolean()
  cancelAtPeriodEnd?: boolean;
}

// ── Contacts ─────────────────────────────────────────────────────────

export class CreateContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsEmail()
  email!: string;

  @IsIn(CONTACT_ROLES as unknown as string[])
  role!: ContactRole;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsUUID()
  personId?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class PatchContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(CONTACT_ROLES as unknown as string[])
  role?: ContactRole;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

// ── Interactions ─────────────────────────────────────────────────────

export class CreateInteractionDto {
  @IsIn(INTERACTION_TYPES as unknown as string[])
  interactionType!: InteractionType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @IsISO8601({ strict: false })
  interactionAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsOptional()
  @IsUUID()
  contactId?: string;
}

// ── Onboarding ───────────────────────────────────────────────────────

export class OnboardingTaskInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  taskName!: string;

  @IsIn(TASK_CATEGORIES as unknown as string[])
  taskCategory!: TaskCategory;

  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class InitOnboardingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  templateVersion?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingTaskInput)
  tasks?: OnboardingTaskInput[];
}

export class PatchOnboardingTaskDto {
  @IsIn(['COMPLETED', 'SKIPPED', 'PENDING'])
  status!: 'COMPLETED' | 'SKIPPED' | 'PENDING';
}

// ── Health Scores ────────────────────────────────────────────────────

export class CreateHealthScoreDto {
  @IsISO8601({ strict: false })
  scoreDate!: string;

  @IsInt()
  @Min(0)
  @Max(100)
  overallScore!: number;

  @IsIn(RISK_LEVELS as unknown as string[])
  riskLevel!: RiskLevel;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  adoptionScore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  engagementScore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  supportTicketScore?: number;

  @IsOptional()
  @IsInt()
  @Min(-100)
  @Max(100)
  npsScore?: number;
}

// ── Renewals ─────────────────────────────────────────────────────────

export class CreateRenewalDto {
  @IsUUID()
  accountId!: string;

  @IsISO8601({ strict: false })
  renewalDate!: string;

  @IsInt()
  @Min(0)
  currentMrrCents!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  proposedMrrCents?: number;

  @IsOptional()
  @IsIn(RENEWAL_STAGES as unknown as string[])
  stage?: RenewalStage;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  riskFactors?: string[];

  @IsOptional()
  @IsUUID()
  assignedCsm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class PatchRenewalDto {
  @IsOptional()
  @IsISO8601({ strict: false })
  renewalDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentMrrCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  proposedMrrCents?: number;

  @IsOptional()
  @IsIn(RENEWAL_STAGES as unknown as string[])
  stage?: RenewalStage;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  riskFactors?: string[];

  @IsOptional()
  @IsUUID()
  assignedCsm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

// ── Response DTOs ────────────────────────────────────────────────────

export interface AccountDto {
  id: string;
  schoolId: string | null;
  organisationId: string | null;
  accountName: string;
  pricingBandId: string | null;
  status: AccountStatus;
  billingEmail: string;
  billingAddressJson: Record<string, unknown> | null;
  stripeCustomerId: string | null;
  schoolChampionPersonId: string | null;
  signedDate: string | null;
  goLiveDate: string | null;
  renewalDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionDto {
  id: string;
  accountId: string;
  planName: string;
  stripeSubscriptionId: string | null;
  billingInterval: SubscriptionInterval;
  mrrCents: number;
  studentCountAtSign: number | null;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContactDto {
  id: string;
  accountId: string;
  personId: string | null;
  name: string;
  email: string;
  phone: string | null;
  role: ContactRole;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionDto {
  id: string;
  accountId: string;
  contactId: string | null;
  interactionType: InteractionType;
  subject: string;
  notes: string | null;
  loggedBy: string;
  interactionAt: string;
  createdAt: string;
}

export interface OnboardingChecklistDto {
  id: string;
  accountId: string;
  templateVersion: number;
  startedAt: string | null;
  completedAt: string | null;
  status: ChecklistStatus;
  tasks: OnboardingTaskDto[];
  taskCounts: { total: number; pending: number; completed: number; skipped: number };
}

export interface OnboardingTaskDto {
  id: string;
  checklistId: string;
  taskName: string;
  taskCategory: TaskCategory;
  sortOrder: number;
  status: TaskStatus;
  completedAt: string | null;
  completedBy: string | null;
}

export interface HealthScoreDto {
  id: string;
  accountId: string;
  scoreDate: string;
  overallScore: number;
  adoptionScore: number | null;
  engagementScore: number | null;
  supportTicketScore: number | null;
  npsScore: number | null;
  riskLevel: RiskLevel;
  createdAt: string;
}

export interface RenewalDto {
  id: string;
  accountId: string;
  renewalDate: string;
  currentMrrCents: number;
  proposedMrrCents: number | null;
  stage: RenewalStage;
  riskFactors: string[];
  assignedCsm: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceDto {
  id: string;
  accountId: string;
  stripeInvoiceId: string | null;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  invoiceDate: string;
  dueDate: string;
  paidAt: string | null;
  pdfUrl: string | null;
  createdAt: string;
}

export interface MrrSummaryDto {
  totalMrrCents: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  cancelledSubscriptions: number;
}

export interface AccountTimelineDto {
  account: AccountDto;
  interactions: InteractionDto[];
  healthScores: HealthScoreDto[];
  onboardingChecklist: OnboardingChecklistDto | null;
  subscriptions: SubscriptionDto[];
  renewals: RenewalDto[];
}
