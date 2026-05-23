import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SubstituteProfileService } from '@modules/m82-substitutes/substitute-profile.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant } from '../helpers/tenant-context';

/**
 * Self-service substitute registration — exercised by the Getting
 * Started "I want to substitute teach" card on the web. Differs from
 * the existing admin-flavoured `create()` path in three ways:
 *
 *   1. No sub-001:write permission required (a brand-new user
 *      registering for the first time holds nothing).
 *   2. Idempotent — calling twice returns the existing profile.
 *   3. Refreshes the persona cache so the SUBSTITUTE persona
 *      surfaces on the next /auth/me.
 */
describe('integration:m82-substitutes/register-self', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let personaResolution: PersonaResolutionService;
  let service: SubstituteProfileService;

  const personId = generateId();
  const accountId = generateId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    personaResolution = new PersonaResolutionService(prisma, tenantPrisma);
    service = new SubstituteProfileService(
      tenantPrisma,
      new PermissionCheckService(prisma),
      personaResolution,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'New', 'Sub', 'EXTERNAL', true)
       ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'New Sub', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      accountId,
      personId,
      'register-self-' + personId.slice(-6) + '@test.integration',
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_substitute_profiles WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM platform.iam_person WHERE id = $1::uuid`, personId);
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_substitute_profiles WHERE person_id = $1::uuid`,
      personId,
    );
  });

  function actor() {
    return {
      accountId,
      personId,
      employeeId: null,
      personType: 'EXTERNAL',
      isSchoolAdmin: false,
    };
  }

  it('creates the profile + activates SUBSTITUTE persona', async () => {
    const created = await withTestTenant(() =>
      service.registerSelf(
        {
          displayName: 'Alex Sub',
          gradeLevels: ['K-2', '3-5'],
          subjectAreas: ['English'],
          yearsExperience: 4,
        },
        actor(),
      ),
    );
    expect(created.personId).toBe(personId);
    expect(created.gradeLevels).toEqual(['K-2', '3-5']);

    const persona = await prisma.platformPersona.findFirst({
      where: { personId, type: 'SUBSTITUTE' },
    });
    expect(persona).toBeTruthy();
  });

  it('idempotent — second call returns the same profile (no 409)', async () => {
    const first = await withTestTenant(() =>
      service.registerSelf({ gradeLevels: ['9-12'] }, actor()),
    );
    const second = await withTestTenant(() =>
      service.registerSelf({ gradeLevels: ['9-12'] }, actor()),
    );
    expect(second.id).toBe(first.id);
  });

  it('empty gradeLevels → 400', async () => {
    await expect(
      withTestTenant(() => service.registerSelf({ gradeLevels: [] }, actor())),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
