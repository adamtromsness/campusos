import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const FAMILY_CHILD_STATUSES = ['PLACEHOLDER', 'PENDING_LINK', 'LINKED'] as const;
export type FamilyChildStatus = (typeof FAMILY_CHILD_STATUSES)[number];

/**
 * accessLevel is the caller-relative authority on a family row. The
 * server derives it from platform_users.managed_by_person_id and the
 * authenticated caller's iam_person.id:
 *
 *   PLACEHOLDER   — status is PLACEHOLDER / PENDING_LINK / PENDING_INVITE.
 *                   No linked iam_person yet. Edits go to the family
 *                   row directly; access is parent-only.
 *   MANAGED       — the linked iam_person's platform_users row has
 *                   managed_by_person_id = caller. The caller is the
 *                   account custodian and has full edit access.
 *   INDEPENDENT   — the linked iam_person's account is either
 *                   unmanaged (NULL managed_by) or managed by someone
 *                   other than the caller. The caller can read but
 *                   not write to the row's identity fields.
 */
export const FAMILY_ACCESS_LEVELS = ['PLACEHOLDER', 'MANAGED', 'INDEPENDENT'] as const;
export type FamilyAccessLevel = (typeof FAMILY_ACCESS_LEVELS)[number];

export const EMERGENCY_CONTACT_SOURCES = ['FAMILY', 'CUSTOM'] as const;
export type EmergencyContactSource = (typeof EMERGENCY_CONTACT_SOURCES)[number];

export class FamilyChildDto {
  @ApiProperty() id!: string;
  @ApiProperty() familyId!: string;
  @ApiPropertyOptional() personId!: string | null;
  @ApiProperty() firstName!: string;
  @ApiPropertyOptional() middleName!: string | null;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() preferredName!: string | null;
  @ApiPropertyOptional() dateOfBirth!: string | null;
  @ApiPropertyOptional() gender!: string | null;
  // primaryPhone + notes live on iam_person and are surfaced for
  // LINKED children only — PLACEHOLDER / PENDING_LINK rows have no
  // iam_person yet and these will be null.
  @ApiPropertyOptional() primaryPhone!: string | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty({ enum: FAMILY_CHILD_STATUSES }) status!: FamilyChildStatus;
  // DESCRIPTIVE ONLY (self-login indicator). accessLevel no longer gates
  // editing — INDEPENDENT just means the child has their own login. Use
  // canEdit for whether the current caller may edit this account.
  @ApiProperty({ enum: FAMILY_ACCESS_LEVELS }) accessLevel!: FamilyAccessLevel;
  // Server-computed, caller-relative edit authority (the age + consent model:
  // guardian AND (under 18 → unconditional; 18+ → not revoked)). The UI gates
  // edit affordances on this; the server re-checks on every mutation.
  @ApiProperty() canEdit!: boolean;
  // Per-child preference: 'FAMILY' (default) inherits emergency
  // contacts from platform_families; 'CUSTOM' uses only per-child
  // contacts. See the per-tab UI for the semantics.
  @ApiProperty({ enum: EMERGENCY_CONTACT_SOURCES })
  emergencyContactSource!: EmergencyContactSource;
  // Per-child home address. addressSource 'FAMILY' (default) inherits
  // from platform_families; 'CUSTOM' uses the customAddress* columns.
  // mailingAddressDifferent === false (default) → mailing equals home;
  // true → the mailing* columns are authoritative. Mirrors the shape
  // on the adult /profile Contact tab.
  @ApiProperty({ enum: ['FAMILY', 'CUSTOM'] }) addressSource!: 'FAMILY' | 'CUSTOM';
  @ApiPropertyOptional() customAddressLine1!: string | null;
  @ApiPropertyOptional() customAddressLine2!: string | null;
  @ApiPropertyOptional() customCity!: string | null;
  @ApiPropertyOptional() customState!: string | null;
  @ApiPropertyOptional() customPostalCode!: string | null;
  @ApiPropertyOptional() customCountry!: string | null;
  // Mailing source mirrors addressSource: 'FAMILY' inherits the family
  // mailing address; 'CUSTOM' uses mailingAddressDifferent (false =
  // same-as-physical, true = the mailing* fields).
  @ApiProperty({ enum: ['FAMILY', 'CUSTOM'] }) mailingAddressSource!: 'FAMILY' | 'CUSTOM';
  @ApiProperty() mailingAddressDifferent!: boolean;
  @ApiPropertyOptional() mailingLine1!: string | null;
  @ApiPropertyOptional() mailingLine2!: string | null;
  @ApiPropertyOptional() mailingCity!: string | null;
  @ApiPropertyOptional() mailingState!: string | null;
  @ApiPropertyOptional() mailingPostalCode!: string | null;
  @ApiPropertyOptional() mailingCountry!: string | null;
  // Login email — joins platform_users.email. Populated for LINKED
  // children only; PLACEHOLDER / PENDING_LINK have no platform_users
  // row yet and this is null. Read-only on this DTO — email changes
  // go through the identity-management surface, not /family/children.
  @ApiPropertyOptional() email!: string | null;
  @ApiPropertyOptional() inviteCode!: string | null;
  @ApiPropertyOptional() inviteEmail!: string | null;
  @ApiPropertyOptional() inviteSentAt!: string | null;
  @ApiPropertyOptional() linkedAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateFamilyChildDto {
  @ApiProperty() @IsString() @MaxLength(100) firstName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) middleName?: string;
  @ApiProperty() @IsString() @MaxLength(100) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) preferredName?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
}

