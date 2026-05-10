import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export const DISCOUNT_TYPES = [
  'SIBLING',
  'EARLY_PAYMENT',
  'LOYALTY',
  'BURSARY',
  'STAFF_CHILD',
  'CUSTOM',
] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const CALCULATION_METHODS = ['PERCENTAGE', 'FIXED_AMOUNT'] as const;
export type CalculationMethod = (typeof CALCULATION_METHODS)[number];

export class DiscountRuleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: DISCOUNT_TYPES }) discountType!: DiscountType;
  @ApiProperty({ enum: CALCULATION_METHODS }) calculationMethod!: CalculationMethod;
  @ApiProperty() value!: number;
  @ApiPropertyOptional({ nullable: true }) appliesToFeeCategoryId!: string | null;
  @ApiPropertyOptional({ nullable: true }) appliesToFeeCategoryName!: string | null;
  @ApiPropertyOptional({ nullable: true }) siblingOrder!: number | null;
  @ApiPropertyOptional({ nullable: true }) minimumInvoiceAmount!: number | null;
  @ApiPropertyOptional({ nullable: true }) academicYearId!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateDiscountRuleDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty({ enum: DISCOUNT_TYPES })
  @IsIn(DISCOUNT_TYPES as unknown as string[])
  discountType!: DiscountType;
  @ApiProperty({ enum: CALCULATION_METHODS })
  @IsIn(CALCULATION_METHODS as unknown as string[])
  calculationMethod!: CalculationMethod;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) value!: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() appliesToFeeCategoryId?: string;
  @ApiPropertyOptional({
    description: 'For SIBLING discount type only. The Nth child gets this rate. >= 2.',
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  siblingOrder?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minimumInvoiceAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDiscountRuleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) value?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minimumInvoiceAmount?: number;
}

export class ListDiscountRulesQueryDto {
  @ApiPropertyOptional({ enum: DISCOUNT_TYPES })
  @IsOptional()
  @IsIn(DISCOUNT_TYPES as unknown as string[])
  discountType?: DiscountType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeInactive?: boolean;
}
