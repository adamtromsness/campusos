import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class GradebookQueryDto {
  @IsOptional()
  @IsUUID()
  termId?: string;
}

export class GradebookStudentSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) studentNumber!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
}

export class GradebookClassSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) sectionCode!: string | null;
  @ApiProperty({ nullable: true }) courseCode!: string | null;
  @ApiProperty({ nullable: true }) courseName!: string | null;
}

export class GradebookSnapshotDto {
  @ApiProperty() id!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() termId!: string;
  @ApiProperty({ nullable: true }) currentAverage!: number | null;
  @ApiProperty({ nullable: true }) letterGrade!: string | null;
  @ApiProperty() assignmentsGraded!: number;
  @ApiProperty() assignmentsTotal!: number;
  @ApiProperty({ nullable: true }) lastGradeEventAt!: string | null;
  @ApiProperty() lastUpdatedAt!: string;
}

/**
 * Teacher view of a class gradebook — one row per enrolled student with their
 * snapshot (or null if no published grades yet).
 */
export class GradebookClassRowDto {
  @ApiProperty({ type: GradebookStudentSummaryDto })
  student!: GradebookStudentSummaryDto;
  @ApiProperty({ type: GradebookSnapshotDto, nullable: true })
  snapshot!: GradebookSnapshotDto | null;
}

export class GradebookClassResponseDto {
  @ApiProperty({ type: GradebookClassSummaryDto })
  class!: GradebookClassSummaryDto;
  @ApiProperty({ nullable: true }) termId!: string | null;
  @ApiProperty({ type: [GradebookClassRowDto] })
  rows!: GradebookClassRowDto[];
}

/**
 * Student / parent view — one row per enrolled class with a snapshot.
 */
export class GradebookStudentRowDto {
  @ApiProperty({ type: GradebookClassSummaryDto })
  class!: GradebookClassSummaryDto;
  @ApiProperty({ type: GradebookSnapshotDto, nullable: true })
  snapshot!: GradebookSnapshotDto | null;
}

export class GradebookStudentResponseDto {
  @ApiProperty({ type: GradebookStudentSummaryDto })
  student!: GradebookStudentSummaryDto;
  @ApiProperty({ nullable: true }) termId!: string | null;
  @ApiProperty({ type: [GradebookStudentRowDto] })
  rows!: GradebookStudentRowDto[];
}
