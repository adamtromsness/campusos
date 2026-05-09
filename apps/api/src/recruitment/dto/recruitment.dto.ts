import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  ArrayNotEmpty,
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
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'TEMPORARY',
  'LONG_TERM_SUBSTITUTE',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const POSTING_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'LIVE',
  'CLOSED',
  'CANCELLED',
] as const;
export type PostingStatus = (typeof POSTING_STATUSES)[number];

export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'SCREENING',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'OFFER_EXTENDED',
  'OFFER_ACCEPTED',
  'OFFER_DECLINED',
  'NOT_SELECTED',
  'WITHDRAWN',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const INTERVIEW_STATUSES = ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const EVALUATION_RATINGS = [
  'STRONG_HIRE',
  'HIRE',
  'NEUTRAL',
  'NO_HIRE',
  'STRONG_NO_HIRE',
] as const;
export type EvaluationRating = (typeof EVALUATION_RATINGS)[number];

export const CONTRACT_TYPES = ['ANNUAL', 'MULTI_YEAR', 'AT_WILL', 'TEMPORARY'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

// ----- Job postings ------------------------------------------------------

export class CreateJobPostingDto {
  @ApiProperty() @IsString() @MaxLength(200) positionTitle!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) department?: string;
  @ApiProperty() @IsString() @MaxLength(8000) description!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) qualificationsRequired?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) salaryRangeLow?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) salaryRangeHigh?: number;
  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn([...EMPLOYMENT_TYPES])
  employmentType!: EmploymentType;
  @ApiPropertyOptional() @IsOptional() @IsDateString() applicationDeadline?: string;
}

export class UpdateJobPostingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) positionTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) department?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) qualificationsRequired?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) salaryRangeLow?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) salaryRangeHigh?: number;
  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn([...EMPLOYMENT_TYPES])
  employmentType?: EmploymentType;
  @ApiPropertyOptional() @IsOptional() @IsDateString() applicationDeadline?: string;
  @ApiPropertyOptional({ enum: POSTING_STATUSES })
  @IsOptional()
  @IsIn([...POSTING_STATUSES])
  status?: PostingStatus;
}

export interface JobPostingDto {
  id: string;
  schoolId: string;
  positionTitle: string;
  department: string | null;
  description: string;
  qualificationsRequired: string | null;
  salaryRangeLow: number | null;
  salaryRangeHigh: number | null;
  employmentType: EmploymentType;
  applicationDeadline: string | null;
  status: PostingStatus;
  postedAt: string | null;
  closedAt: string | null;
  applicationCount: number;
  createdAt: string;
}

export class ListJobPostingsQueryDto {
  @ApiPropertyOptional({ enum: POSTING_STATUSES })
  @IsOptional()
  @IsIn([...POSTING_STATUSES])
  status?: PostingStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
}

// ----- Applications ------------------------------------------------------

export class ApplyToJobDto {
  @ApiProperty() @IsEmail() applicantEmail!: string;
  @ApiProperty() @IsString() @MaxLength(120) firstName!: string;
  @ApiProperty() @IsString() @MaxLength(120) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) resumeS3Key?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) coverLetterS3Key?: string;
}

export class UpdateApplicationDto {
  @ApiPropertyOptional({ enum: APPLICATION_STATUSES })
  @IsOptional()
  @IsIn([...APPLICATION_STATUSES])
  status?: ApplicationStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notSelectedReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) withdrawnReason?: string;
}

export interface ApplicationDto {
  id: string;
  postingId: string;
  postingTitle: string;
  personId: string;
  applicantName: string | null;
  applicantEmail: string | null;
  status: ApplicationStatus;
  resumeS3Key: string | null;
  coverLetterS3Key: string | null;
  submittedAt: string;
  notSelectedReason: string | null;
  withdrawnReason: string | null;
}

export class ListApplicationsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() postingId?: string;
  @ApiPropertyOptional({ enum: APPLICATION_STATUSES })
  @IsOptional()
  @IsIn([...APPLICATION_STATUSES])
  status?: ApplicationStatus;
}

