import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const REDUCTION_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT'] as const;
export type ReductionType = (typeof REDUCTION_TYPES)[number];

export const AWARD_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type AwardStatus = (typeof AWARD_STATUSES)[number];

export const APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const INCOME_BANDS = ['BAND_A', 'BAND_B', 'BAND_C', 'BAND_D', 'BAND_E'] as const;
export type IncomeBand = (typeof INCOME_BANDS)[number];

export class FinancialAidProgramResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: REDUCTION_TYPES }) reductionType!: ReductionType;
  @ApiProperty() reductionValue!: number;
  @ApiPropertyOptional({ nullable: true }) totalFundAmount!: number | null;
  @ApiPropertyOptional({ nullable: true }) fundRemaining!: number | null;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ nullable: true }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateFinancialAidProgramDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty({ enum: REDUCTION_TYPES })
  @IsIn(REDUCTION_TYPES as unknown as string[])
  reductionType!: ReductionType;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) reductionValue!: number;
  @ApiPropertyOptional({ description: 'NULL means uncapped' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalFundAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateFinancialAidProgramDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalFundAmount?: number;
}

export class FinancialAidAwardResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiProperty() programId!: string;
  @ApiPropertyOptional({ nullable: true }) programName!: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() awardAmount!: number;
  @ApiProperty() approvedBy!: string;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional({ nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ enum: AWARD_STATUSES }) status!: AwardStatus;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class FinancialAidApplicationDocumentDto {
  @ApiProperty() @IsString() @MaxLength(500) s3Key!: string;
  @ApiProperty() @IsString() @MaxLength(200) label!: string;
}

export class FinancialAidApplicationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiProperty() programId!: string;
  @ApiPropertyOptional({ nullable: true }) programName!: string | null;
  @ApiProperty() guardianId!: string;
  @ApiPropertyOptional({ nullable: true }) guardianName!: string | null;
  @ApiProperty() academicYearId!: string;
  @ApiPropertyOptional({ nullable: true }) householdIncomeBand!: IncomeBand | null;
  @ApiProperty({ type: [FinancialAidApplicationDocumentDto] })
  supportingDocuments!: FinancialAidApplicationDocumentDto[];
  @ApiPropertyOptional({ nullable: true }) applicationStatement!: string | null;
  @ApiProperty({ enum: APPLICATION_STATUSES }) status!: ApplicationStatus;
  @ApiPropertyOptional({ nullable: true }) submittedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewerNotes!: string | null;
  @ApiPropertyOptional({ nullable: true }) awardId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateFinancialAidApplicationDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsUUID() programId!: string;
  @ApiProperty() @IsUUID() academicYearId!: string;
  @ApiPropertyOptional({ enum: INCOME_BANDS })
  @IsOptional()
  @IsIn(INCOME_BANDS as unknown as string[])
  householdIncomeBand?: IncomeBand;
  @ApiPropertyOptional({ type: [FinancialAidApplicationDocumentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinancialAidApplicationDocumentDto)
  supportingDocuments?: FinancialAidApplicationDocumentDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) applicationStatement?: string;
  @ApiPropertyOptional({
    description:
      'If true, the application is submitted immediately and status becomes SUBMITTED. Otherwise it lands as DRAFT.',
  })
  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}

export class UpdateFinancialAidApplicationDto {
  @ApiPropertyOptional({ enum: INCOME_BANDS })
  @IsOptional()
  @IsIn(INCOME_BANDS as unknown as string[])
  householdIncomeBand?: IncomeBand;
  @ApiPropertyOptional({ type: [FinancialAidApplicationDocumentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinancialAidApplicationDocumentDto)
  supportingDocuments?: FinancialAidApplicationDocumentDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) applicationStatement?: string;
}

export class ReviewFinancialAidApplicationDto {
  @ApiProperty({
    description:
      'Review action. APPROVE creates an award and decrements programme fund_remaining. REJECT records a rejection. UNDER_REVIEW marks the application as in-review.',
    enum: ['APPROVE', 'REJECT', 'UNDER_REVIEW'],
  })
  @IsIn(['APPROVE', 'REJECT', 'UNDER_REVIEW'])
  action!: 'APPROVE' | 'REJECT' | 'UNDER_REVIEW';

  @ApiPropertyOptional({
    description: 'For APPROVE only. Award amount in dollars. > 0 and <= programme fund_remaining.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  awardAmount?: number;

  @ApiPropertyOptional({ description: 'For APPROVE only. Effective-from date for the award.' })
  @IsOptional()
  @IsString()
  awardEffectiveFrom?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) reviewerNotes?: string;
}

export class WithdrawFinancialAidApplicationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class ListFinancialAidApplicationsQueryDto {
  @ApiPropertyOptional({ enum: APPLICATION_STATUSES })
  @IsOptional()
  @IsIn(APPLICATION_STATUSES as unknown as string[])
  status?: ApplicationStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() studentId?: string;
}
