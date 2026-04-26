import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export var REASON_CATEGORIES = ['ILLNESS', 'MEDICAL_APPOINTMENT', 'FAMILY_EMERGENCY', 'HOLIDAY', 'RELIGIOUS_OBSERVANCE', 'OTHER'] as const;
export var REQUEST_TYPES = ['SAME_DAY_REPORT', 'ADVANCE_REQUEST'] as const;
export var REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'] as const;

export class CreateAbsenceRequestDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ description: 'Inclusive start date (YYYY-MM-DD)' })
  @IsDateString()
  absenceDateFrom!: string;

  @ApiProperty({ description: 'Inclusive end date (YYYY-MM-DD)' })
  @IsDateString()
  absenceDateTo!: string;

  @ApiProperty({ enum: REQUEST_TYPES })
  @IsIn(REQUEST_TYPES as unknown as string[])
  requestType!: string;

  @ApiProperty({ enum: REASON_CATEGORIES })
  @IsIn(REASON_CATEGORIES as unknown as string[])
  reasonCategory!: string;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString() @MaxLength(1000)
  reasonText!: string;

  @ApiPropertyOptional({ description: 'Pre-uploaded S3 key (e.g. doctor note)' })
  @IsOptional() @IsString() @MaxLength(500)
  supportingDocumentS3Key?: string;
}

export class ReviewAbsenceRequestDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1000)
  reviewerNotes?: string;
}

export class ListAbsenceRequestsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() studentId?: string;
  @ApiPropertyOptional({ enum: REQUEST_STATUSES }) @IsOptional() @IsIn(REQUEST_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional({ description: 'If true, restrict to requests submitted by the calling user' })
  @IsOptional() mySubmissions?: boolean;
}

export class AbsenceRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() submittedBy!: string;
  @ApiProperty() submittedByEmail!: string | null;
  @ApiProperty() absenceDateFrom!: string;
  @ApiProperty() absenceDateTo!: string;
  @ApiProperty({ enum: REQUEST_TYPES }) requestType!: string;
  @ApiProperty({ enum: REASON_CATEGORIES }) reasonCategory!: string;
  @ApiProperty() reasonText!: string;
  @ApiProperty({ nullable: true }) supportingDocumentS3Key!: string | null;
  @ApiProperty({ enum: REQUEST_STATUSES }) status!: string;
  @ApiProperty({ nullable: true }) reviewedBy!: string | null;
  @ApiProperty({ nullable: true }) reviewedAt!: string | null;
  @ApiProperty({ nullable: true }) reviewerNotes!: string | null;
  @ApiProperty() createdAt!: string;
}
