import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export var EFFORT_RATINGS = [
  'EXCELLENT',
  'GOOD',
  'SATISFACTORY',
  'NEEDS_IMPROVEMENT',
  'UNSATISFACTORY',
] as const;

export class UpsertProgressNoteDto {
  @ApiProperty({ description: 'sis_students.id of the student' })
  @IsUUID()
  studentId!: string;

  @ApiProperty({ description: 'sis_terms.id — note is scoped to one term' })
  @IsUUID()
  termId!: string;

  @ApiProperty({ minLength: 1, maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  noteText!: string;

  @ApiPropertyOptional({ enum: EFFORT_RATINGS })
  @IsOptional()
  @IsString()
  @IsIn(EFFORT_RATINGS as unknown as string[])
  overallEffortRating?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isParentVisible?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isStudentVisible?: boolean;
}

export class ProgressNoteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() termId!: string;
  @ApiProperty() authorId!: string;
  @ApiProperty() noteText!: string;
  @ApiProperty({ nullable: true }) overallEffortRating!: string | null;
  @ApiProperty() isParentVisible!: boolean;
  @ApiProperty() isStudentVisible!: boolean;
  @ApiProperty({ nullable: true }) publishedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