/**
 * PATCH /family/children/:id — parent-write fields.
 *
 * Identity fields (firstName, middleName, lastName, preferredName,
 * primaryPhone, notes) apply to the iam_person row when the child
 * is LINKED, and are no-ops when the child is PLACEHOLDER (no
 * iam_person exists yet). dateOfBirth and gender always update the
 * platform_family_children row; dateOfBirth additionally syncs to
 * iam_person.date_of_birth on LINKED rows so the canonical identity
 * stays consistent with the family-children mirror.
 */
export class UpdateFamilyChildDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) middleName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) preferredName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) primaryPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @ApiPropertyOptional({ enum: EMERGENCY_CONTACT_SOURCES })
  @IsOptional()
  @IsIn(EMERGENCY_CONTACT_SOURCES)
  emergencyContactSource?: EmergencyContactSource;
  // Per-child home + mailing address. Empty strings on string fields
  // null-out the column (same convention as UpdateFamilySettingsDto).
  @ApiPropertyOptional({ enum: ['FAMILY', 'CUSTOM'] })
  @IsOptional()
  @IsIn(['FAMILY', 'CUSTOM'])
  addressSource?: 'FAMILY' | 'CUSTOM';
  @ApiPropertyOptional({ enum: ['FAMILY', 'CUSTOM'] })
  @IsOptional()
  @IsIn(['FAMILY', 'CUSTOM'])
  mailingAddressSource?: 'FAMILY' | 'CUSTOM';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customAddressLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customAddressLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) customPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customCountry?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mailingAddressDifferent?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mailingLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mailingLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mailingCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mailingState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) mailingPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mailingCountry?: string | null;
}

export class CreateChildAccountDto {
  // Optional — under-13 accounts are parent-managed and don't need
  // their own email. Older minors get a Keycloak account stub.
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  // DOB + gender are REQUIRED to provision a real account (Account
  // Creation spec, Step 2), but the PLACEHOLDER child row may already
  // carry them. These optional fields let the create-account call fill
  // gaps; the service computes the effective value (dto ?? row) and
  // 400s if either is still missing. Validated as a non-future date /
  // non-empty gender at the service layer so existing 'F'/'M' data on
  // other surfaces stays compatible.
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
}

export class SendChildLinkDto {
  @ApiProperty() @IsEmail() email!: string;
}

export class AcceptFamilyLinkDto {
  // 8-char alphanumeric code — case-insensitive on lookup but stored
  // uppercase. Length 8 keeps the design doc's "ABCD-1234" shape.
  @ApiProperty() @IsString() @Length(8, 8) code!: string;
}

export const INVITATION_TYPES = [
  'EMPLOYEE',
  'CHILD_LINK',
  'PARENT_LINK',
  'SUBSTITUTE',
  'FAMILY_INVITE',
  'GUARDIAN_INVITE',
] as const;
export type InvitationType = (typeof INVITATION_TYPES)[number];

