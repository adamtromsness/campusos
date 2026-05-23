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
 * POST /auth/switch-persona scenarios.
 *
 * Same fixture pattern as auth-me-personas.spec.ts. Each test seeds
 * personas + cache rows then calls controller.switchPersona to confirm
 * the response carries the new active persona and its scoped
 * permission set.
 */
describe('integration:m00-platform/switch-persona', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let controller: AuthController;

  const personId = generateId();
  const accountId = generateId();
  const otherPersonId = generateId();

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
       VALUES ($1::uuid, 'Switch', 'Me', 'GUARDIAN', true)
       ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Other', 'User', 'STAFF', true)
       ON CONFLICT (id) DO NOTHING`,
      otherPersonId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'Switch Me', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      accountId,
      personId,
      'switchme-' + personId.slice(-6) + '@test.integration',
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid)`,
      personId,
      otherPersonId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id IN ($1::uuid, $2::uuid)`,
      personId,
      otherPersonId,
    );
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      accountId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id IN ($1::uuid, $2::uuid)`,
      personId,
      otherPersonId,
    );
  });

  function makeReq(): any {
    return {
      headers: {},
      user: {
        sub: accountId,
        personId,
        email: 'switchme-' + personId.slice(-6) + '@test.integration',
        displayName: 'Switch Me',
        sessionId: generateId(),
      },
    };
  }

  async function seedPersona(
    type: string,
    schoolId: string | null,
    label: string,
    targetPersonId: string = personId,
  ): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_personas (id, person_id, type, school_id, label, is_active, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, true, now())
       ON CONFLICT (person_id, type, COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET label = EXCLUDED.label, is_active = true`,
      generateId(),
      targetPersonId,
      type,
      schoolId,
      label,
    );
    const row = await prisma.platformPersona.findFirst({
      where: { personId: targetPersonId, type, schoolId },
      select: { id: true },
    });
    return row!.id;
  }

  async function setPersonaActive(id: string, active: boolean): Promise<void> {
    await prisma.platformPersona.update({
      where: { id },
      data: { isActive: active },
    });
  }

  async function seedCache(scopeId: string, codes: string[], hash: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), $5)
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      generateId(),
      accountId,
      scopeId,
      codes,
      hash,
    );
  }

  // ────────────────────────────────────────────────────────────

  it('switch from STAFF to PARENT → permissions reflect the new active persona', async () => {
    const staffId = await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    const parentId = await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    // Both personas live at the same school, so the cache row's codes
    // surface through either persona — but the test still confirms the
    // active persona id flips.
    await seedCache(TEST_SCHOOL_SCOPE_ID, ['stu-001:read', 'tch-003:read'], 'switch-test');

    // Open as STAFF.
    const staffResp = await controller.switchPersona(makeReq(), { personaId: staffId });
    expect(staffResp.activePersona!.id).toBe(staffId);
    expect(staffResp.activePersona!.type).toBe('STAFF');

    // Flip to PARENT.
    const parentResp = await controller.switchPersona(makeReq(), { personaId: parentId });
    expect(parentResp.activePersona!.id).toBe(parentId);
    expect(parentResp.activePersona!.type).toBe('PARENT');
    expect(parentResp.permissions).toContain('stu-001:read');
  });

  it('switch to a persona owned by another person → 404', async () => {
    const otherStaffId = await seedPersona(
      'STAFF',
      TEST_SCHOOL_ID,
      'Staff at Test School',
      otherPersonId,
    );

    await expect(controller.switchPersona(makeReq(), { personaId: otherStaffId })).rejects.toThrow(
      /Persona not found/,
    );
  });

  it('switch to an inactive persona → 404', async () => {
    const staffId = await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    await setPersonaActive(staffId, false);

    await expect(controller.switchPersona(makeReq(), { personaId: staffId })).rejects.toThrow(
      /Persona not found/,
    );
  });

  it('switch with unknown personaId → 404', async () => {
    const ghost = generateId();
    await expect(controller.switchPersona(makeReq(), { personaId: ghost })).rejects.toThrow(
      /Persona not found/,
    );
  });

  it('missing personaId in body → 400', async () => {
    await expect(controller.switchPersona(makeReq(), { personaId: '' })).rejects.toThrow(
      /personaId is required/,
    );
  });

  it('response shape matches /auth/me (same fields)', async () => {
    const staffId = await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    await seedCache(TEST_SCHOOL_SCOPE_ID, ['tch-003:read'], 'shape-test');

    const resp = await controller.switchPersona(makeReq(), { personaId: staffId });
    expect(resp).toHaveProperty('user');
    expect(resp).toHaveProperty('activePersona');
    expect(resp).toHaveProperty('personas');
    expect(resp).toHaveProperty('permissions');
    expect((resp as any).personType).toBeUndefined();
  });
});
