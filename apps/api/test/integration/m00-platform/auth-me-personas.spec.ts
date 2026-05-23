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
 * Codex review FIX 2 — the response permission set is now filtered by
 * the active persona's role-assignment source (not just the cached
 * union per scope). Tests model the filter by seeding a real
 * iam_role_assignment with the source the resolver maps to the
 * target persona type:
 *
 *   STAFF   → source = WORKFLOW_APPROVAL  (employee onboarding)
 *   PARENT  → source = GUARDIAN_RELATIONSHIP
 *   STUDENT → source = SIS_DERIVED
 *
 * A redundant `seedCache` is still maintained so the request-hot-path
 * PermissionGuard (which reads cache, not assignments) keeps working
 * across test runs even though it's not exercised here. The Platform
 * Admin bypass keys off the cache row carrying 'sys-001:admin'.
 */
describe('integration:m00-platform/auth-me-personas', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let controller: AuthController;

  const personId = generateId();
  const accountId = generateId();

  const createdRoleIds = new Set<string>();
  const createdAssignmentIds = new Set<string>();

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
    if (createdAssignmentIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_role_assignment WHERE id = ANY($1::uuid[])`,
        Array.from(createdAssignmentIds),
      );
    }
    if (createdRoleIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.role_permissions WHERE role_id = ANY($1::uuid[])`,
        Array.from(createdRoleIds),
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.roles WHERE id = ANY($1::uuid[])`,
        Array.from(createdRoleIds),
      );
    }
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
    if (createdAssignmentIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_role_assignment WHERE id = ANY($1::uuid[])`,
        Array.from(createdAssignmentIds),
      );
      createdAssignmentIds.clear();
    }
    if (createdRoleIds.size > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.role_permissions WHERE role_id = ANY($1::uuid[])`,
        Array.from(createdRoleIds),
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.roles WHERE id = ANY($1::uuid[])`,
        Array.from(createdRoleIds),
      );
      createdRoleIds.clear();
    }
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
    const row = await prisma.platformPersona.findFirst({
      where: { personId, type, schoolId },
      select: { id: true },
    });
    return row!.id;
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

  /**
   * Create a per-test role + assign it to the test account at the
   * given scope with the supplied source. Returns the assignment id.
   * The cache is also stamped with the union so the Platform Admin
   * bypass + the request-hot-path PermissionGuard both stay in sync.
   */
  async function seedAssignment(
    scopeId: string,
    source: 'WORKFLOW_APPROVAL' | 'GUARDIAN_RELATIONSHIP' | 'SIS_DERIVED' | 'MANUAL',
    permissionCodes: string[],
  ): Promise<string> {
    const roleId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.roles (id, school_id, name, description, is_system)
       VALUES ($1::uuid, $2::uuid, $3, 'test', false)`,
      roleId,
      TEST_SCHOOL_ID,
      `me-role-${source}-${roleId.slice(-6)}`,
    );
    createdRoleIds.add(roleId);

    const perms = await prisma.permission.findMany({
      where: { code: { in: permissionCodes } },
      select: { id: true },
    });
    if (perms.length !== permissionCodes.length) {
      throw new Error(
        `Missing permissions in catalogue: ${permissionCodes.join(', ')} → found ${perms.length}`,
      );
    }
    for (const p of perms) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.role_permissions (id, role_id, permission_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)
         ON CONFLICT DO NOTHING`,
        generateId(),
        roleId,
        p.id,
      );
    }

    const assignmentId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_role_assignment
         (id, account_id, role_id, scope_id, status, source, effective_from)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', $5::"AssignmentSource", now())`,
      assignmentId,
      accountId,
      roleId,
      scopeId,
      source,
    );
    createdAssignmentIds.add(assignmentId);
    return assignmentId;
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
    await seedAssignment(TEST_SCHOOL_SCOPE_ID, 'WORKFLOW_APPROVAL', [
      'tch-003:read',
      'tch-003:write',
    ]);
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
    await seedAssignment(TEST_SCHOOL_SCOPE_ID, 'WORKFLOW_APPROVAL', ['tch-003:read']);

    const result = await controller.me(makeReq());
    // getActivePersonas sorts by type ASC → PARENT precedes STAFF.
    expect(result.activePersona).toBeTruthy();
    expect(result.activePersona!.type).toBe('PARENT');
    expect(result.personas.length).toBe(2);
    expect(result.personas.find((p) => p.id === staffId)).toBeTruthy();
  });

  it('X-Active-Persona header selects the persona', async () => {
    const staffId = await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    await seedAssignment(TEST_SCHOOL_SCOPE_ID, 'WORKFLOW_APPROVAL', ['tch-003:read']);

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

  // ── FIX 2: per-persona permission isolation ────────────────

  it('STAFF + PARENT at the same school — switching to PARENT hides STAFF codes', async () => {
    await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    const parentId = await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    // Two separate role assignments at the same scope with distinct
    // sources — STAFF role grants tch-003:*, PARENT role grants
    // stu-001:read.
    await seedAssignment(TEST_SCHOOL_SCOPE_ID, 'WORKFLOW_APPROVAL', [
      'tch-003:read',
      'tch-003:write',
    ]);
    await seedAssignment(TEST_SCHOOL_SCOPE_ID, 'GUARDIAN_RELATIONSHIP', ['stu-001:read']);
    await seedCache(
      TEST_SCHOOL_SCOPE_ID,
      ['tch-003:read', 'tch-003:write', 'stu-001:read'],
      'me-mixed',
    );

    const asParent = await controller.me(makeReq(parentId));
    expect(asParent.activePersona!.type).toBe('PARENT');
    expect(asParent.permissions).toContain('stu-001:read');
    expect(asParent.permissions).not.toContain('tch-003:read');
    expect(asParent.permissions).not.toContain('tch-003:write');
  });

  it('Platform Admin bypass — sys-001:admin in cache returns the full unfiltered set', async () => {
    await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    // No GUARDIAN_RELATIONSHIP assignment is required for the bypass —
    // the cache row alone signals platform admin status.
    await seedCache(
      TEST_SCHOOL_SCOPE_ID,
      ['sys-001:admin', 'tch-003:read', 'stu-001:read'],
      'me-platform-admin',
    );

    const result = await controller.me(makeReq());
    expect(result.permissions).toContain('sys-001:admin');
    expect(result.permissions).toContain('tch-003:read');
    expect(result.permissions).toContain('stu-001:read');
  });

  it('Platform-scope cache row → PARENT inherits platform admin codes via the bypass', async () => {
    const platformScope = await prisma.iamScope.findFirst({
      where: { scopeType: { code: 'PLATFORM' }, isActive: true },
      select: { id: true },
    });
    expect(platformScope).toBeTruthy();

    await seedPersona('PARENT', TEST_SCHOOL_ID, 'Parent at Test School');
    // Platform admin cache row at the PLATFORM scope — triggers the
    // bypass even though the active persona is PARENT.
    await seedCache(platformScope!.id, ['sys-001:admin', 'plat-001:read'], 'me-platform');

    const result = await controller.me(makeReq());
    expect(result.permissions).toContain('sys-001:admin');
    expect(result.permissions).toContain('plat-001:read');
  });

  it('response shape does NOT include personType', async () => {
    await seedPersona('STAFF', TEST_SCHOOL_ID, 'Staff at Test School');
    const result = await controller.me(makeReq());
    expect((result as any).personType).toBeUndefined();
  });
});
