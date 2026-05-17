import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export const LUNCH_TX_TYPES = ['MEAL_CHARGE', 'DEPOSIT', 'REFUND', 'ADJUSTMENT'] as const;
export type LunchTransactionType = (typeof LUNCH_TX_TYPES)[number];

export const LUNCH_TRANSFER_TYPES = [
  'SIBLING_TRANSFER',
  'NEXT_YEAR_ROLLOVER',
  'REFUND_TO_FAMILY',
] as const;
export type LunchTransferType = (typeof LUNCH_TRANSFER_TYPES)[number];

export class LunchAccountResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiProperty() balance!: number;
  @ApiProperty() lowBalanceThreshold!: number;
  @ApiProperty() autoReplenishEnabled!: boolean;
  @ApiPropertyOptional({ nullable: true }) autoReplenishAmount!: number | null;
  @ApiPropertyOptional({ nullable: true }) lastLowBalanceAlertAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class LunchTransactionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() lunchAccountId!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: LUNCH_TX_TYPES }) transactionType!: LunchTransactionType;
  @ApiPropertyOptional({ nullable: true }) mealDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) posDeviceId!: string | null;
  @ApiPropertyOptional({ nullable: true }) sourceEventId!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LunchTransferResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() fromAccountId!: string;
  @ApiPropertyOptional({ nullable: true }) toAccountId!: string | null;
  @ApiProperty({ enum: LUNCH_TRANSFER_TYPES }) transferType!: LunchTransferType;
  @ApiProperty() amount!: number;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({ nullable: true }) refundId!: string | null;
  @ApiProperty() processedBy!: string;
  @ApiProperty() processedAt!: string;
}

export class DepositLunchAccountDto {
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class TransferLunchBalanceDto {
  @ApiProperty() @IsUUID() fromAccountId!: string;
  @ApiPropertyOptional({
    description:
      'Target sibling account. Required for SIBLING_TRANSFER and NEXT_YEAR_ROLLOVER. NULL for REFUND_TO_FAMILY.',
  })
  @IsOptional()
  @IsUUID()
  toAccountId?: string;
  @ApiProperty({ enum: LUNCH_TRANSFER_TYPES })
  @IsIn(LUNCH_TRANSFER_TYPES as unknown as string[])
  transferType!: LunchTransferType;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @ApiProperty() @IsString() @MaxLength(1000) reason!: string;
  @ApiPropertyOptional({
    description:
      'For REFUND_TO_FAMILY only — the pay_refunds.id that returned the balance to the family.',
  })
  @IsOptional()
  @IsUUID()
  refundId?: string;
}

export class UpdateLunchAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  lowBalanceThreshold?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoReplenishEnabled?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  autoReplenishAmount?: number;
}

export class LunchAccountWithTransactionsDto {
  @ApiProperty() account!: LunchAccountResponseDto;
  @ApiProperty({ type: [LunchTransactionResponseDto] })
  transactions!: LunchTransactionResponseDto[];
  @ApiProperty() lowBalance!: boolean;
}
