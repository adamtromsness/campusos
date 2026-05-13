import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Conference Events ────────────────────────────────────────────

export type ConferenceEventStatus = 'DRAFT' | 'BOOKING_OPEN' | 'IN_PROGRESS' | 'COMPLETED';

export interface ConferenceEventDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string;
  bookingOpensAt: string;
  bookingClosesAt: string;
  defaultSlotDurationMinutes: number;
  defaultBreakMinutes: number;
  status: ConferenceEventStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class CreateConferenceEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsISO8601()
  bookingOpensAt!: string;

  @IsISO8601()
  bookingClosesAt!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  defaultSlotDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultBreakMinutes?: number;
}

export class UpdateConferenceEventDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsISO8601()
  bookingOpensAt?: string;

  @IsOptional()
  @IsISO8601()
  bookingClosesAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  defaultSlotDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultBreakMinutes?: number;

  @IsOptional()
  @IsIn(['DRAFT', 'BOOKING_OPEN', 'IN_PROGRESS', 'COMPLETED'])
  status?: ConferenceEventStatus;
}

// ── Conference Slots ─────────────────────────────────────────────

export type ConferenceSlotStatus = 'AVAILABLE' | 'BOOKED' | 'BLOCKED';

export interface ConferenceSlotDto {
  id: string;
  conferenceEventId: string;
  schoolId: string;
  teacherId: string;
  teacherName: string | null;
  slotDate: string;
  startTime: string;
  endTime: string;
  location: string | null;
  meetingUrl: string | null;
  status: ConferenceSlotStatus;
  maxBookings: number;
  currentBookings: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export class GenerateSlotsDto {
  @IsUUID()
  teacherId!: string;

  @IsDateString()
  slotDate!: string;

  @IsString()
  startTime!: string;

  @IsString()
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(240)
  slotDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingUrl?: string;
}

export class UpdateSlotDto {
  @IsOptional()
  @IsIn(['AVAILABLE', 'BLOCKED'])
  status?: 'AVAILABLE' | 'BLOCKED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ── Conference Bookings ──────────────────────────────────────────

export interface FollowUpAction {
  description: string;
  due_date: string;
  status: 'PENDING' | 'COMPLETED';
}

export interface ConferenceBookingDto {
  id: string;
  slotId: string;
  schoolId: string;
  parentId: string;
  studentId: string;
  bookedAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  attended: boolean | null;
  conferenceNotes: string | null;
  followUpActions: FollowUpAction[] | null;
  parentFeedbackRating: number | null;
  parentFeedbackComments: string | null;
  createdAt: string;
  updatedAt: string;
  slot?: ConferenceSlotDto | null;
}

export class BookSlotDto {
  @IsUUID()
  studentId!: string;
}

export class CancelBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class FollowUpActionInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsDateString()
  due_date!: string;

  @IsIn(['PENDING', 'COMPLETED'])
  status!: 'PENDING' | 'COMPLETED';
}

export class UpdateBookingDto {
  @IsOptional()
  @IsBoolean()
  attended?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  conferenceNotes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FollowUpActionInputDto)
  followUpActions?: FollowUpActionInputDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  parentFeedbackRating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  parentFeedbackComments?: string;
}

// ── Engagement Scores ────────────────────────────────────────────

export type EngagementLevel = 'HIGHLY_ENGAGED' | 'ENGAGED' | 'MINIMAL' | 'AT_RISK';

export interface EngagementScoreDto {
  id: string;
  schoolId: string;
  familyAccountId: string;
  scoreDate: string;
  compositeScore: number;
  attendanceComponent: number | null;
  communicationComponent: number | null;
  conferenceComponent: number | null;
  volunteerComponent: number | null;
  paymentComponent: number | null;
  engagementLevel: EngagementLevel;
  componentWeights: Record<string, number> | null;
  notes: string | null;
  computedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngagementSummaryDto {
  totalFamilies: number;
  byLevel: Record<EngagementLevel, number>;
  averageScore: number;
  scoreDate: string | null;
}

export interface EngagementScoreWeights {
  attendance: number;
  communication: number;
  conference: number;
  volunteer: number;
  payment: number;
}

export interface EngagementLevelThresholds {
  highlyEngaged: number;
  engaged: number;
  minimal: number;
}

export class UpdateScoreConfigDto {
  @IsOptional()
  @IsObject()
  weights?: Partial<EngagementScoreWeights>;

  @IsOptional()
  @IsObject()
  thresholds?: Partial<EngagementLevelThresholds>;
}

// ── Parent Surveys ───────────────────────────────────────────────

export type SurveyStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

export type SurveyQuestionType =
  | 'RATING_1_5'
  | 'RATING_1_10'
  | 'YES_NO'
  | 'FREE_TEXT'
  | 'MULTIPLE_CHOICE';

export interface SurveyQuestion {
  id: string;
  question_text: string;
  question_type: SurveyQuestionType;
  options?: string[];
}

export interface SurveyDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  questions: SurveyQuestion[];
  isAnonymous: boolean;
  opensAt: string | null;
  closesAt: string | null;
  status: SurveyStatus;
  totalResponses: number;
  responseDataAggregated: Record<string, unknown> | null;
  createdBy: string;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CreateSurveyQuestionDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  question_text!: string;

  @IsIn(['RATING_1_5', 'RATING_1_10', 'YES_NO', 'FREE_TEXT', 'MULTIPLE_CHOICE'])
  question_type!: SurveyQuestionType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];
}

export class CreateSurveyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSurveyQuestionDto)
  questions!: CreateSurveyQuestionDto[];

  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  @IsOptional()
  @IsISO8601()
  opensAt?: string;

  @IsOptional()
  @IsISO8601()
  closesAt?: string;
}

export class UpdateSurveyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSurveyQuestionDto)
  questions?: CreateSurveyQuestionDto[];

  @IsOptional()
  @IsISO8601()
  opensAt?: string;

  @IsOptional()
  @IsISO8601()
  closesAt?: string;

  @IsOptional()
  @IsIn(['DRAFT', 'OPEN', 'CLOSED'])
  status?: SurveyStatus;
}

export class SubmitSurveyResponseDto {
  @IsObject()
  answers!: Record<string, string | number | boolean>;
}
