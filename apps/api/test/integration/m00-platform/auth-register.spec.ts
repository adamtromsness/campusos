import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AuthService } from '@modules/m00-platform/auth/auth.service';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

/**
 * Integration coverage for POST /auth/register. The endpoint creates
 * the canonical identity trio (iam_person + platform_users + family +
 * family member) inside one tx and returns a fresh JWT pair.
 *
 * We exercise the AuthService directly so the assertions don't depend
 * on the Nest HTTP harness; the controller is a thin wrapper that
 * just stamps the refresh cookie.
 */
describe('integration:m00-platform/auth-register', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let service: AuthService;

  // Track created identities so we can clean up. Each test uses a
  // unique email, so collecting accountIds via lookup is fine.
  const createdEmails = new Set<string>();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    service = new AuthService(
      prisma,
      new PersonaResolutionService(prisma, tenantPrisma),
      new PermissionCheckService(prisma),
    );
  });

  afterAll(async () => {
    for (const email of createdEmails) {
      const user = await prisma.platformUser.findUnique({
        where: { email },
        select: { id: true, personId: true },
      });
      if (!user) continue;
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_auth_event WHERE account_id = $1::uuid`,
        user.id,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE person_id = $1::uuid`,
        user.personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_families WHERE id NOT IN
           (SELECT family_id FROM platform.platform_family_members)`,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        user.id,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        user.personId,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  function freshEmail(): string {
    const email = `register-${generateId().slice(-12)}@test.integration`;
    createdEmails.add(email);
    return email;
  }

  it('creates iam_person + platform_users + family + family_member and returns JWT', async () => {
    const email = freshEmail();
    const result = await service.register({
      firstName: 'New',
      lastName: 'Registrant',
      email,
      phone: '+1-555-0100',
    });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.user.email).toBe(email);

    const account = await prisma.platformUser.findUnique({ where: { email } });
    expect(account).toBeTruthy();
    expect(account!.accountStatus).toBe('PENDING_VERIFICATION');
    expect(account!.isMinorAccount).toBe(false);
    expect(account!.managedByPersonId).toBeNull();
    expect(account!.displayName).toBe('New Registrant');

    const person = await prisma.iamPerson.findUnique({ where: { id: account!.personId } });
    expect(person!.firstName).toBe('New');
    expect(person!.lastName).toBe('Registrant');
    expect(person!.primaryPhone).toBe('+1-555-0100');

    const fam = await prisma.familyMember.findUnique({ where: { personId: person!.id } });
    expect(fam).toBeTruthy();
    expect(fam!.memberRole).toBe('HEAD_OF_HOUSEHOLD');
    expect(fam!.isPrimaryContact).toBe(true);
  });

  it('normalises email to lowercase + trims whitespace', async () => {
    const tail = generateId().slice(-12);
    const messy = `  Caps-${tail}@TEST.INTEGRATION  `;
    const expected = `caps-${tail}@test.integration`;
    createdEmails.add(expected);
    const result = await service.register({
      firstName: 'Caps',
      lastName: 'Tester',
      email: messy,
    });
    expect(result.user.email).toBe(expected);
    const account = await prisma.platformUser.findUnique({ where: { email: expected } });
    expect(account).toBeTruthy();
  });

  it('duplicate email → 409 Conflict', async () => {
    const email = freshEmail();
    await service.register({ firstName: 'First', lastName: 'Person', email });

    let caught: unknown;
    try {
      await service.register({ firstName: 'Second', lastName: 'Person', email });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(409);
  });

  it('missing fields → 400 Bad Request', async () => {
    await expect(
      service.register({ firstName: '', lastName: 'Solo', email: freshEmail() }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.register({ firstName: 'Solo', lastName: '', email: freshEmail() }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.register({ firstName: 'Solo', lastName: 'Solo', email: '' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('issued access token verifies + carries personId', async () => {
    const email = freshEmail();
    const result = await service.register({ firstName: 'Token', lastName: 'Test', email });
    const decoded = service.verifyToken(result.accessToken);
    expect(decoded).toBeTruthy();
    expect(decoded!.sub).toBe(result.user.sub);
    expect(decoded!.personId).toBe(result.user.personId);
    expect(decoded!.email).toBe(email);
  });
});
