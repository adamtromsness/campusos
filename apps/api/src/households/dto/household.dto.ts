import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const HOUSEHOLD_ROLES = [
  'HEAD_OF_HOUSEHOLD',
  'SPOUSE',
  'CHILD',
  'GRANDPARENT',
  'OTHER_GUARDIAN',
  'SIBLING',
  'OTHER',
] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

export class HouseholdMemberDto {
  @ApiProperty() id!: string;
  @ApiProperty() personId!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() preferredName?: string | null;
  @ApiProperty() role!: HouseholdRole;
  @ApiProperty() isPrimaryContact!: boolean;
  @ApiProperty() joinedAt!: string;
}

export class HouseholdDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiPropertyOptional() addressLine1?: string | null;
  @ApiPropertyOptional() addressLine2?: string | null;
  @ApiPropertyOptional() city?: string | null;
  @ApiPropertyOptional() state?: string | null;
  @ApiPropertyOptional() postalCode?: string | null;
  @ApiPropertyOptional() country?: string | null;
  @ApiPropertyOptional() homePhone?: string | null;
  @ApiProperty() homeLanguage!: string;
  @ApiProperty() mailingAddressSame!: boolean;
  @ApiPropertyOptional() mailingLine1?: string | null;
  @ApiPropertyOptional() mailingLine2?: string | null;
  @ApiPropertyOptional() mailingCity?: string | null;
  @ApiPropertyOptional() mailingState?: string | null;
  @ApiPropertyOptional() mailingPostalCode?: string | null;
  @ApiPropertyOptional() mailingCountry?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty({ type: [HouseholdMemberDto] }) members!: HouseholdMemberDto[];
  @ApiProperty() canEdit!: boolean;
}

export class UpdateHouseholdDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) state?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) postalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) country?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) homePhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) homeLanguage?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mailingAddressSame?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mailingLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mailingLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) mailingCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) mailingState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) mailingPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) mailingCountry?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

export class AddHouseholdMemberDto {
  @ApiProperty() @IsUUID() personId!: string;
  @ApiProperty() @IsIn(HOUSEHOLD_ROLES) role!: HouseholdRole;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimaryContact?: boolean;
}

export class UpdateHouseholdMemberDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(HOUSEHOLD_ROLES) role?: HouseholdRole;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimaryContact?: boolean;
}
