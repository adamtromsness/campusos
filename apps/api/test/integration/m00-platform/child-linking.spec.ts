import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FamilyChildrenService } from '@modules/m00-platform/households/family-children.service';
import { FamilyChildrenController } from '@modules/m00-platform/households/family-children.controller';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { RedisService } from '@shared/cache';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

/**
 * DB-backed integration tests for the Step 6 child-linking flow:
 *   - POST /family/children/:id/create-account
 *   - POST /family/children/:id/send-link
 *   - POST /family/link  (accept code)
 *
 * Also exercises cross-user authorisation + rate limiting.
 */
describe('integration:m00-platform/child-linking', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let redis: RedisService;
  let service: FamilyChildrenService;
  let controller: FamilyChildrenController;

  const parentPersonId = generateId();
  const parentAccountId = generateId();
  // Parent B — owns a separate family; used for cross-user auth + the
  // "claim a code regardless of family" scenario.
  const parentBPersonId = generateId();
  const parentBAccountId = generateId();
  // Child who already has an iam_person — used for accept-link tests.
  const childPersonId = generateId();
  const childAccountId = generateId();

  // Track created iam_person rows so we can clean them up — every
  // create-account test makes a new one.
  const createdPersonIds = new Set<string>();
  const createdAccountIds = new Set<string>();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    redis = new RedisService();
    await redis.onModuleInit();
    const personaResolution = new PersonaResolutionService(prisma, tenantPrisma);
    service = new FamilyChildrenService(prisma, personaResolution, redis);
    controller = new FamilyChildrenController(service);

    const seedUser = async (personId: string, accountId: string, label: string) => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, $2, 'User', 'GUARDIAN', true)
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
        `link-${label}-${personId.slice(-6)}@test.integration`,
        `${label} Test`,
      );
    };

    await seedUser(parentPersonId, parentAccountId, 'Parent');
    await seedUser(parentBPersonId, parentBAccountId, 'ParentB');
    // The "child" identity already exists with an iam_person row — same
    // shape as a previously-registered teen who's accepting a parent's
    // link code.
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Sofia', 'Existing', 'STUDENT', true)
       ON CONFLICT (id) DO NOTHING`,
      childPersonId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'Sofia', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      childAccountId,
      childPersonId,
      `child-${childPersonId.slice(-6)}@test.integration`,
    );
  });

  afterAll(async () => {
    // Unlink + delete every child platform_family_children pointing at
    // dynamically-created iam_persons.
    for (const personId of createdPersonIds) {
      await prisma.$executeRawUnsafe(
        `UPDATE platform.platform_family_children SET person_id = NULL, status = 'PLACEHOLDER'
         WHERE person_id = $1::uuid`,
        personId,
      );
      // Catch any platform_users rows the dynamic create-account flow
      // created. createAccountIds only tracks ids the test bodies
      // explicitly stamped, which misses the rows from "create-account
      // then 400" or persona-refresh paths.
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE person_id = $1::uuid`,
        personId,
      );
    }
    // Wipe family + invitations for our test users.
    for (const personId of [parentPersonId, parentBPersonId, childPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid OR target_person_id = $1::uuid`,
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
    for (const accountId of [parentAccountId, parentBAccountId, childAccountId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        accountId,
      );
    }
    for (const accountId of createdAccountIds) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        accountId,
      );
    }
    for (const personId of [parentPersonId, parentBPersonId, childPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        personId,
      );
    }
    for (const personId of createdPersonIds) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        personId,
      );
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      parentPersonId,
      parentBPersonId,
      childPersonId,
    );
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset family state + invitations + personas + rate-limit counters
    // so every test starts from a clean slate.
    for (const personId of createdPersonIds) {
      await prisma.$executeRawUnsafe(
        `UPDATE platform.platform_family_children SET person_id = NULL, status = 'PLACEHOLDER'
         WHERE person_id = $1::uuid`,
        personId,
      );
    }
    for (const personId of [parentPersonId, parentBPersonId, childPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid OR target_person_id = $1::uuid`,
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
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      parentPersonId,
      parentBPersonId,
      childPersonId,
    );
    for (const accountId of [parentAccountId, parentBAccountId, childAccountId]) {
      await redis['client']?.del(`family:link-attempts:${accountId}`);
    }
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

  // ─── create-account ────────────────────────────────────────

  it('create-account on PLACEHOLDER → LINKED + iam_person + minor account', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Lucas',
      lastName: 'Parent',
      dateOfBirth: '2018-01-01', // under-13 → minor
    });
    const linked = await controller.createAccount(
      reqFor(parentPersonId, parentAccountId),
      c.id,
      {},
    );
    expect(linked.status).toBe('LINKED');
    expect(linked.personId).toBeTruthy();
    createdPersonIds.add(linked.personId!);

    const acct = await prisma.platformUser.findFirst({
      where: { personId: linked.personId! },
      select: { id: true, isMinorAccount: true, managedByPersonId: true, email: true },
    });
    expect(acct).toBeTruthy();
    expect(acct!.isMinorAccount).toBe(true);
    expect(acct!.managedByPersonId).toBe(parentPersonId);
    createdAccountIds.add(acct!.id);
  });

  it('create-account on LINKED → 400', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Mia',
      lastName: 'Parent',
    });
    const linked = await controller.createAccount(
      reqFor(parentPersonId, parentAccountId),
      c.id,
      {},
    );
    createdPersonIds.add(linked.personId!);

    await expect(
      controller.createAccount(reqFor(parentPersonId, parentAccountId), c.id, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create-account with email on under-13 → 400 (COPPA)', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Tiny',
      lastName: 'Parent',
      dateOfBirth: '2020-05-01',
    });
    await expect(
      controller.createAccount(reqFor(parentPersonId, parentAccountId), c.id, {
        email: 'kid@example.invalid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cross-user: parent B cannot create-account for parent A’s placeholder → 404', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'NotYours',
      lastName: 'Parent',
    });
    await expect(
      controller.createAccount(reqFor(parentBPersonId, parentBAccountId), c.id, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── send-link ─────────────────────────────────────────────

  it('send-link on PLACEHOLDER → PENDING_LINK + invitation row (72h expiry)', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Sofia',
      lastName: 'Parent',
    });
    const before = Date.now();
    const updated = await controller.sendLink(reqFor(parentPersonId, parentAccountId), c.id, {
      email: 'sofia@example.invalid',
    });
    expect(updated.status).toBe('PENDING_LINK');
    expect(updated.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(updated.inviteEmail).toBe('sofia@example.invalid');

    const inv = await prisma.platformInvitation.findUnique({
      where: { token: updated.inviteCode! },
    });
    expect(inv).toBeTruthy();
    expect(inv!.type).toBe('CHILD_LINK');
    expect(inv!.status).toBe('PENDING');
    expect(inv!.inviterPersonId).toBe(parentPersonId);
    expect(inv!.targetEmail).toBe('sofia@example.invalid');
    const expiresMs = inv!.expiresAt.getTime();
    const expectedMin = before + 71 * 3600 * 1000;
    const expectedMax = before + 73 * 3600 * 1000;
    expect(expiresMs).toBeGreaterThan(expectedMin);
    expect(expiresMs).toBeLessThan(expectedMax);
  });

  it('send-link on LINKED → 400', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Sofia',
      lastName: 'Parent',
    });
    const linked = await controller.createAccount(
      reqFor(parentPersonId, parentAccountId),
      c.id,
      {},
    );
    createdPersonIds.add(linked.personId!);
    await expect(
      controller.sendLink(reqFor(parentPersonId, parentAccountId), c.id, {
        email: 'sofia@example.invalid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── accept code ───────────────────────────────────────────

  it('accept valid code → LINKED + invitation ACCEPTED + inviter persona refreshed', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Sofia',
      lastName: 'Parent',
    });
    const sent = await controller.sendLink(reqFor(parentPersonId, parentAccountId), c.id, {
      email: 'sofia@example.invalid',
    });
    const linked = await controller.accept(reqFor(childPersonId, childAccountId), {
      code: sent.inviteCode!,
    });
    expect(linked.status).toBe('LINKED');
    expect(linked.personId).toBe(childPersonId);

    const inv = await prisma.platformInvitation.findUnique({
      where: { token: sent.inviteCode! },
    });
    expect(inv!.status).toBe('ACCEPTED');
    expect(inv!.targetPersonId).toBe(childPersonId);

    // The inviting parent's PARENT persona should have appeared in the
    // cache after the refresh hook fired.
    const personaRows = await prisma.platformPersona.findMany({
      where: { personId: parentPersonId, type: 'PARENT' },
    });
    expect(personaRows.length).toBeGreaterThan(0);
  });

  it('accept expired code → 404', async () => {
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Sofia',
      lastName: 'Parent',
    });
    const sent = await controller.sendLink(reqFor(parentPersonId, parentAccountId), c.id, {
      email: 'sofia@example.invalid',
    });
    // Manually expire the invitation row.
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_invitations SET expires_at = now() - interval '1 minute'
       WHERE token = $1`,
      sent.inviteCode,
    );
    await expect(
      controller.accept(reqFor(childPersonId, childAccountId), { code: sent.inviteCode! }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accept unknown code → 404', async () => {
    await expect(
      controller.accept(reqFor(childPersonId, childAccountId), { code: 'NOTACODE' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accept code claims regardless of accepter’s family — links into inviter’s family', async () => {
    // Parent A sends a code; parent B (different family) accepts. The
    // child slot stays with parent A's family; B's family is unaffected.
    const c = await controller.create(reqFor(parentPersonId, parentAccountId), {
      firstName: 'Sofia',
      lastName: 'Parent',
    });
    const sent = await controller.sendLink(reqFor(parentPersonId, parentAccountId), c.id, {
      email: 'sofia@example.invalid',
    });
    const linked = await controller.accept(reqFor(parentBPersonId, parentBAccountId), {
      code: sent.inviteCode!,
    });
    expect(linked.familyId).toBe(c.familyId);
    expect(linked.personId).toBe(parentBPersonId);
  });

  it('rate limit: 6th attempt within 15 min → 429', async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await controller.accept(reqFor(childPersonId, childAccountId), { code: 'NONESUCH' });
      } catch (e) {
        // First 5 attempts should be 404s, not 429s.
        expect(e).toBeInstanceOf(NotFoundException);
      }
    }
    try {
      await controller.accept(reqFor(childPersonId, childAccountId), { code: 'NONESUCH' });
      throw new Error('Expected 429');
    } catch (e: any) {
      expect(e).toBeInstanceOf(HttpException);
      expect(e.getStatus()).toBe(429);
    }
  });
});