/**
 * POST /family/invite-guardian — generate a GUARDIAN_INVITE code.
 * Optional target_email is recorded on platform_invitations so the
 * email-send path (currently a TODO that logs the code) has the
 * address to use; the code itself is shareable out-of-band so the
 * caller can also copy + paste it.
 *
 * firstName / lastName / relationship are informational hints for
 * the eventual email body — the accepter's own iam_person is the
 * canonical source for their name, so we stash these as
 * invitation.metadata rather than overwriting anything.
 */
export class InviteGuardianDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) relationship?: string;
}

/**
 * POST /family/generate-code — parent generates a FAMILY_INVITE.
 * Optional email is recorded on target_email so a future email
 * worker can send a "Join {Family} on CampusOS" message; the
 * caller can also copy + paste the code directly.
 */
export class GenerateFamilyCodeDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
}

export class InvitationSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: INVITATION_TYPES }) type!: InvitationType;
  @ApiProperty() inviterName!: string;
  @ApiPropertyOptional() schoolId!: string | null;
  @ApiPropertyOptional() schoolName!: string | null;
  @ApiPropertyOptional() jobTitle!: string | null;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() status!: string;
}

export class MyInvitationDto extends InvitationSummaryDto {
  @ApiProperty() token!: string;
}

export class AcceptInvitationResultDto {
  @ApiProperty() invitationId!: string;
  @ApiProperty({ enum: INVITATION_TYPES }) type!: InvitationType;
  @ApiPropertyOptional() personaType!: string | null;
  @ApiPropertyOptional() personaId!: string | null;
  @ApiPropertyOptional() schoolId!: string | null;
}

/**
 * Response for POST /family/generate-code (FAMILY_INVITE, parent
 * side) and POST /family/generate-child-code (CHILD_LINK without a
 * family_child placeholder, child side).
 */
export class GenerateLinkCodeDto {
  @ApiProperty() code!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ enum: INVITATION_TYPES }) type!: InvitationType;
}

// ─── /family — full family structure ───────────────────────

export type FamilyViewerRole = 'PARENT' | 'CHILD';

export const FAMILY_MEMBER_STATUSES = ['PLACEHOLDER', 'PENDING_INVITE', 'ACTIVE'] as const;
export type FamilyMemberStatus = (typeof FAMILY_MEMBER_STATUSES)[number];

/**
 * One row from platform_family_members. For ACTIVE rows the name
 * comes from iam_person and personId is non-null; for PLACEHOLDER
 * and PENDING_INVITE rows the name lives on the family_members row
 * itself and personId is null. memberRole distinguishes
 * HEAD_OF_HOUSEHOLD / SPOUSE / GUARDIAN / etc.
 */
export class FamilyMemberDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() personId!: string | null;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() preferredName?: string | null;
  @ApiPropertyOptional() email?: string | null;
  // Surfaced for ACTIVE guardians (joined to iam_person). Used by
  // the family Emergency Contacts tab to render the guardian row's
  // phone column. Null for PLACEHOLDER / PENDING_INVITE rows.
  @ApiPropertyOptional() primaryPhone?: string | null;
  // Primary phone + email type info for the read-only Guardian
  // Contacts panel on the child Contact tab. Surfaced for ACTIVE
  // guardians via subqueries on platform_person_phones /
  // platform_person_emails (is_primary=true). Null when the row
  // hasn't been seeded yet or for PLACEHOLDER members.
  @ApiPropertyOptional() primaryPhoneType?: string | null;
  @ApiPropertyOptional() primaryEmailType?: string | null;
  @ApiProperty() memberRole!: string;
  @ApiProperty() isPrimaryContact!: boolean;
  @ApiProperty() isCurrentUser!: boolean;
  @ApiProperty({ enum: FAMILY_MEMBER_STATUSES }) status!: FamilyMemberStatus;
  @ApiProperty({ enum: FAMILY_ACCESS_LEVELS }) accessLevel!: FamilyAccessLevel;
  // Family-level preference: whether this guardian is allowed to
  // pick the child up from school. Surfaced + togglable on the
  // Emergency Contacts tab. Default true at row-creation time.
  @ApiProperty() emergencyAuthorizedPickup!: boolean;
  // Position in the unified emergency-contacts list, shared with
  // platform_family_emergency_contacts.priority_order. Default 0
  // until the first reorder fans positions out.
  @ApiProperty() emergencyPriorityOrder!: number;
  @ApiPropertyOptional() inviteCode?: string | null;
  @ApiPropertyOptional() inviteSentAt?: string | null;
}

