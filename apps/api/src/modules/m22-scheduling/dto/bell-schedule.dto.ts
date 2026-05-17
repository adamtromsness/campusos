import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export var BELL_SCHEDULE_TYPES = [
  'STANDARD',
  'EARLY_DISMISSAL',
  'ASSEMBLY',
  'EXAM',
  'CUSTOM',
] as const;
export type BellScheduleType = (typeof BELL_SCHEDULE_TYPES)[number];

export var PERIOD_TYPES = ['LESSON', 'BREAK', 'LUNCH', 'REGISTRATION', 'ASSEMBLY'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

var TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export class PeriodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() bellScheduleId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) dayOfWeek!: number | null;
  @ApiProperty() startTime!: string;
  @ApiProperty() endTime!: string;
  @ApiProperty({ enum: PERIOD_TYPES }) periodType!: PeriodType;
  @ApiProperty() sortOrder!: number;
}

export class BellScheduleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: BELL_SCHEDULE_TYPES }) scheduleType!: BellScheduleType;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({ type: [PeriodResponseDto] }) periods!: PeriodResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateBellScheduleDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  name!: string;

  @ApiProperty({ enum: BELL_SCHEDULE_TYPES })
  @IsIn(BELL_SCHEDULE_TYPES as unknown as string[])
  scheduleType!: BellScheduleType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateBellScheduleDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: BELL_SCHEDULE_TYPES })
  @IsOptional()
  @IsIn(BELL_SCHEDULE_TYPES as unknown as string[])
  scheduleType?: BellScheduleType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class PeriodInputDto {
  @ApiPropertyOptional({ description: 'Optional id — when present, upsert that row.' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ maxLength: 60 })
  @IsString()
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({
    description: '0=Mon..6=Sun. Null means rotation-driven (every weekday).',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  dayOfWeek?: number | null;

  @ApiProperty({ description: 'HH:MM or HH:MM:SS' })
  @Matches(TIME_REGEX)
  startTime!: string;

  @ApiProperty({ description: 'HH:MM or HH:MM:SS' })
  @Matches(TIME_REGEX)
  endTime!: string;

  @ApiProperty({ enum: PERIOD_TYPES })
  @IsIn(PERIOD_TYPES as unknown as string[])
  periodType!: PeriodType;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpsertPeriodsDto {
  @ApiProperty({
    type: [PeriodInputDto],
    description: "Replace the schedule's periods with this set (full upsert).",
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PeriodInputDto)
  periods!: PeriodInputDto[];
}
