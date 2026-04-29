import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

type TxClient = Prisma.TransactionClient;
import { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  AddHouseholdMemberDto,
  HouseholdDto,
  HouseholdMemberDto,
  HouseholdRole,
  UpdateHouseholdDto,
  UpdateHouseholdMemberDto,
} from './dto/household.dto';

interface FamilyRow {
  id: string;
  name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  home_phone: string | null;
  home_language: string;
  mailing_address_same: boolean;
  mailing_line1: string | null;
  mailing_line2: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_postal_code: string | null;
  mailing_country: string | null;
  notes: string | null;
}

interface MemberRow {
  id: string;
  family_id: string;
  person_id: string;
  member_role: string;
  is_primary_contact: boolean;
  joined_at: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
}

const EDIT_ROLES: ReadonlyArray<HouseholdRole> = ['HEAD_OF_HOUSEHOLD', 'SPOUSE'];

/**
 * HouseholdsService — Profile and Household Mini-Cycle Step 6.
 *
 * All writes target platform-schema tables (platform_families,
 * platform_family_members) and so use REGULAR Prisma transactions, NOT
 * executeInTenantTransaction. The tenant search_path is irrelevant for
 * platform writes; SET LOCAL there would be wasted overhead and could
 * mask a real bug.
 *
 * Authorisation gate is role-based, not IAM-permission-based: the
 * caller must hold one of HEAD_OF_HOUSEHOLD or SPOUSE in the household
 * being mutated, OR have usr-001:admin (school admin / platform admin
 * override). The endpoint-level @RequirePermission(usr-001:write) is a
 * coarse gate; assertCanEditHousehold is the real one.
 *
 * Concurrency: every state-change opens a $transaction and runs SELECT
 * ... FOR UPDATE on platform_families.id BEFORE reading the membership
 * for the gate check. Two simultaneous "promote me to primary contact"
 * clicks serialise on that lock; the partial UNIQUE INDEX on
 * (family_id) WHERE is_primary_contact = true (Step 1) is the
 * schema-side belt-and-braces.
 */
