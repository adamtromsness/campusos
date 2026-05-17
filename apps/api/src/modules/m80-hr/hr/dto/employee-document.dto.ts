import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class EmployeeDocumentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty() documentTypeId!: string;
  @ApiProperty() documentTypeName!: string;
  @ApiProperty() fileName!: string;
  @ApiProperty() s3Key!: string;
  @ApiPropertyOptional({ nullable: true }) contentType!: string | null;
  @ApiPropertyOptional({ nullable: true }) fileSizeBytes!: number | null;
  @ApiProperty() uploadedBy!: string;
  @ApiProperty() uploadedAt!: string;
  @ApiPropertyOptional({ nullable: true }) expiryDate!: string | null;
  @ApiProperty() isArchived!: boolean;
}

export class CreateEmployeeDocumentDto {
  @ApiProperty()
  @IsUUID()
  documentTypeId!: string;

  @ApiProperty({ minLength: 1, maxLength: 240 })
  @IsString()
  @MaxLength(240)
  fileName!: string;

  @ApiProperty({ description: 'Object storage key returned from the signed-URL upload step.' })
  @IsString()
  @MaxLength(512)
  s3Key!: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentType?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}
