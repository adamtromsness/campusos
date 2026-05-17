import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ----- Telehealth ----------------------------------------------------------

export const TELEHEALTH_SESSION_STATUSES = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
] as const;
export type TelehealthSessionStatus = (typeof TELEHEALTH_SESSION_STATUSES)[number];

export const TELEHEALTH_DOCUMENT_TYPES = [
  'SESSION_NOTES',
  'TREATMENT_PLAN',
  'REFERRAL_LETTER',
  'CONSENT',
  'OTHER',
] as const;
export type TelehealthDocumentType = (typeof TELEHEALTH_DOCUMENT_TYPES)[number];

export class CreateTelehealthProviderDto {
  @ApiProperty() @IsString() @Length(1, 200) providerName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) speciality?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) contactPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) bookingUrl?: string;
}

export class UpdateTelehealthProviderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) providerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) speciality?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) contactPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) bookingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class TelehealthProviderDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() schoolId!: string | null;
  @ApiProperty() providerName!: string;
  @ApiPropertyOptional() speciality!: string | null;
  @ApiPropertyOptional() contactEmail!: string | null;
  @ApiPropertyOptional() contactPhone!: string | null;
  @ApiPropertyOptional() bookingUrl!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateTelehealthSessionDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsUUID() providerId!: string;
  @ApiProperty() @IsString() scheduledAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(480) durationMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) meetingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requestParentConsent?: boolean;
}

export class UpdateTelehealthSessionDto {
  @ApiPropertyOptional({ enum: TELEHEALTH_SESSION_STATUSES })
  @IsOptional()
  @IsIn(TELEHEALTH_SESSION_STATUSES)
  status?: TelehealthSessionStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) meetingUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) cancellationReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sessionNotesS3Key?: string;
}

export class TelehealthSessionDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() providerId!: string;
  @ApiPropertyOptional() providerName!: string | null;
  @ApiPropertyOptional() providerSpeciality!: string | null;
  @ApiProperty() scheduledAt!: string;
  @ApiPropertyOptional() durationMinutes!: number | null;
  @ApiProperty({ enum: TELEHEALTH_SESSION_STATUSES }) status!: TelehealthSessionStatus;
  @ApiPropertyOptional() meetingUrl!: string | null;
  @ApiPropertyOptional() sessionNotesS3Key!: string | null;
  @ApiPropertyOptional() consentSignatureId!: string | null;
  @ApiPropertyOptional() consentReceivedAt!: string | null;
  @ApiPropertyOptional() completedAt!: string | null;
  @ApiPropertyOptional() cancelledAt!: string | null;
  @ApiPropertyOptional() cancellationReason!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ListTelehealthSessionsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() studentId?: string;
  @ApiPropertyOptional({ enum: TELEHEALTH_SESSION_STATUSES })
  @IsOptional()
  @IsIn(TELEHEALTH_SESSION_STATUSES)
  status?: TelehealthSessionStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}

export class UploadTelehealthDocumentDto {
  @ApiProperty({ enum: TELEHEALTH_DOCUMENT_TYPES })
  @IsIn(TELEHEALTH_DOCUMENT_TYPES)
  documentType!: TelehealthDocumentType;
  @ApiProperty() @IsString() @MaxLength(500) s3Key!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) fileSizeBytes?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() signatureRequestId?: string;
}

export class TelehealthDocumentDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty({ enum: TELEHEALTH_DOCUMENT_TYPES }) documentType!: TelehealthDocumentType;
  @ApiProperty() s3Key!: string;
  @ApiPropertyOptional() fileSizeBytes!: number | null;
  @ApiPropertyOptional() signatureRequestId!: string | null;
  @ApiProperty() uploadedBy!: string;
  @ApiPropertyOptional() uploadedByName!: string | null;
  @ApiProperty() uploadedAt!: string;
}

// ----- Immunisation requirements + compliance ------------------------------

export const COMPLIANCE_STATUSES = ['COMPLIANT', 'NON_COMPLIANT', 'EXEMPT', 'PROVISIONAL'] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const EXEMPTION_TYPES = ['MEDICAL', 'RELIGIOUS', 'PHILOSOPHICAL'] as const;
export type ExemptionType = (typeof EXEMPTION_TYPES)[number];

export class CreateImmunisationRequirementDto {
  @ApiProperty() @IsString() @Length(2, 4) stateCode!: string;
  @ApiProperty() @IsString() @Length(1, 100) vaccineName!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(20) requiredDoses!: number;
  @ApiProperty() @IsString() @Length(1, 4) requiredByGrade!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowsExemption?: boolean;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsIn(EXEMPTION_TYPES, { each: true })
  @ArrayMaxSize(3)
  exemptionTypes?: ExemptionType[];
}

export class UpdateImmunisationRequirementDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) requiredDoses?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowsExemption?: boolean;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsIn(EXEMPTION_TYPES, { each: true })
  @ArrayMaxSize(3)
  exemptionTypes?: ExemptionType[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ImmunisationRequirementDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() schoolId!: string | null;
  @ApiProperty() stateCode!: string;
  @ApiProperty() vaccineName!: string;
  @ApiProperty() requiredDoses!: number;
  @ApiProperty() requiredByGrade!: string;
  @ApiProperty() allowsExemption!: boolean;
  @ApiPropertyOptional() exemptionTypes!: string[] | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class MissingVaccineDto {
  @ApiProperty() vaccineName!: string;
  @ApiProperty() dosesReceived!: number;
  @ApiProperty() dosesRequired!: number;
}

export class ImmunisationComplianceDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiPropertyOptional() studentGrade!: string | null;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional() academicYearId!: string | null;
  @ApiProperty({ enum: COMPLIANCE_STATUSES }) status!: ComplianceStatus;
  @ApiProperty({ type: [MissingVaccineDto] }) missingVaccines!: MissingVaccineDto[];
  @ApiPropertyOptional() exemptionType!: string | null;
  @ApiPropertyOptional() exemptionDocumentS3Key!: string | null;
  @ApiProperty() lastComputedAt!: string;
  @ApiPropertyOptional() parentNotifiedAt!: string | null;
}

export class ListComplianceQueryDto {
  @ApiPropertyOptional({ enum: COMPLIANCE_STATUSES })
  @IsOptional()
  @IsIn(COMPLIANCE_STATUSES)
  status?: ComplianceStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 4) grade?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  limit?: number;
}

export class ComplianceDashboardDto {
  @ApiProperty() schoolId!: string;
  @ApiProperty() totalStudents!: number;
  @ApiProperty() compliant!: number;
  @ApiProperty() nonCompliant!: number;
  @ApiProperty() exempt!: number;
  @ApiProperty() provisional!: number;
  @ApiProperty() compliancePercent!: number;
  @ApiProperty() lastComputedAt!: string | null;
}

export class ManualComputeDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() studentId?: string;
}

// ----- Screening referrals -------------------------------------------------

export const REFERRAL_TYPES = ['VISION', 'HEARING', 'SCOLIOSIS', 'OTHER'] as const;
export type ReferralType = (typeof REFERRAL_TYPES)[number];

export const REFERRAL_OUTCOMES = [
  'NORMAL',
  'TREATMENT_REQUIRED',
  'GLASSES_PRESCRIBED',
  'HEARING_AID',
  'OTHER',
] as const;
export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number];

export const REFERRAL_STATUSES = ['REFERRED', 'FOLLOW_UP_COMPLETE', 'LOST_TO_FOLLOW_UP'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export class CreateScreeningReferralDto {
  @ApiProperty({ enum: REFERRAL_TYPES }) @IsIn(REFERRAL_TYPES) referralType!: ReferralType;
  @ApiProperty() @IsString() @Length(5, 1000) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) referredTo?: string;
  @ApiProperty() @IsString() referralDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() followUpDate?: string;
}

export class UpdateScreeningReferralDto {
  @ApiPropertyOptional({ enum: REFERRAL_STATUSES })
  @IsOptional()
  @IsIn(REFERRAL_STATUSES)
  status?: ReferralStatus;
  @ApiPropertyOptional({ enum: REFERRAL_OUTCOMES })
  @IsOptional()
  @IsIn(REFERRAL_OUTCOMES)
  followUpOutcome?: ReferralOutcome;
  @ApiPropertyOptional() @IsOptional() @IsString() followUpDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) followUpNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) referredTo?: string;
}

export class ScreeningReferralDto {
  @ApiProperty() id!: string;
  @ApiProperty() screeningId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: REFERRAL_TYPES }) referralType!: ReferralType;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional() referredTo!: string | null;
  @ApiProperty() referralDate!: string;
  @ApiPropertyOptional() followUpDate!: string | null;
  @ApiPropertyOptional({ enum: REFERRAL_OUTCOMES }) followUpOutcome!: ReferralOutcome | null;
  @ApiPropertyOptional() followUpNotes!: string | null;
  @ApiProperty({ enum: REFERRAL_STATUSES }) status!: ReferralStatus;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() createdByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ListReferralsQueryDto {
  @ApiPropertyOptional({ enum: REFERRAL_STATUSES })
  @IsOptional()
  @IsIn(REFERRAL_STATUSES)
  status?: ReferralStatus;
  @ApiPropertyOptional({ enum: REFERRAL_TYPES })
  @IsOptional()
  @IsIn(REFERRAL_TYPES)
  referralType?: ReferralType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() studentId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  limit?: number;
}
