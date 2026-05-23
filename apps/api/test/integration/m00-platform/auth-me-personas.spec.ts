import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AuthController } from '@modules/m00-platform/auth/auth.controller';
import { AuthService } from '@modules/m00-platform/auth/auth.service';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * /auth/me persona scenarios.
 *
 * Each scenario seeds a different combination of platform_personas +
 * iam_effective_access_cache rows for a stable test user, then asserts
 * the shape of the response: identity, activePersona, personas[], and
 * the persona-scoped permissions union.
 */
describe('integration:m00-platform/auth-me-personas', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let controller: AuthController;

  const personId = generateId();
  const accountId = generateId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    const authService = new AuthService(
      prisma,
      new PersonaResolutionService(prisma, tenantPrisma),
      new PermissionCheckService(prisma),
    );
    controller = new AuthController(authService);

    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Auth', 'Me', 'GUARDIAN', true)
       ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'Auth Me', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      accountId,
      personId,
      'authme-' + personId.slice(-6) + '@test.integration',
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
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
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
      personId,
    );
  });

  function makeReq(activePersonaId?: string): any {
    return {
      headers: activePersonaId ? { 'x-active-persona': activePersonaId } : {},
      user: {
        sub: accountId,
        personId,
        email: 'authme-' + personId.slice(-6) + '@test.integration',
        displayName: 'Auth Me',
        sessionId: generateId(),
      },
    };
  }

  async function seedPersona(
    type: string,
    schoolId: string | null,
    label: string,
  ): Promise<string> {
    const id = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_personas (id, person_id, type, school_id, label, is_active, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, true, now())
       ON CONFLICT (person_id, type, COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET label = EXCLUDED.label, is_active = true`,
      id,
      personId,
      type,
      schoolId,
      label,
    );
    // Re-read the id from the table — the ON CONFLICT branch may have
    // resolved to a different existing id.
    const row = await prisma.platformPersona.findFirst({
      where: { personId, type, schoolId },
      select: { id: true },
    });
    return row!.id;
  }

  async function seedCache(scopeId: string, codes: string[], hash: string): Promise<string> {
    const id = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), $5)
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      id,
      accountId,
      scopeId,
      codes,
      hash,
    );
    return id;
  }

  // ────────────────────────────────────────────────────────────

  it('zero personas → activePersona null + empty permissions', async () => {
    const result = await controller.me(makeReq());
    expect(result.activePersona).toBeNull();
    expect(result.personas).toEqual([]);
    expect(result.permissions).toEqual([]);
  });

  it('STAFF persona → returns STAFF-scoped permissions', async () => {
    await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    await seedCache(TEST_SCHOOL_SCOPE_ID, ['tch-003:read', 'tch-003:write'], 'me-staff');

    const result = await controller.me(makeReq());
    expect(result.activePersona).toBeTruthy();
    expect(result.activePersona!.type).toBe('STAFF');
    expect(result.permissions).toContain('tch-003:read');
    expect(result.permissions).toContain('tch-003:write');
  });

  it('STAFF + PARENT, no X-Active-Persona → first-sorted persona is active', async () => {
    const staffId = await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    await seedCache(TEST_SCHOOL_SCOPE_ID, ['tch-003:read'], 'me-pair');

    const result = await controller.me(makeReq());
    // PersonaResolutionService.getActivePersonas orders by type ASC →
    // PARENT precedes STAFF. So the default activePersona is PARENT.
    expect(result.activePersona).toBeTruthy();
    expect(result.activePersona!.type).toBe('PARENT');
    expect(result.personas.length).toBe(2);
    // Verify the STAFF id is still in the personas list.
    expect(result.personas.find((p) => p.id === staffId)).toBeTruthy();
  });

  it('X-Active-Persona header selects the persona', async () => {
    const staffId = await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    await seedCache(TEST_SCHOOL_SCOPE_ID, ['tch-003:read'], 'me-header');

    const result = await controller.me(makeReq(staffId));
    expect(result.activePersona!.id).toBe(staffId);
    expect(result.activePersona!.type).toBe('STAFF');
  });

  it('X-Active-Persona for a non-owned persona → 404', async () => {
    await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    const ghost = generateId();

    await expect(controller.me(makeReq(ghost))).rejects.toThrow(
      /Active persona not found or not owned by user/,
    );
  });

  it('Platform-scope cache row → PARENT persona at school still inherits platform permissions', async () => {
    // The PLATFORM scope is seeded by the global setup. Resolve its id
    // to seed a cache row containing the all-permissions superset.
    const platformScope = await prisma.iamScope.findFirst({
      where: { scopeType: { code: 'PLATFORM' }, isActive: true },
      select: { id: true },
    });
    expect(platformScope).toBeTruthy();

    await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    await seedCache(platformScope!.id, ['plat-001:read', 'plat-001:admin'], 'me-platform');

    const result = await controller.me(makeReq());
    expect(result.permissions).toContain('plat-001:read');
    expect(result.permissions).toContain('plat-001:admin');
  });

  it('response shape does NOT include personType', async () => {
    await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    const result = await controller.me(makeReq());
    expect((result as any).personType).toBeUndefined();
  });
});
