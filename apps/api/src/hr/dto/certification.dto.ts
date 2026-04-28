import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export var CERTIFICATION_TYPES = [
  'TEACHING_LICENCE',
  'FIRST_AID',
  'SAFEGUARDING_LEVEL1',
  'SAFEGUARDING_LEVEL2',
  'DBS_BASIC',
  'DBS_ENHANCED',
  'FOOD_HYGIENE',
  'FIRE_SAFETY_WARDEN',
  'SPECIALIST_SUBJECT',
  'CUSTOM',
] as const;
export type CertificationType = (typeof CERTIFICATION_TYPES)[number];

export var VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'EXPIRED', 'REVOKED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export class CertificationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty({ enum: CERTIFICATION_TYPES }) certificationType!: CertificationType;
  @ApiProperty() certificationName!: string;
  @ApiPropertyOptional({ nullable: true }) issuingBody!: string | null;
  @ApiPropertyOptional({ nullable: true }) referenceNumber!: string | null;
  @ApiPropertyOptional({ nullable: true }) issuedDate!: string | null;
  @ApiPropertyOptional({ nullable: true }) expiryDate!: string | null;
  @ApiProperty({ enum: VERIFICATION_STATUSES }) verificationStatus!: VerificationStatus;
  @ApiPropertyOptional({ nullable: true }) verifiedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) verifiedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) documentS3Key!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiPropertyOptional({ nullable: true })
  daysUntilExpiry!: number | null;
}

export class CreateCertificationDto {
  @ApiProperty({ enum: CERTIFICATION_TYPES })
  @IsIn(CERTIFICATION_TYPES as unknown as string[])
  certificationType!: CertificationType;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MaxLength(200)
  certificationName!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingBody?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referenceNumber?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  issuedDate?: string;

  @ApiPropertyOptional({ description: 'ISO date YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional({ description: 'Object key for the scanned cert PDF.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  documentS3Key?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class VerifyCertificationDto {
  @ApiProperty({
    enum: ['VERIFIED', 'REVOKED', 'EXPIRED'],
    description: 'New verification status.',
  })
  @IsIn(['VERIFIED', 'REVOKED', 'EXPIRED'])
  status!: 'VERIFIED' | 'REVOKED' | 'EXPIRED';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
