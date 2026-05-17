import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitAssignmentDto {
  @ApiPropertyOptional({
    description:
      'Student-authored text response (markdown / plain). Empty body is allowed for ' +
      'attachment-only submissions.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  submissionText?: string;

  @ApiPropertyOptional({
    type: 'array',
    description:
      'Free-form attachment metadata stored as JSONB. File upload UX lands later — for now ' +
      'this is a passthrough so the wire format is stable.',
  })
  @IsOptional()
  @IsArray()
  attachments?: Array<Record<string, unknown>>;
}

export class SubmissionStudentSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentNumber!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
}

export class SubmissionGradeSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() gradeValue!: number;
  @ApiProperty({ nullable: true }) letterGrade!: string | null;
  @ApiProperty({ nullable: true }) feedback!: string | null;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty({ nullable: true }) publishedAt!: string | null;
  @ApiProperty() gradedAt!: string;
}

export class SubmissionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() assignmentId!: string;
  @ApiProperty() classId!: string;
  @ApiProperty({ type: SubmissionStudentSummaryDto })
  student!: SubmissionStudentSummaryDto;
  @ApiProperty({
    enum: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'GRADED', 'RETURNED'],
  })
  status!: string;
  @ApiProperty({ nullable: true }) submissionText!: string | null;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  attachments!: Array<Record<string, unknown>>;
  @ApiProperty({ nullable: true }) submittedAt!: string | null;
  @ApiProperty({ nullable: true }) returnedAt!: string | null;
  @ApiProperty({ nullable: true }) returnReason!: string | null;
  @ApiProperty({ type: SubmissionGradeSummaryDto, nullable: true })
  grade!: SubmissionGradeSummaryDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TeacherSubmissionListResponseDto {
  @ApiProperty() assignmentId!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() rosterSize!: number;
  @ApiProperty() submittedCount!: number;
  @ApiProperty() gradedCount!: number;
  @ApiProperty() publishedCount!: number;
  @ApiProperty({ type: [SubmissionResponseDto] })
  submissions!: SubmissionResponseDto[];
}
