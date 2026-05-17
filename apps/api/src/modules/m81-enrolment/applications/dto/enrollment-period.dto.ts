import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export var ENROLLMENT_PERIOD_STATUSES = ['UPCOMING', 'OPEN', 'CLOSED'] as const;
export type EnrollmentPeriodStatus = (typeof ENROLLMENT_PERIOD_STATUSES)[number];

export class IntakeCapacityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() enrollmentPeriodId!: string;
  @ApiPropertyOptional({ nullable: true }) streamId!: string | null;
  @ApiProperty() gradeLevel!: string;
  @ApiProperty() totalPlaces!: number;
  @ApiProperty() reservedPlaces!: number;
}

export class AdmissionStreamResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() enrollmentPeriodId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) gradeLevel!: string | null;
  @ApiPropertyOptional({ nullable: true }) opensAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) closesAt!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class CapacitySummaryRowDto {
  @ApiProperty() gradeLevel!: string;
  @ApiProperty() totalPlaces!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() applicationsReceived!: number;
  @ApiProperty() offersIssued!: number;
  @ApiProperty() offersAccepted!: number;
  @ApiProperty() waitlisted!: number;
  @ApiProperty() available!: number;
}

export class EnrollmentPeriodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() academicYearName!: string;
  @ApiProperty() name!: string;
  @ApiProperty() opensAt!: string;
  @ApiProperty() closesAt!: string;
  @ApiProperty({ enum: ENROLLMENT_PERIOD_STATUSES }) status!: EnrollmentPeriodStatus;
  @ApiProperty() allowsMidYearApplications!: boolean;
  @ApiProperty({ type: [AdmissionStreamResponseDto] }) streams!: AdmissionStreamResponseDto[];
  @ApiProperty({ type: [IntakeCapacityResponseDto] }) capacities!: IntakeCapacityResponseDto[];
  @ApiProperty({ type: [CapacitySummaryRowDto] }) capacitySummary!: CapacitySummaryRowDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateEnrollmentPeriodDto {
  @ApiProperty() @IsUUID() academicYearId!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @MaxLength(100) name!: string;
  @ApiProperty() @IsISO8601() opensAt!: string;
  @ApiProperty() @IsISO8601() closesAt!: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowsMidYearApplications?: boolean;
}

export class UpdateEnrollmentPeriodDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() closesAt?: string;

  @ApiPropertyOptional({ enum: ENROLLMENT_PERIOD_STATUSES })
  @IsOptional()
  @IsIn(ENROLLMENT_PERIOD_STATUSES as unknown as string[])
  status?: EnrollmentPeriodStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowsMidYearApplications?: boolean;
}

export class CreateAdmissionStreamDto {
  @ApiProperty({ maxLength: 80 }) @IsString() @MaxLength(80) name!: string;

  @ApiPropertyOptional({ maxLength: 8, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  gradeLevel?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() closesAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateIntakeCapacityDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() streamId?: string | null;

  @ApiProperty({ maxLength: 8 })
  @IsString()
  @MaxLength(8)
  @Matches(/^[A-Za-z0-9-]+$/)
  gradeLevel!: string;

  @ApiProperty() @IsInt() @Min(0) totalPlaces!: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) reservedPlaces?: number;
}
