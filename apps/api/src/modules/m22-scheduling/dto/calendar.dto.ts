import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export var CALENDAR_EVENT_TYPES = [
  'HOLIDAY',
  'PROFESSIONAL_DEVELOPMENT',
  'EARLY_DISMISSAL',
  'ASSEMBLY',
  'EXAM_PERIOD',
  'PARENT_EVENT',
  'FIELD_TRIP',
  'CUSTOM',
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

var TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export class CalendarEventResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: CALENDAR_EVENT_TYPES }) eventType!: CalendarEventType;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty() allDay!: boolean;
  @ApiPropertyOptional({ nullable: true }) startTime!: string | null;
  @ApiPropertyOptional({ nullable: true }) endTime!: string | null;
  @ApiPropertyOptional({ nullable: true }) bellScheduleId!: string | null;
  @ApiPropertyOptional({ nullable: true }) bellScheduleName!: string | null;
  @ApiProperty() affectsAttendance!: boolean;
  @ApiProperty() isPublished!: boolean;
  @ApiPropertyOptional({ nullable: true }) createdById!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateCalendarEventDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: CALENDAR_EVENT_TYPES })
  @IsIn(CALENDAR_EVENT_TYPES as unknown as string[])
  eventType!: CalendarEventType;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @ApiPropertyOptional({ description: 'HH:MM — required when allDay=false' })
  @IsOptional()
  @Matches(TIME_REGEX)
  startTime?: string;

  @ApiPropertyOptional({ description: 'HH:MM — required when allDay=false' })
  @IsOptional()
  @Matches(TIME_REGEX)
  endTime?: string;

  @ApiPropertyOptional({ description: 'Optional override bell schedule for this date range' })
  @IsOptional()
  @IsUUID()
  bellScheduleId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  affectsAttendance?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Publish immediately or save as draft.' })
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateCalendarEventDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: CALENDAR_EVENT_TYPES })
  @IsOptional()
  @IsIn(CALENDAR_EVENT_TYPES as unknown as string[])
  eventType?: CalendarEventType;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @ApiPropertyOptional({ description: 'HH:MM' })
  @IsOptional()
  @Matches(TIME_REGEX)
  startTime?: string;

  @ApiPropertyOptional({ description: 'HH:MM' })
  @IsOptional()
  @Matches(TIME_REGEX)
  endTime?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  bellScheduleId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  affectsAttendance?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class ListCalendarEventsQueryDto {
  @ApiPropertyOptional({
    description: 'ISO date YYYY-MM-DD — events ending on or after this date.',
  })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({
    description: 'ISO date YYYY-MM-DD — events starting on or before this date.',
  })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ enum: CALENDAR_EVENT_TYPES })
  @IsOptional()
  @IsIn(CALENDAR_EVENT_TYPES as unknown as string[])
  eventType?: CalendarEventType;

  @ApiPropertyOptional({
    description: 'Admin-only — include unpublished drafts. Non-admins only ever see published.',
  })
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return false;
  })
  @IsBoolean()
  includeDrafts?: boolean;

  @ApiPropertyOptional({
    description:
      'Parent only — restrict to events where the parent or their linked children have a GOING / TENTATIVE RSVP.',
  })
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return false;
  })
  @IsBoolean()
  myKidsOnly?: boolean;
}

export class SetCalendarEventRsvpDto {
  @ApiProperty({ enum: ['GOING', 'TENTATIVE', 'NOT_GOING'] })
  @IsIn(['GOING', 'TENTATIVE', 'NOT_GOING'])
  response!: 'GOING' | 'TENTATIVE' | 'NOT_GOING';
}

export class CalendarEventRsvpResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() calendarEventId!: string;
  @ApiProperty() personId!: string;
  @ApiPropertyOptional({ nullable: true }) personName!: string | null;
  @ApiProperty({ enum: ['GOING', 'TENTATIVE', 'NOT_GOING'] })
  response!: 'GOING' | 'TENTATIVE' | 'NOT_GOING';
  @ApiProperty() respondedAt!: string;
}

export class CalendarEventRsvpSummaryResponseDto {
  @ApiProperty() going!: number;
  @ApiProperty() tentative!: number;
  @ApiProperty() notGoing!: number;
  @ApiPropertyOptional({ nullable: true, enum: ['GOING', 'TENTATIVE', 'NOT_GOING'] })
  myResponse!: 'GOING' | 'TENTATIVE' | 'NOT_GOING' | null;
}

export class DayOverrideResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() overrideDate!: string;
  @ApiPropertyOptional({ nullable: true }) bellScheduleId!: string | null;
  @ApiPropertyOptional({ nullable: true }) bellScheduleName!: string | null;
  @ApiProperty() isSchoolDay!: boolean;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateDayOverrideDto {
  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  overrideDate!: string;

  @ApiPropertyOptional({ description: 'Override bell schedule for this date.' })
  @IsOptional()
  @IsUUID()
  bellScheduleId?: string;

  @ApiPropertyOptional({ default: true, description: 'false = closure (snow day, emergency).' })
  @IsOptional()
  @IsBoolean()
  isSchoolDay?: boolean;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ListDayOverridesQueryDto {
  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  toDate?: string;
}

export class CalendarDayResolutionDto {
  @ApiProperty({ description: 'YYYY-MM-DD' }) date!: string;
  @ApiProperty({
    description: 'Where the resolved bellSchedule came from: OVERRIDE / EVENT / DEFAULT / NONE',
    enum: ['OVERRIDE', 'EVENT', 'DEFAULT', 'NONE'],
  })
  resolvedFrom!: 'OVERRIDE' | 'EVENT' | 'DEFAULT' | 'NONE';
  @ApiProperty() isSchoolDay!: boolean;
  @ApiPropertyOptional({ nullable: true }) bellScheduleId!: string | null;
  @ApiPropertyOptional({ nullable: true }) bellScheduleName!: string | null;
  @ApiPropertyOptional({ nullable: true }) overrideId!: string | null;
  @ApiPropertyOptional({ nullable: true }) overrideReason!: string | null;
  @ApiPropertyOptional({
    type: [String],
    description: 'IDs of calendar events that overlap this date.',
  })
  eventIds!: string[];
}
