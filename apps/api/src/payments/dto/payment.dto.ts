import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export var PAYMENT_METHODS = ['CARD', 'BANK_TRANSFER', 'CASH', 'CHEQUE', 'WAIVER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export var PAYMENT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export class PaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiProperty() invoiceTitle!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() familyAccountNumber!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: PAYMENT_METHODS }) paymentMethod!: PaymentMethod;
  @ApiPropertyOptional({ nullable: true }) stripePaymentIntentId!: string | null;
  @ApiProperty({ enum: PAYMENT_STATUSES }) status!: PaymentStatus;
  @ApiPropertyOptional({ nullable: true }) paidAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) receiptS3Key!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdBy!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PayInvoiceDto {
  @ApiProperty({ description: 'NUMERIC(10,2). > 0.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ enum: PAYMENT_METHODS, default: 'CARD' })
  @IsOptional()
  @IsIn(PAYMENT_METHODS as unknown as string[])
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ description: 'For admin-recorded offline payments.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListPaymentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() familyAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() invoiceId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES as unknown as string[])
  status?: PaymentStatus;
}
