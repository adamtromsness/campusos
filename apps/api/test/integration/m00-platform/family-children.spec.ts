import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FamilyChildrenService } from '@modules/m00-platform/households/family-children.service';
import { FamilyChildrenController } from '@modules/m00-platform/households/family-children.controller';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { RedisService } from '@shared/cache';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

/**
 * DB-backed integration tests for FamilyChildrenService — Step 5 of the
 * persona-registration design. Covers CRUD, cross-family isolation,
 * and the LINKED read-only guard.
 *
 * Step 6 (account creation, link send, accept code) lives in
 * child-linking.spec.ts so the surface area per spec stays small.
 */
describe('integration:m00-platform/family-children', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let redis: RedisService;
  let service: FamilyChildrenService;
  let controller: FamilyChildrenController;

  // Two users in two separate families to exercise cross-family
  // isolation.
  const userAPersonId = generateId();
  const userAAccountId = generateId();
  const userBPersonId = generateId();
  const userBAccountId = generateId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    redis = new RedisService();
    await redis.onModuleInit();
    const personaResolution = new PersonaResolutionService(prisma, tenantPrisma);
    service = new FamilyChildrenService(prisma, personaResolution, redis);
    controller = new FamilyChildrenController(service);

    for (const { personId, accountId, label } of [
      { personId: userAPersonId, accountId: userAAccountId, label: 'A' },
      { personId: userBPersonId, accountId: userBAccountId, label: 'B' },
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, $2, 'Parent', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        personId,
        label,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
        accountId,
        personId,
        `family-children-${label}-${personId.slice(-6)}@test.integration`,
        `User ${label}`,
      );
    }
  });

  afterAll(async () => {
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_children WHERE family_id IN
           (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE person_id = $1::uuid`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_families WHERE id NOT IN
           (SELECT family_id FROM platform.platform_family_members)`,
      );
    }
    for (const accountId of [userAAccountId, userBAccountId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        accountId,
      );
    }
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        personId,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Wipe each user's family children + family between tests so order
    // doesn't matter and `ensureFamilyForPerson` re-creates the family.
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_children WHERE family_id IN
           (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE person_id = $1::uuid`,
        personId,
      );
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_families WHERE id NOT IN
         (SELECT family_id FROM platform.platform_family_members)`,
    );
  });

  function reqFor(personId: string, accountId: string): any {
    return {
      headers: {},
      user: {
        sub: accountId,
        personId,
        email: 'irrelevant@test',
        displayName: 'Test',
        sessionId: generateId(),
      },
    };
  }

  const reqA = () => reqFor(userAPersonId, userAAccountId);
  const reqB = () => reqFor(userBPersonId, userBAccountId);

  // ─── GET /family/children ──────────────────────────────────

  it('list with no family yet → empty array (no implicit family creation)', async () => {
    const result = await controller.list(reqA());
    expect(result).toEqual([]);
  });

  it('list returns placeholders + linked rows after seeding', async () => {
    await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
    const result = await controller.list(reqA());
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.firstName).sort()).toEqual(['Lucas', 'Sofia']);
    for (const c of result) {
      expect(c.status).toBe('PLACEHOLDER');
      expect(c.personId).toBeNull();
    }
  });

  // ─── POST /family/children ─────────────────────────────────

  it('create writes PLACEHOLDER, person_id NULL, lazy-creates family', async () => {
    const child = await controller.create(reqA(), {
      firstName: 'Sofia',
      lastName: 'A',
      dateOfBirth: '2010-06-12',
      gender: 'F',
    });
    expect(child.status).toBe('PLACEHOLDER');
    expect(child.personId).toBeNull();
    expect(child.firstName).toBe('Sofia');
    expect(child.dateOfBirth).toBe('2010-06-12');

    // Confirm family was created lazily.
    const fams = await prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id FROM platform.platform_family_members
       WHERE person_id = $1::uuid`,
      userAPersonId,
    );
    expect(fams).toHaveLength(1);
    expect(fams[0]!.family_id).toBe(child.familyId);
  });

  it('create twice → both children in same family', async () => {
    const c1 = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const c2 = await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
    expect(c1.familyId).toBe(c2.familyId);
    const list = await controller.list(reqA());
    expect(list).toHaveLength(2);
  });

  // ─── PATCH /family/children/:id ────────────────────────────

  it('patch placeholder updates name + DOB', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const updated = await controller.update(reqA(), c.id, {
      firstName: 'Sophie',
      dateOfBirth: '2011-03-04',
    });
    expect(updated.firstName).toBe('Sophie');
    expect(updated.dateOfBirth).toBe('2011-03-04');
    expect(updated.lastName).toBe('A');
  });

  it('patch LINKED child → 400 (read-only)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    // Promote to LINKED directly by stamping the row.
    const linkedPersonId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Sofia', 'A', 'STUDENT', true)`,
      linkedPersonId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children
         SET person_id = $1::uuid, status = 'LINKED', linked_at = now()
       WHERE id = $2::uuid`,
      linkedPersonId,
      c.id,
    );

    await expect(controller.update(reqA(), c.id, { firstName: 'Sophie' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Unlink before deleting the iam_person row — the FK from
    // platform_family_children would otherwise block cleanup.
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children SET person_id = NULL, status = 'PLACEHOLDER'
       WHERE id = $1::uuid`,
      c.id,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
      linkedPersonId,
    );
  });

  // ─── DELETE /family/children/:id ───────────────────────────

  it('delete placeholder removes it from the list', async () => {
    const c1 = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const c2 = await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
    await controller.remove(reqA(), c1.id);
    const list = await controller.list(reqA());
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(c2.id);
  });

  it('delete LINKED child → 400', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const linkedPersonId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Sofia', 'A', 'STUDENT', true)`,
      linkedPersonId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children
         SET person_id = $1::uuid, status = 'LINKED', linked_at = now()
       WHERE id = $2::uuid`,
      linkedPersonId,
      c.id,
    );

    await expect(controller.remove(reqA(), c.id)).rejects.toBeInstanceOf(BadRequestException);

    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children SET person_id = NULL, status = 'PLACEHOLDER'
       WHERE id = $1::uuid`,
      c.id,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
      linkedPersonId,
    );
  });

  // Helper: drop the row to PENDING_LINK with a fixed code + invitation
  // row so the lifecycle tests below can exercise cancel + resend.
  async function seedPendingLink(childId: string, code: string): Promise<string> {
    const invitationId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata,
          status, expires_at, created_at)
       VALUES ($1::uuid, 'CHILD_LINK', $2, $3::uuid, $4,
               jsonb_build_object('familyChildId', $5::text),
               'PENDING', now() + interval '72 hours', now())`,
      invitationId,
      code,
      userAPersonId,
      'sofia@example.invalid',
      childId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children
         SET status = 'PENDING_LINK', invite_code = $1, invite_email = $2
       WHERE id = $3::uuid`,
      code,
      'sofia@example.invalid',
      childId,
    );
    return invitationId;
  }

  it('delete PENDING_LINK child → 400 (must cancel-link first)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK1');

    await expect(controller.remove(reqA(), c.id)).rejects.toBeInstanceOf(BadRequestException);

    // Row + invitation must still exist (the BadRequest is a no-op).
    const inv = await prisma.platformInvitation.findUnique({ where: { token: 'PENDLINK1' } });
    expect(inv!.status).toBe('PENDING');
  });

  it('cancel-link on PENDING_LINK → invitation REVOKED, row back to PLACEHOLDER', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK2');

    const after = await controller.cancelLink(reqA(), c.id);

    expect(after.status).toBe('PLACEHOLDER');
    expect(after.inviteCode).toBeNull();
    expect(after.inviteEmail).toBeNull();
    expect(after.inviteSentAt).toBeNull();

    const inv = await prisma.platformInvitation.findUnique({ where: { token: 'PENDLINK2' } });
    expect(inv!.status).toBe('REVOKED');
  });

  it('cancel-link → delete succeeds (PENDING_LINK → PLACEHOLDER → removed)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK3');

    await controller.cancelLink(reqA(), c.id);
    await controller.remove(reqA(), c.id);

    const list = await controller.list(reqA());
    expect(list.find((x) => x.id === c.id)).toBeUndefined();
  });

  it('cancel-link on PLACEHOLDER → 400 (no pending link to cancel)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await expect(controller.cancelLink(reqA(), c.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('send-link works on PENDING_LINK — old code revoked, new code issued (resend)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK4');

    const after = await controller.sendLink(reqA(), c.id, { email: 'sofia@example.invalid' });

    expect(after.status).toBe('PENDING_LINK');
    expect(after.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(after.inviteCode).not.toBe('PENDLINK4');

    const oldInv = await prisma.platformInvitation.findUnique({ where: { token: 'PENDLINK4' } });
    expect(oldInv!.status).toBe('REVOKED');

    const newInv = await prisma.platformInvitation.findUnique({
      where: { token: after.inviteCode! },
    });
    expect(newInv!.status).toBe('PENDING');
  });

  // ─── Cross-family isolation ────────────────────────────────

  it('user B cannot see user A’s children', async () => {
    await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const listB = await controller.list(reqB());
    expect(listB).toEqual([]);
  });

  it('user B cannot patch user A’s child (404)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await expect(controller.update(reqB(), c.id, { firstName: 'Hacked' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('user B cannot delete user A’s child (404)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await expect(controller.remove(reqB(), c.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
