import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

export var ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'TARDY', 'EARLY_DEPARTURE', 'EXCUSED'] as const;
export var CONFIRMATION_STATUSES = ['PRE_POPULATED', 'CONFIRMED'] as const;

export class AttendanceRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty({ nullable: true }) studentNumber!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() date!: string;
  @ApiProperty() period!: string;
  @ApiProperty({ enum: ATTENDANCE_STATUSES }) status!: string;
  @ApiProperty({ enum: CONFIRMATION_STATUSES }) confirmationStatus!: string;
  @ApiProperty({ nullable: true }) parentExplanation!: string | null;
  @ApiProperty({ nullable: true }) markedBy!: string | null;
  @ApiProperty({ nullable: true }) markedAt!: string | null;
  @ApiProperty({ nullable: true }) absenceRequestId!: string | null;
}

export class GetClassAttendanceQueryDto {
  @ApiPropertyOptional({ description: 'Filter to a single period; omit for all periods on the date' })
  @IsOptional() @IsString() @MaxLength(10) period?: string;
}

export class MarkAttendanceDto {
  @ApiProperty({ enum: ATTENDANCE_STATUSES })
  @IsIn(ATTENDANCE_STATUSES as unknown as string[])
  status!: string;

  @ApiPropertyOptional({ description: 'Free-text note (e.g. "arrived 8:15"); shown to parent' })
  @IsOptional() @IsString() @MaxLength(500)
  parentExplanation?: string;
}

export class BatchAttendanceEntryDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ enum: ATTENDANCE_STATUSES })
  @IsIn(ATTENDANCE_STATUSES as unknown as string[])
  status!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  parentExplanation?: string;
}

export class BatchSubmitAttendanceDto {
  @ApiProperty({ description: 'Class period this batch covers' })
  @IsString() @MaxLength(10)
  period!: string;

  @ApiProperty({ type: [BatchAttendanceEntryDto], description: 'One entry per student exception (Present students may be omitted; service treats omitted as PRESENT)' })
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => BatchAttendanceEntryDto)
  records!: BatchAttendanceEntryDto[];
}

export class BatchSubmitResultDto {
  @ApiProperty() classId!: string;
  @ApiProperty() date!: string;
  @ApiProperty() period!: string;
  @ApiProperty() totalStudents!: number;
  @ApiProperty() presentCount!: number;
  @ApiProperty() tardyCount!: number;
  @ApiProperty() absentCount!: number;
  @ApiProperty() earlyDepartureCount!: number;
  @ApiProperty() excusedCount!: number;
  @ApiProperty() confirmedAt!: string;
}

export class GetStudentAttendanceQueryDto {
  @ApiPropertyOptional({ description: 'Inclusive start date (YYYY-MM-DD)' })
  @IsOptional() @IsString() fromDate?: string;
  @ApiPropertyOptional({ description: 'Inclusive end date (YYYY-MM-DD)' })
  @IsOptional() @IsString() toDate?: string;
}
