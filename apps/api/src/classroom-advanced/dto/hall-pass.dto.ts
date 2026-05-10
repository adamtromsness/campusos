import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateHallPassDto {
  @ApiProperty({ description: 'sis_students.id of the student leaving the class' })
  @IsUUID()
  studentId!: string;

  @ApiProperty({ description: 'sis_classes.id the student is leaving from' })
  @IsUUID()
  classId!: string;

  @ApiProperty({
    description:
      'Destination label. Must match a value in cls_hall_pass_settings.destinations for this school.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  destination!: string;

  @ApiPropertyOptional({
    description:
      'Override the default duration. When omitted, the school setting cls_hall_pass_settings.default_duration_minutes applies.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  durationMinutes?: number;

  @ApiPropertyOptional({ description: 'Optional teacher notes captured at issue time.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ReturnHallPassDto {
  @ApiPropertyOptional({ description: 'Optional notes appended on return.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class RecallHallPassDto {
  @ApiProperty({ description: 'Why the pass was recalled (audit trail).' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}

export class UpdateHallPassSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxConcurrentPassesPerClass?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxDailyPassesPerStudent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  defaultDurationMinutes?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  destinations?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireTeacherApproval?: boolean;
}

export interface HallPassResponseDto {
  id: string;
  schoolId: string;
  studentId: string;
  studentName: string | null;
  classId: string;
  className: string | null;
  issuedBy: string;
  issuedByName: string | null;
  destination: string;
  issuedAt: string;
  expectedReturnAt: string;
  returnedAt: string | null;
  status: 'ACTIVE' | 'RETURNED' | 'OVERDUE' | 'RECALLED';
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HallPassSettingsResponseDto {
  id: string;
  schoolId: string;
  maxConcurrentPassesPerClass: number;
  maxDailyPassesPerStudent: number;
  defaultDurationMinutes: number;
  destinations: string[];
  requireTeacherApproval: boolean;
  updatedAt: string;
}
