import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, Max, Min } from 'class-validator';

export var PLAN_FREQUENCIES = ['MONTHLY', 'QUARTERLY'] as const;
export type PlanFrequency = (typeof PLAN_FREQUENCIES)[number];

export var PLAN_STATUSES = ['ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export var INSTALLMENT_STATUSES = ['UPCOMING', 'DUE', 'PAID', 'OVERDUE'] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export class PaymentPlanInstallmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() planId!: string;
  @ApiProperty() installmentNumber!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() dueDate!: string;
  @ApiProperty({ enum: INSTALLMENT_STATUSES }) status!: InstallmentStatus;
  @ApiPropertyOptional({ nullable: true }) paymentId!: string | null;
  @ApiPropertyOptional({ nullable: true }) paidAt!: string | null;
}

export class PaymentPlanResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() installmentCount!: number;
  @ApiProperty({ enum: PLAN_FREQUENCIES }) frequency!: PlanFrequency;
  @ApiProperty() startDate!: string;
  @ApiProperty({ enum: PLAN_STATUSES }) status!: PlanStatus;
  @ApiProperty({ type: [PaymentPlanInstallmentDto] })
  installments!: PaymentPlanInstallmentDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreatePaymentPlanDto {
  @ApiProperty({ description: 'Number of installments (>0). Must divide cleanly into 12 / 4.' })
  @IsInt()
  @Min(2)
  @Max(12)
  installmentCount!: number;

  @ApiProperty({ enum: PLAN_FREQUENCIES })
  @IsIn(PLAN_FREQUENCIES as unknown as string[])
  frequency!: PlanFrequency;

  @ApiProperty({ description: 'YYYY-MM-DD — first installment due date.' })
  @IsDateString()
  startDate!: string;
}
