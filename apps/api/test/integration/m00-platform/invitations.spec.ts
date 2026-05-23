import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { InvitationService } from '@modules/m00-platform/iam/invitation.service';
import { InvitationController } from '@modules/m00-platform/iam/invitation.controller';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * DB-backed integration tests for the generic invitation surface
 * (Step 7 of persona-registration). Covers:
 *
 *   - GET /:token (public landing page)
 *   - POST /:token/accept (EMPLOYEE / PARENT_LINK / SUBSTITUTE /
 *     CHILD_LINK delegation)
 *   - POST /:token/decline
 *   - GET /mine
 *
 * Each accept-flow test seeds the projection-table preconditions
 * (role + scope for EMPLOYEE; sis_students + platform_students for
 * PARENT_LINK; etc.), then verifies the side-effects + persona cache.
 */
describe('integration:m00-platform/invitations', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let service: InvitationService;
  let controller: InvitationController;

  // Inviter (school admin / parent) — fixed per suite.
  const inviterPersonId = generateId();
  const inviterAccountId = generateId();
  const accepterPersonId = generateId();
  const accepterAccountId = generateId();
  const accepterEmail = `accepter-${accepterPersonId.slice(-6)}@test.integration`;

  // Pre-seeded role for EMPLOYEE accepts.
  const testRoleId = generateId();
  // Scope is created lazily by the service via ensureSchoolScope.

  // Track per-test rows that need cleanup.
  const createdInvitationIds = new Set<string>();
  const createdAssignmentIds = new Set<string>();
  const createdScopeIds = new Set<string>();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    const personaResolution = new PersonaResolutionService(prisma, tenantPrisma);
    service = new InvitationService(prisma, tenantPrisma, personaResolution);
    controller = new InvitationController(service);

    // iam_person + platform_users for inviter + accepter
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Inviter', 'Person', 'STAFF', true)
       ON CONFLICT (id) DO NOTHING`,
      inviterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'Inviter Person', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      inviterAccountId,
      inviterPersonId,
      `inviter-${inviterPersonId.slice(-6)}@test.integration`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Accepter', 'Person', 'STAFF', true)
       ON CONFLICT (id) DO NOTHING`,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'Accepter Person', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      accepterAccountId,
      accepterPersonId,
      accepterEmail,
    );

    // Seed a role for EMPLOYEE invitation acceptance.
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.roles (id, school_id, name, description, is_system)
       VALUES ($1::uuid, $2::uuid, $3, 'Invitation test role', false)
       ON CONFLICT (school_id, name) DO NOTHING`,
      testRoleId,
      TEST_SCHOOL_ID,
      'Invitation-Test-Role-' + testRoleId.slice(-6),
    );
  });

  afterAll(async () => {
    // Per-test cleanup is best-effort; the suite-wide tear-down here
    // removes anything left over.
    if (createdAssignmentIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_role_assignment WHERE id = ANY($1::uuid[])`,
        Array.from(createdAssignmentIds),
      );
    }
    if (createdScopeIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_scope WHERE id = ANY($1::uuid[])`,
        Array.from(createdScopeIds),
      );
    }
    if (createdInvitationIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations WHERE id = ANY($1::uuid[])`,
        Array.from(createdInvitationIds),
      );
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid`,
      inviterPersonId,
    );
    // Wipe accepter-side projections that the tests may have created.
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid)`,
      inviterPersonId,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE family_id IN
         (SELECT family_id FROM platform.platform_family_members WHERE person_id IN ($1::uuid, $2::uuid))`,
      inviterPersonId,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_members WHERE person_id IN ($1::uuid, $2::uuid)`,
      inviterPersonId,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_families WHERE id NOT IN
         (SELECT family_id FROM platform.platform_family_members)`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_substitute_profiles WHERE person_id = $1::uuid`,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE person_id = $1::uuid`,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_role_assignment WHERE account_id = $1::uuid`,
      accepterAccountId,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM platform.roles WHERE id = $1::uuid`, testRoleId);
    for (const accountId of [inviterAccountId, accepterAccountId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        accountId,
      );
    }
    for (const personId of [inviterPersonId, accepterPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        personId,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset per-test state so independent tests can re-create the same
    // accepter-side rows without ON CONFLICT/UNIQUE collisions.
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid`,
      inviterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid)`,
      inviterPersonId,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE family_id IN
         (SELECT family_id FROM platform.platform_family_members WHERE person_id IN ($1::uuid, $2::uuid))`,
      inviterPersonId,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_members WHERE person_id IN ($1::uuid, $2::uuid)`,
      inviterPersonId,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_families WHERE id NOT IN
         (SELECT family_id FROM platform.platform_family_members)`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_substitute_profiles WHERE person_id = $1::uuid`,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hr_employees WHERE person_id = $1::uuid`,
      accepterPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_role_assignment WHERE account_id = $1::uuid`,
      accepterAccountId,
    );
    createdInvitationIds.clear();
  });

  function accepterActor(): { personId: string; accountId: string; email: string } {
    return {
      personId: accepterPersonId,
      accountId: accepterAccountId,
      email: accepterEmail,
    };
  }

  function req(actor = accepterActor()): any {
    return {
      headers: {},
      user: {
        sub: actor.accountId,
        personId: actor.personId,
        email: actor.email,
        displayName: 'Accepter',
        sessionId: generateId(),
      },
    };
  }

  async function seedInvitation(input: {
    type: 'EMPLOYEE' | 'PARENT_LINK' | 'SUBSTITUTE' | 'CHILD_LINK';
    token?: string;
    metadata?: object;
    targetEmail?: string;
    targetPersonId?: string;
    expiresInHours?: number;
    status?: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  }): Promise<string> {
    const id = generateId();
    const token = input.token ?? randomToken();
    const expires = new Date(Date.now() + (input.expiresInHours ?? 24) * 3600 * 1000);
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, target_person_id,
          metadata, status, expires_at, created_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid,
               $7::jsonb, $8, $9::timestamptz, now())`,
      id,
      input.type,
      token,
      inviterPersonId,
      input.targetEmail ?? null,
      input.targetPersonId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.status ?? 'PENDING',
      expires.toISOString(),
    );
    createdInvitationIds.add(id);
    return token;
  }

  // ─── GET /:token (public) ──────────────────────────────────

  it('GET /:token → returns inviter name + school + expiry for a PENDING invite', async () => {
    const token = await seedInvitation({
      type: 'EMPLOYEE',
      metadata: { schoolId: TEST_SCHOOL_ID, roleId: testRoleId, jobTitle: 'Teacher' },
      targetEmail: 'candidate@example.invalid',
    });
    const result = await controller.get(token);
    expect(result.type).toBe('EMPLOYEE');
    expect(result.status).toBe('PENDING');
    expect(result.schoolId).toBe(TEST_SCHOOL_ID);
    expect(result.schoolName).toBeTruthy();
    expect(result.jobTitle).toBe('Teacher');
    expect(result.inviterName).toContain('Inviter');
  });

  it('GET /:token for an expired invite → 404', async () => {
    const token = await seedInvitation({
      type: 'EMPLOYEE',
      metadata: { schoolId: TEST_SCHOOL_ID, roleId: testRoleId },
      expiresInHours: -1,
    });
    await expect(controller.get(token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /:token for an unknown token → 404', async () => {
    await expect(controller.get('NONESUCH-' + generateId().slice(-8))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ─── POST /:token/accept — EMPLOYEE ────────────────────────

  it('accept EMPLOYEE → hr_employees row + iam_role_assignment + STAFF persona', async () => {
    const token = await seedInvitation({
      type: 'EMPLOYEE',
      metadata: { schoolId: TEST_SCHOOL_ID, roleId: testRoleId, jobTitle: 'Teacher' },
    });
    const result = await controller.accept(req(), token);
    expect(result.type).toBe('EMPLOYEE');
    expect(result.personaType).toBe('STAFF');
    expect(result.schoolId).toBe(TEST_SCHOOL_ID);

    const emp = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.hr_employees WHERE person_id = $1::uuid`,
      accepterPersonId,
    );
    expect(emp.length).toBe(1);

    const assignments = await prisma.iamRoleAssignment.findMany({
      where: { accountId: accepterAccountId, roleId: testRoleId },
    });
    expect(assignments.length).toBe(1);
    for (const a of assignments) createdAssignmentIds.add(a.id);

    const persona = await prisma.platformPersona.findFirst({
      where: { personId: accepterPersonId, type: 'STAFF' },
    });
    expect(persona).toBeTruthy();
  });

  // ─── POST /:token/accept — PARENT_LINK ─────────────────────

  it('accept PARENT_LINK → sis_student_guardians + platform_family_children LINKED + PARENT persona', async () => {
    // Seed student in platform + tenant.
    const studentPersonId = generateId();
    const platformStudentId = generateId();
    const tenantStudentId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Linked', 'Kid', 'STUDENT', true)`,
      studentPersonId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Linked', 'Kid', true)`,
      platformStudentId,
      studentPersonId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'ENROLLED')`,
      tenantStudentId,
      platformStudentId,
      TEST_SCHOOL_ID,
    );

    try {
      const token = await seedInvitation({
        type: 'PARENT_LINK',
        metadata: {
          schoolId: TEST_SCHOOL_ID,
          studentId: tenantStudentId,
          custodyArrangement: 'FULL',
        },
      });
      const result = await controller.accept(req(), token);
      expect(result.type).toBe('PARENT_LINK');
      expect(result.personaType).toBe('PARENT');

      const guardianLink = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = $1::uuid`,
        tenantStudentId,
      );
      expect(guardianLink.length).toBe(1);

      const child = await prisma.platformFamilyChild.findFirst({
        where: { personId: studentPersonId, status: 'LINKED' },
      });
      expect(child).toBeTruthy();

      const persona = await prisma.platformPersona.findFirst({
        where: { personId: accepterPersonId, type: 'PARENT' },
      });
      expect(persona).toBeTruthy();
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = $1::uuid`,
        tenantStudentId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid AND school_id = $2::uuid`,
        accepterPersonId,
        TEST_SCHOOL_ID,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
        tenantStudentId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_children WHERE person_id = $1::uuid`,
        studentPersonId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
        platformStudentId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        studentPersonId,
      );
    }
  });

  // ─── POST /:token/accept — SUBSTITUTE ──────────────────────

  it('accept SUBSTITUTE → platform_substitute_profiles row + SUBSTITUTE persona', async () => {
    const token = await seedInvitation({
      type: 'SUBSTITUTE',
      metadata: { schoolIds: [TEST_SCHOOL_ID] },
    });
    const result = await controller.accept(req(), token);
    expect(result.type).toBe('SUBSTITUTE');
    expect(result.personaType).toBe('SUBSTITUTE');

    const sub = await prisma.substituteProfile.findUnique({
      where: { personId: accepterPersonId },
    });
    expect(sub).toBeTruthy();
    expect(sub!.isActive).toBe(true);

    const persona = await prisma.platformPersona.findFirst({
      where: { personId: accepterPersonId, type: 'SUBSTITUTE' },
    });
    expect(persona).toBeTruthy();
  });

  // ─── Bad states ────────────────────────────────────────────

  it('accept ACCEPTED invitation → 400', async () => {
    const token = await seedInvitation({
      type: 'SUBSTITUTE',
      status: 'ACCEPTED',
    });
    await expect(controller.accept(req(), token)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accept expired invitation → 400', async () => {
    const token = await seedInvitation({
      type: 'SUBSTITUTE',
      expiresInHours: -1,
    });
    await expect(controller.accept(req(), token)).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── decline ───────────────────────────────────────────────

  it('decline PENDING invitation → status EXPIRED + target_person_id stamped', async () => {
    const token = await seedInvitation({ type: 'SUBSTITUTE' });
    await controller.decline(req(), token);
    const inv = await prisma.platformInvitation.findUnique({ where: { token } });
    expect(inv!.status).toBe('EXPIRED');
    expect(inv!.targetPersonId).toBe(accepterPersonId);
  });

  it('decline non-pending → 404', async () => {
    const token = await seedInvitation({ type: 'SUBSTITUTE', status: 'ACCEPTED' });
    await expect(controller.decline(req(), token)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── GET /mine ─────────────────────────────────────────────

  it('list mine — by target_email', async () => {
    await seedInvitation({
      type: 'EMPLOYEE',
      metadata: { schoolId: TEST_SCHOOL_ID, roleId: testRoleId, jobTitle: 'Teacher' },
      targetEmail: accepterEmail,
    });
    await seedInvitation({
      type: 'SUBSTITUTE',
      targetEmail: 'someone-else@example.invalid',
    });
    const mine = await controller.mine(req());
    expect(mine.length).toBe(1);
    expect(mine[0]!.type).toBe('EMPLOYEE');
    expect(mine[0]!.token).toBeTruthy();
  });

  it('list mine — does not return ACCEPTED or expired', async () => {
    await seedInvitation({
      type: 'SUBSTITUTE',
      targetEmail: accepterEmail,
      status: 'ACCEPTED',
    });
    await seedInvitation({
      type: 'SUBSTITUTE',
      targetEmail: accepterEmail,
      expiresInHours: -1,
    });
    await seedInvitation({
      type: 'SUBSTITUTE',
      targetEmail: accepterEmail,
    });
    const mine = await controller.mine(req());
    expect(mine.length).toBe(1);
  });
});

function randomToken(): string {
  return generateId().replace(/-/g, '').slice(0, 20);
}
