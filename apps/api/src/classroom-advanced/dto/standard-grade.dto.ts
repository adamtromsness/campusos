import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const PROFICIENCY_LEVELS = [
  'EXCEEDING',
  'MEETING',
  'APPROACHING',
  'BELOW',
  'NOT_ASSESSED',
] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

export const EVIDENCE_TYPES = ['SUBMISSION', 'OBSERVATION', 'ASSESSMENT', 'TEACHER_NOTE'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export class CreateStandardGradeDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({
    description:
      'Soft polymorphic FK — resolves to either tenant cur_standards or platform.cur_standards_platform per the Cycle 23 dual-resolution keystone.',
  })
  @IsUUID()
  standardId!: string;

  @ApiProperty()
  @IsUUID()
  classId!: string;

  @ApiProperty({ enum: PROFICIENCY_LEVELS })
  @IsIn(PROFICIENCY_LEVELS as unknown as string[])
  proficiencyLevel!: ProficiencyLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateStandardGradeDto {
  @ApiPropertyOptional({ enum: PROFICIENCY_LEVELS })
  @IsOptional()
  @IsIn(PROFICIENCY_LEVELS as unknown as string[])
  proficiencyLevel?: ProficiencyLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class AddEvidenceDto {
  @ApiProperty({ enum: EVIDENCE_TYPES })
  @IsIn(EVIDENCE_TYPES as unknown as string[])
  evidenceType!: EvidenceType;

  @ApiPropertyOptional({
    description:
      'Required for SUBMISSION (cls_submissions.id) + ASSESSMENT (cls_grades.id). Omit for OBSERVATION + TEACHER_NOTE.',
  })
  @IsOptional()
  @IsUUID()
  evidenceRefId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export interface StandardGradeEvidenceResponseDto {
  id: string;
  standardGradeId: string;
  evidenceType: EvidenceType;
  evidenceRefId: string | null;
  description: string | null;
  addedBy: string | null;
  addedAt: string;
}

export interface StandardGradeResponseDto {
  id: string;
  studentId: string;
  studentName: string | null;
  standardId: string;
  standardCode: string | null;
  standardDescription: string | null;
  classId: string;
  className: string | null;
  proficiencyLevel: ProficiencyLevel;
  assessedBy: string;
  assessedByName: string | null;
  assessedAt: string;
  notes: string | null;
  evidence: StandardGradeEvidenceResponseDto[];
  createdAt: string;
  updatedAt: string;
}

export interface ProficiencyHeatmapCellDto {
  studentId: string;
  studentName: string | null;
  standardId: string;
  standardCode: string | null;
  proficiencyLevel: ProficiencyLevel | null;
}

export interface ClassStandardsReportDto {
  classId: string;
  className: string | null;
  standards: Array<{
    standardId: string;
    standardCode: string | null;
    standardDescription: string | null;
    counts: Record<ProficiencyLevel, number>;
  }>;
  cells: ProficiencyHeatmapCellDto[];
}