@Injectable()
export class HouseholdsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly perms: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /** GET /households/my — composed read for the calling actor. */
  async getMyHousehold(actor: ResolvedActor): Promise<HouseholdDto | null> {
    const familyRow = await this.loadFamilyForPerson(actor.personId);
    if (!familyRow) return null;
    const members = await this.loadMembers(familyRow.id);
    const canEdit = await this.canEdit(familyRow.id, actor);
    return this.toDto(familyRow, members, canEdit);
  }

  /**
   * GET /households/:id — only callable by a member of the household
   * OR an admin. We don't expose arbitrary other-household details
   * even to authenticated users; row scope is the security boundary.
   */
  async getHouseholdById(id: string, actor: ResolvedActor): Promise<HouseholdDto> {
    const familyRow = await this.loadFamilyById(id);
    if (!familyRow) throw new NotFoundException('Household not found');
    const isMember = await this.findMemberByPerson(id, actor.personId);
    if (!isMember && !(await this.hasAdmin(actor))) {
      throw new NotFoundException('Household not found');
    }
    const members = await this.loadMembers(id);
    const canEdit = await this.canEdit(id, actor);
    return this.toDto(familyRow, members, canEdit);
  }

  /**
   * PATCH /households/:id — update shared-household fields. Locks the
   * platform_families row inside the tx so concurrent writers serialise.
   */
  async updateHousehold(
    id: string,
    dto: UpdateHouseholdDto,
    actor: ResolvedActor,
  ): Promise<HouseholdDto> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM platform.platform_families WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (locked.length === 0) throw new NotFoundException('Household not found');
      await this.assertCanEditHousehold(id, actor, tx);

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      const cols: Record<keyof UpdateHouseholdDto, string> = {
        name: 'name',
        addressLine1: 'address_line1',
        addressLine2: 'address_line2',
        city: 'city',
        state: 'state',
        postalCode: 'postal_code',
        country: 'country',
        homePhone: 'home_phone',
        homeLanguage: 'home_language',
        mailingAddressSame: 'mailing_address_same',
        mailingLine1: 'mailing_line1',
        mailingLine2: 'mailing_line2',
        mailingCity: 'mailing_city',
        mailingState: 'mailing_state',
        mailingPostalCode: 'mailing_postal_code',
        mailingCountry: 'mailing_country',
        notes: 'notes',
      };
      for (const k of Object.keys(cols) as Array<keyof UpdateHouseholdDto>) {
        if (dto[k] !== undefined) {
          setClauses.push(cols[k] + ' = $' + i++);
          values.push(dto[k]);
        }
      }
      if (setClauses.length === 0) return;
      setClauses.push('updated_at = now()');
      values.push(id);
      const sql =
        'UPDATE platform.platform_families SET ' +
        setClauses.join(', ') +
        ' WHERE id = $' +
        i +
        '::uuid';
      await tx.$executeRawUnsafe(sql, ...values);
    });

    return (await this.getHouseholdById(id, actor)) as HouseholdDto;
  }

  /**
   * POST /households/:id/members — add a person to the household.
   * person_id is UNIQUE on platform_family_members (Step 1) so a person
   * already in another household raises 23505 — translated to 409.
   */
  async addMember(
    id: string,
    dto: AddHouseholdMemberDto,
    actor: ResolvedActor,
  ): Promise<HouseholdDto> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM platform.platform_families WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (locked.length === 0) throw new NotFoundException('Household not found');
      await this.assertCanEditHousehold(id, actor, tx);

      const newPerson = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM platform.iam_person WHERE id = $1::uuid',
        dto.personId,
      );
      if (newPerson.length === 0) throw new BadRequestException('Person not found');

      const isPrimary = dto.isPrimaryContact === true;
      if (isPrimary) {
        // Demote any existing primary contact in this household — partial
        // UNIQUE INDEX on (family_id) WHERE is_primary_contact would 23505 otherwise.
        await tx.$executeRawUnsafe(
          'UPDATE platform.platform_family_members SET is_primary_contact = false, updated_at = now() WHERE family_id = $1::uuid AND is_primary_contact = true',
          id,
        );
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO platform.platform_family_members (id, family_id, person_id, member_role, is_primary_contact) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"platform"."MemberRole", $5)',
          randomUUID(),
          id,
          dto.personId,
          dto.role,
          isPrimary,
        );
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2010' || /unique constraint/i.test(String(err))) {
          throw new ConflictException(
            'This person is already a member of a household. Remove them from the existing household first.',
          );
        }
        throw err;
      }
    });

    await this.kafka.emit({
      topic: 'iam.household.member_changed',
      key: id,
      payload: {
        familyId: id,
        personId: dto.personId,
        role: dto.role,
        action: 'ADDED',
        actorPersonId: actor.personId,
      },
      sourceModule: 'iam',
    });
    return (await this.getHouseholdById(id, actor)) as HouseholdDto;
  }

  /**
   * PATCH /households/:id/members/:memberId — flip role or
   * is_primary_contact. Promoting a new primary atomically clears the
   * old one in the same tx so the partial UNIQUE never rejects.
   */
  async updateMember(
    id: string,
    memberId: string,
    dto: UpdateHouseholdMemberDto,
    actor: ResolvedActor,
  ): Promise<HouseholdDto> {
    let touchedRole: HouseholdRole | null = null;
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM platform.platform_families WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (locked.length === 0) throw new NotFoundException('Household not found');
      await this.assertCanEditHousehold(id, actor, tx);

      const member = await tx.$queryRawUnsafe<
        { id: string; member_role: string; is_primary_contact: boolean }[]
      >(
        'SELECT id::text AS id, member_role::text AS member_role, is_primary_contact ' +
          'FROM platform.platform_family_members WHERE id = $1::uuid AND family_id = $2::uuid FOR UPDATE',
        memberId,
        id,
      );
      if (member.length === 0) throw new NotFoundException('Household member not found');

      // Refuse demoting the last HEAD_OF_HOUSEHOLD.
      if (
        member[0]!.member_role === 'HEAD_OF_HOUSEHOLD' &&
        dto.role !== undefined &&
        dto.role !== 'HEAD_OF_HOUSEHOLD'
      ) {
        const heads = await tx.$queryRawUnsafe<{ c: number }[]>(
          "SELECT COUNT(*)::int AS c FROM platform.platform_family_members WHERE family_id = $1::uuid AND member_role = 'HEAD_OF_HOUSEHOLD'",
          id,
        );
        if ((heads[0]?.c ?? 0) <= 1) {
          throw new BadRequestException(
            'Households must always have at least one head of household. Promote another member first.',
          );
        }
      }

      if (dto.isPrimaryContact === true && !member[0]!.is_primary_contact) {
        await tx.$executeRawUnsafe(
          'UPDATE platform.platform_family_members SET is_primary_contact = false, updated_at = now() WHERE family_id = $1::uuid AND is_primary_contact = true',
          id,
        );
      }

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (dto.role !== undefined) {
        setClauses.push('member_role = $' + i++ + '::"platform"."MemberRole"');
        values.push(dto.role);
        touchedRole = dto.role;
      }
      if (dto.isPrimaryContact !== undefined) {
        setClauses.push('is_primary_contact = $' + i++);
        values.push(dto.isPrimaryContact);
      }
      if (setClauses.length === 0) return;
      setClauses.push('updated_at = now()');
      values.push(memberId);
      const sql =
        'UPDATE platform.platform_family_members SET ' +
        setClauses.join(', ') +
        ' WHERE id = $' +
        i +
        '::uuid';
      await tx.$executeRawUnsafe(sql, ...values);
    });

    if (dto.role !== undefined || dto.isPrimaryContact !== undefined) {
      await this.kafka.emit({
        topic: 'iam.household.member_changed',
        key: id,
        payload: {
          familyId: id,
          memberId,
          role: touchedRole,
          isPrimaryContact: dto.isPrimaryContact,
          action: 'UPDATED',
          actorPersonId: actor.personId,
        },
        sourceModule: 'iam',
      });
    }
    return (await this.getHouseholdById(id, actor)) as HouseholdDto;
  }

  /**
   * DELETE /households/:id/members/:memberId — refuse if the member is
   * the last HEAD_OF_HOUSEHOLD and refuse self-eviction unless the
   * caller has admin override (avoids accidental bricked-self).
   */
  async removeMember(id: string, memberId: string, actor: ResolvedActor): Promise<HouseholdDto> {
    let removedPersonId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM platform.platform_families WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (locked.length === 0) throw new NotFoundException('Household not found');
      await this.assertCanEditHousehold(id, actor, tx);

      const member = await tx.$queryRawUnsafe<
        { id: string; member_role: string; person_id: string }[]
      >(
        'SELECT id::text AS id, member_role::text AS member_role, person_id::text AS person_id ' +
          'FROM platform.platform_family_members WHERE id = $1::uuid AND family_id = $2::uuid FOR UPDATE',
        memberId,
        id,
      );
      if (member.length === 0) throw new NotFoundException('Household member not found');

      const isAdmin = await this.hasAdmin(actor);
      if (member[0]!.person_id === actor.personId && !isAdmin) {
        throw new BadRequestException(
          'You cannot remove yourself from your household. Ask another head of household, or contact an administrator.',
        );
      }
      if (member[0]!.member_role === 'HEAD_OF_HOUSEHOLD') {
        const heads = await tx.$queryRawUnsafe<{ c: number }[]>(
          "SELECT COUNT(*)::int AS c FROM platform.platform_family_members WHERE family_id = $1::uuid AND member_role = 'HEAD_OF_HOUSEHOLD'",
          id,
        );
        if ((heads[0]?.c ?? 0) <= 1) {
          throw new BadRequestException(
            'Households must always have at least one head of household. Promote another member first.',
          );
        }
      }

      await tx.$executeRawUnsafe(
        'DELETE FROM platform.platform_family_members WHERE id = $1::uuid',
        memberId,
      );
      removedPersonId = member[0]!.person_id;
    });

    await this.kafka.emit({
      topic: 'iam.household.member_changed',
      key: id,
      payload: {
        familyId: id,
        memberId,
        personId: removedPersonId,
        action: 'REMOVED',
        actorPersonId: actor.personId,
      },
      sourceModule: 'iam',
    });
    return (await this.getHouseholdById(id, actor)) as HouseholdDto;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async assertCanEditHousehold(
    familyId: string,
    actor: ResolvedActor,
    tx: TxClient,
  ): Promise<void> {
    if (await this.hasAdmin(actor)) return;
    const rows = await tx.$queryRawUnsafe<{ member_role: string }[]>(
      'SELECT member_role::text AS member_role FROM platform.platform_family_members WHERE family_id = $1::uuid AND person_id = $2::uuid LIMIT 1',
      familyId,
      actor.personId,
    );
    const role = rows[0]?.member_role as HouseholdRole | undefined;
    if (!role || !EDIT_ROLES.includes(role)) {
      throw new ForbiddenException(
        'Only the head of household or spouse can edit shared household details. Contact an administrator if this is wrong.',
      );
    }
  }

  private async canEdit(familyId: string, actor: ResolvedActor): Promise<boolean> {
    if (await this.hasAdmin(actor)) return true;
    const member = await this.findMemberByPerson(familyId, actor.personId);
    if (!member) return false;
    return EDIT_ROLES.includes(member.member_role as HouseholdRole);
  }

  private async hasAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.perms.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, ['usr-001:admin']);
  }

  private async loadFamilyForPerson(personId: string): Promise<FamilyRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<FamilyRow[]>(
      this.familySelectSql() +
        'WHERE pf.id = (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid LIMIT 1)',
      personId,
    );
    return rows[0] ?? null;
  }

  private async loadFamilyById(id: string): Promise<FamilyRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<FamilyRow[]>(
      this.familySelectSql() + 'WHERE pf.id = $1::uuid',
      id,
    );
    return rows[0] ?? null;
  }

  private familySelectSql(): string {
    return (
      'SELECT pf.id::text AS id, pf.name, pf.address_line1, pf.address_line2, pf.city, pf.state, ' +
      'pf.postal_code, pf.country, pf.home_phone, pf.home_language, pf.mailing_address_same, ' +
      'pf.mailing_line1, pf.mailing_line2, pf.mailing_city, pf.mailing_state, pf.mailing_postal_code, ' +
      'pf.mailing_country, pf.notes ' +
      'FROM platform.platform_families pf '
    );
  }

  private async loadMembers(familyId: string): Promise<MemberRow[]> {
    return this.prisma.$queryRawUnsafe<MemberRow[]>(
      'SELECT fm.id::text AS id, fm.family_id::text AS family_id, fm.person_id::text AS person_id, ' +
        'fm.member_role::text AS member_role, fm.is_primary_contact, fm.joined_at::text AS joined_at, ' +
        'p.first_name, p.last_name, p.preferred_name ' +
        'FROM platform.platform_family_members fm ' +
        'JOIN platform.iam_person p ON p.id = fm.person_id ' +
        'WHERE fm.family_id = $1::uuid ORDER BY fm.is_primary_contact DESC, p.last_name ASC',
      familyId,
    );
  }

  private async findMemberByPerson(familyId: string, personId: string): Promise<MemberRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<MemberRow[]>(
      'SELECT fm.id::text AS id, fm.family_id::text AS family_id, fm.person_id::text AS person_id, ' +
        'fm.member_role::text AS member_role, fm.is_primary_contact, fm.joined_at::text AS joined_at, ' +
        'p.first_name, p.last_name, p.preferred_name ' +
        'FROM platform.platform_family_members fm ' +
        'JOIN platform.iam_person p ON p.id = fm.person_id ' +
        'WHERE fm.family_id = $1::uuid AND fm.person_id = $2::uuid LIMIT 1',
      familyId,
      personId,
    );
    return rows[0] ?? null;
  }

  private toDto(family: FamilyRow, members: MemberRow[], canEdit: boolean): HouseholdDto {
    const memberDtos: HouseholdMemberDto[] = members.map((m) => ({
      id: m.id,
      personId: m.person_id,
      firstName: m.first_name,
      lastName: m.last_name,
      preferredName: m.preferred_name,
      role: m.member_role as HouseholdRole,
      isPrimaryContact: m.is_primary_contact,
      joinedAt: m.joined_at,
    }));
    return {
      id: family.id,
      name: family.name,
      addressLine1: family.address_line1,
      addressLine2: family.address_line2,
      city: family.city,
      state: family.state,
      postalCode: family.postal_code,
      country: family.country,
      homePhone: family.home_phone,
      homeLanguage: family.home_language,
      mailingAddressSame: family.mailing_address_same,
      mailingLine1: family.mailing_line1,
      mailingLine2: family.mailing_line2,
      mailingCity: family.mailing_city,
      mailingState: family.mailing_state,
      mailingPostalCode: family.mailing_postal_code,
      mailingCountry: family.mailing_country,
      notes: family.notes,
      members: memberDtos,
      canEdit,
    };
  }
}
