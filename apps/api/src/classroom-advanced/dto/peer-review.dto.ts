import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const PEER_REVIEW_TYPES = ['RANDOM', 'TEACHER_ASSIGNED'] as const;
export type PeerReviewType = (typeof PEER_REVIEW_TYPES)[number];

export const PEER_REVIEW_STATUSES = ['ASSIGNED', 'SUBMITTED', 'REVIEWED_BY_TEACHER'] as const;
export type PeerReviewStatus = (typeof PEER_REVIEW_STATUSES)[number];

export const PEER_OVERALL_RATINGS = ['EXCELLENT', 'GOOD', 'DEVELOPING', 'NEEDS_WORK'] as const;
export type PeerOverallRating = (typeof PEER_OVERALL_RATINGS)[number];

export class CreatePeerReviewAssignmentDto {
  @ApiPropertyOptional({ enum: PEER_REVIEW_TYPES, default: 'RANDOM' })
  @IsOptional()
  @IsIn(PEER_REVIEW_TYPES as unknown as string[])
  reviewType?: PeerReviewType;

  @ApiPropertyOptional({ default: 2, minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  reviewsPerStudent?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  @ApiPropertyOptional({ description: 'Optional rubric for peer scoring.' })
  @IsOptional()
  @IsUUID()
  rubricId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;
}

export class AssignPeerReviewsDto {
  @ApiPropertyOptional({
    description:
      'Required when reviewType=TEACHER_ASSIGNED. Map of reviewer_student_id to array of submission_ids to review. RANDOM mode auto-distributes.',
  })
  @IsOptional()
  manualAssignments?: Record<string, string[]>;
}

export class SubmitPeerReviewDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  feedback?: string;

  @ApiPropertyOptional({ enum: PEER_OVERALL_RATINGS })
  @IsOptional()
  @IsIn(PEER_OVERALL_RATINGS as unknown as string[])
  overallRating?: PeerOverallRating;
}

export interface PeerReviewAssignmentResponseDto {
  id: string;
  assignmentId: string;
  assignmentTitle: string | null;
  reviewType: PeerReviewType;
  reviewsPerStudent: number;
  isAnonymous: boolean;
  rubricId: string | null;
  rubricTitle: string | null;
  dueDate: string | null;
  instructions: string | null;
  createdBy: string;
  createdByName: string | null;
  totalReviews: number;
  submittedReviews: number;
  createdAt: string;
  updatedAt: string;
}

export interface PeerReviewResponseDto {
  id: string;
  peerAssignmentId: string;
  reviewerStudentId: string | null;
  reviewerStudentName: string | null;
  revieweeSubmissionId: string;
  revieweeStudentId: string | null;
  revieweeStudentName: string | null;
  feedback: string | null;
  overallRating: PeerOverallRating | null;
  status: PeerReviewStatus;
  submittedAt: string | null;
  teacherReviewedBy: string | null;
  teacherReviewedAt: string | null;
  isAnonymousView: boolean;
  createdAt: string;
  updatedAt: string;
}