/**
 * POST /family/members — add a placeholder guardian. The new row
 * lands at status='PLACEHOLDER' with person_id NULL; the parent can
 * later promote it via send-invite or create-account.
 */
export class AddFamilyMemberDto {
  @ApiProperty() @IsString() @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MaxLength(100) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) relationship?: string;
}

/**
 * PATCH /family/members/:id — edit a placeholder guardian's display
 * fields. ACTIVE rows reject this endpoint — those edits go through
 * /profile (the linked guardian's own iam_person row).
 */
export class UpdateFamilyMemberDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) relationship?: string;
  // Emergency-pickup toggle — settable on ACTIVE guardians too, even
  // though the rest of this DTO refuses ACTIVE rows. Identity fields
  // belong to the guardian's own profile; pickup is a family-level
  // preference and stays here.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() emergencyAuthorizedPickup?: boolean;
}

/**
 * POST /family/members/:id/create-account — synthesise an iam_person
 * + platform_users for a placeholder guardian. The new account lands
 * at PENDING_VERIFICATION; the platform_family_members row is
 * promoted to ACTIVE in the same transaction.
 */
export class CreateMemberAccountDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  // DOB + gender are REQUIRED to provision an adult account (Account
  // Creation spec, Step 2). Unlike the child path, platform_family_members
  // has no DOB/gender columns, so these MUST be supplied here; the
  // service 400s if either is missing and writes them onto the new
  // iam_person. Optional at the DTO layer (so the 400 carries a precise
  // field-level message rather than a generic class-validator one).
  //
  // NOTE on Step 4 "also a student": person_type stays GUARDIAN (personas
  // are derived, never assigned — there's no STUDENT projection here), so
  // the student-variant choice has no durable backend representation. It
  // drives only the immediate post-create redirect, which the client
  // already knows from the DOB it submitted — the server needs no flag.
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
}

/**
 * POST /family/members/:id/send-invite — generate a GUARDIAN_INVITE
 * scoped to this specific placeholder row. metadata.familyMemberId
 * carries the row id so the accept path UPDATEs in place rather than
 * INSERTing a duplicate.
 */
export class SendMemberInviteDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
}

// ─── Child medical / emergency / dietary value objects ────

export const ALLERGY_SEVERITIES = ['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'] as const;
export const ALLERGY_TYPES = ['FOOD', 'ENVIRONMENTAL', 'MEDICATION', 'OTHER'] as const;
export const DIETARY_TYPES = [
  'NONE',
  'VEGETARIAN',
  'VEGAN',
  'HALAL',
  'KOSHER',
  'GLUTEN_FREE',
  'DAIRY_FREE',
  'OTHER',
] as const;

export class ChildAllergyEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ enum: ALLERGY_SEVERITIES }) severity?: (typeof ALLERGY_SEVERITIES)[number];
  @ApiPropertyOptional({ enum: ALLERGY_TYPES }) type?: (typeof ALLERGY_TYPES)[number];
  @ApiPropertyOptional() notes?: string;
}

export class ChildMedicationEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() dosage?: string;
  @ApiPropertyOptional() frequency?: string;
  @ApiPropertyOptional() prescriber?: string;
  @ApiPropertyOptional() notes?: string;
}

export class ChildConditionEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() diagnosedDate?: string;
  @ApiPropertyOptional() notes?: string;
}

export class ChildFoodAllergyEntry {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() severity?: (typeof ALLERGY_SEVERITIES)[number];
  @ApiPropertyOptional() notes?: string;
}

export const MEDICAL_SOURCES = ['FAMILY', 'CUSTOM'] as const;
export type MedicalSource = (typeof MEDICAL_SOURCES)[number];

