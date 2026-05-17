import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/*
 * Cycle 30 Step 5 — DTOs for ROPA + Retention + DPIA surface.
 *
 * Steps 6 + 7 add Processors + Breach + SARs + Erasure + Consent +
 * Privacy DTOs to the same file.
 */

// ─── Step 5 — ROPA / Retention / DPIA ───────────────────────────────

export const LEGAL_BASIS_VALUES = [
  'LEGAL_OBLIGATION',
  'PUBLIC_TASK',
  'LEGITIMATE_INTERESTS',
  'VITAL_INTERESTS',
  'CONTRACT',
  'CONSENT',
] as const;
export type LegalBasis = (typeof LEGAL_BASIS_VALUES)[number];

export const REVIEW_FREQUENCY_VALUES = ['ANNUAL', 'BIENNIAL', 'ON_CHANGE'] as const;
export type ReviewFrequency = (typeof REVIEW_FREQUENCY_VALUES)[number];

export const DPIA_STATUS_VALUES = [
  'SCOPING',
  'IN_PROGRESS',
  'COMPLETED',
  'APPROVED',
  'REJECTED',
] as const;
export type DpiaStatus = (typeof DPIA_STATUS_VALUES)[number];

export const RESIDUAL_RISK_VALUES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ResidualRisk = (typeof RESIDUAL_RISK_VALUES)[number];

export interface ProcessingActivityDto {
  id: string;
  schoolId: string;
  activityName: string;
  purpose: string;
  legalBasis: LegalBasis;
  dataCategories: string[];
  dataSubjects: string[];
  retentionPolicyId: string | null;
  retentionPolicyCategory: string | null;
  transfersOutsideUkEea: boolean;
  transferSafeguards: string | null;
  automatedDecisionMaking: boolean;
  profiling: boolean;
  highRiskProcessing: boolean;
  dpiaId: string | null;
  dpiaTitle: string | null;
  hasDpiaGap: boolean;
  isActive: boolean;
  lastReviewedAt: string | null;
  reviewedById: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateProcessingActivityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  activityName!: string;

  @IsString()
  @IsNotEmpty()
  purpose!: string;

  @IsIn(LEGAL_BASIS_VALUES as readonly string[])
  legalBasis!: LegalBasis;

  @IsArray()
  @IsString({ each: true })
  dataCategories!: string[];

  @IsArray()
  @IsString({ each: true })
  dataSubjects!: string[];

  @IsOptional()
  @IsUUID()
  retentionPolicyId?: string;

  @IsOptional()
  @IsBoolean()
  transfersOutsideUkEea?: boolean;

  @IsOptional()
  @IsString()
  transferSafeguards?: string;

  @IsOptional()
  @IsBoolean()
  automatedDecisionMaking?: boolean;

  @IsOptional()
  @IsBoolean()
  profiling?: boolean;

  @IsOptional()
  @IsBoolean()
  highRiskProcessing?: boolean;

  @IsOptional()
  @IsUUID()
  dpiaId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateProcessingActivityDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  activityName?: string;

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsIn(LEGAL_BASIS_VALUES as readonly string[])
  legalBasis?: LegalBasis;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dataCategories?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dataSubjects?: string[];

  @IsOptional()
  @IsUUID()
  retentionPolicyId?: string | null;

  @IsOptional()
  @IsBoolean()
  transfersOutsideUkEea?: boolean;

  @IsOptional()
  @IsString()
  transferSafeguards?: string | null;

  @IsOptional()
  @IsBoolean()
  automatedDecisionMaking?: boolean;

  @IsOptional()
  @IsBoolean()
  profiling?: boolean;

  @IsOptional()
  @IsBoolean()
  highRiskProcessing?: boolean;

