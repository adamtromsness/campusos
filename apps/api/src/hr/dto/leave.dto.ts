import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export var LEAVE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

export class LeaveTypeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isPaid!: boolean;
  @ApiProperty() accrualRate!: number;
  @ApiPropertyOptional({ nullable: true }) maxBalance!: number | null;
  @ApiProperty() isActive!: boolean;
}

export class LeaveBalanceDto {
  @ApiProperty() leaveTypeId!: string;
  @ApiProperty() leaveTypeName!: string;
  @ApiProperty() isPaid!: boolean;
  @ApiProperty() accrued!: number;
  @ApiProperty() used!: number;
  @ApiProperty() pending!: number;
  @ApiProperty({ description: 'accrued - used - pending' }) available!: number;
  @ApiProperty() academicYearId!: string;
}

export class LeaveRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty() employeeName!: string;
  @ApiProperty() leaveTypeId!: string;
  @ApiProperty() leaveTypeName!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty() daysRequested!: number;
  @ApiProperty({ enum: LEAVE_REQUEST_STATUSES }) status!: LeaveRequestStatus;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() submittedAt!: string;
  @ApiPropertyOptional({ nullable: true }) reviewedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) reviewNotes!: string | null;
  @ApiPropertyOptional({ nullable: true }) cancelledAt!: string | null;
  @ApiProperty() isHrInitiated!: boolean;
}

export class SubmitLeaveRequestDto {
  @ApiProperty()
  @IsUUID()
  leaveTypeId!: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsDateString()
  endDate!: string;

  @ApiProperty({ description: 'Number of leave days; supports halves (0.5).' })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.5)
  daysRequested!: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewLeaveRequestDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNotes?: string;
}

export class ListLeaveRequestsQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by status. Admins use this to drive the approval queue (?status=PENDING).',
  })
  @IsOptional()
  @IsIn(LEAVE_REQUEST_STATUSES as unknown as string[])
  status?: LeaveRequestStatus;

  @ApiPropertyOptional({ description: 'Admin-only — filter to a specific employee.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
