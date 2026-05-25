import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomInt } from 'crypto';
import { generateId } from '@campusos/database';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { RedisService } from '@shared/cache';
import {
  AcceptFamilyLinkDto,
  AddChildEmergencyContactDto,
  AddFamilyMemberDto,
  ChildAllergyEntry,
  ChildConditionEntry,
  ChildDietaryInfoDto,
  ChildEmergencyContactDto,
  ChildFoodAllergyEntry,
  ChildMedicalInfoDto,
  ChildMedicationEntry,
  CreateChildAccountDto,
  CreateFamilyChildDto,
  CreateMemberAccountDto,
  FamilyAccessLevel,
  FamilyChildDto,
  FamilyHeaderDto,
  FamilyLinkResultDto,
  FamilyMemberDto,
  FamilySettingsDto,
  FamilyViewDto,
  FamilyViewerRole,
  GenerateFamilyCodeDto,
  GenerateLinkCodeDto,
  InviteGuardianDto,
  SendChildLinkDto,
  SendMemberInviteDto,
  UpdateChildDietaryInfoDto,
  UpdateChildEmergencyContactDto,
  UpdateChildMedicalInfoDto,
  UpdateFamilyChildDto,
  UpdateFamilyMemberDto,
  UpdateFamilySettingsDto,
} from './dto/family-child.dto';

interface FamilyChildRow {
  id: string;
  family_id: string;
  person_id: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  primary_phone: string | null;
  notes: string | null;
  status: string;
  invite_code: string | null;
  invite_email: string | null;
  invite_sent_at: string | null;
  linked_at: string | null;
  created_at: string;
  managed_by_person_id: string | null;
}

function computeAccessLevel(
  status: string,
  managedByPersonId: string | null,
  viewerPersonId: string,
): FamilyAccessLevel {
  // PLACEHOLDER + every other pre-link state: the row has no linked
  // iam_person yet, so there's no "account holder" to manage. Edit
  // permission comes from family membership, not account custody.
  if (status !== 'LINKED' && status !== 'ACTIVE') return 'PLACEHOLDER';
  // LINKED / ACTIVE: account is in custody of the viewer iff
  // platform_users.managed_by_person_id matches the viewer's
  // iam_person.id. Anything else (NULL or another person) means the
  // account holder owns their identity and the viewer is read-only.
  if (managedByPersonId && managedByPersonId === viewerPersonId) return 'MANAGED';
  return 'INDEPENDENT';
}

const LINK_CODE_TTL_HOURS = 72;
const LINK_ATTEMPTS_LIMIT = 5;
const LINK_ATTEMPTS_WINDOW_SECONDS = 15 * 60;

/**
 * FamilyChildrenService — persona-registration Step 5 + 6.
 *
 * Owns the platform_family_children table: CRUD of placeholder/pending
 * children, plus the three account-linking flows (create minor account,
 * send link code, accept code).
 *
 * Authorisation: a person can only see / mutate children inside the
 * family they're a member of. We resolve `family_id` from
 * platform_family_members.person_id; if the person isn't a member of
 * any family yet (registration didn't seed one), POST creates one on
 * demand so the parent can capture their children before any school
 * relationship exists.
 *
 * Persona refresh: every LINKED transition refreshes the inviting
 * parent's persona cache so the PARENT persona activates immediately.
 * Failures are swallowed — refresh is a cache rebuild, not a
 * correctness requirement.
 */