  @IsOptional()
  @IsUUID()
  dpiaId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsDateString()
  lastReviewedAt?: string;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export interface RetentionPolicyDto {
  id: string;
  schoolId: string;
  dataCategory: string;
  retentionPeriod: string;
  legalBasisForRetention: string;
  reviewFrequency: ReviewFrequency;
  lastReviewedAt: string | null;
  nextReviewDate: string;
  reviewedById: string | null;
  linksToArchiveTier: string | null;
  notes: string | null;
  reviewDue: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CreateRetentionPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  dataCategory!: string;

  @IsString()
  @IsNotEmpty()
  retentionPeriod!: string;

  @IsString()
  @IsNotEmpty()
  legalBasisForRetention!: string;

  @IsOptional()
  @IsIn(REVIEW_FREQUENCY_VALUES as readonly string[])
  reviewFrequency?: ReviewFrequency;

  @IsDateString()
  nextReviewDate!: string;

  @IsOptional()
  @IsString()
  linksToArchiveTier?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateRetentionPolicyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  dataCategory?: string;

  @IsOptional()
  @IsString()
  retentionPeriod?: string;

  @IsOptional()
  @IsString()
  legalBasisForRetention?: string;

  @IsOptional()
  @IsIn(REVIEW_FREQUENCY_VALUES as readonly string[])
  reviewFrequency?: ReviewFrequency;

  @IsOptional()
  @IsDateString()
  lastReviewedAt?: string;

  @IsOptional()
  @IsDateString()
  nextReviewDate?: string;

  @IsOptional()
  @IsString()
  linksToArchiveTier?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export interface DpiaRiskEntry {
  riskDescription: string;
  likelihood: 'low' | 'medium' | 'high';
  severity: 'low' | 'medium' | 'high';
  mitigationMeasures: string;
}

const DPIA_RISK_LIKELIHOODS = ['low', 'medium', 'high'] as const;
const DPIA_RISK_SEVERITIES = ['low', 'medium', 'high'] as const;

/**
 * REVIEW-CYCLE30 MAJOR 10 — deep validation of every entry in the
 * `risksIdentified` array. Prior implementation only checked the array
 * was an array, so a caller could pass `[{}, "foo", null]` and persist
 * garbage in the JSONB column. The class-validator + class-transformer
 * pair below enforces the shape per element.
 */
export class DpiaRiskEntryDto implements DpiaRiskEntry {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  riskDescription!: string;

  @IsIn(DPIA_RISK_LIKELIHOODS as readonly string[])
  likelihood!: 'low' | 'medium' | 'high';

  @IsIn(DPIA_RISK_SEVERITIES as readonly string[])
  severity!: 'low' | 'medium' | 'high';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  mitigationMeasures!: string;
}

export interface DpiaDto {
  id: string;
  schoolId: string;
  processingActivityId: string | null;
  processingActivityName: string | null;
  dpiaTitle: string;
  triggerReason: string;
  status: DpiaStatus;
  descriptionOfProcessing: string;
  necessityProportionalityAssessment: string | null;
  risksIdentified: DpiaRiskEntry[];
  residualRiskLevel: ResidualRisk | null;
  dpoOpinion: string | null;
  supervisoryAuthorityConsultationRequired: boolean;
  completedAt: string | null;
  completedById: string | null;
  approvedById: string | null;
  documentS3Key: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateDpiaDto {
  @IsOptional()
  @IsUUID()
  processingActivityId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  dpiaTitle!: string;

  @IsString()
  @IsNotEmpty()
  triggerReason!: string;

  @IsString()
  @IsNotEmpty()
  descriptionOfProcessing!: string;

  @IsOptional()
  @IsString()
  necessityProportionalityAssessment?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DpiaRiskEntryDto)
  risksIdentified?: DpiaRiskEntryDto[];

  @IsOptional()
  @IsBoolean()
  supervisoryAuthorityConsultationRequired?: boolean;
}

export class UpdateDpiaDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  dpiaTitle?: string;

  @IsOptional()
  @IsString()
  triggerReason?: string;

  @IsOptional()
  @IsIn(DPIA_STATUS_VALUES as readonly string[])
  status?: DpiaStatus;

  @IsOptional()
  @IsString()
  descriptionOfProcessing?: string;

  @IsOptional()
  @IsString()
  necessityProportionalityAssessment?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DpiaRiskEntryDto)
  risksIdentified?: DpiaRiskEntryDto[];

