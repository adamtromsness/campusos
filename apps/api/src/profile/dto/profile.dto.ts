import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const PHONE_TYPES = ['MOBILE', 'HOME', 'WORK'] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

export class StudentDemographicsDto {
  @ApiPropertyOptional() gender?: string | null;
  @ApiPropertyOptional() ethnicity?: string | null;
  @ApiPropertyOptional() primaryLanguage?: string | null;
  @ApiPropertyOptional() birthCountry?: string | null;
  @ApiPropertyOptional() citizenship?: string | null;
  @ApiPropertyOptional() medicalAlertNotes?: string | null;
}

export class GuardianEmploymentDto {
  @ApiPropertyOptional() employer?: string | null;
  @ApiPropertyOptional() employerPhone?: string | null;
  @ApiPropertyOptional() occupation?: string | null;
  @ApiPropertyOptional() workAddress?: string | null;
}

export class EmergencyContactDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() relationship?: string | null;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() email?: string | null;
  @ApiProperty() source!: 'STUDENT' | 'EMPLOYEE';
}

export class HouseholdMemberSummaryDto {
  @ApiProperty() personId!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() role!: string;
  @ApiProperty() isPrimaryContact!: boolean;
}

export class HouseholdSummaryDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiProperty() role!: string;
  @ApiProperty() isPrimaryContact!: boolean;
}

export class ProfileResponseDto {
  @ApiProperty() personId!: string;
  @ApiProperty() accountId!: string | null;
  @ApiProperty() personType!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() middleName?: string | null;
  @ApiPropertyOptional() preferredName?: string | null;
  @ApiPropertyOptional() suffix?: string | null;
  @ApiProperty({ type: [String] }) previousNames!: string[];
  @ApiPropertyOptional() dateOfBirth?: string | null;
  @ApiProperty() loginEmail!: string | null;
  @ApiPropertyOptional() personalEmail?: string | null;
  @ApiPropertyOptional() primaryPhone?: string | null;
  @ApiPropertyOptional() phoneTypePrimary?: PhoneType | null;
  @ApiPropertyOptional() secondaryPhone?: string | null;
  @ApiPropertyOptional() phoneTypeSecondary?: PhoneType | null;
  @ApiPropertyOptional() workPhone?: string | null;
  @ApiProperty() preferredLanguage!: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() profileUpdatedAt?: string | null;
  @ApiPropertyOptional({ type: HouseholdSummaryDto }) household?: HouseholdSummaryDto | null;
  @ApiPropertyOptional({ type: EmergencyContactDto }) emergencyContact?: EmergencyContactDto | null;
  @ApiPropertyOptional({ type: StudentDemographicsDto })
  demographics?: StudentDemographicsDto | null;
  @ApiPropertyOptional({ type: GuardianEmploymentDto })
  employment?: GuardianEmploymentDto | null;
}

export class UpdateEmergencyContactDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) relationship?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}

/**
 * PATCH /profile/me — fields a user is allowed to edit on themself.
 * Identity fields (first_name, last_name, login email, date_of_birth
 * after initial set) are intentionally absent and only editable via
 * the admin path PATCH /profile/:personId gated on iam-001:write.
 */
export class UpdateMyProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) middleName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) preferredName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) suffix?: string | null;

  // REVIEW-CYCLE6.1 MAJOR 4: also enforce min-length 1 per element so
  // previousNames=[''] doesn't persist a junk empty-string row.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  previousNames?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) primaryPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsIn(PHONE_TYPES) phoneTypePrimary?: PhoneType | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) secondaryPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsIn(PHONE_TYPES) phoneTypeSecondary?: PhoneType | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) workPhone?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) personalEmail?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) preferredLanguage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;

  // Persona-extras. The service layer ignores them when the persona
  // doesn't match (a STUDENT cannot send `employer`; a GUARDIAN cannot
  // send `gender`).

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) employer?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) employerPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) occupation?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) workAddress?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) primaryLanguage?: string | null;

  @ApiPropertyOptional({ type: () => UpdateEmergencyContactDto })
  @IsOptional()
  emergencyContact?: UpdateEmergencyContactDto;
}

/**
 * PATCH /profile/:personId — admin path.
 * Adds identity fields (first_name, last_name, date_of_birth) on top
 * of the self-service allow-list. Demographics fields beyond
 * primary_language are also admin-only.
 */
export class UpdateAdminProfileDto extends UpdateMyProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() dateOfBirth?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) ethnicity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) birthCountry?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) citizenship?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) medicalAlertNotes?:
    | string
    | null;
}