export class ChildMedicalInfoDto {
  @ApiProperty() personId!: string;
  @ApiProperty({ type: [ChildAllergyEntry] }) allergies!: ChildAllergyEntry[];
  @ApiProperty({ type: [ChildMedicationEntry] }) medications!: ChildMedicationEntry[];
  @ApiProperty({ type: [ChildConditionEntry] }) conditions!: ChildConditionEntry[];
  // 'FAMILY' (doctor + insurance inherit from the family record) or
  // 'CUSTOM' (use the per-child columns). Defaults to FAMILY at
  // insert time — most households share a doctor + insurance.
  @ApiProperty({ enum: MEDICAL_SOURCES }) medicalSource!: MedicalSource;
  // Doctor + insurance fields on the wire: when medicalSource is
  // 'FAMILY' the server returns the family-level values here so the
  // UI can render them without a second fetch; the per-child columns
  // are still preserved for if the user toggles back to CUSTOM.
  // The DTO doesn't distinguish — clients should display whatever
  // the server sends.
  @ApiPropertyOptional() doctorName?: string | null;
  @ApiPropertyOptional() doctorPhone?: string | null;
  @ApiPropertyOptional() doctorClinic?: string | null;
  @ApiPropertyOptional() insuranceProvider?: string | null;
  @ApiPropertyOptional() insurancePolicy?: string | null;
  @ApiPropertyOptional() insuranceGroup?: string | null;
  @ApiPropertyOptional() bloodType?: string | null;
  @ApiPropertyOptional() medicalNotes?: string | null;
  // Family's explicit three-state doctor/insurance flags, surfaced ONLY
  // in FAMILY (inherited) mode so the child view can distinguish a
  // definitive "the family has no doctor/insurer" (flag === false) from
  // "nobody filled it in yet" (flag === null) — otherwise both render as
  // empty dashes. null in CUSTOM mode (the child's own record governs).
  @ApiPropertyOptional() hasFamilyDoctor?: boolean | null;
  @ApiPropertyOptional() hasInsurance?: boolean | null;
}

export class UpdateChildMedicalInfoDto {
  // Whole-list replace semantics on the array columns — simpler
  // than item-level patch and makes deletes explicit (a missing
  // entry from the payload disappears from the row).
  @ApiPropertyOptional({ type: [ChildAllergyEntry] }) @IsOptional() allergies?: ChildAllergyEntry[];
  @ApiPropertyOptional({ type: [ChildMedicationEntry] })
  @IsOptional()
  medications?: ChildMedicationEntry[];
  @ApiPropertyOptional({ type: [ChildConditionEntry] })
  @IsOptional()
  conditions?: ChildConditionEntry[];
  // Set to 'FAMILY' to inherit doctor + insurance from the family;
  // set to 'CUSTOM' to use the per-child doctor* / insurance*
  // columns sent in this same payload (or pre-existing on the row).
  @ApiPropertyOptional({ enum: MEDICAL_SOURCES })
  @IsOptional()
  @IsIn(MEDICAL_SOURCES)
  medicalSource?: MedicalSource;
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

export class ChildEmergencyContactDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() relationship!: string;
  @ApiProperty() phonePrimary!: string;
  @ApiPropertyOptional() phoneAlternate?: string | null;
  @ApiPropertyOptional() email?: string | null;
  @ApiProperty() authorizedPickup!: boolean;
  @ApiProperty() priorityOrder!: number;
}

export class AddChildEmergencyContactDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiProperty() @IsString() @MaxLength(80) relationship!: string;
  @ApiProperty() @IsString() @MaxLength(40) phonePrimary!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phoneAlternate?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() authorizedPickup?: boolean;
  @ApiPropertyOptional() @IsOptional() priorityOrder?: number;
}

export class UpdateChildEmergencyContactDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) relationship?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phonePrimary?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phoneAlternate?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() authorizedPickup?: boolean;
  @ApiPropertyOptional() @IsOptional() priorityOrder?: number;
}

export class ChildDietaryInfoDto {
  @ApiProperty() personId!: string;
  @ApiProperty({ enum: DIETARY_TYPES }) dietaryType!: (typeof DIETARY_TYPES)[number];
  @ApiProperty({ type: [ChildFoodAllergyEntry] }) foodAllergies!: ChildFoodAllergyEntry[];
  @ApiPropertyOptional() additionalRestrictions?: string | null;
  @ApiPropertyOptional() mealPreference?: string | null;
}

