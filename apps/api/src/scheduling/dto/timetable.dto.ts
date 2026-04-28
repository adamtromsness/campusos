import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class TimetableSlotResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() classSectionCode!: string;
  @ApiProperty() courseName!: string;
  @ApiProperty() periodId!: string;
  @ApiProperty() periodName!: string;
  @ApiPropertyOptional({ nullable: true }) dayOfWeek!: number | null;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiPropertyOptional({ nullable: true }) teacherId!: string | null;
  @ApiPropertyOptional({ nullable: true }) teacherName!: string | null;
  @ApiProperty() roomId!: string;
  @ApiProperty() roomName!: string;
  @ApiProperty() effectiveFrom!: string;
  @ApiPropertyOptional({ nullable: true }) effectiveTo!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
}

export class CreateTimetableSlotDto {
  @ApiProperty()
  @IsUUID()
  classId!: string;

  @ApiProperty()
  @IsUUID()
  periodId!: string;

  @ApiPropertyOptional({ description: 'hr_employees.id — null for TBD.', nullable: true })
  @IsOptional()
  @IsUUID()
  teacherId?: string | null;

  @ApiProperty()
  @IsUUID()
  roomId!: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD; null = open-ended', nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateTimetableSlotDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  teacherId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD; null = open-ended', nullable: true })
  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListTimetableQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  classId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD — slots active on this date.' })
  @IsOptional()
  @IsDateString()
  onDate?: string;
}
