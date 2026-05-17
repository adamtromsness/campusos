import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export var COVERAGE_STATUSES = ['OPEN', 'ASSIGNED', 'COVERED', 'CANCELLED'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export class CoverageRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() timetableSlotId!: string;
  @ApiProperty() classSectionCode!: string;
  @ApiProperty() courseName!: string;
  @ApiProperty() periodId!: string;
  @ApiProperty() periodName!: string;
  @ApiProperty() roomId!: string;
  @ApiProperty() roomName!: string;
  @ApiProperty() absentTeacherId!: string;
  @ApiProperty() absentTeacherName!: string;
  @ApiPropertyOptional({ nullable: true }) leaveRequestId!: string | null;
  @ApiProperty() coverageDate!: string;
  @ApiProperty({ enum: COVERAGE_STATUSES }) status!: CoverageStatus;
  @ApiPropertyOptional({ nullable: true }) assignedSubstituteId!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedSubstituteName!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class AssignCoverageDto {
  @ApiProperty({ description: 'hr_employees.id of the substitute' })
  @IsUUID()
  substituteId!: string;

  @ApiPropertyOptional({
    description: "Optional override room. Defaults to the original slot's room when omitted.",
  })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CancelCoverageDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListCoverageQueryDto {
  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD — coverage on or after this date.' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD — coverage on or before this date.' })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ enum: COVERAGE_STATUSES })
  @IsOptional()
  @IsIn(COVERAGE_STATUSES as unknown as string[])
  status?: CoverageStatus;
}

export class SubstitutionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() originalSlotId!: string;
  @ApiProperty() classSectionCode!: string;
  @ApiProperty() courseName!: string;
  @ApiProperty() periodName!: string;
  @ApiProperty() effectiveDate!: string;
  @ApiProperty() substituteId!: string;
  @ApiProperty() substituteName!: string;
  @ApiProperty() roomId!: string;
  @ApiProperty() roomName!: string;
  @ApiPropertyOptional({ nullable: true }) coverageRequestId!: string | null;
  @ApiPropertyOptional({ nullable: true }) absentTeacherName!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class ListSubstitutionsQueryDto {
  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  toDate?: string;
}
