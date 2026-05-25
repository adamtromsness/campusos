import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
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
  // Top-level self-editable gender — distinct from demographics.gender
  // (admin-managed per-tenant). Wire shape uses '' / 'F' / 'M' to
  // match the family-child picker; legacy values stay rendered as-is.
  @ApiPropertyOptional() gender?: string | null;
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
  // iam_person.created_at — used by /profile's "Account created" line.
  @ApiPropertyOptional() createdAt?: string | null;
  // Contact-tab fields. addressSource 'FAMILY' (default) means
  // inherit the household address from /family/settings; 'CUSTOM'
  // means use the customAddress* columns surfaced here.
  @ApiProperty({ enum: ['FAMILY', 'CUSTOM'] }) addressSource!: 'FAMILY' | 'CUSTOM';
  @ApiPropertyOptional() customAddressLine1?: string | null;
  @ApiPropertyOptional() customAddressLine2?: string | null;
  @ApiPropertyOptional() customCity?: string | null;
  @ApiPropertyOptional() customState?: string | null;
  @ApiPropertyOptional() customPostalCode?: string | null;
  @ApiPropertyOptional() customCountry?: string | null;
  // Mailing address (per-person). mailingAddressDifferent === true
  // means the customMailing* columns are authoritative; false means
  // the mailing address is the same as the home address.
  @ApiProperty() mailingAddressDifferent!: boolean;
  @ApiPropertyOptional() customMailingLine1?: string | null;
  @ApiPropertyOptional() customMailingLine2?: string | null;
  @ApiPropertyOptional() customMailingCity?: string | null;
  @ApiPropertyOptional() customMailingState?: string | null;
  @ApiPropertyOptional() customMailingPostalCode?: string | null;
  @ApiPropertyOptional() customMailingCountry?: string | null;
  // Work contact (platform-wide; distinct from the per-tenant
  // sis_guardian_employment that the admin profile path uses).
  @ApiPropertyOptional() workEmail?: string | null;
  @ApiPropertyOptional() employer?: string | null;
  @ApiPropertyOptional() jobTitle?: string | null;
  // Occupation-tab fields. employmentStatus is enum-shaped (validated
  // by the CHECK constraint on the column); industry is open text.
  @ApiPropertyOptional() employmentStatus?: string | null;
  @ApiPropertyOptional() industry?: string | null;
  @ApiPropertyOptional() workAddressLine1?: string | null;
  @ApiPropertyOptional() workAddressLine2?: string | null;
  @ApiPropertyOptional() workCity?: string | null;
  @ApiPropertyOptional() workState?: string | null;
  @ApiPropertyOptional() workPostalCode?: string | null;
  @ApiPropertyOptional() workCountry?: string | null;
  // About-tab fields. interests + languages are arrays of strings.
  @ApiPropertyOptional() bio?: string | null;
  @ApiProperty({ type: [String] }) interests!: string[];
  @ApiProperty({ type: [String] }) languages!: string[];
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
 *
 * Identity fields (first_name, last_name, date_of_birth) are now
 * self-editable. The 0-persona registration flow (`/auth/register`)
 * lets users type their own names, so locking edits to an admin path
 * before any school relationship exists would mean a typo at signup
 * is unfixable until the user enrols somewhere. Once the user is a
 * STAFF / STUDENT in a tenant the school can override via the admin
 * PATCH /profile/:personId path (unchanged), and operational policy
 * — not API surface — decides who is allowed to change their own
 * name post-enrolment.
 *
 * Login email is still NOT editable here — changing it requires an
 * email-verification flow that isn't built yet, and the admin path
 * doesn't surface it either (managed via the IdP).
 */
export class UpdateMyProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() dateOfBirth?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) middleName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) preferredName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) suffix?: string | null;

  // REVIEW-CYCLE6.1 MAJOR 4: enforce min-length 1 per element so
  // previousNames=[''] doesn't persist a junk empty-string row.
  // REVIEW-CYCLE6.1 Round 2 minor follow-up: also reject
  // whitespace-only entries via @Matches(/\S/) so previousNames=['   ']
  // is rejected too. The validator does not auto-trim — clients still
  // need to send trimmed values; this just blocks pure-whitespace.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  @Matches(/\S/, { each: true, message: 'each previousNames entry must contain non-whitespace' })
  previousNames?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) primaryPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsIn(PHONE_TYPES) phoneTypePrimary?: PhoneType | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) secondaryPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsIn(PHONE_TYPES) phoneTypeSecondary?: PhoneType | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) workPhone?: string | null;

  // Self-editable on /profile/me. The admin path (UpdateAdminProfileDto)
  // already exposes gender — this carve-out duplicates it onto the
  // self-service surface for the /profile Account tab.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string | null;

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
  // Adult Contact-tab additions. employer above writes to BOTH
  // iam_person.employer (the new platform-wide canonical) AND
  // sis_guardian_employment.employer (per-tenant legacy) for
  // continuity; jobTitle + workEmail are platform-only.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) jobTitle?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) workEmail?: string | null;
  // Occupation-tab additions.
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn([
    'EMPLOYED_FULL_TIME',
    'EMPLOYED_PART_TIME',
    'SELF_EMPLOYED',
    'UNEMPLOYED',
    'RETIRED',
    'STUDENT',
    'HOMEMAKER',
    'NOT_SPECIFIED',
  ])
  employmentStatus?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) industry?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) workAddressLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) workAddressLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) workCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) workState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) workPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) workCountry?: string | null;
  // About-tab. bio capped at 500 chars per spec; interests +
  // languages whole-list replace, capped at 30 entries each.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) bio?: string | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  interests?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  languages?: string[];
  // Address inheritance toggle + per-person custom address.
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['FAMILY', 'CUSTOM'])
  addressSource?: 'FAMILY' | 'CUSTOM';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customAddressLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customAddressLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) customPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customCountry?: string | null;
  // Mailing address — wire-positive sense.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mailingAddressDifferent?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customMailingLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customMailingLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customMailingCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customMailingState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) customMailingPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customMailingCountry?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) primaryLanguage?: string | null;

  @ApiPropertyOptional({ type: () => UpdateEmergencyContactDto })
  @IsOptional()
  emergencyContact?: UpdateEmergencyContactDto;
}