@Injectable()
export class FamilyChildrenService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personaResolution: PersonaResolutionService,
    private readonly redis: RedisService,
  ) {}

  // ─── /family — composite view ──────────────────────────────

  /**
   * GET /family — composite view of the caller's family.
   *
   * Viewer-family resolution:
   *   1. If the caller is a family_members row in a family that has
   *      any platform_family_children rows → that family, PARENT view.
   *   2. Else if the caller is a LINKED family_child anywhere → that
   *      family, CHILD view. (A user can be LINKED in multiple
   *      families; we pick the most-recently-linked one.)
   *   3. Else if the caller is a family_members row anywhere (empty
   *      singleton from registration) → that family, PARENT view.
   *   4. Otherwise null — the caller has no family at all. The
   *      controller returns null and the frontend falls back to its
   *      empty state.
   *
   * Step (1) ordering is important — once an adult has children of
   * their own they should land on their OWN family even if they're
   * also still LINKED in their parent's family.
   */
  async getFamilyView(personId: string): Promise<FamilyViewDto | null> {
    const resolved = await this.resolveViewerFamily(personId);
    if (!resolved) return null;

    const family = await this.prisma.platformFamily.findUnique({
      where: { id: resolved.familyId },
      select: { id: true, name: true },
    });
    if (!family) return null;

    // LEFT JOIN iam_person so PLACEHOLDER / PENDING_INVITE rows
    // (person_id NULL) come through with family_members.first_name /
    // last_name / email instead of NULL columns. COALESCE picks
    // iam_person for ACTIVE rows, family_members for placeholders.
    const memberRows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        person_id: string | null;
        first_name: string;
        last_name: string;
        preferred_name: string | null;
        email: string | null;
        member_role: string;
        is_primary_contact: boolean;
        status: string;
        invite_code: string | null;
        invite_sent_at: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT pfm.id::text AS id,
              pfm.person_id::text AS person_id,
              COALESCE(p.first_name, pfm.first_name) AS first_name,
              COALESCE(p.last_name, pfm.last_name) AS last_name,
              p.preferred_name AS preferred_name,
              pfm.email AS email,
              pfm.member_role::text AS member_role,
              pfm.is_primary_contact,
              pfm.status,
              pfm.invite_code,
              pfm.invite_sent_at::text AS invite_sent_at,
              pu.managed_by_person_id::text AS managed_by_person_id
       FROM platform.platform_family_members pfm
       LEFT JOIN platform.iam_person p ON p.id = pfm.person_id
       LEFT JOIN platform.platform_users pu ON pu.person_id = pfm.person_id
       WHERE pfm.family_id = $1::uuid
       ORDER BY pfm.is_primary_contact DESC, pfm.joined_at ASC`,
      resolved.familyId,
    );
    const members: FamilyMemberDto[] = memberRows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      firstName: r.first_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      email: r.email,
      memberRole: r.member_role,
      isPrimaryContact: r.is_primary_contact,
      isCurrentUser: r.person_id !== null && r.person_id === personId,
      status: r.status as FamilyMemberDto['status'],
      // ACTIVE rows mapping to a status the helper recognises as
      // linked (LINKED is its child-side analogue) → MANAGED if
      // managed_by matches the viewer, otherwise INDEPENDENT.
      // PLACEHOLDER + PENDING_INVITE fall through to 'PLACEHOLDER'.
      accessLevel: computeAccessLevel(
        r.status === 'ACTIVE' ? 'LINKED' : r.status,
        r.managed_by_person_id,
        personId,
      ),
      inviteCode: r.invite_code,
      inviteSentAt: r.invite_sent_at,
    }));

    const childRows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.family_id = $1::uuid ORDER BY pfc.created_at ASC',
      resolved.familyId,
    );

    return {
      family: { id: family.id, name: family.name },
      viewerRole: resolved.role,
      viewerPersonId: personId,
      members,
      children: childRows.map((r) => this.toDto(r, personId)),
    };
  }

  /**
   * Pick the family that should drive the /family page for this user.
   * Returns null if the user has no family of any kind (registration
   * normally seeds one, but the unauth-by-API-token case can land
   * here). Documented at length on getFamilyView above.
   */
  private async resolveViewerFamily(
    personId: string,
  ): Promise<{ familyId: string; role: FamilyViewerRole } | null> {
    const myMemberFamilyId = await this.findFamilyForPerson(personId);

    if (myMemberFamilyId) {
      const childCountRows = await this.prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*)::bigint AS cnt
         FROM platform.platform_family_children
         WHERE family_id = $1::uuid`,
        myMemberFamilyId,
      );
      if (Number(childCountRows[0]?.cnt ?? 0n) > 0) {
        return { familyId: myMemberFamilyId, role: 'PARENT' };
      }
    }

    const linkedRows = await this.prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id
       FROM platform.platform_family_children
       WHERE person_id = $1::uuid AND status = 'LINKED'
       ORDER BY linked_at DESC NULLS LAST
       LIMIT 1`,
      personId,
    );
    if (linkedRows[0]) {
      return { familyId: linkedRows[0].family_id, role: 'CHILD' };
    }

    if (myMemberFamilyId) {
      return { familyId: myMemberFamilyId, role: 'PARENT' };
    }
    return null;
  }

  /**
   * Refuse a parent-write when the caller's primary family view is
   * CHILD (they're LINKED into someone else's family with no kids of
   * their own). PATCH/DELETE/send-link/create-account already gate
   * via requireOwnedRow's family_members membership check; this
   * helper covers POST /family/children and generate-code where the
   * caller has no existing target row to check against.
   *
   * `resolveViewerFamily` ordering prefers PARENT-with-kids first
   * and falls through to LINKED-child-elsewhere, so a fresh parent
   * with an empty singleton family still passes — only "I am a
   * LINKED child somewhere AND have no kids of my own" trips the
   * 403.
   */
  private async assertNotChildViewer(personId: string): Promise<void> {
    const resolved = await this.resolveViewerFamily(personId);
    if (resolved?.role === 'CHILD') {
      throw new HttpException(
        'Only parents/guardians can perform this action',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // ─── Family settings — shared attributes ────────────────────

  /**
   * GET /family/settings — household-wide attributes (display name,
   * address, doctor, insurance) plus the current primary-contact
   * identity. Children inherit these by default; per-child overrides
   * live on PlatformChildMedicalInfo / per-child contact tables.
   *
   * Resolves the caller's family via resolveViewerFamily so both
   * PARENT and CHILD viewers can see the settings; canEdit is true
   * only for parents/guardians (the assertNotChildViewer rule on
   * the PATCH path enforces this server-side).
   *
   * Returns null when the caller has no family row yet (the registration
   * normally seeds one, but an unauth-flow caller would land here).
   */
  async getFamilySettings(personId: string): Promise<FamilySettingsDto | null> {
    const resolved = await this.resolveViewerFamily(personId);
    if (!resolved) return null;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        name: string | null;
        address_line1: string | null;
        address_line2: string | null;
        city: string | null;
        state: string | null;
        postal_code: string | null;
        country: string | null;
        home_phone: string | null;
        doctor_name: string | null;
        doctor_phone: string | null;
        doctor_clinic: string | null;
        insurance_provider: string | null;
        insurance_policy: string | null;
        insurance_group: string | null;
        primary_contact_person_id: string | null;
        primary_first_name: string | null;
        primary_last_name: string | null;
        primary_preferred_name: string | null;
      }>
    >(
      `SELECT
         pf.id::text AS id,
         pf.name,
         pf.address_line1, pf.address_line2, pf.city, pf.state,
         pf.postal_code, pf.country, pf.home_phone,
         pf.doctor_name, pf.doctor_phone, pf.doctor_clinic,
         pf.insurance_provider, pf.insurance_policy, pf.insurance_group,
         pc.person_id::text AS primary_contact_person_id,
         p.first_name AS primary_first_name,
         p.last_name AS primary_last_name,
         p.preferred_name AS primary_preferred_name
       FROM platform.platform_families pf
       LEFT JOIN platform.platform_family_members pc
         ON pc.family_id = pf.id AND pc.is_primary_contact = true
       LEFT JOIN platform.iam_person p ON p.id = pc.person_id
       WHERE pf.id = $1::uuid
       LIMIT 1`,
      resolved.familyId,
    );
    const row = rows[0];
    if (!row) return null;
    const primaryName = row.primary_contact_person_id
      ? row.primary_preferred_name?.trim() ||
        [row.primary_first_name, row.primary_last_name].filter(Boolean).join(' ') ||
        null
      : null;
    return {
      familyId: row.id,
      displayName: row.name,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
      country: row.country,
      homePhone: row.home_phone,
      doctorName: row.doctor_name,
      doctorPhone: row.doctor_phone,
      doctorClinic: row.doctor_clinic,
      insuranceProvider: row.insurance_provider,
      insurancePolicy: row.insurance_policy,
      insuranceGroup: row.insurance_group,
      primaryContactPersonId: row.primary_contact_person_id,
      primaryContactName: primaryName,
      canEdit: resolved.role === 'PARENT',
    };
  }

  /**
   * PATCH /family/settings — partial update. Children rejected by
   * assertNotChildViewer (their viewerRole resolves to CHILD when
   * they have no kids of their own). Empty strings on the wire are
   * coerced to NULL — clients use '' to clear a field.
   */
  async updateFamilySettings(
    personId: string,
    dto: UpdateFamilySettingsDto,
  ): Promise<FamilySettingsDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);

    const cols: Record<keyof UpdateFamilySettingsDto, string> = {
      displayName: 'name',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      city: 'city',
      state: 'state',
      postalCode: 'postal_code',
      country: 'country',
      homePhone: 'home_phone',
      doctorName: 'doctor_name',
      doctorPhone: 'doctor_phone',
      doctorClinic: 'doctor_clinic',
      insuranceProvider: 'insurance_provider',
      insurancePolicy: 'insurance_policy',
      insuranceGroup: 'insurance_group',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const k of Object.keys(cols) as Array<keyof UpdateFamilySettingsDto>) {
      if (dto[k] === undefined) continue;
      setClauses.push(cols[k] + ' = $' + i++);
      // '' → NULL so the UI can clear a field by submitting an empty
      // string. null → NULL stays null.
      const v = dto[k];
      values.push(typeof v === 'string' && v.trim() === '' ? null : v);
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = now()');
      values.push(familyId);
      await this.prisma.$executeRawUnsafe(
        'UPDATE platform.platform_families SET ' +
          setClauses.join(', ') +
          ' WHERE id = $' +
          i +
          '::uuid',
        ...values,
      );
    }

    const refreshed = await this.getFamilySettings(personId);
    if (!refreshed) {
      throw new HttpException(
        'Could not reload family settings after update',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return refreshed;
  }

  // ─── CRUD (Step 5) ─────────────────────────────────────────

  async listForUser(personId: string): Promise<FamilyChildDto[]> {
    const familyId = await this.findFamilyForPerson(personId);
    if (!familyId) return [];
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.family_id = $1::uuid ORDER BY pfc.created_at ASC',
      familyId,
    );
    return rows.map((r) => this.toDto(r, personId));
  }

  async create(personId: string, dto: CreateFamilyChildDto): Promise<FamilyChildDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const id = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_children
         (id, family_id, person_id, first_name, middle_name, last_name, preferred_name,
          date_of_birth, gender, status, created_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $4, $5, $6, $7::date, $8, 'PLACEHOLDER', now())`,
      id,
      familyId,
      dto.firstName,
      dto.middleName ?? null,
      dto.lastName,
      dto.preferredName ?? null,
      dto.dateOfBirth ?? null,
      dto.gender ?? null,
    );
    return this.requireById(id, personId);
  }

  async update(
    personId: string,
    childId: string,
    dto: UpdateFamilyChildDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);

    // INDEPENDENT children own their own identity — only the account
    // holder (or an admin via a future surface) can edit. The caller
    // can still see the row via GET because they're a parent in the
    // family, but PATCH refuses.
    const accessLevel = computeAccessLevel(row.status, row.managed_by_person_id, personId);
    if (accessLevel === 'INDEPENDENT') {
      throw new HttpException(
        'This account is managed by the account holder. You can view but not edit their information.',
        HttpStatus.FORBIDDEN,
      );
    }

    // For LINKED children, the iam_person row is the canonical source
    // of name + DOB. Mirror those fields onto platform_family_children
    // so the existing /family/children GET (which reads from the
    // mirror) stays consistent without a join. middle_name +
    // preferred_name + primary_phone + notes only exist on iam_person,
    // so they're skipped silently for PLACEHOLDER children. gender
    // lives on family_children for everyone — there's no
    // iam_person.gender column.
    const childSet: string[] = [];
    const childArgs: unknown[] = [];
    let ci = 1;
    if (dto.firstName !== undefined) {
      childSet.push('first_name = $' + ci++);
      childArgs.push(dto.firstName);
    }
    if (dto.middleName !== undefined) {
      childSet.push('middle_name = $' + ci++);
      childArgs.push(dto.middleName);
    }
    if (dto.lastName !== undefined) {
      childSet.push('last_name = $' + ci++);
      childArgs.push(dto.lastName);
    }
    if (dto.preferredName !== undefined) {
      childSet.push('preferred_name = $' + ci++);
      childArgs.push(dto.preferredName);
    }
    if (dto.dateOfBirth !== undefined) {
      childSet.push('date_of_birth = $' + ci++ + '::date');
      childArgs.push(dto.dateOfBirth);
    }
    if (dto.gender !== undefined) {
      childSet.push('gender = $' + ci++);
      childArgs.push(dto.gender);
    }

    const personPatch: Record<string, unknown> = {};
    if (row.status === 'LINKED' && row.person_id) {
      if (dto.firstName !== undefined) personPatch.firstName = dto.firstName;
      if (dto.middleName !== undefined) personPatch.middleName = dto.middleName;
      if (dto.lastName !== undefined) personPatch.lastName = dto.lastName;
      if (dto.preferredName !== undefined) personPatch.preferredName = dto.preferredName;
      if (dto.primaryPhone !== undefined) personPatch.primaryPhone = dto.primaryPhone;
      if (dto.notes !== undefined) personPatch.notes = dto.notes;
      if (dto.dateOfBirth !== undefined) {
        personPatch.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
      }
    }

    if (childSet.length === 0 && Object.keys(personPatch).length === 0) {
      return this.toDto(row, personId);
    }

    const linkedPersonId = row.person_id;
    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(personPatch).length > 0 && linkedPersonId) {
        await tx.iamPerson.update({ where: { id: linkedPersonId }, data: personPatch });
      }
      if (childSet.length > 0) {
        childSet.push('updated_at = now()');
        childArgs.push(childId);
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_children
           SET ${childSet.join(', ')}
           WHERE id = $${ci}::uuid`,
          ...childArgs,
        );
      }
    });
    return this.requireById(childId, personId);
  }

  /**
   * DELETE /family/children/:id — only PLACEHOLDER rows may be
   * removed. Codex review FIX 3: the prior implementation would
   * silently revoke a PENDING_LINK invitation as a side-effect of
   * delete, which conflated "I no longer want to invite this person"
   * with "remove this child entirely." Callers must now cancel the
   * link explicitly via /cancel-link, which resets the row back to
   * PLACEHOLDER; the row can then be deleted normally.
   */
  async remove(personId: string, childId: string): Promise<void> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status === 'LINKED') {
      throw new BadRequestException(
        'Cannot remove a linked child. Use /unlink to detach the canonical account.',
      );
    }
    if (row.status === 'PENDING_LINK') {
      throw new BadRequestException(
        'Cancel the link invitation first (POST /family/children/:id/cancel-link), then remove the child.',
      );
    }
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE id = $1::uuid`,
      childId,
    );
  }

  /**
   * POST /family/children/:id/cancel-link — revokes the outstanding
   * CHILD_LINK invitation and resets the family_child row back to
   * PLACEHOLDER. After cancelling the row can either be deleted or
   * have a fresh link sent.
   */
  async cancelLink(personId: string, childId: string): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status !== 'PENDING_LINK') {
      throw new BadRequestException(
        `Cannot cancel a link in status ${row.status}; expected PENDING_LINK`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET status = 'PLACEHOLDER',
               invite_code = NULL,
               invite_email = NULL,
               invite_sent_at = NULL,
               updated_at = now()
         WHERE id = $1::uuid`,
        childId,
      );
    });
    return this.requireById(childId, personId);
  }

  // ─── Account creation + linking (Step 6) ───────────────────

  /**
   * POST /family/children/:id/create-account — Option C: parent-managed
   * minor account. Creates iam_person + platform_users for the child,
   * stamps platform_family_children to LINKED, and refreshes the
   * parent's persona cache so PARENT activates.
   *
   * COPPA gate: under-13 (computed from date_of_birth if present)
   * accounts MUST NOT carry a target email; the parent manages
   * everything. 13+ children may have their own email. We don't have a
   * real Keycloak provisioning hook yet — the email is recorded on
   * platform_users and a future migration / sync worker will mirror to
   * the IdP.
   */
  async createAccountForChild(
    personId: string,
    childId: string,
    dto: CreateChildAccountDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status !== 'PLACEHOLDER') {
      throw new BadRequestException(
        `Cannot create account for child in status ${row.status}; expected PLACEHOLDER`,
      );
    }
    const ageYears = row.date_of_birth ? ageInYears(row.date_of_birth) : null;
    if (dto.email && ageYears !== null && ageYears < 13) {
      throw new BadRequestException(
        'Under-13 accounts are parent-managed and cannot have their own email (COPPA)',
      );
    }
    const newPersonId = generateId();
    const newAccountId = generateId();
    const emailForAccount = dto.email ?? this.syntheticChildEmail(newPersonId);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.iam_person
           (id, first_name, last_name, date_of_birth, person_type, is_active, created_at)
         VALUES ($1::uuid, $2, $3, $4::date, 'STUDENT', true, now())`,
        newPersonId,
        row.first_name,
        row.last_name,
        row.date_of_birth,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type,
            mfa_enabled, is_minor_account, managed_by_person_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING_VERIFICATION', 'HUMAN',
                 false, true, $5::uuid, now())`,
        newAccountId,
        newPersonId,
        emailForAccount,
        row.first_name + ' ' + row.last_name,
        personId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET person_id = $1::uuid,
               status = 'LINKED',
               linked_at = now(),
               updated_at = now()
         WHERE id = $2::uuid`,
        newPersonId,
        childId,
      );
    });

    await this.refreshPersonaCacheSafe(personId);
    return this.requireById(childId, personId);
  }

  /**
   * POST /family/children/:id/send-link — generate an 8-char alphanumeric
   * invite code, stamp PENDING_LINK on the family child, and store the
   * outstanding invitation row. The email send is a TODO — for now we
   * log the code so devs can copy it locally.
   */
  async sendLinkInvitation(
    personId: string,
    childId: string,
    dto: SendChildLinkDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);
    // Codex review FIX 4 — accept both PLACEHOLDER (first send) and
    // PENDING_LINK (resend). LINKED rows reject; the canonical
    // account is already attached and there's nothing to invite.
    if (row.status !== 'PLACEHOLDER' && row.status !== 'PENDING_LINK') {
      throw new BadRequestException(
        `Cannot send link invitation for child in status ${row.status}; expected PLACEHOLDER or PENDING_LINK`,
      );
    }
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // Revoke the previous outstanding invitation (if any) so we
      // don't leak a still-valid old code after a resend.
      if (row.status === 'PENDING_LINK' && row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_invitations
           (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
         VALUES ($1::uuid, 'CHILD_LINK', $2, $3::uuid, $4,
                 jsonb_build_object('familyChildId', $5::text),
                 'PENDING', $6::timestamptz, now())`,
        invitationId,
        code,
        personId,
        dto.email,
        childId,
        expiresAt.toISOString(),
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET status = 'PENDING_LINK',
               invite_code = $1,
               invite_email = $2,
               invite_sent_at = now(),
               updated_at = now()
         WHERE id = $3::uuid`,
        code,
        dto.email,
        childId,
      );
    });

    // eslint-disable-next-line no-console
    console.log(
      `[child-link-invite] family_child=${childId} email=${dto.email} code=${code} expires=${expiresAt.toISOString()}`,
    );

    return this.requireById(childId, personId);
  }

  /**
   * POST /family/link — accept a family-link invitation. Dispatches on
   * invitation type + metadata shape:
   *
   *   FAMILY_INVITE
   *     A PARENT issued an open code via /family/generate-code. The
   *     accepter (current user) joins the inviter's family as a
   *     LINKED child. Auto-matches a same-name PLACEHOLDER row in
   *     the inviter's family if one exists; otherwise creates a
   *     fresh row using the accepter's iam_person identity.
   *
   *   CHILD_LINK with metadata.familyChildId
   *     Existing parent-issued path. The accepter is the CHILD
   *     (or second parent) named on the PLACEHOLDER family_child
   *     row; we stamp person_id + status=LINKED on that row.
   *
   *   CHILD_LINK without metadata.familyChildId
   *     New path — a CHILD issued the code via
   *     /family/generate-child-code. The accepter (current user) is
   *     the PARENT. We add the child to the parent's family the
   *     same way as FAMILY_INVITE but with inviter/accepter
   *     reversed — auto-match against a same-name PLACEHOLDER or
   *     create a fresh LINKED row using the child's iam_person.
   *
   * Persona refresh: whichever side is the PARENT (FAMILY_INVITE
   * inviter, parent-issued CHILD_LINK inviter, or child-issued
   * CHILD_LINK accepter) has their persona cache refreshed so PARENT
   * activates immediately.
   */
  async acceptLinkCode(
    personId: string,
    accountId: string,
    dto: AcceptFamilyLinkDto,
  ): Promise<FamilyLinkResultDto> {
    await this.assertLinkRateLimit(accountId);

    const codeUpper = dto.code.toUpperCase();
    const invitation = await this.prisma.platformInvitation.findUnique({
      where: { token: codeUpper },
      select: {
        id: true,
        type: true,
        status: true,
        inviterPersonId: true,
        metadata: true,
        expiresAt: true,
      },
    });
    if (
      !invitation ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException('Invalid or expired link code');
    }

    if (invitation.type === 'GUARDIAN_INVITE') {
      return this.acceptGuardianInvite(personId, invitation);
    }
    if (invitation.type === 'FAMILY_INVITE') {
      const child = await this.acceptFamilyInvite(personId, invitation);
      return { kind: 'CHILD', child };
    }
    if (invitation.type === 'CHILD_LINK') {
      const metadata = invitation.metadata as { familyChildId?: string } | null;
      const child = metadata?.familyChildId
        ? await this.acceptParentIssuedChildLink(personId, invitation, metadata.familyChildId)
        : await this.acceptChildIssuedLink(personId, invitation);
      return { kind: 'CHILD', child };
    }

    // Other invitation types (EMPLOYEE / PARENT_LINK / SUBSTITUTE)
    // have their own dispatcher in InvitationService. /family/link is
    // family-only — surface as NotFound rather than leak the type.
    throw new NotFoundException('Invalid or expired link code');
  }

  // ─── Generate codes — bidirectional family-link feature ─────

  /**
   * POST /family/generate-code — parent generates a FAMILY_INVITE
   * code. The accepter joins the parent's family as a LINKED child.
   * Ensures the caller has a platform_families row first (registration
   * normally seeds one; this is a safety net for accounts that
   * pre-date that flow).
   */
  async generateFamilyCode(
    personId: string,
    dto: GenerateFamilyCodeDto = {},
  ): Promise<GenerateLinkCodeDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'FAMILY_INVITE', $2, $3::uuid, $4,
               jsonb_build_object('familyId', $5::text),
               'PENDING', $6::timestamptz, now())`,
      invitationId,
      code,
      personId,
      dto.email ?? null,
      familyId,
      expiresAt.toISOString(),
    );
    if (dto.email) {
      // eslint-disable-next-line no-console
      console.log(
        `[family-invite] family=${familyId} email=${dto.email} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return { code, expiresAt: expiresAt.toISOString(), type: 'FAMILY_INVITE' };
  }

  /**
   * POST /family/invite-guardian — parent generates a GUARDIAN_INVITE
   * code. Whoever accepts is added to the family as a co-parent (a
   * second HEAD_OF_HOUSEHOLD row in platform_family_members) and
   * gains full read/write on every child in the family.
   *
   * Optional `email` lands on target_email so a future email-send
   * worker has the address to use; the code itself is shareable out
   * of band so the caller can also copy + paste it.
   */
  async generateGuardianInvite(
    personId: string,
    dto: InviteGuardianDto,
  ): Promise<GenerateLinkCodeDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    // The accepter's iam_person is the canonical source for their
    // name post-accept; firstName/lastName/relationship sit on the
    // invitation as informational hints for the eventual email body
    // and any pre-accept display in /invitations/mine.
    const metadata: Record<string, unknown> = { familyId };
    if (dto.firstName) metadata.targetFirstName = dto.firstName.trim();
    if (dto.lastName) metadata.targetLastName = dto.lastName.trim();
    if (dto.relationship) metadata.relationship = dto.relationship.trim();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'GUARDIAN_INVITE', $2, $3::uuid, $4, $5::jsonb,
               'PENDING', $6::timestamptz, now())`,
      invitationId,
      code,
      personId,
      dto.email ?? null,
      JSON.stringify(metadata),
      expiresAt.toISOString(),
    );
    if (dto.email) {
      // eslint-disable-next-line no-console
      console.log(
        `[guardian-invite] family=${familyId} email=${dto.email} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return { code, expiresAt: expiresAt.toISOString(), type: 'GUARDIAN_INVITE' };
  }

  // ─── Placeholder guardian members ─────────────────────────

  /**
   * POST /family/members — add a placeholder guardian. Creates a
   * platform_family_members row with person_id NULL, status=PLACEHOLDER,
   * and the parent-supplied display fields. No iam_person is created —
   * that comes later via create-account or invite-accept.
   */
  async addPlaceholderMember(
    personId: string,
    dto: AddFamilyMemberDto,
  ): Promise<FamilyMemberDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const id = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members
         (id, family_id, person_id, member_role, is_primary_contact, status,
          first_name, last_name, email, joined_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, NULL, 'PARENT', false, 'PLACEHOLDER',
               $3, $4, $5, now(), now(), now())`,
      id,
      familyId,
      dto.firstName.trim(),
      dto.lastName.trim(),
      dto.email?.trim() || null,
    );
    return this.requireMemberById(id, personId);
  }

  /**
   * PATCH /family/members/:id — edit a PLACEHOLDER or PENDING_INVITE
   * guardian's display fields. ACTIVE rows reject: an ACTIVE
   * INDEPENDENT guardian owns their identity via /profile + their
   * own iam_person row; an ACTIVE MANAGED guardian (created via
   * /family/members/:id/create-account) currently still routes
   * through this same row, but we refuse PATCH here and direct
   * those edits through the child/profile-edit path that already
   * writes both iam_person + the family-members mirror correctly.
   */
  async updateMember(
    personId: string,
    memberId: string,
    dto: UpdateFamilyMemberDto,
  ): Promise<FamilyMemberDto> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      const accessLevel = computeAccessLevel('LINKED', row.managed_by_person_id ?? null, personId);
      if (accessLevel === 'INDEPENDENT') {
        throw new HttpException(
          'This account is managed by the account holder. You can view but not edit their information.',
          HttpStatus.FORBIDDEN,
        );
      }
      throw new BadRequestException(
        'Cannot edit a linked guardian here — edit their profile via /profile instead.',
      );
    }
    const set: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (dto.firstName !== undefined) {
      set.push('first_name = $' + i++);
      args.push(dto.firstName.trim());
    }
    if (dto.lastName !== undefined) {
      set.push('last_name = $' + i++);
      args.push(dto.lastName.trim());
    }
    if (dto.email !== undefined) {
      set.push('email = $' + i++);
      args.push(dto.email ? dto.email.trim() : null);
    }
    if (set.length === 0) return this.toMemberDto(row, personId);
    set.push('updated_at = now()');
    args.push(memberId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_members SET ${set.join(', ')} WHERE id = $${i}::uuid`,
      ...args,
    );
    return this.requireMemberById(memberId, personId);
  }

  /**
   * DELETE /family/members/:id — remove a PLACEHOLDER or
   * PENDING_INVITE guardian. ACTIVE rows reject — leaving the family
   * is the guardian's own decision and lives on a separate unlink
   * surface. Outstanding GUARDIAN_INVITE codes for the row are
   * revoked in the same tx.
   */
  async removeMember(personId: string, memberId: string): Promise<void> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      throw new BadRequestException(
        'Cannot remove a linked guardian. They must leave the family themselves.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE id = $1::uuid`,
        memberId,
      );
    });
  }

  /**
   * POST /family/members/:id/create-account — synthesise an
   * iam_person + platform_users for a PLACEHOLDER guardian and link
   * them. The account lands at PENDING_VERIFICATION; the
   * family_members row is promoted to ACTIVE in the same tx. Refreshes
   * the new guardian's persona cache so PARENT activates on their
   * next sign-in. Returns the updated member.
   */
  async createAccountForMember(
    personId: string,
    memberId: string,
    dto: CreateMemberAccountDto,
  ): Promise<FamilyMemberDto> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      throw new BadRequestException('Member already has an account.');
    }
    const newPersonId = generateId();
    const newAccountId = generateId();
    const email = dto.email?.trim() || row.email || this.syntheticGuardianEmail(newPersonId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.iam_person
           (id, first_name, last_name, person_type, is_active, created_at)
         VALUES ($1::uuid, $2, $3, 'EXTERNAL', true, now())`,
        newPersonId,
        row.first_name ?? '',
        row.last_name ?? '',
      );
      await tx.$executeRawUnsafe(
        // managed_by_person_id = the parent who created the account.
        // This stamps the new guardian's platform_users row as a
        // MANAGED account from the caller's perspective — they're
        // the custodian, and PATCH /family/members/:id will let them
        // through. The new guardian becomes INDEPENDENT relative to
        // other family members.
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type,
            mfa_enabled, is_minor_account, managed_by_person_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING_VERIFICATION', 'HUMAN',
                 false, false, $5::uuid, now())`,
        newAccountId,
        newPersonId,
        email,
        ((row.first_name ?? '') + ' ' + (row.last_name ?? '')).trim() || 'Family member',
        personId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_members
           SET person_id = $1::uuid,
               status = 'ACTIVE',
               invite_code = NULL,
               invite_sent_at = NULL,
               updated_at = now()
         WHERE id = $2::uuid`,
        newPersonId,
        memberId,
      );
    });
    await this.refreshPersonaCacheSafe(newPersonId);
    return this.requireMemberById(memberId, personId);
  }

  /**
   * POST /family/members/:id/send-invite — generate a GUARDIAN_INVITE
   * scoped to this specific placeholder row. metadata.familyMemberId
   * tells acceptGuardianInvite to UPDATE the existing row in place
   * rather than INSERT a fresh one, preserving the parent-typed
   * display name + relationship.
   */
  async sendMemberInvite(
    personId: string,
    memberId: string,
    dto: SendMemberInviteDto,
  ): Promise<FamilyMemberDto> {
    const row = await this.requireOwnedMemberRow(personId, memberId);
    if (row.status === 'ACTIVE') {
      throw new BadRequestException('Member is already linked.');
    }
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    const targetEmail = dto.email?.trim() || row.email || null;
    await this.prisma.$transaction(async (tx) => {
      // Revoke any previous outstanding invite for this row so the
      // old code can't still link after a resend.
      if (row.invite_code) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_invitations
             SET status = 'REVOKED'
           WHERE token = $1 AND status = 'PENDING'`,
          row.invite_code,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_invitations
           (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
         VALUES ($1::uuid, 'GUARDIAN_INVITE', $2, $3::uuid, $4,
                 jsonb_build_object('familyId', $5::text, 'familyMemberId', $6::text),
                 'PENDING', $7::timestamptz, now())`,
        invitationId,
        code,
        personId,
        targetEmail,
        row.family_id,
        memberId,
        expiresAt.toISOString(),
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_members
           SET status = 'PENDING_INVITE',
               invite_code = $1,
               invite_sent_at = now(),
               updated_at = now()
         WHERE id = $2::uuid`,
        code,
        memberId,
      );
    });
    if (targetEmail) {
      // eslint-disable-next-line no-console
      console.log(
        `[guardian-invite-member] member=${memberId} email=${targetEmail} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return this.requireMemberById(memberId, personId);
  }

  /**
   * POST /family/generate-child-code — child generates a CHILD_LINK
   * code with NO familyChildId metadata. The parent who accepts
   * adds this person as a LINKED child in the parent's family
   * (auto-match against PLACEHOLDER if names line up, otherwise
   * fresh row).
   */
  async generateChildCode(personId: string): Promise<GenerateLinkCodeDto> {
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'CHILD_LINK', $2, $3::uuid, NULL,
               'PENDING', $4::timestamptz, now())`,
      invitationId,
      code,
      personId,
      expiresAt.toISOString(),
    );
    return { code, expiresAt: expiresAt.toISOString(), type: 'CHILD_LINK' };
  }

  // ─── Internal accept-flow dispatchers ───────────────────────

  private async acceptParentIssuedChildLink(
    personId: string,
    invitation: { id: string; inviterPersonId: string },
    familyChildId: string,
  ): Promise<FamilyChildDto> {
    const child = await this.findById(familyChildId);
    if (!child || child.status === 'LINKED') {
      // Child was already linked through another flow — 404 so we
      // don't leak the family_child id state.
      throw new NotFoundException('Invalid or expired link code');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_family_children
           SET person_id = $1::uuid,
               status = 'LINKED',
               linked_at = now(),
               updated_at = now()
         WHERE id = $2::uuid`,
        personId,
        familyChildId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_invitations
           SET status = 'ACCEPTED',
               target_person_id = $1::uuid,
               accepted_at = now()
         WHERE id = $2::uuid`,
        personId,
        invitation.id,
      );
    });
    await this.refreshPersonaCacheSafe(invitation.inviterPersonId);
    return this.requireById(familyChildId, personId);
  }

  /**
   * Accept a GUARDIAN_INVITE — add the caller as a co-parent on the
   * inviter's family. Inserts a HEAD_OF_HOUSEHOLD (or upgrades a
   * pre-existing row to is_primary_contact=false) so the new
   * guardian appears alongside the inviter in /family.members[].
   * Refuses if the caller is already a member (idempotent re-accept
   * surfaces as a 400 rather than a UNIQUE-violation).
   */
  private async acceptGuardianInvite(
    personId: string,
    invitation: { id: string; inviterPersonId: string; metadata: unknown },
  ): Promise<FamilyLinkResultDto> {
    const metadata = invitation.metadata as
      | { familyId?: string; familyMemberId?: string }
      | null;
    const familyId = metadata?.familyId;
    const targetMemberId = metadata?.familyMemberId;
    if (!familyId) {
      throw new NotFoundException('Invalid or expired link code');
    }
    if (personId === invitation.inviterPersonId) {
      throw new BadRequestException('You cannot accept your own family code');
    }

    // platform_family_members.person_id is UNIQUE — a person can only
    // be a member of one family. If the caller is already a member of
    // ANY family, refuse with a clear 400.
    const existing = await this.prisma.familyMember.findUnique({
      where: { personId },
      select: { familyId: true },
    });
    if (existing) {
      if (existing.familyId === familyId) {
        throw new BadRequestException('You are already a guardian of this family');
      }
      throw new BadRequestException(
        'You are already a member of another family. Leave that family before joining a new one.',
      );
    }

    // metadata.familyMemberId distinguishes a targeted invite (from
    // /family/members/:id/send-invite, which created a placeholder
    // row and named this member specifically) from an open invite
    // (from /family/invite-guardian, which carries only familyId).
    // Targeted invites UPDATE the existing PLACEHOLDER /
    // PENDING_INVITE row to ACTIVE; open invites INSERT a new row.
    await this.prisma.$transaction(async (tx) => {
      if (targetMemberId) {
        const targetRows = await tx.$queryRawUnsafe<
          Array<{ family_id: string; status: string }>
        >(
          `SELECT family_id::text AS family_id, status
           FROM platform.platform_family_members
           WHERE id = $1::uuid
           LIMIT 1`,
          targetMemberId,
        );
        const target = targetRows[0];
        if (!target || target.family_id !== familyId || target.status === 'ACTIVE') {
          throw new NotFoundException('Invalid or expired link code');
        }
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_members
             SET person_id = $1::uuid,
                 status = 'ACTIVE',
                 invite_code = NULL,
                 invite_sent_at = NULL,
                 joined_at = now(),
                 updated_at = now()
           WHERE id = $2::uuid`,
          personId,
          targetMemberId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_members
             (id, family_id, person_id, member_role, is_primary_contact, status, joined_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', false, 'ACTIVE', now())`,
          generateId(),
          familyId,
          personId,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_invitations
           SET status = 'ACCEPTED', target_person_id = $1::uuid, accepted_at = now()
         WHERE id = $2::uuid`,
        personId,
        invitation.id,
      );
    });
    // The new guardian gains a PARENT persona via /auth/me's
    // resolveForPerson — the cache refresh below kicks that in
    // immediately without waiting for a re-login.
    await this.refreshPersonaCacheSafe(personId);

    const family = await this.prisma.platformFamily.findUnique({
      where: { id: familyId },
      select: { id: true, name: true },
    });
    const inviter = await this.prisma.iamPerson.findUnique({
      where: { id: invitation.inviterPersonId },
      select: { firstName: true, lastName: true, preferredName: true },
    });
    const inviterName = inviter
      ? [inviter.preferredName ?? inviter.firstName, inviter.lastName].filter(Boolean).join(' ')
      : 'a parent';
    const familyHeader: FamilyHeaderDto = { id: family?.id ?? familyId, name: family?.name ?? null };
    return { kind: 'GUARDIAN', family: familyHeader, inviterName };
  }

  private async acceptFamilyInvite(
    personId: string,
    invitation: { id: string; inviterPersonId: string; metadata: unknown },
  ): Promise<FamilyChildDto> {
    const metadata = invitation.metadata as { familyId?: string } | null;
    const familyId = metadata?.familyId;
    if (!familyId) {
      throw new NotFoundException('Invalid or expired link code');
    }
    if (personId === invitation.inviterPersonId) {
      throw new BadRequestException('You cannot accept your own family code');
    }
    const newChildId = await this.upsertLinkedChildRow({
      familyId,
      childPersonId: personId,
      invitationId: invitation.id,
    });
    await this.refreshPersonaCacheSafe(invitation.inviterPersonId);
    return this.requireById(newChildId, personId);
  }

  private async acceptChildIssuedLink(
    personId: string,
    invitation: { id: string; inviterPersonId: string },
  ): Promise<FamilyChildDto> {
    if (personId === invitation.inviterPersonId) {
      throw new BadRequestException('You cannot accept your own family code');
    }
    const familyId = await this.ensureFamilyForPerson(personId);
    const newChildId = await this.upsertLinkedChildRow({
      familyId,
      childPersonId: invitation.inviterPersonId,
      invitationId: invitation.id,
      accepterPersonId: personId,
    });
    // The CALLER is the parent here; refresh their persona cache.
    await this.refreshPersonaCacheSafe(personId);
    return this.requireById(newChildId, personId);
  }

  /**
   * Shared write path for both FAMILY_INVITE and child-issued
   * CHILD_LINK accepts. Auto-matches a same-name PLACEHOLDER row in
   * the target family; if none (or multiple — ambiguous), creates a
   * fresh LINKED row using the child's iam_person identity.
   *
   * Refuses the write if a family_children row already exists for
   * (familyId, childPersonId) so re-accepting an already-LINKED code
   * surfaces as a clean 409 rather than a UNIQUE-constraint error.
   *
   * Returns the family_children id (existing PLACEHOLDER or
   * newly-inserted) so the caller can refetch the row for the
   * response.
   */
  private async upsertLinkedChildRow(opts: {
    familyId: string;
    childPersonId: string;
    invitationId: string;
    accepterPersonId?: string;
  }): Promise<string> {
    const { familyId, childPersonId, invitationId, accepterPersonId } = opts;

    const existing = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id
       FROM platform.platform_family_children
       WHERE family_id = $1::uuid AND person_id = $2::uuid
       LIMIT 1`,
      familyId,
      childPersonId,
    );
    if (existing.length > 0) {
      throw new BadRequestException('This person is already linked to the family');
    }

    const child = await this.prisma.iamPerson.findUnique({
      where: { id: childPersonId },
      select: {
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        // gender lives on sis_student_demographics, not iam_person —
        // leave NULL on the family_children row and let the parent
        // edit it through the wizard if it matters.
      },
    });
    if (!child) {
      throw new NotFoundException('Invalid or expired link code');
    }

    const placeholder = await this.findMatchingPlaceholder(
      familyId,
      child.firstName,
      child.lastName,
    );
    const dob = child.dateOfBirth ? child.dateOfBirth.toISOString().slice(0, 10) : null;
    const newId = placeholder?.id ?? generateId();
    const targetPersonForInvitation = accepterPersonId ?? childPersonId;

    await this.prisma.$transaction(async (tx) => {
      if (placeholder) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.platform_family_children
             SET person_id = $1::uuid,
                 status = 'LINKED',
                 linked_at = now(),
                 updated_at = now()
           WHERE id = $2::uuid`,
          childPersonId,
          placeholder.id,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_children
             (id, family_id, person_id, first_name, last_name, date_of_birth, gender,
              status, linked_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, NULL,
                   'LINKED', now(), now())`,
          newId,
          familyId,
          childPersonId,
          child.firstName,
          child.lastName,
          dob,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_invitations
           SET status = 'ACCEPTED',
               target_person_id = $1::uuid,
               accepted_at = now()
         WHERE id = $2::uuid`,
        targetPersonForInvitation,
        invitationId,
      );
    });

    return newId;
  }

  private async findMatchingPlaceholder(
    familyId: string,
    firstName: string,
    lastName: string,
  ): Promise<{ id: string } | null> {
    // Case-insensitive exact-match on first + last. If 0 or 2+ rows
    // match we return null and let the caller create a fresh row;
    // ambiguity is safer to resolve by adding a new row than by
    // guessing which placeholder the parent meant.
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id
       FROM platform.platform_family_children
       WHERE family_id = $1::uuid
         AND status = 'PLACEHOLDER'
         AND lower(first_name) = lower($2)
         AND lower(last_name) = lower($3)
       LIMIT 2`,
      familyId,
      firstName.trim(),
      lastName.trim(),
    );
    return rows.length === 1 ? rows[0]! : null;
  }

  // ─── helpers ───────────────────────────────────────────────

  private async findFamilyForPerson(personId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id
       FROM platform.platform_family_members
       WHERE person_id = $1::uuid
       LIMIT 1`,
      personId,
    );
    return rows[0]?.family_id ?? null;
  }

  /**
   * Resolve the caller's family, creating one on demand if registration
   * didn't seed it. Idempotent — concurrent callers race on the UNIQUE
   * (family_id, person_id) constraint, so the loser falls back to the
   * existing row.
   */
  private async ensureFamilyForPerson(personId: string): Promise<string> {
    const existing = await this.findFamilyForPerson(personId);
    if (existing) return existing;
    const familyId = generateId();
    const memberId = generateId();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_families (id, name, home_language, mailing_address_same)
           VALUES ($1::uuid, NULL, 'en', true)`,
          familyId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_members
             (id, family_id, person_id, member_role, is_primary_contact, joined_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', true, now())`,
          memberId,
          familyId,
          personId,
        );
      });
      return familyId;
    } catch {
      // Lost the race — another concurrent call seeded the family.
      const fallback = await this.findFamilyForPerson(personId);
      if (!fallback) {
        throw new HttpException(
          'Could not resolve family for current user',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      return fallback;
    }
  }

  private async requireOwnedRow(personId: string, childId: string): Promise<FamilyChildRow> {
    const familyId = await this.findFamilyForPerson(personId);
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.id = $1::uuid',
      childId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Family child not found');
    if (!familyId || row.family_id !== familyId) {
      // Don't leak the existence of another family's child row.
      throw new NotFoundException('Family child not found');
    }
    return row;
  }

  private async requireById(childId: string, viewerPersonId: string): Promise<FamilyChildDto> {
    const row = await this.findById(childId);
    if (!row) throw new NotFoundException('Family child not found');
    return this.toDto(row, viewerPersonId);
  }

  private async findById(childId: string): Promise<FamilyChildRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.id = $1::uuid',
      childId,
    );
    return rows[0] ?? null;
  }

  /**
   * LEFT JOIN iam_person so LINKED rows surface the canonical identity
   * fields (middle_name / preferred_name / primary_phone / notes) that
   * don't have mirror columns on platform_family_children. For
   * first_name / last_name / date_of_birth — which DO have mirrors —
   * we COALESCE to the iam_person value first so a stale mirror (e.g.
   * after an out-of-band iam_person edit) doesn't shadow the
   * canonical name. PLACEHOLDER rows have person_id IS NULL so the
   * LEFT JOIN produces NULL columns and the COALESCE falls back to
   * the placeholder values.
   *
   * Required for the parent-edit form to round-trip middle_name /
   * preferred_name / phone / notes — the form's useEffect re-seeds
   * from this DTO after every save, so anything not on the wire
   * silently disappears from the inputs.
   */
  private selectSql(): string {
    return (
      'SELECT pfc.id::text AS id, ' +
      '  pfc.family_id::text AS family_id, ' +
      '  pfc.person_id::text AS person_id, ' +
      '  COALESCE(p.first_name, pfc.first_name) AS first_name, ' +
      '  COALESCE(p.middle_name, pfc.middle_name) AS middle_name, ' +
      '  COALESCE(p.last_name, pfc.last_name) AS last_name, ' +
      '  COALESCE(p.preferred_name, pfc.preferred_name) AS preferred_name, ' +
      '  COALESCE(p.date_of_birth::text, pfc.date_of_birth::text) AS date_of_birth, ' +
      '  pfc.gender AS gender, ' +
      '  p.primary_phone AS primary_phone, ' +
      '  p.notes AS notes, ' +
      '  pfc.status, ' +
      '  pfc.invite_code, pfc.invite_email, ' +
      '  pfc.invite_sent_at::text AS invite_sent_at, ' +
      '  pfc.linked_at::text AS linked_at, ' +
      '  pfc.created_at::text AS created_at, ' +
      '  pu.managed_by_person_id::text AS managed_by_person_id ' +
      'FROM platform.platform_family_children pfc ' +
      'LEFT JOIN platform.iam_person p ON p.id = pfc.person_id ' +
      'LEFT JOIN platform.platform_users pu ON pu.person_id = pfc.person_id '
    );
  }

  private toDto(r: FamilyChildRow, viewerPersonId: string): FamilyChildDto {
    return {
      id: r.id,
      familyId: r.family_id,
      personId: r.person_id,
      firstName: r.first_name,
      middleName: r.middle_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      dateOfBirth: r.date_of_birth,
      gender: r.gender,
      primaryPhone: r.primary_phone,
      notes: r.notes,
      status: r.status as FamilyChildDto['status'],
      accessLevel: computeAccessLevel(r.status, r.managed_by_person_id, viewerPersonId),
      inviteCode: r.invite_code,
      inviteEmail: r.invite_email,
      inviteSentAt: r.invite_sent_at,
      linkedAt: r.linked_at,
      createdAt: r.created_at,
    };
  }

  /**
   * Generate an 8-char uppercase alphanumeric code using crypto.randomInt
   * (uniform distribution — NOT crypto.randomBytes + modulo, which biases
   * the alphabet). Token space = 36^8 ≈ 2.8 trillion combos.
   */
  private generateLinkCode(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += alphabet[randomInt(0, alphabet.length)];
    }
    return out;
  }

  private syntheticChildEmail(personId: string): string {
    // Stable per child so re-creation conflicts surface as 409 rather
    // than mutating an unrelated user. Domain is the unroutable .invalid
    // TLD so nothing ever sends mail here by accident.
    const suffix = randomBytes(4).toString('hex');
    return `child-${personId.slice(-6)}-${suffix}@minor.invalid`;
  }

  private syntheticGuardianEmail(personId: string): string {
    // Same .invalid pattern as the child synthetic email, but with a
    // distinct prefix so log greps + DB exports can tell them apart.
    const suffix = randomBytes(4).toString('hex');
    return `guardian-${personId.slice(-6)}-${suffix}@external.invalid`;
  }

  // ─── Member-row helpers ────────────────────────────────────

  /**
   * Raw shape of a platform_family_members row used by the placeholder
   * member mutations. Mirrors the column list — keeps the surface
   * away from Prisma since most of these writes are $executeRawUnsafe
   * and we don't want partial Prisma model exposure leaking into
   * service callers.
   */
  // (declared inside `private`-method block for proximity to use)
  private async requireOwnedMemberRow(
    personId: string,
    memberId: string,
  ): Promise<{
    id: string;
    family_id: string;
    person_id: string | null;
    member_role: string;
    is_primary_contact: boolean;
    status: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    invite_code: string | null;
    invite_sent_at: string | null;
    managed_by_person_id: string | null;
  }> {
    const familyId = await this.findFamilyForPerson(personId);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        family_id: string;
        person_id: string | null;
        member_role: string;
        is_primary_contact: boolean;
        status: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        invite_code: string | null;
        invite_sent_at: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT pfm.id::text AS id, pfm.family_id::text AS family_id,
              pfm.person_id::text AS person_id,
              pfm.member_role::text AS member_role, pfm.is_primary_contact,
              pfm.status, pfm.first_name, pfm.last_name, pfm.email,
              pfm.invite_code, pfm.invite_sent_at::text AS invite_sent_at,
              pu.managed_by_person_id::text AS managed_by_person_id
       FROM platform.platform_family_members pfm
       LEFT JOIN platform.platform_users pu ON pu.person_id = pfm.person_id
       WHERE pfm.id = $1::uuid`,
      memberId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Family member not found');
    // Cross-family isolation: refuse if the row's family doesn't
    // match the caller's. Return 404 (not 403) so we don't leak the
    // existence of another family's member row.
    if (!familyId || row.family_id !== familyId) {
      throw new NotFoundException('Family member not found');
    }
    return row;
  }

  private async requireMemberById(memberId: string, viewerPersonId?: string): Promise<FamilyMemberDto> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        person_id: string | null;
        first_name: string | null;
        last_name: string | null;
        preferred_name: string | null;
        email: string | null;
        member_role: string;
        is_primary_contact: boolean;
        status: string;
        invite_code: string | null;
        invite_sent_at: string | null;
        managed_by_person_id: string | null;
      }>
    >(
      `SELECT pfm.id::text AS id,
              pfm.person_id::text AS person_id,
              COALESCE(p.first_name, pfm.first_name) AS first_name,
              COALESCE(p.last_name, pfm.last_name) AS last_name,
              p.preferred_name AS preferred_name,
              pfm.email AS email,
              pfm.member_role::text AS member_role,
              pfm.is_primary_contact,
              pfm.status,
              pfm.invite_code,
              pfm.invite_sent_at::text AS invite_sent_at,
              pu.managed_by_person_id::text AS managed_by_person_id
       FROM platform.platform_family_members pfm
       LEFT JOIN platform.iam_person p ON p.id = pfm.person_id
       LEFT JOIN platform.platform_users pu ON pu.person_id = pfm.person_id
       WHERE pfm.id = $1::uuid`,
      memberId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Family member not found');
    return {
      id: row.id,
      personId: row.person_id,
      firstName: row.first_name ?? '',
      lastName: row.last_name ?? '',
      preferredName: row.preferred_name,
      email: row.email,
      memberRole: row.member_role,
      isPrimaryContact: row.is_primary_contact,
      isCurrentUser: row.person_id !== null && row.person_id === viewerPersonId,
      status: row.status as FamilyMemberDto['status'],
      accessLevel: computeAccessLevel(
        row.status === 'ACTIVE' ? 'LINKED' : row.status,
        row.managed_by_person_id,
        viewerPersonId ?? '',
      ),
      inviteCode: row.invite_code,
      inviteSentAt: row.invite_sent_at,
    };
  }

  private toMemberDto(
    row: {
      id: string;
      person_id: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      member_role: string;
      is_primary_contact: boolean;
      status: string;
      invite_code: string | null;
      invite_sent_at: string | null;
    },
    viewerPersonId?: string,
  ): FamilyMemberDto {
    return {
      id: row.id,
      personId: row.person_id,
      firstName: row.first_name ?? '',
      lastName: row.last_name ?? '',
      preferredName: null,
      email: row.email,
      memberRole: row.member_role,
      isPrimaryContact: row.is_primary_contact,
      isCurrentUser: row.person_id !== null && row.person_id === viewerPersonId,
      status: row.status as FamilyMemberDto['status'],
      // toMemberDto is only called from updateMember after a no-op
      // PATCH (no fields supplied), where the row was loaded via
      // requireOwnedMemberRow which doesn't fetch managed_by. The
      // call site has already passed assertNotChildViewer + the
      // ACTIVE-reject guard, so the access level here is purely
      // informational — be conservative and report PLACEHOLDER for
      // non-ACTIVE, INDEPENDENT for ACTIVE.
      accessLevel:
        row.status === 'ACTIVE' ? 'INDEPENDENT' : 'PLACEHOLDER',
      inviteCode: row.invite_code,
      inviteSentAt: row.invite_sent_at,
    };
  }

  private async assertLinkRateLimit(accountId: string): Promise<void> {
    const key = `family:link-attempts:${accountId}`;
    const count = await this.redis.incrementCounter(key, 1, LINK_ATTEMPTS_WINDOW_SECONDS);
    if (count > LINK_ATTEMPTS_LIMIT) {
      throw new HttpException(
        'Too many link-code attempts; try again in a few minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async refreshPersonaCacheSafe(personId: string): Promise<void> {
    try {
      await this.personaResolution.refreshPersonaCache(personId);
    } catch (e: any) {
      // Cache refresh is best-effort — the next /auth/me read can re-resolve.
      // eslint-disable-next-line no-console
      console.warn('[family-children] persona cache refresh failed: ' + (e?.message || e));
    }
  }

  // ─── Child medical / emergency / dietary ───────────────────
  //
  // TODO: sync platform medical/emergency/dietary to tenant tables
  // on enrolment. When sis_students is created for the linked
  // person, a worker reads these three platform tables + seeds
  // hlth_health_records / sis_emergency_contacts / fds_dietary_
  // restrictions and flips the source-of-truth from platform →
  // tenant. Until that worker ships, these endpoints are the only
  // surface and platform_child_* are authoritative.

  /**
   * Refuses every child-section endpoint when the row isn't a
   * LINKED child of the caller's family. requireOwnedRow already
   * enforces cross-family isolation; this helper layers on the
   * LINKED check (no iam_person → no row to attach medical info to).
   * Returns the resolved family_id so callers can stamp it onto the
   * new row without a second query.
   */
  private async requireLinkedChildOwned(
    personId: string,
    childId: string,
  ): Promise<{ familyId: string; personId: string }> {
    const row = await this.requireOwnedRow(personId, childId);
    if (row.status !== 'LINKED' || !row.person_id) {
      throw new BadRequestException(
        'This action requires a linked CampusOS account. Create the account first.',
      );
    }
    return { familyId: row.family_id, personId: row.person_id };
  }

  async getChildMedical(callerPersonId: string, childId: string): Promise<ChildMedicalInfoDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const row = await this.prisma.platformChildMedicalInfo.findUnique({
      where: { personId },
    });
    return this.toMedicalDto(personId, row);
  }

  async updateChildMedical(
    callerPersonId: string,
    childId: string,
    dto: UpdateChildMedicalInfoDto,
  ): Promise<ChildMedicalInfoDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const upsertId = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_child_medical_info
         (id, person_id, family_id, allergies, medications, conditions,
          doctor_name, doctor_phone, doctor_clinic,
          insurance_provider, insurance_policy, insurance_group,
          blood_type, medical_notes)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               COALESCE($4::jsonb, '[]'::jsonb),
               COALESCE($5::jsonb, '[]'::jsonb),
               COALESCE($6::jsonb, '[]'::jsonb),
               $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (person_id) DO UPDATE SET
         allergies = COALESCE(EXCLUDED.allergies, platform_child_medical_info.allergies),
         medications = COALESCE(EXCLUDED.medications, platform_child_medical_info.medications),
         conditions = COALESCE(EXCLUDED.conditions, platform_child_medical_info.conditions),
         doctor_name = COALESCE($7, platform_child_medical_info.doctor_name),
         doctor_phone = COALESCE($8, platform_child_medical_info.doctor_phone),
         doctor_clinic = COALESCE($9, platform_child_medical_info.doctor_clinic),
         insurance_provider = COALESCE($10, platform_child_medical_info.insurance_provider),
         insurance_policy = COALESCE($11, platform_child_medical_info.insurance_policy),
         insurance_group = COALESCE($12, platform_child_medical_info.insurance_group),
         blood_type = COALESCE($13, platform_child_medical_info.blood_type),
         medical_notes = COALESCE($14, platform_child_medical_info.medical_notes),
         updated_at = now()`,
      upsertId,
      personId,
      familyId,
      dto.allergies !== undefined ? JSON.stringify(dto.allergies) : null,
      dto.medications !== undefined ? JSON.stringify(dto.medications) : null,
      dto.conditions !== undefined ? JSON.stringify(dto.conditions) : null,
      dto.doctorName ?? null,
      dto.doctorPhone ?? null,
      dto.doctorClinic ?? null,
      dto.insuranceProvider ?? null,
      dto.insurancePolicy ?? null,
      dto.insuranceGroup ?? null,
      dto.bloodType ?? null,
      dto.medicalNotes ?? null,
    );
    return this.getChildMedical(callerPersonId, childId);
  }

  private toMedicalDto(
    personId: string,
    row: {
      allergies: unknown;
      medications: unknown;
      conditions: unknown;
      doctorName: string | null;
      doctorPhone: string | null;
      doctorClinic: string | null;
      insuranceProvider: string | null;
      insurancePolicy: string | null;
      insuranceGroup: string | null;
      bloodType: string | null;
      medicalNotes: string | null;
    } | null,
  ): ChildMedicalInfoDto {
    if (!row) {
      // Don't write an empty row eagerly — the upsert path handles
      // first-write. Returning the empty shape lets the form render
      // without an explicit 404 case.
      return {
        personId,
        allergies: [],
        medications: [],
        conditions: [],
        doctorName: null,
        doctorPhone: null,
        doctorClinic: null,
        insuranceProvider: null,
        insurancePolicy: null,
        insuranceGroup: null,
        bloodType: null,
        medicalNotes: null,
      };
    }
    return {
      personId,
      allergies: Array.isArray(row.allergies) ? (row.allergies as ChildAllergyEntry[]) : [],
      medications: Array.isArray(row.medications)
        ? (row.medications as ChildMedicationEntry[])
        : [],
      conditions: Array.isArray(row.conditions) ? (row.conditions as ChildConditionEntry[]) : [],
      doctorName: row.doctorName,
      doctorPhone: row.doctorPhone,
      doctorClinic: row.doctorClinic,
      insuranceProvider: row.insuranceProvider,
      insurancePolicy: row.insurancePolicy,
      insuranceGroup: row.insuranceGroup,
      bloodType: row.bloodType,
      medicalNotes: row.medicalNotes,
    };
  }

  // ─── Emergency contacts ────────────────────────────────────

  async listChildEmergencyContacts(
    callerPersonId: string,
    childId: string,
  ): Promise<ChildEmergencyContactDto[]> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const rows = await this.prisma.platformChildEmergencyContact.findMany({
      where: { personId },
      orderBy: [{ priorityOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(this.toEmergencyDto);
  }

  async addChildEmergencyContact(
    callerPersonId: string,
    childId: string,
    dto: AddChildEmergencyContactDto,
  ): Promise<ChildEmergencyContactDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const id = generateId();
    try {
      await this.prisma.platformChildEmergencyContact.create({
        data: {
          id,
          personId,
          familyId,
          name: dto.name.trim(),
          relationship: dto.relationship.trim(),
          phonePrimary: dto.phonePrimary.trim(),
          phoneAlternate: dto.phoneAlternate?.trim() || null,
          email: dto.email?.trim() || null,
          authorizedPickup: dto.authorizedPickup ?? false,
          priorityOrder: dto.priorityOrder ?? 0,
        },
      });
    } catch (e: any) {
      // UNIQUE (person_id, phone_primary)
      if (e?.meta?.code === '23505' || /unique constraint/i.test(String(e))) {
        throw new ConflictException(
          'A contact with that primary phone number already exists for this child.',
        );
      }
      throw e;
    }
    const row = await this.prisma.platformChildEmergencyContact.findUnique({ where: { id } });
    return this.toEmergencyDto(row!);
  }

  async updateChildEmergencyContact(
    callerPersonId: string,
    childId: string,
    contactId: string,
    dto: UpdateChildEmergencyContactDto,
  ): Promise<ChildEmergencyContactDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformChildEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Emergency contact not found');
    }
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.relationship !== undefined) patch.relationship = dto.relationship.trim();
    if (dto.phonePrimary !== undefined) patch.phonePrimary = dto.phonePrimary.trim();
    if (dto.phoneAlternate !== undefined)
      patch.phoneAlternate = dto.phoneAlternate ? dto.phoneAlternate.trim() : null;
    if (dto.email !== undefined) patch.email = dto.email ? dto.email.trim() : null;
    if (dto.authorizedPickup !== undefined) patch.authorizedPickup = dto.authorizedPickup;
    if (dto.priorityOrder !== undefined) patch.priorityOrder = dto.priorityOrder;
    if (Object.keys(patch).length === 0) return this.toEmergencyDto(existing);
    patch.updatedAt = new Date();
    const updated = await this.prisma.platformChildEmergencyContact.update({
      where: { id: contactId },
      data: patch,
    });
    return this.toEmergencyDto(updated);
  }

  async removeChildEmergencyContact(
    callerPersonId: string,
    childId: string,
    contactId: string,
  ): Promise<void> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const existing = await this.prisma.platformChildEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.personId !== personId) {
      throw new NotFoundException('Emergency contact not found');
    }
    await this.prisma.platformChildEmergencyContact.delete({ where: { id: contactId } });
  }

  private toEmergencyDto(row: {
    id: string;
    name: string;
    relationship: string;
    phonePrimary: string;
    phoneAlternate: string | null;
    email: string | null;
    authorizedPickup: boolean;
    priorityOrder: number;
  }): ChildEmergencyContactDto {
    return {
      id: row.id,
      name: row.name,
      relationship: row.relationship,
      phonePrimary: row.phonePrimary,
      phoneAlternate: row.phoneAlternate,
      email: row.email,
      authorizedPickup: row.authorizedPickup,
      priorityOrder: row.priorityOrder,
    };
  }

  // ─── Dietary ───────────────────────────────────────────────

  async getChildDietary(callerPersonId: string, childId: string): Promise<ChildDietaryInfoDto> {
    const { personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const row = await this.prisma.platformChildDietaryInfo.findUnique({ where: { personId } });
    return this.toDietaryDto(personId, row);
  }

  async updateChildDietary(
    callerPersonId: string,
    childId: string,
    dto: UpdateChildDietaryInfoDto,
  ): Promise<ChildDietaryInfoDto> {
    const { familyId, personId } = await this.requireLinkedChildOwned(callerPersonId, childId);
    const upsertId = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_child_dietary_info
         (id, person_id, family_id, dietary_type, food_allergies,
          additional_restrictions, meal_preference)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               COALESCE($4, 'NONE'),
               COALESCE($5::jsonb, '[]'::jsonb),
               $6, $7)
       ON CONFLICT (person_id) DO UPDATE SET
         dietary_type = COALESCE($4, platform_child_dietary_info.dietary_type),
         food_allergies = COALESCE(EXCLUDED.food_allergies, platform_child_dietary_info.food_allergies),
         additional_restrictions = COALESCE($6, platform_child_dietary_info.additional_restrictions),
         meal_preference = COALESCE($7, platform_child_dietary_info.meal_preference),
         updated_at = now()`,
      upsertId,
      personId,
      familyId,
      dto.dietaryType ?? null,
      dto.foodAllergies !== undefined ? JSON.stringify(dto.foodAllergies) : null,
      dto.additionalRestrictions ?? null,
      dto.mealPreference ?? null,
    );
    return this.getChildDietary(callerPersonId, childId);
  }

  private toDietaryDto(
    personId: string,
    row: {
      dietaryType: string;
      foodAllergies: unknown;
      additionalRestrictions: string | null;
      mealPreference: string | null;
    } | null,
  ): ChildDietaryInfoDto {
    if (!row) {
      return {
        personId,
        dietaryType: 'NONE',
        foodAllergies: [],
        additionalRestrictions: null,
        mealPreference: null,
      };
    }
    return {
      personId,
      dietaryType: row.dietaryType as ChildDietaryInfoDto['dietaryType'],
      foodAllergies: Array.isArray(row.foodAllergies)
        ? (row.foodAllergies as ChildFoodAllergyEntry[])
        : [],
      additionalRestrictions: row.additionalRestrictions,
      mealPreference: row.mealPreference,
    };
  }
}

function ageInYears(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