// ----- Interview panels --------------------------------------------------

export class CreateInterviewPanelDto {
  @ApiProperty() @IsUUID() postingId!: string;
  @ApiProperty() @IsString() @MaxLength(200) panelName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiProperty()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  panelistPersonIds!: string[];
}

export interface InterviewPanelDto {
  id: string;
  postingId: string;
  panelName: string;
  notes: string | null;
  isActive: boolean;
  members: Array<{
    id: string;
    panelistPersonId: string;
    panelistName: string | null;
    roleInPanel: string | null;
  }>;
  createdAt: string;
}

// ----- Interviews --------------------------------------------------------

export class ScheduleInterviewDto {
  @ApiProperty() @IsUUID() applicationId!: string;
  @ApiProperty() @IsUUID() panelId!: string;
  @ApiProperty() @IsDateString() scheduledAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) durationMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) location?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) meetingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateInterviewDto {
  @ApiPropertyOptional({ enum: INTERVIEW_STATUSES })
  @IsOptional()
  @IsIn([...INTERVIEW_STATUSES])
  status?: InterviewStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @ValidateIf((o: { status?: InterviewStatus }) => o.status === 'CANCELLED')
  @Matches(/\S/, { message: 'cancellationReason must be non-empty when status=CANCELLED' })
  cancellationReason?: string;
}

export interface InterviewDto {
  id: string;
  applicationId: string;
  panelId: string;
  panelName: string | null;
  scheduledAt: string;
  durationMinutes: number | null;
  location: string | null;
  meetingUrl: string | null;
  status: InterviewStatus;
  notes: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export class SubmitEvaluationDto {
  @ApiProperty({ enum: EVALUATION_RATINGS })
  @IsIn([...EVALUATION_RATINGS])
  rating!: EvaluationRating;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) strengths?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) concerns?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export interface InterviewEvaluationDto {
  id: string;
  interviewId: string;
  evaluatorId: string;
  evaluatorName: string | null;
  rating: EvaluationRating;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  submittedAt: string;
}

// ----- Offers ------------------------------------------------------------

export class ExtendOfferDto {
  @ApiProperty() @IsString() @MaxLength(200) positionTitle!: string;
  @ApiProperty() @IsNumber() @Min(0) salary!: number;
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiProperty({ enum: CONTRACT_TYPES }) @IsIn([...CONTRACT_TYPES]) contractType!: ContractType;
  @ApiPropertyOptional() @IsOptional() @Allow() conditions?: unknown;
  @ApiProperty() @IsDateString() acceptanceDeadline!: string;
}

export class RespondToOfferDto {
  @ApiProperty()
  @IsIn(['ACCEPTED', 'DECLINED', 'WITHDRAWN'])
  decision!: 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) responseNotes?: string;
}

export interface OfferDto {
  id: string;
  applicationId: string;
  schoolId: string;
  positionTitle: string;
  salary: number;
  startDate: string;
  contractType: ContractType;
  conditions: unknown;
  acceptanceDeadline: string;
  status: OfferStatus;
  extendedAt: string;
  respondedAt: string | null;
  responseNotes: string | null;
  createdEmployeeId: string | null;
}

// ----- Job alerts --------------------------------------------------------

export class CreateJobAlertDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) subjectArea?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) gradeLevel?: string;
  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn([...EMPLOYMENT_TYPES])
  employmentType?: EmploymentType;
}

export class UpdateJobAlertDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) subjectArea?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) gradeLevel?: string;
  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn([...EMPLOYMENT_TYPES])
  employmentType?: EmploymentType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export interface JobAlertDto {
  id: string;
  personId: string;
  schoolId: string | null;
  subjectArea: string | null;
  gradeLevel: string | null;
  employmentType: EmploymentType | null;
  isActive: boolean;
  lastNotifiedAt: string | null;
  createdAt: string;
}
