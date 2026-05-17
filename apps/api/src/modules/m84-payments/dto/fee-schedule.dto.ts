import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export var RECURRENCE_VALUES = ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'SEMESTER', 'ANNUAL'] as const;
export type Recurrence = (typeof RECURRENCE_VALUES)[number];

export class FeeCategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class FeeScheduleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() academicYearId!: string;
  @ApiProperty() academicYearName!: string;
  @ApiProperty() feeCategoryId!: string;
  @ApiProperty() feeCategoryName!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) gradeLevel!: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() isRecurring!: boolean;
  @ApiProperty({ enum: RECURRENCE_VALUES }) recurrence!: Recurrence;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateFeeCategoryDto {
  @ApiProperty({ maxLength: 80 }) @IsString() @MaxLength(80) name!: string;
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateFeeScheduleDto {
  @ApiProperty() @IsUUID() academicYearId!: string;
  @ApiProperty() @IsUUID() feeCategoryId!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @MaxLength(100) name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  @Matches(/^[A-Za-z0-9-]+$/)
  gradeLevel?: string | null;

  @ApiProperty({ description: 'NUMERIC(10,2). >= 0.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isRecurring?: boolean;

  @ApiPropertyOptional({ enum: RECURRENCE_VALUES, default: 'ANNUAL' })
  @IsOptional()
  @IsIn(RECURRENCE_VALUES as unknown as string[])
  recurrence?: Recurrence;
}

export class UpdateFeeScheduleDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  gradeLevel?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isRecurring?: boolean;

  @ApiPropertyOptional({ enum: RECURRENCE_VALUES })
  @IsOptional()
  @IsIn(RECURRENCE_VALUES as unknown as string[])
  recurrence?: Recurrence;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