export class UpdateChildDietaryInfoDto {
  @ApiPropertyOptional({ enum: DIETARY_TYPES })
  @IsOptional()
  @IsIn(DIETARY_TYPES)
  dietaryType?: (typeof DIETARY_TYPES)[number];
  @ApiPropertyOptional({ type: [ChildFoodAllergyEntry] })
  @IsOptional()
  foodAllergies?: ChildFoodAllergyEntry[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  additionalRestrictions?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mealPreference?: string | null;
}

export class FamilyHeaderDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string | null;
}

// ─── /family/contact-preferences ───────────────────────────

export const FAMILY_CONTACT_CATEGORIES = [
  'GENERAL',
  'ELECTRONIC_APPROVALS',
  'TRANSPORTATION',
  'HEALTH_MEDICAL',
  'BILLING_FINANCIAL',
  'ACADEMIC',
  'BEHAVIOUR_DISCIPLINE',
  'EMERGENCY',
] as const;
export type FamilyContactCategory = (typeof FAMILY_CONTACT_CATEGORIES)[number];

/**
 * One row of per-category contact routing. The server resolves
 * primaryContactName by joining iam_person.preferred_name /
 * first_name / last_name so the client can render a friendly
 * label without a per-row second fetch.
 */
export class FamilyContactPreferenceDto {
  @ApiProperty({ enum: FAMILY_CONTACT_CATEGORIES }) category!: FamilyContactCategory;
  @ApiProperty() primaryPersonId!: string;
  @ApiProperty() primaryContactName!: string;
}

export class UpdateFamilyContactPreferenceItemDto {
  @ApiProperty({ enum: FAMILY_CONTACT_CATEGORIES })
  @IsIn(FAMILY_CONTACT_CATEGORIES)
  category!: FamilyContactCategory;
  @ApiProperty() @IsString() primaryPersonId!: string;
}

/**
 * PATCH /family/contact-preferences — bulk upsert. Validates each
 * primaryPersonId is a member of the family before writing. The
 * GENERAL category is mirrored to platform_family_members.is_primary_contact
 * so the /family page badge + /family/settings hero stay in sync.
 */
export class UpdateFamilyContactPreferencesDto {
  // @ApiProperty alone isn't enough — class-validator only adds a
  // property to its whitelist when at least one class-validator
  // decorator is present, and the global ValidationPipe has
  // `forbidNonWhitelisted: true`. Without @IsArray + @ValidateNested
  // here the entire payload gets rejected as "property preferences
  // should not exist." @Type tells class-transformer to instantiate
  // each item as an UpdateFamilyContactPreferenceItemDto so the
  // nested @IsIn / @IsString decorators on the item also fire.
  @ApiProperty({ type: [UpdateFamilyContactPreferenceItemDto] })
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => UpdateFamilyContactPreferenceItemDto)
  preferences!: UpdateFamilyContactPreferenceItemDto[];
}

// ─── /family/settings/emergency-contacts ──────────────────

/**
 * One row of platform_family_emergency_contacts. Inherited by every
 * child in the family whose emergencyContactSource is 'FAMILY';
 * ignored when 'CUSTOM'.
 */
export class FamilyEmergencyContactDto {
  @ApiProperty() id!: string;
  @ApiProperty() familyId!: string;
  // When set, the contact IS a CampusOS user; name/phone/email are
  // mirrored from iam_person at link time and refreshed by the read
  // path. The wire payload always carries the current value; clients
  // shouldn't try to compute it from `linkedPersonId` alone.
  @ApiPropertyOptional() linkedPersonId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() relationship!: string;
  @ApiProperty() phonePrimary!: string;
  @ApiPropertyOptional() phoneAlternate!: string | null;
  @ApiPropertyOptional() email!: string | null;
  @ApiProperty() authorizedPickup!: boolean;
  @ApiProperty() priorityOrder!: number;
}

export class AddFamilyEmergencyContactDto {
  // Either send linkedPersonId to bind to a CampusOS user (the server
  // auto-fills name/phone/email from iam_person) OR send the full
  // name/phone payload for a manual entry. Sending both is allowed —
  // the server uses linkedPersonId values for the synced fields.
  @ApiPropertyOptional() @IsOptional() @IsString() linkedPersonId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiProperty() @IsString() @MaxLength(80) relationship!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phonePrimary?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phoneAlternate?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() authorizedPickup?: boolean;
  @ApiPropertyOptional() @IsOptional() priorityOrder?: number;
}

