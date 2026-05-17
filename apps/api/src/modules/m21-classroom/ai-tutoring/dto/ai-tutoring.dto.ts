import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

/**
 * AI Tutoring DTOs — P2-7c Step 6.
 *
 * All Cycle 7 sub-cycle c contracts follow the same pattern as P2-7a/b
 * — class-validator decorators on the wire payload, plain TypeScript
 * interfaces on the response. The AI safety rules from ADR-004 are
 * enforced at the service layer (no PII to AI Gateway, no cls_grades
 * writes, opt-out gate before every Gateway call) — the DTO surface
 * carries no PII fields by design.
 */

export class StartAITutoringSessionDto {
  @ApiProperty({
    description:
      'sis_students.id of the student starting the session. STUDENT actors must omit or pass own id — the service binds to the calling actor for non-admin non-staff. Teacher and admin can start a session on behalf of a student for demo or accommodation reasons.',
  })
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({
    description: 'Optional class context — used to scope learning signals to a class.',
  })
  @IsOptional()
  @IsUUID()
  classId?: string;

  @ApiProperty({ description: 'Free-text subject label — e.g. Algebra, Photosynthesis.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject!: string;
}

export class AIMessageDto {
  @ApiProperty({ description: 'The student message body. Plain text. Max 4000 characters.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}

export class CompleteAISessionDto {
  @ApiPropertyOptional({
    description:
      'Optional outcome notes from the student or teacher. Stored on the session row for the session list view.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export interface AITutoringMessageResponseDto {
  id: string;
  sessionId: string;
  role: 'STUDENT' | 'ASSISTANT';
  content: string;
  sentAt: string;
  tokensUsed: number | null;
  createdAt: string;
}

export interface AITutoringSessionResponseDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  classId: string | null;
  className: string | null;
  subject: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  startedAt: string;
  endedAt: string | null;
  totalMessages: number;
  learningSignalsExtracted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AITutoringSessionWithMessagesDto extends AITutoringSessionResponseDto {
  messages: AITutoringMessageResponseDto[];
}

export interface AILearningSignalResponseDto {
  id: string;
  sessionId: string;
  signalType: 'MISCONCEPTION' | 'STRENGTH' | 'STRUGGLE' | 'INTEREST' | 'ENGAGEMENT';
  signalDescription: string;
  standardId: string | null;
  confidence: number | null;
  extractedAt: string;
  createdAt: string;
}

export class CreateLessonRecordingDto {
  @ApiProperty({
    description:
      'cls_lessons.id this recording belongs to. The lesson must be in a class the calling teacher teaches.',
  })
  @IsUUID()
  lessonId!: string;

  @ApiProperty({
    description: 'S3 object key — signed URL pattern matching hr_employee_documents.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  s3Key!: string;

  @ApiPropertyOptional({ description: 'Recording duration in seconds. Optional.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;
}

export interface LessonRecordingResponseDto {
  id: string;
  lessonId: string;
  classId: string;
  schoolId: string;
  recordedBy: string;
  recordedByName: string | null;
  s3Key: string;
  durationSeconds: number | null;
  recordedAt: string;
  processingStatus: 'UPLOADED' | 'TRANSCRIBING' | 'SUMMARISING' | 'COMPLETE' | 'FAILED';
  errorMessage: string | null;
  transcript: LessonTranscriptResponseDto | null;
  summary: LessonSummaryResponseDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface LessonTranscriptResponseDto {
  id: string;
  recordingId: string;
  transcriptText: string;
  wordCount: number | null;
  language: string;
  generatedAt: string;
}

export interface LessonSummaryResponseDto {
  id: string;
  recordingId: string;
  summaryText: string;
  keyTopics: string[];
  actionItems: string[];
  modelVersion: string | null;
  tokensUsed: number | null;
  generatedAt: string;
}

export interface AIUsageRowResponseDto {
  id: string;
  schoolId: string;
  jobType: 'GRADING' | 'SUMMARISATION' | 'TUTORING' | 'STUDENT_SUMMARY';
  tokensUsed: number;
  costUsd: number;
  referenceId: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface AIUsageSummaryDto {
  totalTokens: number;
  totalCost: number;
  byJobType: Record<string, { tokens: number; cost: number; calls: number }>;
  windowStart: string;
  windowEnd: string;
}

export interface AIQuotaResponseDto {
  schoolId: string;
  dailyLimitTokens: number;
  usedTokensToday: number;
  remainingTokensToday: number;
  resetAt: string;
}

export class CreateOptOutDto {
  @ApiProperty({
    description:
      'sis_students.id of the student to opt out. Parents may opt out their own children only — the service validates the guardian relationship via sis_student_guardians.',
  })
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional({
    description: 'Optional reason — stored on the row for audit. Max 1000 characters.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export interface OptOutResponseDto {
  id: string;
  studentId: string;
  studentName: string | null;
  optedOutBy: string;
  optedOutByName: string | null;
  optedOutAt: string;
  reason: string | null;
}
