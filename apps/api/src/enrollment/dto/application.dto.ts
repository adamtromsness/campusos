import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export var APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'WITHDRAWN',
  'ENROLLED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export var ADMIN_TRANSITION_TARGETS = [
  'UNDER_REVIEW',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
  'WITHDRAWN',
] as const;
export type AdminTransitionTarget = (typeof ADMIN_TRANSITION_TARGETS)[number];

export var ADMISSION_TYPES = ['NEW_STUDENT', 'TRANSFER', 'MID_YEAR_ADMISSION'] as const;
export type AdmissionType = (typeof ADMISSION_TYPES)[number];

export var APPLICATION_NOTE_TYPES = [
  'INTERVIEW_NOTES',
  'ASSESSMENT_RESULT',
  'STAFF_OBSERVATION',
  'REFERENCE_CHECK',
  'VISIT_NOTES',
  'GENERAL',
] as const;
export type ApplicationNoteType = (typeof APPLICATION_NOTE_TYPES)[number];

export class ScreeningResponseInputDto {
  @ApiProperty() @IsString() @MaxLength(80) questionKey!: string;

  @ApiProperty({ description: 'Free-form JSON value (string, boolean, number, object, array).' })
  @Allow()
  responseValue!: any;
}

export class ScreeningResponseDto {
  @ApiProperty() questionKey!: string;
  @ApiProperty() responseValue!: any;
}

export class ApplicationDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() documentType!: string;
  @ApiProperty() s3Key!: string;
  @ApiPropertyOptional({ nullable: true }) fileName!: string | null;
  @ApiPropertyOptional({ nullable: true }) contentType!: string | null;
  @ApiPropertyOptional({ nullable: true }) fileSizeBytes!: number | null;
  @ApiProperty() uploadedAt!: string;
}

export class ApplicationNoteDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: APPLICATION_NOTE_TYPES }) noteType!: ApplicationNoteType;
  @ApiProperty() noteText!: string;
  @ApiProperty() isConfidential!: boolean;
  @ApiPropertyOptional({ nullable: true }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ApplicationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() enrollmentPeriodId!: string;
  @ApiProperty() enrollmentPeriodName!: string;
  @ApiPropertyOptional({ nullable: true }) streamId!: string | null;
  @ApiPropertyOptional({ nullable: true }) streamName!: string | null;
  @ApiProperty() studentFirstName!: string;
  @ApiProperty() studentLastName!: string;
  @ApiProperty() studentDateOfBirth!: string;
  @ApiProperty() applyingForGrade!: string;
  @ApiPropertyOptional({ nullable: true }) guardianPersonId!: string | null;
  @ApiProperty() guardianEmail!: string;
  @ApiPropertyOptional({ nullable: true }) guardianPhone!: string | null;
  @ApiProperty({ enum: ADMISSION_TYPES }) admissionType!: AdmissionType;
  @ApiProperty({ enum: APPLICATION_STATUSES }) status!: ApplicationStatus;
  @ApiPropertyOptional({ nullable: true }) submittedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedBy!: string | null;
  @ApiProperty({ type: [ScreeningResponseDto] }) screening!: ScreeningResponseDto[];
  @ApiProperty({ type: [ApplicationDocumentDto] }) documents!: ApplicationDocumentDto[];
  @ApiProperty({ type: [ApplicationNoteDto] }) notes!: ApplicationNoteDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateApplicationDto {
  @ApiProperty() @IsUUID() enrollmentPeriodId!: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() streamId?: string | null;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  studentFirstName!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  studentLastName!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsDateString()
  studentDateOfBirth!: string;

  @ApiProperty({ maxLength: 8 })
  @IsString()
  @MaxLength(8)
  @Matches(/^[A-Za-z0-9-]+$/)
  applyingForGrade!: string;

  @ApiProperty() @IsEmail() guardianEmail!: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  guardianPhone?: string;

  @ApiPropertyOptional({ enum: ADMISSION_TYPES, default: 'NEW_STUDENT' })
  @IsOptional()
  @IsIn(ADMISSION_TYPES as unknown as string[])
  admissionType?: AdmissionType;

  @ApiPropertyOptional({ type: [ScreeningResponseInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScreeningResponseInputDto)
  screening?: ScreeningResponseInputDto[];
}

export class UpdateApplicationStatusDto {
  @ApiProperty({ enum: ADMIN_TRANSITION_TARGETS })
  @IsIn(ADMIN_TRANSITION_TARGETS as unknown as string[])
  status!: AdminTransitionTarget;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}

export class CreateApplicationNoteDto {
  @ApiPropertyOptional({ enum: APPLICATION_NOTE_TYPES, default: 'GENERAL' })
  @IsOptional()
  @IsIn(APPLICATION_NOTE_TYPES as unknown as string[])
  noteType?: ApplicationNoteType;

  @ApiProperty({ maxLength: 4000 }) @IsString() @MaxLength(4000) noteText!: string;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isConfidential?: boolean;
}

export class ListApplicationsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() enrollmentPeriodId?: string;

  @ApiPropertyOptional({ enum: APPLICATION_STATUSES })
  @IsOptional()
  @IsIn(APPLICATION_STATUSES as unknown as string[])
  status?: ApplicationStatus;

  @ApiPropertyOptional({ maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  applyingForGrade?: string;
}
