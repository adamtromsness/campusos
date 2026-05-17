import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export var ROOM_TYPES = [
  'CLASSROOM',
  'LAB',
  'GYM',
  'HALL',
  'LIBRARY',
  'OFFICE',
  'OUTDOOR',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

var DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class RoomResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) capacity!: number | null;
  @ApiProperty({ enum: ROOM_TYPES }) roomType!: RoomType;
  @ApiProperty() hasProjector!: boolean;
  @ApiProperty() hasAv!: boolean;
  @ApiPropertyOptional({ nullable: true }) floor!: string | null;
  @ApiPropertyOptional({ nullable: true }) building!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateRoomDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacity?: number;

  @ApiProperty({ enum: ROOM_TYPES })
  @IsIn(ROOM_TYPES as unknown as string[])
  roomType!: RoomType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hasProjector?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  hasAv?: boolean;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  floor?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  building?: string;
}

export class UpdateRoomDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacity?: number;

  @ApiPropertyOptional({ enum: ROOM_TYPES })
  @IsOptional()
  @IsIn(ROOM_TYPES as unknown as string[])
  roomType?: RoomType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasProjector?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasAv?: boolean;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  floor?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  building?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListRoomsQueryDto {
  @ApiPropertyOptional({ description: 'Include inactive rooms.' })
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return false;
  })
  @IsBoolean()
  includeInactive?: boolean;

  @ApiPropertyOptional({ enum: ROOM_TYPES })
  @IsOptional()
  @IsIn(ROOM_TYPES as unknown as string[])
  roomType?: RoomType;

  @ApiPropertyOptional({
    description: 'When set with availabilityPeriodId, annotates each room with availability.',
  })
  @IsOptional()
  @Matches(DATE_REGEX)
  availabilityDate?: string;

  @ApiPropertyOptional({ description: 'Period id to check availability against.' })
  @IsOptional()
  @IsString()
  availabilityPeriodId?: string;
}

export class RoomAvailabilityDto extends RoomResponseDto {
  @ApiPropertyOptional({
    description:
      'When the request supplied availabilityDate + availabilityPeriodId, true if the room is free. Null when not requested.',
    nullable: true,
  })
  available!: boolean | null;
}
