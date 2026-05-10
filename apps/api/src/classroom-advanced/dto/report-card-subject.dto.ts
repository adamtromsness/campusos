import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateReportCardSubjectDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectLabel!: string;

  @ApiPropertyOptional({ description: 'Soft FK to sis_courses(id).' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  finalGrade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  gradeValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  teacherComments?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  effortGrade?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateReportCardSubjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subjectLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  finalGrade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  gradeValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  teacherComments?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  effortGrade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export interface ReportCardSubjectResponseDto {
  id: string;
  reportCardId: string;
  subjectLabel: string;
  courseId: string | null;
  courseName: string | null;
  finalGrade: string | null;
  gradeValue: number | null;
  teacherComments: string | null;
  effortGrade: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
