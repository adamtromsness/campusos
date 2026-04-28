import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export var BOOKING_STATUSES = ['CONFIRMED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export class RoomBookingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() roomId!: string;
  @ApiProperty() roomName!: string;
  @ApiProperty() bookedById!: string;
  @ApiPropertyOptional({ nullable: true }) bookedByName!: string | null;
  @ApiProperty() bookingPurpose!: string;
  @ApiProperty() startAt!: string;
  @ApiProperty() endAt!: string;
  @ApiProperty({ enum: BOOKING_STATUSES }) status!: BookingStatus;
  @ApiPropertyOptional({ nullable: true }) cancelledAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelledReason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateRoomBookingDto {
  @ApiProperty()
  @IsUUID()
  roomId!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  bookingPurpose!: string;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  @IsISO8601()
  startAt!: string;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  @IsISO8601()
  endAt!: string;
}

export class CancelRoomBookingDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelledReason?: string;
}

export class ListRoomBookingsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({ enum: BOOKING_STATUSES })
  @IsOptional()
  @IsIn(BOOKING_STATUSES as unknown as string[])
  status?: BookingStatus;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD — bookings on or after this date.' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD — bookings on or before this date.' })
  @IsOptional()
  @IsDateString()
  toDate?: string;
}
