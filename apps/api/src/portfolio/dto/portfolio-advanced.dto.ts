import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── P2-27 unions ─────────────────────────────────────────────

export type EndorserRole = 'TEACHER' | 'COUNSELLOR' | 'MENTOR';
export const ENDORSER_ROLES: readonly EndorserRole[] = ['TEACHER', 'COUNSELLOR', 'MENTOR'] as const;

export type PathwayType =
  | 'COLLEGE_PREP'
  | 'CAREER_TECHNICAL'
  | 'ARTS_CONSERVATORY'
  | 'MILITARY'
  | 'GENERAL';
export const PATHWAY_TYPES: readonly PathwayType[] = [
  'COLLEGE_PREP',
  'CAREER_TECHNICAL',
  'ARTS_CONSERVATORY',
  'MILITARY',
  'GENERAL',
] as const;

export type MilestoneCategory =
  | 'ACADEMIC'
  | 'TESTING'
  | 'SERVICE'
  | 'APPLICATION'
  | 'FINANCIAL_AID'
  | 'OTHER';
export const MILESTONE_CATEGORIES: readonly MilestoneCategory[] = [
  'ACADEMIC',
  'TESTING',
  'SERVICE',
  'APPLICATION',
  'FINANCIAL_AID',
  'OTHER',
] as const;

export type MilestoneStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export const MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
] as const;

export type PathwayAssignmentStatus = 'ACTIVE' | 'COMPLETED' | 'WITHDRAWN';
export const PATHWAY_ASSIGNMENT_STATUSES: readonly PathwayAssignmentStatus[] = [
  'ACTIVE',
  'COMPLETED',
  'WITHDRAWN',
] as const;

export type CollegeApplicationType = 'EARLY_DECISION' | 'EARLY_ACTION' | 'REGULAR' | 'ROLLING';
export const COLLEGE_APPLICATION_TYPES: readonly CollegeApplicationType[] = [
  'EARLY_DECISION',
  'EARLY_ACTION',
  'REGULAR',
  'ROLLING',
] as const;

export type CollegeApplicationStatus =
  | 'RESEARCHING'
  | 'PREPARING'
  | 'SUBMITTED'
  | 'INTERVIEW_SCHEDULED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WAITLISTED';
export const COLLEGE_APPLICATION_STATUSES: readonly CollegeApplicationStatus[] = [
  'RESEARCHING',
  'PREPARING',
  'SUBMITTED',
  'INTERVIEW_SCHEDULED',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
] as const;

// ── Section DTOs ────────────────────────────────────────────

export class PortfolioSectionDto {
  id!: string;
  portfolioId!: string;
  title!: string;
  description!: string | null;
  sortOrder!: number;
  coverImageS3Key!: string | null;
  itemCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateSectionDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImageS3Key?: string;
}

export class UpdateSectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImageS3Key?: string;
}

export class AssignItemToSectionDto {
  @ApiPropertyOptional({ description: 'Null to remove from any section.' })
  @IsOptional()
  @IsUUID()
  sectionId?: string | null;
}

// ── Reflection DTOs ─────────────────────────────────────────

export class ReflectionDto {
  id!: string;
  portfolioItemId!: string;
  studentId!: string;
  prompt!: string | null;
  reflectionText!: string;
  writtenAt!: string;
  updatedAt!: string;
}

export class CreateReflectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiProperty()
  @IsString()
  @Length(1, 5000)
  reflectionText!: string;
}

export class UpdateReflectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiProperty()
  @IsString()
  @Length(1, 5000)
  reflectionText!: string;
}

// ── Endorsement DTOs ────────────────────────────────────────

export class EndorsementDto {
  id!: string;
  portfolioId!: string;
  endorsedById!: string | null;
  endorsedByName!: string | null;
  endorserRole!: EndorserRole;
  skills!: string[];
  comment!: string;
  isVisibleOnShare!: boolean;
  endorsedAt!: string;
  updatedAt!: string;
}

export class CreateEndorsementDto {
  @ApiProperty({ enum: ENDORSER_ROLES })
  @IsIn(ENDORSER_ROLES as unknown as string[])
  endorserRole!: EndorserRole;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  skills!: string[];

  @ApiProperty()
  @IsString()
  @Length(1, 2000)
  comment!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVisibleOnShare?: boolean;
}

export class UpdateEndorsementVisibilityDto {
  @ApiProperty()
  @IsBoolean()
  isVisibleOnShare!: boolean;
}

// ── Readiness Pathway DTOs ──────────────────────────────────

export class PathwayMilestoneDto {
  id!: string;
  pathwayId!: string;
  milestoneName!: string;
  description!: string | null;
  category!: MilestoneCategory;
  sortOrder!: number;
  isRequired!: boolean;
  autoCheckSource!: string | null;
}

export class ReadinessPathwayDto {
  id!: string;
  schoolId!: string;
  name!: string;
  description!: string | null;
  pathwayType!: PathwayType;
  isActive!: boolean;
  milestoneCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class ReadinessPathwayDetailDto extends ReadinessPathwayDto {
  milestones!: PathwayMilestoneDto[];
}

export class CreatePathwayDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: PATHWAY_TYPES })
  @IsIn(PATHWAY_TYPES as unknown as string[])
  pathwayType!: PathwayType;
}