/**
 * PATCH /profile/:personId — admin path.
 * Adds demographics fields (gender, ethnicity, etc.) that remain
 * admin-only on top of the self-service allow-list (which already
 * includes first_name, last_name, date_of_birth as of 2026-05-24).
 */
// ─── /profile/me/phones — multi-phone list ─────────────────

export const PERSON_PHONE_TYPES = ['CELL', 'HOME', 'WORK', 'OTHER'] as const;
export type PersonPhoneType = (typeof PERSON_PHONE_TYPES)[number];

export class PersonPhoneDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: PERSON_PHONE_TYPES }) type!: PersonPhoneType;
  @ApiProperty() textsAllowed!: boolean;
  @ApiProperty() isPrimary!: boolean;
}

export class AddPersonPhoneDto {
  @ApiProperty() @IsString() @MaxLength(40) number!: string;
  @ApiPropertyOptional({ enum: PERSON_PHONE_TYPES })
  @IsOptional()
  @IsIn(PERSON_PHONE_TYPES)
  type?: PersonPhoneType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() textsAllowed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class UpdatePersonPhoneDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) number?: string;
  @ApiPropertyOptional({ enum: PERSON_PHONE_TYPES })
  @IsOptional()
  @IsIn(PERSON_PHONE_TYPES)
  type?: PersonPhoneType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() textsAllowed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}

// ─── /profile/me/medical — adult medical info ──────────────

export const ADULT_MEDICAL_SOURCES = ['FAMILY', 'CUSTOM'] as const;
export type AdultMedicalSource = (typeof ADULT_MEDICAL_SOURCES)[number];

export class AdultAllergyEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() severity?: 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';
  @ApiPropertyOptional() type?: 'FOOD' | 'ENVIRONMENTAL' | 'MEDICATION' | 'OTHER';
  @ApiPropertyOptional() notes?: string;
}

export class AdultMedicationEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() dosage?: string;
  @ApiPropertyOptional() frequency?: string;
  @ApiPropertyOptional() prescriber?: string;
  @ApiPropertyOptional() notes?: string;
}

export class AdultConditionEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() diagnosedDate?: string;
  @ApiPropertyOptional() notes?: string;
}

export class AdultMedicalInfoDto {
  @ApiProperty() personId!: string;
  @ApiProperty({ type: [AdultAllergyEntry] }) allergies!: AdultAllergyEntry[];
  @ApiProperty({ type: [AdultMedicationEntry] }) medications!: AdultMedicationEntry[];
  @ApiProperty({ type: [AdultConditionEntry] }) conditions!: AdultConditionEntry[];
  // Mirrors ChildMedicalInfoDto: FAMILY surfaces the family-level
  // doctor + insurance from platform_families; CUSTOM uses the
  // per-person columns.
  @ApiProperty({ enum: ADULT_MEDICAL_SOURCES }) medicalSource!: AdultMedicalSource;
  @ApiPropertyOptional() doctorName?: string | null;
  @ApiPropertyOptional() doctorPhone?: string | null;
  @ApiPropertyOptional() doctorClinic?: string | null;
  @ApiPropertyOptional() insuranceProvider?: string | null;
  @ApiPropertyOptional() insurancePolicy?: string | null;
  @ApiPropertyOptional() insuranceGroup?: string | null;
  @ApiPropertyOptional() bloodType?: string | null;
  @ApiPropertyOptional() medicalNotes?: string | null;
}

export class UpdateAdultMedicalInfoDto {
  // Whole-list replace semantics on the array columns — same as the
  // child medical surface.
  @ApiPropertyOptional({ type: [AdultAllergyEntry] }) @IsOptional() allergies?: AdultAllergyEntry[];
  @ApiPropertyOptional({ type: [AdultMedicationEntry] })
  @IsOptional()
  medications?: AdultMedicationEntry[];
  @ApiPropertyOptional({ type: [AdultConditionEntry] })
  @IsOptional()
  conditions?: AdultConditionEntry[];
  @ApiPropertyOptional({ enum: ADULT_MEDICAL_SOURCES })
  @IsOptional()
  @IsIn(ADULT_MEDICAL_SOURCES)
  medicalSource?: AdultMedicalSource;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) doctorName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) doctorPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) doctorClinic?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) insuranceProvider?:
    | string
    | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) insurancePolicy?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) insuranceGroup?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) bloodType?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) medicalNotes?: string | null;
}

export class UpdateAdminProfileDto extends UpdateMyProfileDto {
  // gender is now inherited from UpdateMyProfileDto (self-editable on
  // both surfaces). The other demographics fields stay admin-only;
  // they write to sis_student_demographics rather than iam_person.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) ethnicity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) birthCountry?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) citizenship?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) medicalAlertNotes?:
    | string
    | null;
}
