import { ApiProperty } from '@nestjs/swagger';
import { AssignmentResponseDto } from './assignment.dto';
import {
  GradebookClassSummaryDto,
  GradebookSnapshotDto,
  GradebookStudentSummaryDto,
} from './gradebook.dto';

export class StudentGradeSubmissionSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'GRADED', 'RETURNED'] })
  status!: string;
  @ApiProperty({ nullable: true }) submittedAt!: string | null;
}

export class StudentGradeEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() gradeValue!: number;
  @ApiProperty() maxPoints!: number;
  @ApiProperty() percentage!: number;
  @ApiProperty({ nullable: true }) letterGrade!: string | null;
  @ApiProperty({ nullable: true }) feedback!: string | null;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty({ nullable: true }) publishedAt!: string | null;
  @ApiProperty() gradedAt!: string;
}

export class StudentClassAssignmentRowDto {
  @ApiProperty({ type: AssignmentResponseDto })
  assignment!: AssignmentResponseDto;
  @ApiProperty({ type: StudentGradeSubmissionSummaryDto, nullable: true })
  submission!: StudentGradeSubmissionSummaryDto | null;
  @ApiProperty({ type: StudentGradeEntryDto, nullable: true })
  grade!: StudentGradeEntryDto | null;
}

export class StudentClassGradesResponseDto {
  @ApiProperty({ type: GradebookClassSummaryDto })
  class!: GradebookClassSummaryDto;
  @ApiProperty({ type: GradebookStudentSummaryDto })
  student!: GradebookStudentSummaryDto;
  @ApiProperty({ nullable: true }) termId!: string | null;
  @ApiProperty({ type: GradebookSnapshotDto, nullable: true })
  snapshot!: GradebookSnapshotDto | null;
  @ApiProperty({ type: [StudentClassAssignmentRowDto] })
  assignments!: StudentClassAssignmentRowDto[];
}
