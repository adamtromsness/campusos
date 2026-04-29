import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export var FAMILY_ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type FamilyAccountStatus = (typeof FAMILY_ACCOUNT_STATUSES)[number];

export var PAYMENT_AUTH_POLICIES = ['ACCOUNT_HOLDER_ONLY', 'ANY_AUTHORISED'] as const;
export type PaymentAuthPolicy = (typeof PAYMENT_AUTH_POLICIES)[number];

export class FamilyAccountStudentDto {
  @ApiProperty() studentId!: string;
  @ApiProperty() studentNumber!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() gradeLevel!: string;
  @ApiProperty() addedAt!: string;
}

export class FamilyAccountResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() accountHolderId!: string;
  @ApiProperty() accountHolderName!: string;
  @ApiPropertyOptional({ nullable: true }) accountHolderEmail!: string | null;
  @ApiProperty() accountNumber!: string;
  @ApiProperty({ enum: FAMILY_ACCOUNT_STATUSES }) status!: FamilyAccountStatus;
  @ApiProperty({ enum: PAYMENT_AUTH_POLICIES })
  paymentAuthorisationPolicy!: PaymentAuthPolicy;
  @ApiProperty() balance!: number;
  @ApiProperty({ type: [FamilyAccountStudentDto] }) students!: FamilyAccountStudentDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
