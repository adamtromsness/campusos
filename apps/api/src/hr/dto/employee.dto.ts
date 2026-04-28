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

export var EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'TEMPORARY',
  'INTERN',
  'VOLUNTEER',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export var EMPLOYMENT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'TERMINATED', 'SUSPENDED'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export class EmployeePositionDto {
  @ApiProperty() id!: string;
  @ApiProperty() positionId!: string;
  @ApiProperty() positionTitle!: string;
  @ApiProperty() isTeachingRole!: boolean;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty() fte!: number;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional({ nullable: true }) effectiveTo!: string | null;
}

export class EmployeeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() personId!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) employeeNumber!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiPropertyOptional({ nullable: true }) email!: string | null;
  @ApiProperty({ enum: EMPLOYMENT_TYPES }) employmentType!: EmploymentType;
  @ApiProperty({ enum: EMPLOYMENT_STATUSES }) employmentStatus!: EmploymentStatus;
  @ApiProperty() hireDate!: string;
  @ApiPropertyOptional({ nullable: true }) terminationDate!: string | null;
  @ApiProperty({ type: [EmployeePositionDto] }) positions!: EmployeePositionDto[];
  @ApiPropertyOptional({ nullable: true })
  primaryPositionTitle!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateEmployeeDto {
  @ApiProperty({ description: 'Existing iam_person.id of the new employee.' })
  @IsUUID()
  personId!: string;

  @ApiProperty({ description: 'Existing platform_users.id linked to the iam_person above.' })
  @IsUUID()
  accountId!: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  employeeNumber?: string;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn(EMPLOYMENT_TYPES as unknown as string[])
  employmentType!: EmploymentType;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  hireDate!: string;

  @ApiPropertyOptional({ description: 'Optional initial position id.' })
  @IsOptional()
  @IsUUID()
  initialPositionId?: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  employeeNumber?: string;

  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES as unknown as string[])
  employmentType?: EmploymentType;

  @ApiPropertyOptional({ enum: EMPLOYMENT_STATUSES })
  @IsOptional()
  @IsIn(EMPLOYMENT_STATUSES as unknown as string[])
  employmentStatus?: EmploymentStatus;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  terminationDate?: string;
}

export class ListEmployeesQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by employment status — defaults to ACTIVE only when omitted.',
  })
  @IsOptional()
  @IsIn(EMPLOYMENT_STATUSES as unknown as string[])
  employmentStatus?: EmploymentStatus;

  @ApiPropertyOptional({
    description: 'When true, include terminated/suspended/on-leave employees.',
  })
  @IsOptional()
  @IsBoolean()
  includeInactive?: boolean;

  @ApiPropertyOptional({
    description: 'Free-text search across first/last name, email, employee_number.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  search?: string;
}
