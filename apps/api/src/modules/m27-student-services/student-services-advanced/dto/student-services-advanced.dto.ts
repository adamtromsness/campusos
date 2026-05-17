import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/* ── Caseload dashboard ───────────────────────────────────────── */

export class CaseloadCapacityRowDto {
  @ApiProperty() counsellorId!: string;
  @ApiProperty() counsellorName!: string | null;
  @ApiProperty() activeCaseloads!: number;
  @ApiPropertyOptional() capacityTarget?: number | null;
  @ApiProperty() utilisationPct!: number;
  @ApiProperty() crisisCount!: number;
  @ApiProperty() academicYearId!: string;
}

export class CaseloadDashboardResponseDto {
  @ApiProperty({ type: () => [CaseloadCapacityRowDto] }) rows!: CaseloadCapacityRowDto[];
  @ApiProperty() totalActive!: number;
  @ApiProperty() totalCrisis!: number;
  @ApiProperty() academicYearId!: string;
}

/* ── Agency referrals ─────────────────────────────────────────── */

export type AgencyReferralStatus = 'REFERRED' | 'CONTACTED' | 'ACTIVE_SERVICE' | 'DISCHARGED';

export class CreateAgencyReferralDto {
  @ApiProperty()
  @IsUUID()
  referralId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  agencyName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  agencyContact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  agencyPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  agencyEmail?: string;

  @ApiProperty()
  @IsDateString()
  referralDate!: string;

  @ApiProperty()
  @IsString()
  @MinLength(4)
  @MaxLength(4000)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consentObtained?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  followUpDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateAgencyReferralDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['REFERRED', 'CONTACTED', 'ACTIVE_SERVICE', 'DISCHARGED'])
  status?: AgencyReferralStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consentObtained?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  followUpDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class AgencyReferralResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() referralId!: string;
  @ApiProperty() agencyName!: string;
  @ApiProperty() agencyContact!: string | null;
  @ApiProperty() agencyPhone!: string | null;
  @ApiProperty() agencyEmail!: string | null;
  @ApiProperty() referralDate!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() status!: AgencyReferralStatus;
  @ApiProperty() consentObtained!: boolean;
  @ApiProperty() followUpDate!: string | null;
  @ApiProperty() notes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/* ── Wellbeing longitudinal ───────────────────────────────────── */

export type WellbeingDomain = 'ACADEMIC' | 'SOCIAL' | 'EMOTIONAL' | 'PHYSICAL' | 'SAFETY';
export type WellbeingTrend = 'IMPROVING' | 'STABLE' | 'DECLINING';

export class MaterialiseLongitudinalDto {
  @ApiProperty()
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  academicYear!: string;
}

export class WellbeingLongitudinalRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() studentName!: string | null;
  @ApiProperty() schoolId!: string;
  @ApiProperty() academicYear!: string;
  @ApiProperty() domain!: WellbeingDomain;
  @ApiProperty() avgScore!: number | null;
  @ApiProperty() trend!: WellbeingTrend;
  @ApiProperty() checkinCount!: number;
  @ApiProperty() flaggedCount!: number;
  @ApiProperty() counsellorNotes!: string | null;
  @ApiProperty() materialisedAt!: string;
}

export class StudentLongitudinalResponseDto {
  @ApiProperty() studentId!: string;
  @ApiProperty() studentName!: string | null;
  @ApiProperty({ type: () => [WellbeingLongitudinalRowDto] }) rows!: WellbeingLongitudinalRowDto[];
}

/* ── MTSS team meeting (extension) ────────────────────────────── */

export class CreateMtssTeamMeetingDto {
  @ApiProperty()
  @IsUUID()
  academicYearId!: string;

  @ApiProperty()
  @IsDateString()
  meetingDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  notes?: string;
}

export type MtssDiscussionRecommendation = 'MAINTAIN' | 'ESCALATE' | 'DE_ESCALATE';

export class RecordStudentDiscussionDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  tierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['MAINTAIN', 'ESCALATE', 'DE_ESCALATE'])
  tierChangeRecommended?: MtssDiscussionRecommendation;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  discussionNotes?: string;
}

export class MtssTeamMeetingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() meetingDate!: string;
  @ApiProperty() facilitatedBy!: string;
  @ApiProperty() facilitatedByName!: string | null;
  @ApiProperty() linkedMeetingId!: string | null;
  @ApiProperty() notes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class MtssStudentDiscussionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() teamMeetingId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() studentName!: string | null;
  @ApiProperty() tierId!: string | null;
  @ApiProperty() tierLabel!: string | null;
  @ApiProperty() tierChangeRecommended!: MtssDiscussionRecommendation | null;
  @ApiProperty() discussionNotes!: string | null;
  @ApiProperty() createdAt!: string;
}

/* ── CRISIS escalation hook ───────────────────────────────────── */

export class EscalateReferralResponseDto {
  @ApiProperty() referralId!: string;
  @ApiProperty() previousPriority!: string;
  @ApiProperty() newPriority!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty() escalatedAt!: string;
}

/* ── Query DTOs ───────────────────────────────────────────────── */

export class ListAgencyReferralsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  referralId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['REFERRED', 'CONTACTED', 'ACTIVE_SERVICE', 'DISCHARGED'])
  status?: AgencyReferralStatus;
}

export class CaseloadDashboardQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class WellbeingLongitudinalQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  academicYear?: string;
}

export class StudentLongitudinalParamDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;
}
