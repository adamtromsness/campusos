import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class GradeSubmissionDto {
  @ApiProperty({ minimum: 0, description: 'Awarded points (0 to assignment.maxPoints)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  gradeValue!: number;

  @ApiPropertyOptional({
    description:
      'Optional letter grade label. If omitted, the service derives one from the grading scale ' +
      'using the percentage gradeValue / assignment.maxPoints.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  letterGrade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  feedback?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Publish the grade immediately. Defaults false (draft). Use POST /grades/:id/publish ' +
      'to publish later. Publishing emits cls.grade.published.',
  })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class BatchGradeEntryDto {
  @ApiProperty({ description: 'sis_students.id of the student being graded' })
  @IsUUID()
  studentId!: string;

  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  gradeValue!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8)
  letterGrade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  feedback?: string;
}

export class BatchGradeRequestDto {
  @ApiProperty({ description: 'Assignment to grade (must belong to the class on the URL)' })
  @IsUUID()
  assignmentId!: string;

  @ApiProperty({
    type: [BatchGradeEntryDto],
    description:
      'One row per student to grade. Existing grades for the same (assignment, student) are ' +
      'updated; missing students are inserted. Wrapped in a single transaction.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchGradeEntryDto)
  entries!: BatchGradeEntryDto[];

  @ApiPropertyOptional({
    default: false,
    description: 'Publish all grades in this batch. Defaults false (draft).',
  })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class GradeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() assignmentId!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty({ nullable: true }) submissionId!: string | null;
  @ApiProperty() teacherId!: string;
  @ApiProperty() gradeValue!: number;
  @ApiProperty() maxPoints!: number;
  @ApiProperty() percentage!: number;
  @ApiProperty({ nullable: true }) letterGrade!: string | null;
  @ApiProperty({ nullable: true }) feedback!: string | null;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty() gradedAt!: string;
  @ApiProperty({ nullable: true }) publishedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class BatchGradeResponseDto {
  @ApiProperty() assignmentId!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() processedCount!: number;
  @ApiProperty() insertedCount!: number;
  @ApiProperty() updatedCount!: number;
  @ApiProperty() publishedCount!: number;
  @ApiProperty({ type: [GradeResponseDto] })
  grades!: GradeResponseDto[];
}

export class PublishAllResponseDto {
  @ApiProperty() assignmentId!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() publishedCount!: number;
  @ApiProperty({ type: [GradeResponseDto] })
  grades!: GradeResponseDto[];
}
