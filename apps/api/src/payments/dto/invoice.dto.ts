import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export var INVOICE_STATUSES = ['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export class InvoiceLineItemInputDto {
  @ApiPropertyOptional({ description: 'Optional fee_schedule_id for historical attribution.' })
  @IsOptional()
  @IsUUID()
  feeScheduleId?: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  description!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  quantity?: number;

  @ApiProperty({ description: 'NUMERIC(10,2) >= 0' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;
}

export class InvoiceLineItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() invoiceId!: string;
  @ApiPropertyOptional({ nullable: true }) feeScheduleId!: string | null;
  @ApiPropertyOptional({ nullable: true }) feeScheduleName!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() total!: number;
  @ApiProperty() sortOrder!: number;
}

export class InvoiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() familyAccountId!: string;
  @ApiProperty() familyAccountNumber!: string;
  @ApiProperty() familyAccountHolderName!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() amountPaid!: number;
  @ApiProperty() balanceDue!: number;
  @ApiPropertyOptional({ nullable: true }) dueDate!: string | null;
  @ApiProperty({ enum: INVOICE_STATUSES }) status!: InvoiceStatus;
  @ApiPropertyOptional({ nullable: true }) sentAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: [InvoiceLineItemResponseDto] }) lineItems!: InvoiceLineItemResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() familyAccountId!: string;

  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(200) title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;

  @ApiProperty({ type: [InvoiceLineItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemInputDto)
  lineItems!: InvoiceLineItemInputDto[];
}

export class GenerateFromScheduleDto {
  @ApiProperty() @IsUUID() feeScheduleId!: string;

  @ApiPropertyOptional({ description: 'Optional title override; defaults to fee schedule name.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
}

export class GenerateFromScheduleResponseDto {
  @ApiProperty() feeScheduleId!: string;
  @ApiProperty() created!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty({ type: [String] }) invoiceIds!: string[];
}

export class ListInvoicesQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() familyAccountId?: string;

  @ApiPropertyOptional({ enum: INVOICE_STATUSES })
  @IsOptional()
  @IsIn(INVOICE_STATUSES as unknown as string[])
  status?: InvoiceStatus;
}
