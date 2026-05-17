import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export var REFUND_CATEGORIES = [
  'OVERPAYMENT',
  'WITHDRAWAL',
  'PROGRAMME_CANCELLED',
  'ERROR_CORRECTION',
  'GOODWILL',
  'OTHER',
] as const;
export type RefundCategory = (typeof REFUND_CATEGORIES)[number];

export var REFUND_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export class RefundResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: REFUND_CATEGORIES }) refundCategory!: RefundCategory;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({ nullable: true }) stripeRefundId!: string | null;
  @ApiProperty({ enum: REFUND_STATUSES }) status!: RefundStatus;
  @ApiProperty() authorisedBy!: string;
  @ApiProperty() authorisedAt!: string;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class IssueRefundDto {
  @ApiProperty({ description: 'NUMERIC(10,2). > 0. Cannot exceed payment amount.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiProperty({ enum: REFUND_CATEGORIES })
  @IsIn(REFUND_CATEGORIES as unknown as string[])
  refundCategory!: RefundCategory;

  @ApiProperty({ maxLength: 1000, description: 'Required justification.' })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class ListRefundsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() familyAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() paymentId?: string;

  @ApiPropertyOptional({ enum: REFUND_STATUSES })
  @IsOptional()
  @IsIn(REFUND_STATUSES as unknown as string[])
  status?: RefundStatus;
}
