import {
  BadRequestException,
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
  CreateChildAccountDto,
  CreateFamilyChildDto,
  FamilyChildDto,
  FamilyHeaderDto,
  FamilyLinkResultDto,
  FamilyMemberDto,
  FamilyViewDto,
  FamilyViewerRole,
  GenerateLinkCodeDto,
  InviteGuardianDto,
  SendChildLinkDto,
  UpdateFamilyChildDto,
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

    const memberRows = await this.prisma.$queryRawUnsafe<
      Array<{
        person_id: string;
        first_name: string;
        last_name: string;
        preferred_name: string | null;
        member_role: string;
        is_primary_contact: boolean;
      }>
    >(
      `SELECT pfm.person_id::text AS person_id,
              p.first_name,
              p.last_name,
              p.preferred_name,
              pfm.member_role::text AS member_role,
              pfm.is_primary_contact
       FROM platform.platform_family_members pfm
       JOIN platform.iam_person p ON p.id = pfm.person_id
       WHERE pfm.family_id = $1::uuid
       ORDER BY pfm.is_primary_contact DESC, pfm.joined_at ASC`,
      resolved.familyId,
    );
    const members: FamilyMemberDto[] = memberRows.map((r) => ({
      personId: r.person_id,
      firstName: r.first_name,
      lastName: r.last_name,
      preferredName: r.preferred_name,
      memberRole: r.member_role,
      isPrimaryContact: r.is_primary_contact,
      isCurrentUser: r.person_id === personId,
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
      children: childRows.map((r) => this.toDto(r)),
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

  // ─── CRUD (Step 5) ─────────────────────────────────────────

  async listForUser(personId: string): Promise<FamilyChildDto[]> {
    const familyId = await this.findFamilyForPerson(personId);
    if (!familyId) return [];
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE pfc.family_id = $1::uuid ORDER BY pfc.created_at ASC',
      familyId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(personId: string, dto: CreateFamilyChildDto): Promise<FamilyChildDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const id = generateId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_children
         (id, family_id, person_id, first_name, last_name, date_of_birth, gender, status, created_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $4, $5::date, $6, 'PLACEHOLDER', now())`,
      id,
      familyId,
      dto.firstName,
      dto.lastName,
      dto.dateOfBirth ?? null,
      dto.gender ?? null,
    );
    return this.requireById(id);
  }

  async update(
    personId: string,
    childId: string,
    dto: UpdateFamilyChildDto,
  ): Promise<FamilyChildDto> {
    const row = await this.requireOwnedRow(personId, childId);

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
    if (dto.lastName !== undefined) {
      childSet.push('last_name = $' + ci++);
      childArgs.push(dto.lastName);
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
      return this.toDto(row);
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
    return this.requireById(childId);
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
    return this.requireById(childId);
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
    return this.requireById(childId);
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

    return this.requireById(childId);
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
  async generateFamilyCode(personId: string): Promise<GenerateLinkCodeDto> {
    await this.assertNotChildViewer(personId);
    const familyId = await this.ensureFamilyForPerson(personId);
    const code = this.generateLinkCode();
    const invitationId = generateId();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_HOURS * 3600 * 1000);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'FAMILY_INVITE', $2, $3::uuid,
               jsonb_build_object('familyId', $4::text),
               'PENDING', $5::timestamptz, now())`,
      invitationId,
      code,
      personId,
      familyId,
      expiresAt.toISOString(),
    );
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
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata, status, expires_at, created_at)
       VALUES ($1::uuid, 'GUARDIAN_INVITE', $2, $3::uuid, $4,
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
        `[guardian-invite] family=${familyId} email=${dto.email} code=${code} expires=${expiresAt.toISOString()}`,
      );
    }
    return { code, expiresAt: expiresAt.toISOString(), type: 'GUARDIAN_INVITE' };
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
    return this.requireById(familyChildId);
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
    const metadata = invitation.metadata as { familyId?: string } | null;
    const familyId = metadata?.familyId;
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

    const memberId = generateId();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_members
           (id, family_id, person_id, member_role, is_primary_contact, joined_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', false, now())`,
        memberId,
        familyId,
        personId,
      );
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
    return this.requireById(newChildId);
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
    return this.requireById(newChildId);
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

  private async requireById(childId: string): Promise<FamilyChildDto> {
    const row = await this.findById(childId);
    if (!row) throw new NotFoundException('Family child not found');
    return this.toDto(row);
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
      '  p.middle_name AS middle_name, ' +
      '  COALESCE(p.last_name, pfc.last_name) AS last_name, ' +
      '  p.preferred_name AS preferred_name, ' +
      '  COALESCE(p.date_of_birth::text, pfc.date_of_birth::text) AS date_of_birth, ' +
      '  pfc.gender AS gender, ' +
      '  p.primary_phone AS primary_phone, ' +
      '  p.notes AS notes, ' +
      '  pfc.status, ' +
      '  pfc.invite_code, pfc.invite_email, ' +
      '  pfc.invite_sent_at::text AS invite_sent_at, ' +
      '  pfc.linked_at::text AS linked_at, ' +
      '  pfc.created_at::text AS created_at ' +
      'FROM platform.platform_family_children pfc ' +
      'LEFT JOIN platform.iam_person p ON p.id = pfc.person_id '
    );
  }

  private toDto(r: FamilyChildRow): FamilyChildDto {
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