  @IsOptional()
  @IsIn(RESIDUAL_RISK_VALUES as readonly string[])
  residualRiskLevel?: ResidualRisk | null;

  @IsOptional()
  @IsString()
  dpoOpinion?: string | null;

  @IsOptional()
  @IsBoolean()
  supervisoryAuthorityConsultationRequired?: boolean;

  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @IsOptional()
  @IsUUID()
  completedById?: string;

  @IsOptional()
  @IsUUID()
  approvedById?: string;

  @IsOptional()
  @IsString()
  documentS3Key?: string | null;
}

// ─── Step 6 — Processors + Breach ───────────────────────────────────

export const PROCESSOR_TYPE_VALUES = [
  'CLOUD_INFRASTRUCTURE',
  'PAYMENT_PROCESSOR',
  'AI_PROVIDER',
  'MDM_PROVIDER',
  'VIDEO_CONFERENCING',
  'EMAIL_PROVIDER',
  'IDENTITY_PROVIDER',
  'ANALYTICS',
  'OTHER',
] as const;
export type ProcessorType = (typeof PROCESSOR_TYPE_VALUES)[number];

export const TRANSFER_MECHANISM_VALUES = [
  'ADEQUACY_DECISION',
  'SCCs',
  'BCRs',
  'DEROGATION',
] as const;
export type TransferMechanism = (typeof TRANSFER_MECHANISM_VALUES)[number];

export const DPA_STATUS_VALUES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const;
export type DpaStatus = (typeof DPA_STATUS_VALUES)[number];

export const BREACH_TYPE_VALUES = [
  'UNAUTHORISED_ACCESS',
  'ACCIDENTAL_DISCLOSURE',
  'RANSOMWARE',
  'THEFT',
  'LOSS_OF_DEVICE',
  'SYSTEM_MISCONFIGURATION',
  'THIRD_PARTY_BREACH',
  'OTHER',
] as const;
export type BreachType = (typeof BREACH_TYPE_VALUES)[number];

export const BREACH_RISK_LEVEL_VALUES = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;
export type BreachRiskLevel = (typeof BREACH_RISK_LEVEL_VALUES)[number];

export const BREACH_RISK_TO_INDIVIDUALS_VALUES = [
  'UNLIKELY',
  'POSSIBLE',
  'LIKELY',
  'VERY_LIKELY',
] as const;
export type BreachRiskToIndividuals = (typeof BREACH_RISK_TO_INDIVIDUALS_VALUES)[number];

export const BREACH_STATUS_VALUES = [
  'UNDER_INVESTIGATION',
  'NOTIFIED',
  'CONTAINED',
  'RESOLVED',
] as const;
export type BreachStatus = (typeof BREACH_STATUS_VALUES)[number];

export interface ProcessorDto {
  id: string;
  schoolId: string;
  processorName: string;
  processorType: ProcessorType;
  registeredCountry: string;
  dataCategoriesProcessed: string[];
  dpaInPlace: boolean;
  dpaId: string | null;
  dpaStatus: DpaStatus | null;
  adequacyDecisionApplicable: boolean;
  transferMechanism: TransferMechanism | null;
  lastReviewedAt: string | null;
  nextReviewDate: string;
  notes: string | null;
  hasDpaGap: boolean;
  reviewDue: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CreateProcessorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  processorName!: string;

  @IsIn(PROCESSOR_TYPE_VALUES as readonly string[])
  processorType!: ProcessorType;

  @IsString()
  @IsNotEmpty()
  registeredCountry!: string;

  @IsArray()
  @IsString({ each: true })
  dataCategoriesProcessed!: string[];

  @IsOptional()
  @IsBoolean()
  adequacyDecisionApplicable?: boolean;

