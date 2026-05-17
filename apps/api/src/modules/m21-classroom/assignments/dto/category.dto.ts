import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AssignmentCategoryDto {
  @ApiProperty() id!: string;
  @ApiProperty() classId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() weight!: number;
  @ApiProperty() sortOrder!: number;
}

export class UpsertCategoryEntryDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 60,
    description: 'Category name; unique per class. Re-using an existing name updates that row.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({ minimum: 0, maximum: 100, description: 'Weight in percent (0-100)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  weight!: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpsertCategoriesDto {
  @ApiProperty({
    type: [UpsertCategoryEntryDto],
    description:
      'Full list of categories for the class — replaces existing rows by name. Weights MUST ' +
      'sum to 100. Names in the body that do not exist are inserted; existing rows are ' +
      'updated; rows not in the body are deleted (returns 409 if any deleted category is ' +
      'still referenced by an assignment).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpsertCategoryEntryDto)
  categories!: UpsertCategoryEntryDto[];
}
