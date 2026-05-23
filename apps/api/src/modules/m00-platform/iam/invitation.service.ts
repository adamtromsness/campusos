import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { PersonaResolutionService } from './persona-resolution.service';
import { TenantPrismaService } from '@shared/tenant';
import {
  AcceptInvitationResultDto,
  InvitationSummaryDto,
  MyInvitationDto,
} from '@modules/m00-platform/households/dto/family-child.dto';

/**
 * InvitationService — generic acceptance for platform_invitations rows
 * (EMPLOYEE, CHILD_LINK, PARENT_LINK, SUBSTITUTE).
 *
 * Each type writes a different projection on accept (hr_employees +
 * iam_role_assignment / platform_family_children / sis_student_guardians
 * + platform_family_children / platform_substitute_profiles), then
 * refreshes the accepter's persona cache so the new persona activates
 * immediately on the next /auth/me call.
 *
 * EMPLOYEE + PARENT_LINK writes hit tenant tables (hr_employees,
 * sis_student_guardians). We resolve the tenant from
 * platform_tenant_routing by the metadata.schoolId and run the writes
 * inside TenantPrismaService.executeInExplicitSchema so the search_path
 * is pinned to that tenant for the duration of the tx.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly personaResolution: PersonaResolutionService,
  ) {}

  /**
   * GET /invitations/:token — public landing page render. Returns only
   * the fields a not-yet-authenticated visitor needs to decide whether
   * to register / log in. inviter PII (email, person id) is omitted.
   */
  async getByToken(token: string): Promise<InvitationSummaryDto> {
    const inv = await this.prisma.platformInvitation.findUnique({
      where: { token },
      select: {
        id: true,
        type: true,
        inviterPersonId: true,
        metadata: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!inv || inv.status !== 'PENDING' || inv.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('Invitation not found');
    }
    const inviter = await this.prisma.iamPerson.findUnique({
      where: { id: inv.inviterPersonId },
      select: { firstName: true, lastName: true, preferredName: true },
    });
    const metadata = (inv.metadata as Record<string, unknown> | null) ?? {};
    const schoolId = typeof metadata.schoolId === 'string' ? (metadata.schoolId as string) : null;
    const schoolName = schoolId ? await this.lookupSchoolName(schoolId) : null;
    const jobTitle = typeof metadata.jobTitle === 'string' ? (metadata.jobTitle as string) : null;
    const inviterName = inviter
      ? (inviter.preferredName ?? inviter.firstName) + ' ' + inviter.lastName
      : 'Someone';
    return {
      id: inv.id,
      type: inv.type as InvitationSummaryDto['type'],
      inviterName,
      schoolId,
      schoolName,
      jobTitle,
      expiresAt: inv.expiresAt.toISOString(),
      status: inv.status,
    };
  }

  /**
   * POST /invitations/:token/accept — type-dispatched accept. Caller
   * must be authenticated. The accepter's personId / accountId / email
   * come from the JWT.
   */
  async accept(
    token: string,
    actor: { personId: string; accountId: string; email: string },
  ): Promise<AcceptInvitationResultDto> {
    const inv = await this.loadAcceptable(token);
    let personaType: string | null = null;
    let schoolId: string | null = null;

    switch (inv.type) {
      case 'EMPLOYEE':
        schoolId = await this.acceptEmployee(inv, actor);
        personaType = 'STAFF';
        break;
      case 'PARENT_LINK':
        schoolId = await this.acceptParentLink(inv, actor);
        personaType = 'PARENT';
        break;
      case 'SUBSTITUTE':
        await this.acceptSubstitute(inv, actor);
        personaType = 'SUBSTITUTE';
        break;
      case 'CHILD_LINK':
        await this.acceptChildLink(inv, actor);
        // CHILD_LINK activates the INVITER's PARENT persona, not the
        // accepter's. The accepter's persona is unchanged.
        personaType = null;
        break;
      default:
        throw new BadRequestException(`Unsupported invitation type: ${inv.type}`);
    }

    await this.markAccepted(inv.id, actor.personId);

    // Refresh the accepter's persona cache so the new persona surfaces
    // immediately on the next /auth/me. For CHILD_LINK, refresh the
    // INVITER's cache instead (they're the one who gains the PARENT
    // persona).
    if (inv.type === 'CHILD_LINK') {
      await this.refreshPersonaCacheSafe(inv.inviterPersonId);
    } else {
      await this.refreshPersonaCacheSafe(actor.personId);
    }

    let personaId: string | null = null;
    if (personaType) {
      const personaRow = await this.prisma.platformPersona.findFirst({
        where: {
          personId: actor.personId,
          type: personaType,
          ...(schoolId ? { schoolId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      personaId = personaRow?.id ?? null;
    }

    return {
      invitationId: inv.id,
      type: inv.type as AcceptInvitationResultDto['type'],
      personaType,
      personaId,
      schoolId,
    };
  }

  /**
   * POST /invitations/:token/decline — caller must be authenticated.
   * Marks the invitation EXPIRED (we don't have a DECLINED status; the
   * design doc treats them as equivalent). Returns 404 if the
   * invitation is already gone or never existed.
   */
  async decline(token: string, actor: { personId: string }): Promise<void> {
    const inv = await this.prisma.platformInvitation.findUnique({
      where: { token },
      select: { id: true, status: true, expiresAt: true, targetPersonId: true },
    });
    if (!inv || inv.status !== 'PENDING') {
      throw new NotFoundException('Invitation not found');
    }
    // Anyone with the token can decline — declining is harmless.
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform.platform_invitations
         SET status = 'EXPIRED',
             target_person_id = COALESCE(target_person_id, $1::uuid)
       WHERE id = $2::uuid`,
      actor.personId,
      inv.id,
    );
  }

  /**
   * GET /invitations/mine — all pending invitations addressed to the
   * caller, either by email or by an already-stamped target_person_id.
   * The token is returned so the UI can present an "Accept" button
   * that hits POST /invitations/:token/accept directly.
   */
  async listMine(actor: { personId: string; email: string }): Promise<MyInvitationDto[]> {
    const rows = await this.prisma.platformInvitation.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        OR: [{ targetEmail: actor.email }, { targetPersonId: actor.personId }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        token: true,
        inviterPersonId: true,
        metadata: true,
        status: true,
        expiresAt: true,
      },
    });
    if (rows.length === 0) return [];

    const inviterIds = Array.from(new Set(rows.map((r) => r.inviterPersonId)));
    const inviters = await this.prisma.iamPerson.findMany({
      where: { id: { in: inviterIds } },
      select: { id: true, firstName: true, lastName: true, preferredName: true },
    });
    const inviterMap = new Map(inviters.map((p) => [p.id, p]));
    const schoolIds = Array.from(
      new Set(
        rows
          .map((r) => (r.metadata as Record<string, unknown> | null)?.schoolId)
          .filter((s): s is string => typeof s === 'string'),
      ),
    );
    const schools = schoolIds.length
      ? await this.prisma.school.findMany({
          where: { id: { in: schoolIds } },
          select: { id: true, name: true },
        })
      : [];
    const schoolMap = new Map(schools.map((s) => [s.id, s.name]));

    return rows.map((r) => {
      const metadata = (r.metadata as Record<string, unknown> | null) ?? {};
      const schoolId = typeof metadata.schoolId === 'string' ? (metadata.schoolId as string) : null;
      const inviter = inviterMap.get(r.inviterPersonId);
      const inviterName = inviter
        ? (inviter.preferredName ?? inviter.firstName) + ' ' + inviter.lastName
        : 'Someone';
      return {
        id: r.id,
        type: r.type as MyInvitationDto['type'],
        token: r.token,
        inviterName,
        schoolId,
        schoolName: schoolId ? (schoolMap.get(schoolId) ?? null) : null,
        jobTitle: typeof metadata.jobTitle === 'string' ? (metadata.jobTitle as string) : null,
        expiresAt: r.expiresAt.toISOString(),
        status: r.status,
      };
    });
  }

  // ─── type handlers ─────────────────────────────────────────

  private async acceptEmployee(
    inv: PendingInvitation,
    actor: { personId: string; accountId: string },
  ): Promise<string> {
    const metadata = inv.metadata as Record<string, unknown> | null;
    const schoolId = strField(metadata, 'schoolId');
    const roleId = strField(metadata, 'roleId');
    if (!schoolId || !roleId) {
      throw new BadRequestException('EMPLOYEE invitation missing schoolId/roleId metadata');
    }
    const schemaName = await this.resolveTenantSchema(schoolId);
    const employeeId = generateId();
    const assignmentId = generateId();

    // hr_employees lives in the tenant schema, but iam_role_assignment +
    // history + access-change events live in platform. Use the platform
    // client for the platform writes and executeInExplicitSchema for
    // the tenant insert.
    await this.tenantPrisma.executeInExplicitSchema(schemaName, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO hr_employees
           (id, person_id, account_id, school_id, employment_type, employment_status, hire_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FULL_TIME', 'ACTIVE', CURRENT_DATE)
         ON CONFLICT (person_id) DO UPDATE SET employment_status = 'ACTIVE'`,
        employeeId,
        actor.personId,
        actor.accountId,
        schoolId,
      );
    });

    const scope = await this.ensureSchoolScope(schoolId);
    await this.prisma.iamRoleAssignment.create({
      data: {
        id: assignmentId,
        accountId: actor.accountId,
        roleId,
        scopeId: scope.id,
        source: 'WORKFLOW_APPROVAL',
        status: 'ACTIVE',
        assignedBy: inv.inviterPersonId,
      },
    });
    return schoolId;
  }

  private async acceptParentLink(
    inv: PendingInvitation,
    actor: { personId: string },
  ): Promise<string> {
    const metadata = inv.metadata as Record<string, unknown> | null;
    const schoolId = strField(metadata, 'schoolId');
    const studentId = strField(metadata, 'studentId');
    if (!schoolId || !studentId) {
      throw new BadRequestException('PARENT_LINK invitation missing studentId/schoolId metadata');
    }
    const custody = strField(metadata, 'custodyArrangement') ?? 'FULL';
    const schemaName = await this.resolveTenantSchema(schoolId);

    await this.tenantPrisma.executeInExplicitSchema(schemaName, async (tx) => {
      const guardianId = generateId();
      // sis_guardians.person_id is the canonical parent identity. We
      // create or find the row; ON CONFLICT against the per-school
      // person uniqueness keeps re-acceptance idempotent.
      await tx.$executeRawUnsafe(
        `INSERT INTO sis_guardians
           (id, person_id, account_id, school_id, family_id, relationship)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, NULL, 'GUARDIAN')
         ON CONFLICT (school_id, person_id) DO NOTHING`,
        guardianId,
        actor.personId,
        schoolId,
      );
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM sis_guardians WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        actor.personId,
        schoolId,
      );
      const finalGuardianId = rows[0]!.id;
      await tx.$executeRawUnsafe(
        `INSERT INTO sis_student_guardians
           (id, student_id, guardian_id, has_custody, is_emergency_contact,
            receives_reports, portal_access, portal_access_scope)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, true, true, true, 'FULL')
         ON CONFLICT (student_id, guardian_id) DO NOTHING`,
        generateId(),
        studentId,
        finalGuardianId,
        custody === 'FULL',
      );
    });

    // Mirror into platform_family_children so the parent's family view
    // includes this child. Two-step lookup: pull
    // sis_students.platform_student_id from the tenant schema, then
    // resolve platform_students.person_id from the platform schema.
    const studentRows = await this.tenantPrisma.executeInExplicitSchema(schemaName, async (tx) => {
      return tx.$queryRawUnsafe<Array<{ platform_student_id: string }>>(
        `SELECT platform_student_id::text AS platform_student_id
           FROM sis_students WHERE id = $1::uuid LIMIT 1`,
        studentId,
      );
    });
    const platformStudentId = studentRows[0]?.platform_student_id ?? null;
    const platformStudent = platformStudentId
      ? await this.prisma.platformStudent.findUnique({
          where: { id: platformStudentId },
          select: { personId: true },
        })
      : null;
    const childPersonId = platformStudent?.personId ?? null;
    if (childPersonId) {
      const familyId = await this.ensureFamilyForPerson(actor.personId);
      const childPerson = await this.prisma.iamPerson.findUnique({
        where: { id: childPersonId },
        select: { firstName: true, lastName: true },
      });
      if (childPerson) {
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO platform.platform_family_children
             (id, family_id, person_id, first_name, last_name, status, linked_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'LINKED', now(), now())
           ON CONFLICT (family_id, person_id) WHERE person_id IS NOT NULL DO NOTHING`,
          generateId(),
          familyId,
          childPersonId,
          childPerson.firstName,
          childPerson.lastName,
        );
      }
    }
    return schoolId;
  }

  private async acceptSubstitute(
    inv: PendingInvitation,
    actor: { personId: string; accountId: string },
  ): Promise<void> {
    void inv;
    // platform_substitute_profiles is a single platform row keyed by
    // person_id — second acceptance of the same invitation type is a
    // no-op via ON CONFLICT.
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_substitute_profiles
         (id, person_id, account_id, is_active, is_available, total_assignments, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, 0, now(), now())
       ON CONFLICT (person_id) DO UPDATE SET is_active = true, is_available = true`,
      generateId(),
      actor.personId,
      actor.accountId,
    );
  }

  private async acceptChildLink(
    inv: PendingInvitation,
    actor: { personId: string },
  ): Promise<void> {
    const metadata = inv.metadata as Record<string, unknown> | null;
    const familyChildId = strField(metadata, 'familyChildId');
    if (!familyChildId) {
      throw new BadRequestException('CHILD_LINK invitation missing familyChildId metadata');
    }
    // Mirror the same write the family-children controller does on
    // /family/link — set person_id + status=LINKED on the row.
    const child = await this.prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM platform.platform_family_children WHERE id = $1::uuid`,
      familyChildId,
    );
    if (child.length === 0 || child[0]!.status === 'LINKED') {
      throw new NotFoundException('Invalid or expired link code');
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children
         SET person_id = $1::uuid,
             status = 'LINKED',
             linked_at = now(),
             updated_at = now()
       WHERE id = $2::uuid`,
      actor.personId,
      familyChildId,
    );
  }

  // ─── helpers ───────────────────────────────────────────────

  private async loadAcceptable(token: string): Promise<PendingInvitation> {
    const inv = await this.prisma.platformInvitation.findUnique({
      where: { token },
      select: {
        id: true,
        type: true,
        inviterPersonId: true,
        metadata: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.status !== 'PENDING') {
      throw new BadRequestException(`Invitation already ${inv.status.toLowerCase()}`);
    }
    if (inv.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invitation expired');
    }
    return inv as PendingInvitation;
  }

  private async markAccepted(invitationId: string, accepterPersonId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE platform.platform_invitations
         SET status = 'ACCEPTED',
             target_person_id = $1::uuid,
             accepted_at = now()
       WHERE id = $2::uuid`,
      accepterPersonId,
      invitationId,
    );
  }

  private async lookupSchoolName(schoolId: string): Promise<string | null> {
    const s = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });
    return s?.name ?? null;
  }

  private async resolveTenantSchema(schoolId: string): Promise<string> {
    const row = await this.prisma.tenantRouting.findUnique({
      where: { tenantId: schoolId },
      select: { schemaName: true, isActive: true },
    });
    if (!row || !row.isActive) {
      throw new BadRequestException(`No active tenant for school ${schoolId}`);
    }
    return row.schemaName;
  }

  private async ensureSchoolScope(schoolId: string): Promise<{ id: string; scopeTypeId: string }> {
    const scopeType = await this.prisma.iamScopeType.findUnique({
      where: { code: 'SCHOOL' },
    });
    if (!scopeType) {
      throw new BadRequestException('SCHOOL scope type not configured');
    }
    const existing = await this.prisma.iamScope.findUnique({
      where: { scopeTypeId_entityId: { scopeTypeId: scopeType.id, entityId: schoolId } },
    });
    if (existing) return { id: existing.id, scopeTypeId: existing.scopeTypeId };
    const created = await this.prisma.iamScope.create({
      data: {
        id: generateId(),
        scopeTypeId: scopeType.id,
        entityId: schoolId,
        entityTable: 'platform.schools',
        label: `School ${schoolId.slice(-6)}`,
      },
    });
    return { id: created.id, scopeTypeId: created.scopeTypeId };
  }

  private async ensureFamilyForPerson(personId: string): Promise<string> {
    const existing = await this.prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id FROM platform.platform_family_members
       WHERE person_id = $1::uuid LIMIT 1`,
      personId,
    );
    if (existing[0]) return existing[0].family_id;
    const familyId = generateId();
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
        generateId(),
        familyId,
        personId,
      );
    });
    return familyId;
  }

  private async refreshPersonaCacheSafe(personId: string): Promise<void> {
    try {
      await this.personaResolution.refreshPersonaCache(personId);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn('[invitation] persona cache refresh failed: ' + (e?.message || e));
    }
  }
}

interface PendingInvitation {
  id: string;
  type: string;
  inviterPersonId: string;
  metadata: unknown;
  status: string;
  expiresAt: Date;
}

function strField(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  const v = metadata[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