export class UpdateFamilyEmergencyContactDto {
  // Relationship and authorizedPickup are always editable, regardless
  // of linked vs manual — those are family-specific, not the linked
  // user's own attributes.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) relationship?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() authorizedPickup?: boolean;
  @ApiPropertyOptional() @IsOptional() priorityOrder?: number;
  // name/phone/email writes are honoured ONLY for manual entries
  // (linked_person_id IS NULL). Sending them on a linked row is a
  // no-op — the read path always pulls fresh from iam_person.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phonePrimary?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phoneAlternate?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
}

/**
 * PATCH /family/settings/emergency-contacts/reorder — bulk reorder.
 * Pass the desired full ordering by id; the server clamps to the
 * caller's family, then assigns priority_order = array index for
 * each row. Any id not in the array keeps its current priority but
 * shifted to the end.
 */
export class ReorderFamilyEmergencyContactsDto {
  @ApiProperty({ type: [String] })
  @IsString({ each: true })
  orderedIds!: string[];
}

/**
 * PATCH /families/:familyId/primary-guardian — reassign which active
 * guardian is the family's primary contact. "Primary" is a contact /
 * label designation only; it does NOT change guardianship or edit
 * rights (decoupled from canEditFamilyStructure / isActiveGuardianOf).
 */
export class SetPrimaryGuardianDto {
  @ApiProperty() @IsString() guardianPersonId!: string;
}

// ─── /family/settings — family-level shared attributes ─────

/**
 * GET /family/settings — shared attributes that apply to the whole
 * household. Children inherit these by default (Contact tab + Medical
 * tab "Use family ..." toggles). Lives on platform_families so a
 * family that hasn't enrolled at any school yet can still capture
 * these once for everyone.
 */
export class FamilySettingsDto {
  @ApiProperty() familyId!: string;
  @ApiPropertyOptional() displayName!: string | null;
  // Home address (residential).
  @ApiPropertyOptional() addressLine1!: string | null;
  @ApiPropertyOptional() addressLine2!: string | null;
  @ApiPropertyOptional() city!: string | null;
  @ApiPropertyOptional() state!: string | null;
  @ApiPropertyOptional() postalCode!: string | null;
  @ApiPropertyOptional() country!: string | null;
  @ApiPropertyOptional() homePhone!: string | null;
  // Mailing address. mailingAddressDifferent === true means the
  // mailing_* columns are authoritative; === false (default) means
  // the mailing address is the same as the home address and the
  // mailing_* columns are ignored.
  @ApiProperty() mailingAddressDifferent!: boolean;
  @ApiPropertyOptional() mailingLine1!: string | null;
  @ApiPropertyOptional() mailingLine2!: string | null;
  @ApiPropertyOptional() mailingCity!: string | null;
  @ApiPropertyOptional() mailingState!: string | null;
  @ApiPropertyOptional() mailingPostalCode!: string | null;
  @ApiPropertyOptional() mailingCountry!: string | null;
  // Doctor + insurance — the family-level defaults. Per-child overrides
  // continue to live on PlatformChildMedicalInfo.
  @ApiPropertyOptional() doctorName!: string | null;
  @ApiPropertyOptional() doctorPhone!: string | null;
  @ApiPropertyOptional() doctorClinic!: string | null;
  @ApiPropertyOptional() insuranceProvider!: string | null;
  @ApiPropertyOptional() insurancePolicy!: string | null;
  @ApiPropertyOptional() insuranceGroup!: string | null;
  // Three-state opt-out toggles. null = not answered, true = has
  // one (defaults filled below), false = explicit "we don't have
  // one" — the completion checker treats false as ✅ complete so a
  // family without a doctor / insurance can still hit 100%.
  @ApiPropertyOptional() hasFamilyDoctor!: boolean | null;
  @ApiPropertyOptional() hasInsurance!: boolean | null;
  // Family-wide medical notes shared with schools and inherited
  // by children whose medical_source is 'FAMILY'.
  @ApiPropertyOptional() medicalNotes!: string | null;
  // Identity of the current primary contact (a guardian
  // platform_family_members row in this family with
  // is_primary_contact = true). Settable via PATCH (see
  // UpdateFamilySettingsDto.primaryContactPersonId) — promote runs
  // inside a tx that demotes the previous primary first.
  @ApiPropertyOptional() primaryContactPersonId!: string | null;
  @ApiPropertyOptional() primaryContactName!: string | null;
  // True when the caller can mutate these fields (parent/guardian
  // member of the family). Children get read-only.
  @ApiProperty() canEdit!: boolean;
}

