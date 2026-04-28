import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export var ROOM_CHANGE_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'AUTO_APPROVED',
] as const;
export type RoomChangeRequestStatus = (typeof ROOM_CHANGE_REQUEST_STATUSES)[number];

export class RoomChangeRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() timetableSlotId!: string;
  @ApiProperty() classSectionCode!: string;
  @ApiProperty() courseName!: string;
  @ApiProperty() periodName!: string;
  @ApiProperty() requestedById!: string;
  @ApiPropertyOptional({ nullable: true }) requestedByName!: string | null;
  @ApiProperty() currentRoomId!: string;
  @ApiProperty() currentRoomName!: string;
  @ApiPropertyOptional({ nullable: true }) requestedRoomId!: string | null;
  @ApiPropertyOptional({ nullable: true }) requestedRoomName!: string | null;
  @ApiProperty() requestDate!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ROOM_CHANGE_REQUEST_STATUSES }) status!: RoomChangeRequestStatus;
  @ApiPropertyOptional({ nullable: true }) reviewedById!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewNotes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateRoomChangeRequestDto {
  @ApiProperty()
  @IsUUID()
  timetableSlotId!: string;

  @ApiPropertyOptional({
    description: 'Null = "any available room"; admin reviewer picks at approval time.',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  requestedRoomId?: string | null;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  requestDate!: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ReviewRoomChangeRequestDto {
  @ApiPropertyOptional({
    description:
      'Final room id when approving. Required when the request was submitted with requestedRoomId=null.',
  })
  @IsOptional()
  @IsUUID()
  approvedRoomId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNotes?: string;
}

export class ListRoomChangeRequestsQueryDto {
  @ApiPropertyOptional({ enum: ROOM_CHANGE_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(ROOM_CHANGE_REQUEST_STATUSES as unknown as string[])
  status?: RoomChangeRequestStatus;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  toDate?: string;
}