export class UpdatePathwayDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateMilestoneDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  milestoneName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: MILESTONE_CATEGORIES })
  @IsIn(MILESTONE_CATEGORIES as unknown as string[])
  category!: MilestoneCategory;

  @ApiProperty()
  @IsInt()
  @Min(1)
  sortOrder!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  autoCheckSource?: string;
}

export class UpdateMilestoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  milestoneName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: MILESTONE_CATEGORIES })
  @IsOptional()
  @IsIn(MILESTONE_CATEGORIES as unknown as string[])
  category?: MilestoneCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  autoCheckSource?: string;
}

export class MilestoneStatusDto {
  milestoneId!: string;
  milestoneName!: string;
  category!: MilestoneCategory;
  sortOrder!: number;
  isRequired!: boolean;
  status!: MilestoneStatus;
  completedAt!: string | null;
  notes!: string | null;
  progressDetail!: string | null;
  autoCheckSource!: string | null;
}

export class PathwayAssignmentDto {
  id!: string;
  studentId!: string;
  studentName!: string | null;
  pathwayId!: string;
  pathwayName!: string | null;
  pathwayType!: PathwayType | null;
  assignedById!: string;
  assignedByName!: string | null;
  assignedAt!: string;
  milestoneStatuses!: MilestoneStatusDto[];
  overallProgress!: number;
  status!: PathwayAssignmentStatus;
  notes!: string | null;
  updatedAt!: string;
}

export class AssignPathwayDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateMilestoneStatusDto {
  @ApiProperty()
  @IsUUID()
  milestoneId!: string;

  @ApiProperty({ enum: MILESTONE_STATUSES })
  @IsIn(MILESTONE_STATUSES as unknown as string[])
  status!: MilestoneStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  progressDetail?: string;
}

export class ReadinessDashboardRowDto {
  studentId!: string;
  studentName!: string | null;
  gradeLevel!: string | null;
  pathwayId!: string;
  pathwayName!: string;
  pathwayType!: PathwayType;
  overallProgress!: number;
  status!: PathwayAssignmentStatus;
  completedMilestones!: number;
  totalMilestones!: number;
  isAtRisk!: boolean;
}

// ── College Application DTOs ────────────────────────────────

export class CollegeApplicationDto {
  id!: string;
  studentId!: string;
  studentName!: string | null;
  collegeName!: string;
  applicationType!: CollegeApplicationType;
  deadline!: string | null;
  status!: CollegeApplicationStatus;
  essayS3Key!: string | null;
  recommendationCount!: number;
  transcriptSent!: boolean;
  financialAidApplied!: boolean;
  notes!: string | null;
  decisionDate!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateCollegeApplicationDto {
  @ApiPropertyOptional({
    description:
      'Defaults to caller-resolved student. Admins / counsellors may submit for a specific student.',
  })
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  collegeName!: string;

  @ApiProperty({ enum: COLLEGE_APPLICATION_TYPES })
  @IsIn(COLLEGE_APPLICATION_TYPES as unknown as string[])
  applicationType!: CollegeApplicationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  deadline?: string;

  @ApiPropertyOptional({ enum: COLLEGE_APPLICATION_STATUSES })
  @IsOptional()
  @IsIn(COLLEGE_APPLICATION_STATUSES as unknown as string[])
  status?: CollegeApplicationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateCollegeApplicationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  collegeName?: string;

  @ApiPropertyOptional({ enum: COLLEGE_APPLICATION_TYPES })
  @IsOptional()
  @IsIn(COLLEGE_APPLICATION_TYPES as unknown as string[])
  applicationType?: CollegeApplicationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  deadline?: string;

  @ApiPropertyOptional({ enum: COLLEGE_APPLICATION_STATUSES })
  @IsOptional()
  @IsIn(COLLEGE_APPLICATION_STATUSES as unknown as string[])
  status?: CollegeApplicationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  essayS3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  recommendationCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  transcriptSent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  financialAidApplied?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  decisionDate?: string;
}

// ── Resume DTOs ─────────────────────────────────────────────

export class ResumeWorkExperienceDto {
  @ApiProperty()
  @IsString()
  employer!: string;

  @ApiProperty()
  @IsString()
  role!: string;

  @ApiProperty()
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class ResumeReferenceDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsString()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  relationship?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class ResumeProfileDto {
  id!: string;
  studentId!: string;
  studentName!: string | null;
  objectiveStatement!: string | null;
  skills!: string[];
  workExperience!: unknown[];
  extracurriculars!: unknown[];
  awards!: unknown[];
  serviceHoursTotal!: number;
  references!: unknown[];
  pdfS3Key!: string | null;
  lastGeneratedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class UpdateResumeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  objectiveStatement?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  workExperience?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  extracurriculars?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  awards?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({}, { each: false })
  @Min(0)
  @Max(9999.9)
  serviceHoursTotal?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  references?: unknown[];
}

export class GenerateResumePdfResponseDto {
  resumeId!: string;
  pdfS3Key!: string;
  lastGeneratedAt!: string;
  skillsCount!: number;
  awardsCount!: number;
  serviceHoursTotal!: number;
  extracurricularsCount!: number;
}
