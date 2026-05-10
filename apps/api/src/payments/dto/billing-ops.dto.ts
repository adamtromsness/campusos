import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const CREDIT_CATEGORIES = [
  'GOODWILL',
  'BILLING_ERROR',
  'PROGRAMME_CANCELLED',
  'OVERPAYMENT',
  'OTHER',
] as const;
export type CreditCategory = (typeof CREDIT_CATEGORIES)[number];

export const REVERSAL_TYPES = [
  'BOUNCED_CHEQUE',
  'RECALLED_TRANSFER',
  'CHARGEBACK',
  'DUPLICATE_PAYMENT',
  'OTHER',
] as const;
export type ReversalType = (typeof REVERSAL_TYPES)[number];

export const LATE_FEE_TYPES = ['FIXED', 'PERCENTAGE_MONTHLY'] as const;
export type LateFeeType = (typeof LATE_FEE_TYPES)[number];

export const SAVED_PM_TYPES = ['CARD', 'BANK_ACCOUNT'] as const;
export type SavedPaymentMethodType = (typeof SAVED_PM_TYPES)[number];

export class CreditNoteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiPropertyOptional({ nullable: true }) lineItemId!: string | null;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() creditAmount!: number;
  @ApiProperty({ enum: CREDIT_CATEGORIES }) creditCategory!: CreditCategory;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({ nullable: true }) ledgerEntryId!: string | null;
  @ApiProperty() issuedBy!: string;
  @ApiProperty() issuedAt!: string;
}

export class IssueCreditNoteDto {
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) creditAmount!: number;
  @ApiPropertyOptional({ enum: CREDIT_CATEGORIES })
  @IsOptional()
  @IsIn(CREDIT_CATEGORIES as unknown as string[])
  creditCategory?: CreditCategory;
  @ApiProperty() @IsString() @MaxLength(2000) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() lineItemId?: string;
}

export class ListCreditNotesQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() invoiceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() familyAccountId?: string;
}

export class PaymentReversalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiProperty({ enum: REVERSAL_TYPES }) reversalType!: ReversalType;
  @ApiProperty() reversalReason!: string;
  @ApiPropertyOptional({ nullable: true }) bankReference!: string | null;
  @ApiProperty() reversedAmount!: number;
  @ApiPropertyOptional({ nullable: true }) ledgerEntryId!: string | null;
  @ApiProperty() reversedBy!: string;
  @ApiProperty() reversedAt!: string;
}

export class ReversePaymentDto {
  @ApiProperty({ enum: REVERSAL_TYPES })
  @IsIn(REVERSAL_TYPES as unknown as string[])
  reversalType!: ReversalType;
  @ApiProperty() @IsString() @MaxLength(2000) reversalReason!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) bankReference?: string;
}

export class ListReversalsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() familyAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() invoiceId?: string;
}

export class PaymentAllocationItemDto {
  @ApiProperty() @IsUUID() invoiceId!: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) allocatedAmount!: number;
}

export class AllocatePaymentDto {
  @ApiProperty({ type: [PaymentAllocationItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationItemDto)
  allocations!: PaymentAllocationItemDto[];
}

export class PaymentAllocationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiPropertyOptional({ nullable: true }) invoiceTitle!: string | null;
  @ApiProperty() allocatedAmount!: number;
  @ApiPropertyOptional({ nullable: true }) allocatedBy!: string | null;
  @ApiProperty() allocatedAt!: string;
}

export class LatePaymentPolicyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() gracePeriodDays!: number;
  @ApiProperty({ enum: LATE_FEE_TYPES }) feeType!: LateFeeType;
  @ApiPropertyOptional({ nullable: true }) feeAmount!: number | null;
  @ApiPropertyOptional({ nullable: true }) feePercentage!: number | null;
  @ApiPropertyOptional({ nullable: true }) maxLateFeeAmount!: number | null;
  @ApiPropertyOptional({ nullable: true }) appliesToFeeCategoryId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class UpsertLatePaymentPolicyDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(90) gracePeriodDays?: number;
  @ApiProperty({ enum: LATE_FEE_TYPES })
  @IsIn(LATE_FEE_TYPES as unknown as string[])
  feeType!: LateFeeType;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  feeAmount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  feePercentage?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxLateFeeAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() appliesToFeeCategoryId?: string;
}

export class LateFeesScanResponseDto {
  @ApiProperty() invoicesEvaluated!: number;
  @ApiProperty() lateFeesApplied!: number;
  @ApiProperty() invoicesSkipped!: number;
  @ApiProperty() totalLateFeeAmount!: number;
}

export class SavedPaymentMethodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() stripePaymentMethodId!: string;
  @ApiProperty({ enum: SAVED_PM_TYPES }) methodType!: SavedPaymentMethodType;
  @ApiPropertyOptional({ nullable: true }) cardLastFour!: string | null;
  @ApiPropertyOptional({ nullable: true }) cardBrand!: string | null;
  @ApiPropertyOptional({ nullable: true }) cardExpMonth!: number | null;
  @ApiPropertyOptional({ nullable: true }) cardExpYear!: number | null;
  @ApiPropertyOptional({ nullable: true }) bankLastFour!: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() addedAt!: string;
}

export class CreateSavedPaymentMethodDto {
  @ApiProperty() @IsUUID() familyAccountId!: string;
  @ApiProperty() @IsString() @MaxLength(200) stripePaymentMethodId!: string;
  @ApiPropertyOptional({ enum: SAVED_PM_TYPES })
  @IsOptional()
  @IsIn(SAVED_PM_TYPES as unknown as string[])
  methodType?: SavedPaymentMethodType;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4) cardLastFour?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) cardBrand?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(12) cardExpMonth?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(2000) cardExpYear?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4) bankLastFour?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}