  @IsOptional()
  @IsIn(TRANSFER_MECHANISM_VALUES as readonly string[])
  transferMechanism?: TransferMechanism;

  @IsDateString()
  nextReviewDate!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateProcessorDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  processorName?: string;

  @IsOptional()
  @IsIn(PROCESSOR_TYPE_VALUES as readonly string[])
  processorType?: ProcessorType;

  @IsOptional()
  @IsString()
  registeredCountry?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dataCategoriesProcessed?: string[];

  @IsOptional()
  @IsBoolean()
  adequacyDecisionApplicable?: boolean;

  @IsOptional()
  @IsIn(TRANSFER_MECHANISM_VALUES as readonly string[])
  transferMechanism?: TransferMechanism | null;

  @IsOptional()
  @IsDateString()
  lastReviewedAt?: string;

  @IsOptional()
  @IsDateString()
  nextReviewDate?: string;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export interface DpaDto {
  id: string;
  schoolId: string;
  processorId: string;
  agreementReference: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  documentS3Key: string;
  subProcessorsDisclosed: boolean;
  subProcessorListS3Key: string | null;
  reviewDate: string;
  signedById: string;
  status: DpaStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateDpaDto {
  @IsUUID()
  processorId!: string;

  @IsString()
  @IsNotEmpty()
  agreementReference!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string;

  @IsString()
  @IsNotEmpty()
  documentS3Key!: string;

  @IsOptional()
  @IsBoolean()
  subProcessorsDisclosed?: boolean;

  @IsOptional()
  @IsString()
  subProcessorListS3Key?: string;

  @IsDateString()
  reviewDate!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateDpaDto {
  @IsOptional()
  @IsString()
  agreementReference?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  documentS3Key?: string;

  @IsOptional()
  @IsBoolean()
  subProcessorsDisclosed?: boolean;

  @IsOptional()
  @IsString()
  subProcessorListS3Key?: string | null;

  @IsOptional()
  @IsDateString()
  reviewDate?: string;

  @IsOptional()
  @IsIn(DPA_STATUS_VALUES as readonly string[])
  status?: DpaStatus;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export interface BreachRecordDto {
  id: string;
  schoolId: string;
  breachTitle: string;
  breachType: BreachType;
  discoveryDate: string;
  breachStartDate: string | null;
  personalDataCategoriesInvolved: string[];
  estimatedAffectedIndividuals: number | null;
  riskLevel: BreachRiskLevel;
  riskToIndividuals: BreachRiskToIndividuals;
  supervisoryAuthorityNotificationRequired: boolean;
  supervisoryAuthorityNotifiedAt: string | null;
  supervisoryAuthorityReference: string | null;
  dataSubjectsNotificationRequired: boolean;
  dataSubjectsNotifiedAt: string | null;
  breachCause: string;
  remediationActions: string;
  isResolved: boolean;
  resolvedAt: string | null;
  reportedById: string;
  status: BreachStatus;
  hoursSinceDiscovery: number;
  hoursRemainingTo72: number | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CreateBreachDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  breachTitle!: string;

  @IsIn(BREACH_TYPE_VALUES as readonly string[])
  breachType!: BreachType;

  @IsDateString()
  discoveryDate!: string;

  @IsOptional()
  @IsDateString()
  breachStartDate?: string;

  @IsArray()
  @IsString({ each: true })
  personalDataCategoriesInvolved!: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedAffectedIndividuals?: number;

  @IsIn(BREACH_RISK_LEVEL_VALUES as readonly string[])
  riskLevel!: BreachRiskLevel;

  @IsIn(BREACH_RISK_TO_INDIVIDUALS_VALUES as readonly string[])
  riskToIndividuals!: BreachRiskToIndividuals;

  @IsOptional()
  @IsBoolean()
  supervisoryAuthorityNotificationRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  dataSubjectsNotificationRequired?: boolean;

  @IsString()
  @IsNotEmpty()
  breachCause!: string;

  @IsString()
  @IsNotEmpty()
  remediationActions!: string;
}

export class UpdateBreachDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  breachTitle?: string;

  @IsOptional()
  @IsIn(BREACH_TYPE_VALUES as readonly string[])
  breachType?: BreachType;

  @IsOptional()
  @IsDateString()
  breachStartDate?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  personalDataCategoriesInvolved?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedAffectedIndividuals?: number;

  @IsOptional()
  @IsIn(BREACH_RISK_LEVEL_VALUES as readonly string[])
  riskLevel?: BreachRiskLevel;

  @IsOptional()
  @IsIn(BREACH_RISK_TO_INDIVIDUALS_VALUES as readonly string[])
  riskToIndividuals?: BreachRiskToIndividuals;

  @IsOptional()
  @IsBoolean()
  supervisoryAuthorityNotificationRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  dataSubjectsNotificationRequired?: boolean;

  @IsOptional()
  @IsString()
  breachCause?: string;

  @IsOptional()
  @IsString()
  remediationActions?: string;
}

export class NotifySupervisoryAuthorityDto {
  @IsString()
  @IsNotEmpty()
  supervisoryAuthorityReference!: string;

  @IsOptional()
  @IsDateString()
  notifiedAt?: string;
}

export class NotifyDataSubjectsDto {
  @IsOptional()
  @IsDateString()
  notifiedAt?: string;
}

export class ResolveBreachDto {
  @IsOptional()
  @IsDateString()
  resolvedAt?: string;
}

// ─── Step 7 — SARs / Erasure / Consent / Privacy ────────────────────

export const SAR_REQUEST_TYPE_VALUES = [
  'ACCESS',
  'RECTIFICATION',
  'PORTABILITY',
  'RESTRICTION',
] as const;
export type SarRequestType = (typeof SAR_REQUEST_TYPE_VALUES)[number];

export const SAR_STATUS_VALUES = [
  'RECEIVED',
  'IN_PROGRESS',
  'EXTENSION_REQUESTED',
  'COMPLETED',
  'DENIED',
  'OVERDUE',
] as const;
export type SarStatus = (typeof SAR_STATUS_VALUES)[number];

export const ERASURE_STATUS_VALUES = [
  'RECEIVED',
  'REVIEWING',
  'PARTIALLY_COMPLETED',
  'COMPLETED',
  'DENIED',
] as const;
export type ErasureStatus = (typeof ERASURE_STATUS_VALUES)[number];

export const CONSENT_METHOD_VALUES = ['DIGITAL', 'PAPER', 'VERBAL'] as const;
export type ConsentMethod = (typeof CONSENT_METHOD_VALUES)[number];

export interface SubjectAccessRequestDto {
  id: string;
  schoolId: string;
  dataSubjectId: string;
  dataSubjectName: string | null;
  requestedById: string;
  requestedByName: string | null;
  requestType: SarRequestType;
  requestDetails: string | null;
  deadlineDate: string;
  status: SarStatus;
  responseS3Key: string | null;
  completedAt: string | null;
  denialReason: string | null;
  extensionReason: string | null;
  extensionUntil: string | null;
  daysUntilDeadline: number;
  isOverdue: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateSarDto {
  @IsUUID()
  dataSubjectId!: string;

  @IsIn(SAR_REQUEST_TYPE_VALUES as readonly string[])
  requestType!: SarRequestType;

  @IsOptional()
  @IsString()
  requestDetails?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateSarDto {
  @IsOptional()
  @IsIn(SAR_STATUS_VALUES as readonly string[])
  status?: SarStatus;

  @IsOptional()
  @IsString()
  responseS3Key?: string | null;

  @IsOptional()
  @IsString()
  denialReason?: string | null;

  @IsOptional()
  @IsString()
  extensionReason?: string | null;

  @IsOptional()
  @IsDateString()
  extensionUntil?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export interface ErasureRequestDto {
  id: string;
  schoolId: string;
  dataSubjectId: string;
  requestedById: string;
  requestDetails: string | null;
  status: ErasureStatus;
  denialBasis: string | null;
  categoriesErased: string[];
  categoriesRetained: string[];
  categoriesPseudonymised: string[];
  reviewedById: string | null;
  completedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateErasureDto {
  @IsUUID()
  dataSubjectId!: string;

  @IsOptional()
  @IsString()
  requestDetails?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateErasureDto {
  @IsOptional()
  @IsIn(ERASURE_STATUS_VALUES as readonly string[])
  status?: ErasureStatus;

  @IsOptional()
  @IsString()
  denialBasis?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoriesErased?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoriesRetained?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoriesPseudonymised?: string[];

  @IsOptional()
  @IsString()
  notes?: string | null;
}

export class PseudonymiseAuditDto {
  @IsString()
  @IsNotEmpty()
  targetTable!: string;

  @IsString()
  @IsNotEmpty()
  targetField!: string;
}

export interface PseudonymisationLogDto {
  id: string;
  schoolId: string;
  erasureRequestId: string;
  dataSubjectId: string;
  targetTable: string;
  targetField: string;
  rowsPseudonymised: number;
  pseudonymisationToken: string;
  pseudonymisedAt: string;
  pseudonymisedById: string;
  notes: string | null;
}

export interface ConsentRecordDto {
  id: string;
  schoolId: string;
  dataSubjectId: string;
  processingActivityId: string;
  processingActivityName: string | null;
  consented: boolean;
  consentMethod: ConsentMethod;
  consentGivenAt: string | null;
  consentWithdrawnAt: string | null;
  evidenceS3Key: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateConsentDto {
  @IsUUID()
  dataSubjectId!: string;

  @IsUUID()
  processingActivityId!: string;

  @IsBoolean()
  consented!: boolean;

  @IsIn(CONSENT_METHOD_VALUES as readonly string[])
  consentMethod!: ConsentMethod;

  @IsOptional()
  @IsDateString()
  consentGivenAt?: string;

  @IsOptional()
  @IsString()
  evidenceS3Key?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class WithdrawConsentDto {
  @IsOptional()
  @IsDateString()
  withdrawnAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export interface PrivacyNoticeDto {
  id: string;
  schoolId: string;
  noticeVersion: string;
  effectiveFrom: string;
  contentSummary: string;
  documentS3Key: string;
  publishedById: string;
  publishedByName: string | null;
  publishedAt: string | null;
  supersededAt: string | null;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CreatePrivacyNoticeDto {
  @IsString()
  @IsNotEmpty()
  noticeVersion!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsString()
  @IsNotEmpty()
  contentSummary!: string;

  @IsString()
  @IsNotEmpty()
  documentS3Key!: string;
}

export class PublishPrivacyNoticeDto {
  @IsOptional()
  @IsDateString()
  publishedAt?: string;
}

export interface ComplianceConfigDto {
  id: string;
  schoolId: string;
  sarDefaultDeadlineDays: number;
  breachEscalationHours: number;
  retentionReviewReminderDays: number;
  dpaReviewReminderDays: number;
  dpiaReviewReminderDays: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class UpdateComplianceConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  sarDefaultDeadlineDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(72)
  breachEscalationHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  retentionReviewReminderDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  dpaReviewReminderDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  dpiaReviewReminderDays?: number;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

// ─── Compliance Dashboard rollup ────────────────────────────────────

export interface ComplianceDashboardDto {
  schoolId: string;
  asOf: string;
  ropaCount: number;
  highRiskActivities: number;
  dpiaGaps: number;
  retentionPolicies: number;
  retentionReviewsDue: number;
  processors: number;
  dpaGaps: number;
  dpaReviewsDue: number;
  activeBreaches: number;
  breachesAwaitingNotification: number;
  breachOverdueCount: number;
  pendingSars: number;
  overdueSars: number;
  pendingErasures: number;
  pseudonymisationsLast30Days: number;
  activeConsents: number;
  withdrawnConsents: number;
  currentPrivacyNoticeVersion: string | null;
}
