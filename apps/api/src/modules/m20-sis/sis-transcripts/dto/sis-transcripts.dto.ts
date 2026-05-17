/* eslint-disable max-classes-per-file */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// ─── Const arrays + types ───

export const TRANSCRIPT_TYPES = ['OFFICIAL', 'UNOFFICIAL'] as const;
export type TranscriptType = (typeof TRANSCRIPT_TYPES)[number];

export const TRANSCRIPT_STATUSES = ['GENERATED', 'SENT', 'REVOKED'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const TRANSCRIPT_REQUEST_STATUSES = [
  'SUBMITTED',
  'PROCESSING',
  'SENT',
  'PICKED_UP',
  'CANCELLED',
] as const;
export type TranscriptRequestStatus = (typeof TRANSCRIPT_REQUEST_STATUSES)[number];

export const TRANSFER_DIRECTIONS = ['INCOMING', 'OUTGOING'] as const;
export type TransferDirection = (typeof TRANSFER_DIRECTIONS)[number];

export const LOCKER_STATUSES = ['AVAILABLE', 'ASSIGNED', 'OUT_OF_SERVICE'] as const;
export type LockerStatus = (typeof LOCKER_STATUSES)[number];

export const REPORTING_PERIOD_TYPES = [
  'PROGRESS_REPORT',
  'REPORT_CARD',
  'INTERIM',
  'FINAL',
] as const;
export type ReportingPeriodType = (typeof REPORTING_PERIOD_TYPES)[number];

export const REPORTING_PERIOD_STATUSES = [
  'UPCOMING',
  'OPEN',
  'GRADING_CLOSED',
  'PUBLISHED',
] as const;
export type ReportingPeriodStatus = (typeof REPORTING_PERIOD_STATUSES)[number];

export const AWARD_TYPES = [
  'HONOR_ROLL',
  'DEANS_LIST',
  'PERFECT_ATTENDANCE',
  'SUBJECT_AWARD',
  'CITIZENSHIP',
  'OTHER',
] as const;
export type AwardType = (typeof AWARD_TYPES)[number];

export const MEDICAL_EXEMPTION_TYPES = ['PE', 'SWIMMING', 'FIELD_TRIP', 'OTHER'] as const;
export type MedicalExemptionType = (typeof MEDICAL_EXEMPTION_TYPES)[number];

// ─── Transcript DTOs ───

export class GenerateTranscriptDto {
  @ApiProperty({ enum: TRANSCRIPT_TYPES })
  @IsIn(TRANSCRIPT_TYPES as unknown as string[])
  transcriptType!: TranscriptType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  gpaConfigId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  recipientName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  recipientAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  recipientEmail?: string;

  @ApiPropertyOptional({
    description: 'When set, links this transcript to the originating request.',
  })
  @IsOptional()
  @IsUUID()
  linkedRequestId?: string;
}

export class PatchTranscriptStatusDto {
  @ApiProperty({ enum: TRANSCRIPT_STATUSES })
  @IsIn(TRANSCRIPT_STATUSES as unknown as string[])
  status!: TranscriptStatus;

  @ApiPropertyOptional({
    description: 'Required when status=REVOKED. Free-form revocation reason for audit.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  revokeReason?: string;
}

export class TranscriptCourseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  academicYear!: string;

  @ApiProperty()
  term!: string;

  @ApiProperty()
  courseName!: string;

  @ApiPropertyOptional()
  courseCode!: string | null;

  @ApiPropertyOptional()
  credits!: number | null;

  @ApiProperty()
  grade!: string;

  @ApiPropertyOptional()
  gradePoints!: number | null;

  @ApiProperty()
  isHonors!: boolean;

  @ApiProperty()
  isAp!: boolean;
}

export class TranscriptDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiPropertyOptional()
  studentName!: string | null;

  @ApiProperty({ enum: TRANSCRIPT_TYPES })
  transcriptType!: TranscriptType;

  @ApiProperty()
  generatedAt!: string;

  @ApiProperty()
  generatedBy!: string;

  @ApiPropertyOptional()
  generatedByName!: string | null;

  @ApiProperty()
  gpaConfigId!: string;

  @ApiPropertyOptional()
  cumulativeGpaSnapshot!: number | null;

  @ApiPropertyOptional()
  totalCredits!: number | null;

  @ApiPropertyOptional()
  classRank!: number | null;

  @ApiPropertyOptional()
  classSize!: number | null;

  @ApiPropertyOptional()
  pdfS3Key!: string | null;

  @ApiPropertyOptional()
  recipientName!: string | null;

  @ApiPropertyOptional()
  recipientAddress!: string | null;

  @ApiPropertyOptional()
  recipientEmail!: string | null;

  @ApiPropertyOptional()
  linkedRequestId!: string | null;

  @ApiProperty({ enum: TRANSCRIPT_STATUSES })
  status!: TranscriptStatus;

  @ApiPropertyOptional()
  sentAt!: string | null;

  @ApiPropertyOptional()
  revokedAt!: string | null;

  @ApiPropertyOptional()
  revokeReason!: string | null;

  @ApiProperty({ type: () => [TranscriptCourseDto] })
  courses!: TranscriptCourseDto[];
}

export class SubmitTranscriptRequestDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  recipientName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  recipientAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  recipientEmail?: string;

  @ApiProperty({ enum: TRANSCRIPT_TYPES })
  @IsIn(TRANSCRIPT_TYPES as unknown as string[])
  transcriptType!: TranscriptType;

  @ApiPropertyOptional({ description: 'Number of copies. Defaults to 1.', minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  copies?: number;

  @ApiPropertyOptional({
    description:
      'Per-copy fee. When set TranscriptService creates a matching pay_invoice for the family account so the family pays via the standard billing flow.',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  feeAmount?: number;

  @ApiPropertyOptional({
    description:
      'Family account to bill when feeAmount is set. Required when feeAmount is supplied.',
  })
  @IsOptional()
  @IsUUID()
  familyAccountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class PatchTranscriptRequestStatusDto {
  @ApiProperty({ enum: TRANSCRIPT_REQUEST_STATUSES })
  @IsIn(TRANSCRIPT_REQUEST_STATUSES as unknown as string[])
  status!: TranscriptRequestStatus;

  @ApiPropertyOptional({ description: 'Required when status=CANCELLED.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cancelReason?: string;
}

export class TranscriptRequestDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiPropertyOptional()
  studentName!: string | null;

  @ApiProperty()
  requestedBy!: string;

  @ApiPropertyOptional()
  requestedByName!: string | null;

  @ApiProperty()
  recipientName!: string;

  @ApiPropertyOptional()
  recipientAddress!: string | null;

  @ApiPropertyOptional()
  recipientEmail!: string | null;

  @ApiProperty({ enum: TRANSCRIPT_TYPES })
  transcriptType!: TranscriptType;

  @ApiProperty()
  copies!: number;

  @ApiPropertyOptional()
  feeAmount!: number | null;

  @ApiProperty()
  feePaid!: boolean;

  @ApiPropertyOptional()
  linkedInvoiceId!: string | null;

  @ApiProperty({ enum: TRANSCRIPT_REQUEST_STATUSES })
  status!: TranscriptRequestStatus;

  @ApiPropertyOptional()
  notes!: string | null;

  @ApiPropertyOptional()
  processedAt!: string | null;

  @ApiPropertyOptional()
  sentAt!: string | null;

  @ApiPropertyOptional()
  pickedUpAt!: string | null;

  @ApiPropertyOptional()
  cancelledAt!: string | null;

  @ApiPropertyOptional()
  cancelReason!: string | null;

  @ApiProperty()
  createdAt!: string;
}

// ─── Transfer DTOs ───

export class CreateTransferRecordDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: TRANSFER_DIRECTIONS })
  @IsIn(TRANSFER_DIRECTIONS as unknown as string[])
  transferDirection!: TransferDirection;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  otherSchoolName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  otherSchoolCountry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  otherSchoolContact?: string;

  @ApiProperty()
  @IsDateString()
  transferDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class PatchTransferRecordDto {
  @ApiPropertyOptional({
    description: 'Marks the records-package received (INCOMING only).',
  })
  @IsOptional()
  @IsBoolean()
  recordsReceived?: boolean;

  @ApiPropertyOptional({
    description: 'Marks the records-package sent (OUTGOING only).',
  })
  @IsOptional()
  @IsBoolean()
  recordsSent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  recordsPackageS3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class TransferRecordDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiPropertyOptional()
  studentName!: string | null;

  @ApiProperty({ enum: TRANSFER_DIRECTIONS })
  transferDirection!: TransferDirection;

  @ApiProperty()
  otherSchoolName!: string;

  @ApiPropertyOptional()
  otherSchoolCountry!: string | null;

  @ApiPropertyOptional()
  otherSchoolContact!: string | null;

  @ApiProperty()
  transferDate!: string;

  @ApiProperty()
  recordsReceived!: boolean;

  @ApiProperty()
  recordsSent!: boolean;

  @ApiPropertyOptional()
  recordsPackageS3Key!: string | null;

  @ApiPropertyOptional()
  notes!: string | null;

  @ApiPropertyOptional()
  recordedBy!: string | null;

  @ApiProperty()
  createdAt!: string;
}

// ─── Locker DTOs ───

export class CreateLockerDto {
  @ApiProperty()
  @IsString()
  @MaxLength(32)
  lockerNumber!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  locationDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class AssignLockerDto {
  @ApiProperty({ description: 'Locker id to assign.' })
  @IsUUID()
  lockerId!: string;

  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(16)
  academicYear!: string;

  @ApiPropertyOptional({
    description:
      'Plaintext combination. When omitted LockerService generates a random 3-digit-3-digit-3-digit combination. The plaintext is returned once in the response and never stored — only the AES-256-GCM ciphertext lands in sis_lockers.combination_encrypted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  combination?: string;
}

export class LockerDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lockerNumber!: string;

  @ApiPropertyOptional()
  locationDescription!: string | null;

  @ApiProperty({ enum: LOCKER_STATUSES })
  status!: LockerStatus;

  @ApiPropertyOptional()
  assignedToStudentId!: string | null;

  @ApiPropertyOptional()
  assignedToStudentName!: string | null;

  @ApiPropertyOptional()
  assignedAt!: string | null;

  @ApiPropertyOptional()
  academicYear!: string | null;

  @ApiPropertyOptional()
  notes!: string | null;

  @ApiProperty({
    description:
      'true when combination_encrypted is populated. Decrypted combination is returned ONLY through the dedicated assign + own-locker endpoints, never on the list view.',
  })
  hasCombination!: boolean;
}

export class StudentLockerDto extends LockerDto {
  @ApiPropertyOptional({
    description: 'Decrypted combination for own-locker view. NULL when no combination on record.',
  })
  combination!: string | null;
}

export class AssignLockerResponseDto {
  @ApiProperty({ type: () => LockerDto })
  locker!: LockerDto;

  @ApiProperty({
    description:
      'The combination plaintext returned ONCE at assignment time. The DB only stores AES-256-GCM ciphertext. Subsequent reads decrypt on demand for the assigned student.',
  })
  combination!: string;
}

export class BulkClearLockersDto {
  @ApiPropertyOptional({
    description:
      'When set restrict bulk-clear to lockers currently assigned for this academic year. When omitted every ASSIGNED locker in the school is released.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  academicYear?: string;
}

export class BulkClearLockersResponseDto {
  @ApiProperty()
  cleared!: number;
}

// ─── Reporting Period DTOs ───

export class CreateReportingPeriodDto {
  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  name!: string;

  @ApiProperty({ enum: REPORTING_PERIOD_TYPES })
  @IsIn(REPORTING_PERIOD_TYPES as unknown as string[])
  periodType!: ReportingPeriodType;

  @ApiProperty()
  @IsDateString()
  startDate!: string;

  @ApiProperty()
  @IsDateString()
  endDate!: string;

  @ApiProperty()
  @IsDateString()
  gradesDueDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  commentsDueDate?: string;
}

export class PatchReportingPeriodStatusDto {
  @ApiProperty({ enum: REPORTING_PERIOD_STATUSES })
  @IsIn(REPORTING_PERIOD_STATUSES as unknown as string[])
  status!: ReportingPeriodStatus;
}

export class ReportingPeriodDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  academicYearId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: REPORTING_PERIOD_TYPES })
  periodType!: ReportingPeriodType;

  @ApiProperty()
  startDate!: string;

  @ApiProperty()
  endDate!: string;

  @ApiProperty()
  gradesDueDate!: string;

  @ApiPropertyOptional()
  commentsDueDate!: string | null;

  @ApiProperty({ enum: REPORTING_PERIOD_STATUSES })
  status!: ReportingPeriodStatus;

  @ApiPropertyOptional()
  publishedAt!: string | null;
}

// ─── Award DTOs ───

export class CreateStudentAwardDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: AWARD_TYPES })
  @IsIn(AWARD_TYPES as unknown as string[])
  awardType!: AwardType;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  awardName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  academicYear?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  term?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  certificateS3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class StudentAwardDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiPropertyOptional()
  studentName!: string | null;

  @ApiProperty({ enum: AWARD_TYPES })
  awardType!: AwardType;

  @ApiProperty()
  awardName!: string;

  @ApiPropertyOptional()
  academicYear!: string | null;

  @ApiPropertyOptional()
  term!: string | null;

  @ApiPropertyOptional()
  awardedBy!: string | null;

  @ApiPropertyOptional()
  awardedByName!: string | null;

  @ApiProperty()
  awardedAt!: string;

  @ApiPropertyOptional()
  certificateS3Key!: string | null;

  @ApiPropertyOptional()
  description!: string | null;
}

export class BulkHonorRollDto {
  @ApiProperty()
  @IsString()
  @MaxLength(16)
  academicYear!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(32)
  term!: string;

  @ApiProperty({ minimum: 0, maximum: 5 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(5)
  gpaThreshold!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  awardName?: string;

  @ApiPropertyOptional({
    description:
      'Restrict to specific student ids. When omitted the bulk run covers every student with a GPA snapshot matching the term.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  studentIds?: string[];
}

export class BulkHonorRollResponseDto {
  @ApiProperty()
  awarded!: number;

  @ApiProperty()
  skipped!: number;

  @ApiProperty({ type: () => [String] })
  awardIds!: string[];
}

// ─── Medical Exemption DTOs ───

export class CreateMedicalExemptionDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: MEDICAL_EXEMPTION_TYPES })
  @IsIn(MEDICAL_EXEMPTION_TYPES as unknown as string[])
  exemptionType!: MedicalExemptionType;

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  doctorNoteS3Key?: string;

  @ApiProperty()
  @IsDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string;
}

export class PatchMedicalExemptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  doctorNoteS3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}

export class MedicalExemptionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiPropertyOptional()
  studentName!: string | null;

  @ApiProperty({ enum: MEDICAL_EXEMPTION_TYPES })
  exemptionType!: MedicalExemptionType;

  @ApiProperty()
  reason!: string;

  @ApiPropertyOptional()
  doctorNoteS3Key!: string | null;

  @ApiProperty()
  effectiveFrom!: string;

  @ApiPropertyOptional()
  effectiveTo!: string | null;

  @ApiPropertyOptional()
  approvedBy!: string | null;

  @ApiPropertyOptional()
  approvedByName!: string | null;

  @ApiPropertyOptional()
  approvedAt!: string | null;
}

// Avoid unused-export lint complaints — class-transformer Type/ValidateNested are
// reserved for future nested DTO use.
export const _NESTED_PLACEHOLDER = { Type, ValidateNested } as const;
