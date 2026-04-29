import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export var OFFER_TYPES = ['UNCONDITIONAL', 'CONDITIONAL'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export var OFFER_STATUSES = [
  'ISSUED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'WITHDRAWN',
  'CONDITIONS_NOT_MET',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export var FAMILY_RESPONSES = ['ACCEPTED', 'DECLINED', 'DEFERRED'] as const;
export type FamilyResponse = (typeof FAMILY_RESPONSES)[number];

export class OfferResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() studentFirstName!: string;
  @ApiProperty() studentLastName!: string;
  @ApiProperty() applyingForGrade!: string;
  @ApiProperty({ enum: OFFER_TYPES }) offerType!: OfferType;
  @ApiPropertyOptional({ type: [String], nullable: true }) offerConditions!: string[] | null;
  @ApiPropertyOptional({ nullable: true }) conditionsMet!: boolean | null;
  @ApiPropertyOptional({ nullable: true }) offerLetterS3Key!: string | null;
  @ApiProperty() issuedAt!: string;
  @ApiProperty() responseDeadline!: string;
  @ApiPropertyOptional({ enum: FAMILY_RESPONSES, nullable: true })
  familyResponse!: FamilyResponse | null;
  @ApiPropertyOptional({ nullable: true }) familyRespondedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) deferralTargetYearId!: string | null;
  @ApiProperty({ enum: OFFER_STATUSES }) status!: OfferStatus;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateOfferDto {
  @ApiPropertyOptional({ enum: OFFER_TYPES, default: 'UNCONDITIONAL' })
  @IsOptional()
  @IsIn(OFFER_TYPES as unknown as string[])
  offerType?: OfferType;

  @ApiPropertyOptional({ type: [String], description: 'Required when offerType=CONDITIONAL.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  offerConditions?: string[];

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  offerLetterS3Key?: string;

  @ApiProperty({ description: 'Response deadline (ISO timestamp). Must be after issuedAt.' })
  @IsISO8601()
  responseDeadline!: string;
}

export class UpdateOfferConditionsMetDto {
  @ApiProperty({ description: 'Verify (true) or fail (false) the offer conditions.' })
  conditionsMet!: boolean;
}

export class RespondToOfferDto {
  @ApiProperty({ enum: FAMILY_RESPONSES })
  @IsIn(FAMILY_RESPONSES as unknown as string[])
  familyResponse!: FamilyResponse;

  @ApiPropertyOptional({ description: 'Required when familyResponse=DEFERRED.' })
  @IsOptional()
  @IsUUID()
  deferralTargetYearId?: string;
}
