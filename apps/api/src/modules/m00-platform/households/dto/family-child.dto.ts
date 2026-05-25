import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export const FAMILY_CHILD_STATUSES = ['PLACEHOLDER', 'PENDING_LINK', 'LINKED'] as const;
export type FamilyChildStatus = (typeof FAMILY_CHILD_STATUSES)[number];

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
}

export class CreateChildAccountDto {
  // Optional — under-13 accounts are parent-managed and don't need
  // their own email. Older minors get a Keycloak account stub.
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
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
  @ApiProperty() memberRole!: string;
  @ApiProperty() isPrimaryContact!: boolean;
  @ApiProperty() isCurrentUser!: boolean;
  @ApiProperty({ enum: FAMILY_MEMBER_STATUSES }) status!: FamilyMemberStatus;
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
}

/**
 * POST /family/members/:id/create-account — synthesise an iam_person
 * + platform_users for a placeholder guardian. The new account lands
 * at PENDING_VERIFICATION; the platform_family_members row is
 * promoted to ACTIVE in the same transaction.
 */
export class CreateMemberAccountDto {
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
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

export class FamilyHeaderDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string | null;
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
