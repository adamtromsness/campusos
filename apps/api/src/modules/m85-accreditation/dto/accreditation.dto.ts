import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ───────────────────────────── Frameworks + Adoptions ─────────────────────────────

export type FrameworkSource = 'PLATFORM' | 'TENANT';

export interface FrameworkDto {
  id: string;
  source: FrameworkSource;
  name: string;
  abbreviation?: string | null;
  organisation?: string | null;
  description: string | null;
  version: string | null;
  isActive: boolean;
  standardCount: number;
  isAdopted: boolean;
}

export interface StandardDto {
  id: string;
  source: FrameworkSource;
  frameworkId: string;
  standardCode: string;
  domain: string | null;
  standardText: string;
  guidanceNotes: string | null;
  sortOrder: number;
}

export interface AdoptionDto {
  id: string;
  schoolId: string;
  platformFrameworkId: string;
  frameworkName: string;
  frameworkAbbreviation: string;
  adoptedAt: string;
  isActive: boolean;
}

export class CreateAdoptionDto {
  @IsUUID('all')
  platformFrameworkId!: string;

  @IsOptional()
  @IsDateString()
  adoptedAt?: string;
}

export class CreateCustomFrameworkDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

// ───────────────────────────── Evidence ─────────────────────────────

export type EvidenceType = 'DOCUMENT' | 'URL' | 'METRIC' | 'OBSERVATION' | 'SURVEY';
export type EvidenceStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export const EVIDENCE_TYPES: EvidenceType[] = [
  'DOCUMENT',
  'URL',
  'METRIC',
  'OBSERVATION',
  'SURVEY',
];
export const EVIDENCE_STATUSES: EvidenceStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'];

export interface EvidenceItemDto {
  id: string;
  schoolId: string;
  standardId: string;
  evidenceType: EvidenceType;
  title: string;
  description: string | null;
  s3Key: string | null;
  url: string | null;
  metricValue: string | null;
  status: EvidenceStatus;
  submittedBy: string;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateEvidenceDto {
  @IsUUID('all')
  standardId!: string;

  @IsIn(EVIDENCE_TYPES)
  evidenceType!: EvidenceType;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  s3Key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  metricValue?: string;
}

export class ReviewEvidenceDto {
  @IsIn(['SUBMITTED', 'APPROVED', 'REJECTED'])
  status!: 'SUBMITTED' | 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewerNotes?: string;
}

// ───────────────────────────── Self-Study Ratings ─────────────────────────────

export type SelfStudyRating = 'EXEMPLARY' | 'ACCOMPLISHED' | 'DEVELOPING' | 'NOT_MET';
export const SELF_STUDY_RATINGS: SelfStudyRating[] = [
  'EXEMPLARY',
  'ACCOMPLISHED',
  'DEVELOPING',
  'NOT_MET',
];

export interface SelfStudyRatingDto {
  id: string;
  schoolId: string;
  standardId: string;
  cycleId: string;
  rating: SelfStudyRating;
  rationale: string;
  ratedBy: string;
  ratedAt: string;
}

export class CreateSelfStudyRatingDto {
  @IsUUID('all')
  standardId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  cycleId!: string;

  @IsIn(SELF_STUDY_RATINGS)
  rating!: SelfStudyRating;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  rationale!: string;
}

export interface SelfStudySummaryDto {
  cycleId: string;
  totals: {
    EXEMPLARY: number;
    ACCOMPLISHED: number;
    DEVELOPING: number;
    NOT_MET: number;
  };
  totalRated: number;
  byDomain: Array<{
    domain: string;
    EXEMPLARY: number;
    ACCOMPLISHED: number;
    DEVELOPING: number;
    NOT_MET: number;
  }>;
}

// ───────────────────────────── Action Plans ─────────────────────────────

export type ActionPlanStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETE' | 'OVERDUE';
export const ACTION_PLAN_STATUSES: ActionPlanStatus[] = [
  'PLANNED',
  'IN_PROGRESS',
  'COMPLETE',
  'OVERDUE',
];

export type SubActionStatus = 'PENDING' | 'COMPLETED' | 'OVERDUE';
export const SUB_ACTION_STATUSES: SubActionStatus[] = ['PENDING', 'COMPLETED', 'OVERDUE'];

export interface SubAction {
  description: string;
  due_date: string;
  status: SubActionStatus;
}

export interface ActionPlanDto {
  id: string;
  schoolId: string;
  standardId: string;
  goal: string;
  actions: SubAction[];
  responsibleParty: string;
  targetDate: string;
  status: ActionPlanStatus;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class CreateActionPlanDto {
  @IsUUID('all')
  standardId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  goal!: string;

  @IsArray()
  @ArrayNotEmpty()
  actions!: SubAction[];

  @IsUUID('all')
  responsibleParty!: string;

  @IsDateString()
  targetDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateActionPlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  goal?: string;

  @IsOptional()
  @IsArray()
  actions?: SubAction[];

  @IsOptional()
  @IsUUID('all')
  responsibleParty?: string;

  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @IsOptional()
  @IsIn(ACTION_PLAN_STATUSES)
  status?: ActionPlanStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateSubActionDto {
  @IsInt()
  @Min(0)
  index!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsDateString()
  due_date?: string;

  @IsOptional()
  @IsIn(SUB_ACTION_STATUSES)
  status?: SubActionStatus;
}

// ───────────────────────────── Site Visit Prep ─────────────────────────────

export type SiteVisitStatus = 'PREPARING' | 'READY' | 'VISIT_COMPLETE';
export const SITE_VISIT_STATUSES: SiteVisitStatus[] = ['PREPARING', 'READY', 'VISIT_COMPLETE'];

export interface SiteVisitPrepDto {
  id: string;
  schoolId: string;
  visitDate: string;
  accreditorOrg: string;
  leadContactName: string | null;
  leadContactEmail: string | null;
  status: SiteVisitStatus;
  readinessScore: number | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReadinessReportDto {
  visitId: string;
  readinessScore: number;
  totalAdoptedStandards: number;
  standardsWithRating: number;
  standardsWithApprovedEvidence: number;
  standardsReady: number;
  gaps: Array<{
    standardId: string;
    standardCode: string;
    domain: string | null;
    hasRating: boolean;
    hasApprovedEvidence: boolean;
  }>;
}

export class CreateSiteVisitPrepDto {
  @IsDateString()
  visitDate!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  accreditorOrg!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  leadContactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  leadContactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateSiteVisitPrepDto {
  @IsOptional()
  @IsDateString()
  visitDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  accreditorOrg?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  leadContactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  leadContactEmail?: string;

  @IsOptional()
  @IsIn(SITE_VISIT_STATUSES)
  status?: SiteVisitStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
