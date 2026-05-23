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
  SendChildLinkDto,
  UpdateFamilyChildDto,
} from './dto/family-child.dto';

interface FamilyChildRow {
  id: string;
  family_id: string;
  person_id: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  gender: string | null;
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

  // ─── CRUD (Step 5) ─────────────────────────────────────────

  async listForUser(personId: string): Promise<FamilyChildDto[]> {
    const familyId = await this.findFamilyForPerson(personId);
    if (!familyId) return [];
    const rows = await this.prisma.$queryRawUnsafe<FamilyChildRow[]>(
      this.selectSql() + 'WHERE family_id = $1::uuid ORDER BY created_at ASC',
      familyId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(personId: string, dto: CreateFamilyChildDto): Promise<FamilyChildDto> {
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
    if (row.status === 'LINKED') {
      throw new BadRequestException(
        'Cannot edit a LINKED child — name comes from iam_person; use the profile API',
      );
    }
    const set: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (dto.firstName !== undefined) {
      set.push('first_name = $' + i++);
      args.push(dto.firstName);
    }
    if (dto.lastName !== undefined) {
      set.push('last_name = $' + i++);
      args.push(dto.lastName);
    }
    if (dto.dateOfBirth !== undefined) {
      set.push('date_of_birth = $' + i++ + '::date');
      args.push(dto.dateOfBirth);
    }
    if (dto.gender !== undefined) {
      set.push('gender = $' + i++);
      args.push(dto.gender);
    }
    if (set.length === 0) return this.toDto(row);
    set.push('updated_at = now()');
    args.push(childId);
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children SET ${set.join(', ')} WHERE id = $${i}::uuid`,
      ...args,
    );
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
   * POST /family/link — accept a child-link invitation as the child or
   * a second parent. Validates code, rate-limits per caller, and
   * stamps the platform_family_children row + the invitation row in
   * one tx. On success refreshes the INVITER's persona cache.
   */
  async acceptLinkCode(
    personId: string,
    accountId: string,
    dto: AcceptFamilyLinkDto,
  ): Promise<FamilyChildDto> {
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
      invitation.type !== 'CHILD_LINK' ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException('Invalid or expired link code');
    }

    const metadata = invitation.metadata as { familyChildId?: string } | null;
    const familyChildId = metadata?.familyChildId;
    if (!familyChildId) {
      throw new NotFoundException('Invalid or expired link code');
    }

    const child = await this.findById(familyChildId);
    if (!child || child.status === 'LINKED') {
      // Child was already linked through another flow — return 404 to
      // avoid leaking the family_child id state.
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
      this.selectSql() + 'WHERE id = $1::uuid',
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
      this.selectSql() + 'WHERE id = $1::uuid',
      childId,
    );
    return rows[0] ?? null;
  }

  private selectSql(): string {
    return (
      'SELECT id::text AS id, family_id::text AS family_id, person_id::text AS person_id, ' +
      'first_name, last_name, date_of_birth::text AS date_of_birth, gender, status, ' +
      'invite_code, invite_email, invite_sent_at::text AS invite_sent_at, ' +
      'linked_at::text AS linked_at, created_at::text AS created_at ' +
      'FROM platform.platform_family_children '
    );
  }

  private toDto(r: FamilyChildRow): FamilyChildDto {
    return {
      id: r.id,
      familyId: r.family_id,
      personId: r.person_id,
      firstName: r.first_name,
      lastName: r.last_name,
      dateOfBirth: r.date_of_birth,
      gender: r.gender,
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
