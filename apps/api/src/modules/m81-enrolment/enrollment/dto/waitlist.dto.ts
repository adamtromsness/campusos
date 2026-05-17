import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export var WAITLIST_STATUSES = ['ACTIVE', 'OFFERED', 'ENROLLED', 'EXPIRED', 'WITHDRAWN'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export class WaitlistEntryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() enrollmentPeriodId!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() studentFirstName!: string;
  @ApiProperty() studentLastName!: string;
  @ApiProperty() gradeLevel!: string;
  @ApiProperty() priorityScore!: number;
  @ApiProperty() position!: number;
  @ApiProperty({ enum: WAITLIST_STATUSES }) status!: WaitlistStatus;
  @ApiProperty() addedAt!: string;
  @ApiPropertyOptional({ nullable: true }) offeredAt!: string | null;
}

export class ListWaitlistQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() enrollmentPeriodId?: string;

  @ApiPropertyOptional({ maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  gradeLevel?: string;

  @ApiPropertyOptional({ enum: WAITLIST_STATUSES })
  @IsOptional()
  @IsIn(WAITLIST_STATUSES as unknown as string[])
  status?: WaitlistStatus;
}

export class OfferFromWaitlistDto {
  @ApiProperty({ description: 'Response deadline for the issued offer.' })
  @IsISO8601()
  responseDeadline!: string;
}
