import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const ASSESSMENT_TYPES = ['EXIT_TICKET', 'POLL', 'QUICK_CHECK', 'DO_NOW'] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];

export class FormativeQuestionInputDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  questionId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  prompt!: string;

  @ApiProperty({ description: 'Free-form response shape — TEXT, MULTIPLE_CHOICE, NUMERIC, etc.' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  responseType!: string;

  @ApiPropertyOptional({ description: 'Optional answer options for MULTIPLE_CHOICE.' })
  @IsOptional()
  @IsArray()
  options?: string[];
}

export class CreateFormativeAssessmentDto {
  @ApiProperty()
  @IsUUID()
  classId!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ enum: ASSESSMENT_TYPES })
  @IsIn(ASSESSMENT_TYPES as unknown as string[])
  assessmentType!: AssessmentType;

  @ApiProperty({ type: [FormativeQuestionInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @Allow()
  questions!: FormativeQuestionInputDto[];
}

export class UpdateFormativeAssessmentDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ type: [FormativeQuestionInputDto] })
  @IsOptional()
  @IsArray()
  @Allow()
  questions?: FormativeQuestionInputDto[];
}

export class SubmitFormativeResponseDto {
  @ApiProperty({
    description: 'Map of question_id to response_value (string or array). Free-form JSONB.',
  })
  @IsObject()
  @Allow()
  responses!: Record<string, unknown>;
}

export interface FormativeAssessmentResponseDto {
  id: string;
  classId: string;
  className: string | null;
  title: string;
  assessmentType: AssessmentType;
  questions: FormativeQuestionInputDto[];
  isActive: boolean;
  activatedAt: string | null;
  closedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  responseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FormativeResponseRowDto {
  id: string;
  assessmentId: string;
  studentId: string;
  studentName: string | null;
  responses: Record<string, unknown>;
  submittedAt: string;
}

export interface FormativeResultsDto {
  assessmentId: string;
  totalResponses: number;
  questionSummaries: Array<{
    questionId: string;
    prompt: string;
    responseCounts: Record<string, number>;
    sampleResponses: string[];
  }>;
  responses: FormativeResponseRowDto[];
}
