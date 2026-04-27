import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, IsString } from 'class-validator';

export class ListClassesQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() termId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() courseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() academicYearId?: string;
  @ApiPropertyOptional({ description: 'Filter to grade level (matches course.grade_level)' })
  @IsOptional()
  @IsString()
  gradeLevel?: string;
}

export class CourseSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true }) gradeLevel!: string | null;
}

export class TermSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() termType!: string;
}

export class AcademicYearSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isCurrent!: boolean;
}

export class ClassTeacherDto {
  @ApiProperty() personId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() isPrimaryTeacher!: boolean;
}

export class ClassResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() sectionCode!: string;
  @ApiProperty({ nullable: true }) room!: string | null;
  @ApiProperty({ nullable: true }) maxEnrollment!: number | null;
  @ApiProperty({ type: CourseSummaryDto }) course!: CourseSummaryDto;
  @ApiProperty({ type: AcademicYearSummaryDto }) academicYear!: AcademicYearSummaryDto;
  @ApiProperty({ type: TermSummaryDto, nullable: true }) term!: TermSummaryDto | null;
  @ApiProperty({ type: [ClassTeacherDto] }) teachers!: ClassTeacherDto[];
  @ApiProperty() enrollmentCount!: number;
}

export class RosterEntryDto {
  @ApiProperty() enrollmentId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty({ nullable: true }) studentNumber!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true }) gradeLevel!: string | null;
  @ApiProperty() enrollmentStatus!: string;
}
