import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, IsIn, MinLength, MaxLength } from 'class-validator';

export var ENROLLMENT_STATUSES = ['ENROLLED', 'TRANSFERRED', 'GRADUATED', 'WITHDRAWN'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export class ListStudentsQueryDto {
  @ApiPropertyOptional({ description: 'Filter to students enrolled in this class (active enrollments only)' })
  @IsOptional()
  @IsUUID()
  classId?: string;

  @ApiPropertyOptional({ description: 'Filter by grade level (e.g. "9", "10")' })
  @IsOptional()
  @IsString()
  gradeLevel?: string;

  @ApiPropertyOptional({ enum: ENROLLMENT_STATUSES })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES as unknown as string[])
  enrollmentStatus?: EnrollmentStatus;
}

export class CreateStudentDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ description: 'Unique student number within the school', maxLength: 40 })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  studentNumber!: string;

  @ApiProperty({ description: 'Grade level (e.g. "9", "10")' })
  @IsString()
  @MaxLength(10)
  gradeLevel!: string;

  @ApiPropertyOptional({ description: 'Homeroom class id' })
  @IsOptional()
  @IsUUID()
  homeroomClassId?: string;
}

export class UpdateStudentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  studentNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  gradeLevel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  homeroomClassId?: string;

  @ApiPropertyOptional({ enum: ENROLLMENT_STATUSES })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES as unknown as string[])
  enrollmentStatus?: EnrollmentStatus;
}

export class StudentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentNumber!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() gradeLevel!: string | null;
  @ApiProperty({ enum: ENROLLMENT_STATUSES }) enrollmentStatus!: string;
  @ApiProperty({ nullable: true }) homeroomClassId!: string | null;
  @ApiProperty() schoolId!: string;
  @ApiProperty() personId!: string;
  @ApiProperty() platformStudentId!: string;
}