/**
 * PATCH /family/settings — partial update of shared attributes.
 * Children can't mutate this surface; the service returns 403.
 * Setting any string field to '' is treated as a null-out — clients
 * pass an empty string to clear a value, null to clear, or the
 * non-empty value to set. The family display name has a separate
 * length cap (200) to mirror iam_person.preferred_name.
 */
export class UpdateFamilySettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) displayName?: string | null;
  // Home address.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) city?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) state?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) postalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) country?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) homePhone?: string | null;
  // Mailing address.
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mailingAddressDifferent?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mailingLine1?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) mailingLine2?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mailingCity?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mailingState?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) mailingPostalCode?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) mailingCountry?: string | null;
  // Health & insurance.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) doctorName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) doctorPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) doctorClinic?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) insuranceProvider?:
    | string
    | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) insurancePolicy?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) insuranceGroup?: string | null;
  // Opt-out toggles — pass true / false to set, null to reset to
  // "not answered." Send the boolean explicitly (not undefined,
  // which the partial-update path skips entirely).
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasFamilyDoctor?: boolean | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasInsurance?: boolean | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) medicalNotes?: string | null;
  // Promote a guardian to primary contact. Service runs a tx that
  // demotes the previous primary first so the partial UNIQUE INDEX
  // on (family_id) WHERE is_primary_contact = true never rejects.
  // Person must already be a member of the family — cross-family
  // ids return 400.
  @ApiPropertyOptional() @IsOptional() @IsString() primaryContactPersonId?: string;
}

/**
 * GET /family — composite shape used by the /family page. Returned
 * with viewerRole so the client can pick the appropriate render path
 * (PARENT sees write controls; CHILD sees read-only siblings + own
 * profile shortcut). children[] uses the existing FamilyChildDto
 * shape so legacy /family/children consumers don't have to learn a
 * new type.
 */
export class FamilyViewDto {
  @ApiProperty({ type: FamilyHeaderDto }) family!: FamilyHeaderDto;
  @ApiProperty({ enum: ['PARENT', 'CHILD'] }) viewerRole!: FamilyViewerRole;
  @ApiProperty() viewerPersonId!: string;
  @ApiProperty({ type: [FamilyMemberDto] }) members!: FamilyMemberDto[];
  @ApiProperty({ type: [FamilyChildDto] }) children!: FamilyChildDto[];
}

// ─── /family/link — discriminated response ────────────────

/**
 * POST /family/link can resolve to either a child-shaped result
 * (FAMILY_INVITE / CHILD_LINK paths) or a guardian-shaped result
 * (GUARDIAN_INVITE). The `kind` tag tells the client which view
 * to render next:
 *
 *   CHILD     → "you are linked to family X as a child", or
 *               "a child has been added to your family"
 *   GUARDIAN  → "you joined family X as a parent/guardian"
 *
 * Existing call sites that ignore the response value (just toast
 * + redirect on success) keep working unchanged.
 */
export class FamilyLinkChildResultDto {
  @ApiProperty({ enum: ['CHILD'] }) kind!: 'CHILD';
  @ApiProperty({ type: FamilyChildDto }) child!: FamilyChildDto;
}

export class FamilyLinkGuardianResultDto {
  @ApiProperty({ enum: ['GUARDIAN'] }) kind!: 'GUARDIAN';
  @ApiProperty({ type: FamilyHeaderDto }) family!: FamilyHeaderDto;
  @ApiProperty() inviterName!: string;
}

export type FamilyLinkResultDto = FamilyLinkChildResultDto | FamilyLinkGuardianResultDto;
