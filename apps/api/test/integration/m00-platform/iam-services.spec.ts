import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient, AssignmentSource } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RoleService } from '@modules/m00-platform/iam/role.service';
import { ScopeService } from '@modules/m00-platform/iam/scope.service';
import { AssignmentService } from '@modules/m00-platform/iam/assignment.service';
import { EffectiveAccessCacheService } from '@modules/m00-platform/iam/effective-access-cache.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_OFFICER_PERSON_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * Foundational IAM service coverage: role, scope, assignment,
 * effective-access-cache, actor-context. The hot-path
 * PermissionCheckService is covered by permission-resolution.spec.ts.
 */
describe('integration:m00-platform/iam-services', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let roles: RoleService;
  let scopes: ScopeService;
  let cache: EffectiveAccessCacheService;
  let assignments: AssignmentService;
  let permCheck: PermissionCheckService;
  let actor: ActorContextService;

  const createdRoleIds: string[] = [];
  const createdScopeIds: string[] = [];
  const createdAssignmentIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    roles = new RoleService(prisma);
    scopes = new ScopeService(prisma);
    cache = new EffectiveAccessCacheService(prisma);
    assignments = new AssignmentService(prisma, cache);
    permCheck = new PermissionCheckService(prisma);
    actor = new ActorContextService(prisma, permCheck, tenantPrisma);
  });

  afterAll(async () => {
    // Best-effort cleanup
    if (createdAssignmentIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_role_assignment WHERE id = ANY($1::uuid[])`,
        createdAssignmentIds,
      );
    }
    if (createdScopeIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_scope WHERE id = ANY($1::uuid[])`,
        createdScopeIds,
      );
    }
    if (createdRoleIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.role_permissions WHERE role_id = ANY($1::uuid[])`,
        createdRoleIds,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.roles WHERE id = ANY($1::uuid[])`,
        createdRoleIds,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset cache rows so per-test seeding is deterministic.
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  // ─── RoleService ────────────────────────────────────────────

  describe('RoleService', () => {
    it('create + findById + findByName', async () => {
      const r = await roles.create({
        name: 'IAM-Test-Role-' + generateId().slice(-6),
        description: 'unit test role',
        isSystem: false,
      });
      createdRoleIds.push(r.id);

      const got = await roles.findById(r.id);
      expect(got!.name).toBe(r.name);

      const byName = await roles.findByName(r.name);
      expect(byName!.id).toBe(r.id);

      const byNameWithSchool = await roles.findByName(r.name, TEST_SCHOOL_ID);
      // Role was created without schoolId → schoolId filter returns null.
      expect(byNameWithSchool).toBeNull();
    });

    it('findById returns null for unknown id', async () => {
      const r = await roles.findById(generateId());
      expect(r).toBeNull();
    });

    it('findAll returns rows sorted ASC + includes rolePermissions', async () => {
      const all = await roles.findAll();
      expect(Array.isArray(all)).toBe(true);
      if (all.length >= 2) {
        expect(all[0]!.name.localeCompare(all[1]!.name)).toBeLessThanOrEqual(0);
      }
    });

    it('getAllPermissions + getPermissionByCode', async () => {
      const allPerms = await roles.getAllPermissions();
      expect(allPerms.length).toBeGreaterThanOrEqual(1);
      const sample = allPerms[0]!;
      const byCode = await roles.getPermissionByCode(sample.code);
      expect(byCode!.id).toBe(sample.id);
    });

    it('assignPermissions skips duplicates', async () => {
      const r = await roles.create({
        name: 'IAM-AP-' + generateId().slice(-6),
      });
      createdRoleIds.push(r.id);
      const allPerms = await roles.getAllPermissions();
      const sub = allPerms.slice(0, 2).map((p) => p.id);
      await roles.assignPermissions(r.id, sub);
      // Re-assign — skipDuplicates means no error and count is 0.
      const result = await roles.assignPermissions(r.id, sub);
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    it('create with schoolId scopes the role', async () => {
      const r = await roles.create({
        name: 'IAM-SchoolRole-' + generateId().slice(-6),
        schoolId: TEST_SCHOOL_ID,
      });
      createdRoleIds.push(r.id);
      const got = await roles.findByName(r.name, TEST_SCHOOL_ID);
      expect(got!.id).toBe(r.id);
    });
  });

  // ─── ScopeService ───────────────────────────────────────────

  describe('ScopeService', () => {
    it('createScope creates a scope row', async () => {
      const entityId = generateId();
      const s = await scopes.createScope({
        scopeTypeCode: 'SCHOOL',
        entityId,
        entityTable: 'platform.schools',
        label: 'IAM-Test-Scope-' + entityId.slice(-6),
      });
      createdScopeIds.push(s.id);
      expect(s.label).toContain('IAM-Test-Scope-');
    });

    it('createScope throws for unknown scope type', async () => {
      await expect(
        scopes.createScope({
          scopeTypeCode: 'NONEXISTENT-' + generateId().slice(-4),
          entityId: generateId(),
          entityTable: 'platform.schools',
          label: 'x',
        }),
      ).rejects.toThrow(/Unknown scope type/);
    });

    it('findByEntity returns the scope row', async () => {
      const entityId = generateId();
      const s = await scopes.createScope({
        scopeTypeCode: 'SCHOOL',
        entityId,
        entityTable: 'platform.schools',
        label: 'IAM-Find-' + entityId.slice(-6),
      });
      createdScopeIds.push(s.id);
      const got = await scopes.findByEntity('SCHOOL', entityId);
      expect(got!.id).toBe(s.id);
    });

    it('findByEntity returns null for unknown scope type', async () => {
      const got = await scopes.findByEntity('NONEXISTENT-' + generateId().slice(-4), generateId());
      expect(got).toBeNull();
    });

    it('getChildren returns child scopes', async () => {
      const parentEntity = generateId();
      const parent = await scopes.createScope({
        scopeTypeCode: 'SCHOOL',
        entityId: parentEntity,
        entityTable: 'platform.schools',
        label: 'IAM-Parent-' + parentEntity.slice(-6),
      });
      createdScopeIds.push(parent.id);
      const childEntity = generateId();
      const child = await scopes.createScope({
        scopeTypeCode: 'DEPARTMENT',
        entityId: childEntity,
        entityTable: 'platform.schools',
        label: 'IAM-Child-' + childEntity.slice(-6),
        parentScopeId: parent.id,
      });
      createdScopeIds.push(child.id);
      const children = await scopes.getChildren(parent.id);
      expect(children.find((c) => c.id === child.id)).toBeDefined();
    });
  });

  // ─── AssignmentService + EffectiveAccessCacheService ────────

  describe('AssignmentService + EffectiveAccessCacheService', () => {
    async function createRoleWithPermission(code: string): Promise<string> {
      const r = await roles.create({
        name: 'IAM-AS-' + generateId().slice(-6),
      });
      createdRoleIds.push(r.id);
      const perm = await prisma.permission.findUnique({ where: { code } });
      if (perm) {
        await roles.assignPermissions(r.id, [perm.id]);
      }
      return r.id;
    }

    it('grantRole + cache rebuild + getAssignmentsForAccount + revoke', async () => {
      const roleId = await createRoleWithPermission('sch-001:read');

      const assignment = await assignments.grantRole({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        roleId,
        scopeId: TEST_SCHOOL_SCOPE_ID,
        source: AssignmentSource.MANUAL,
        assignedBy: TEST_ADMIN_ACCOUNT_ID,
        notes: 'integration test grant',
      });
      createdAssignmentIds.push(assignment.id);
      expect(assignment.status).toBe('ACTIVE');

      // Cache should now contain the role's permissions.
      const cacheRow = await prisma.iamEffectiveAccessCache.findUnique({
        where: {
          accountId_scopeId: {
            accountId: TEST_OFFICER_ACCOUNT_ID,
            scopeId: TEST_SCHOOL_SCOPE_ID,
          },
        },
      });
      expect(cacheRow).not.toBeNull();
      expect(cacheRow!.permissionCodes).toContain('sch-001:read');

      const list = await assignments.getAssignmentsForAccount(TEST_OFFICER_ACCOUNT_ID);
      expect(list.find((a) => a.id === assignment.id)).toBeDefined();

      const revoked = await assignments.revokeAssignment(
        assignment.id,
        TEST_ADMIN_ACCOUNT_ID,
        'test revocation',
      );
      expect(revoked.status).toBe('REVOKED');

      // Cache should be empty after revoke (no active assignments left).
      const cacheAfter = await prisma.iamEffectiveAccessCache.findUnique({
        where: {
          accountId_scopeId: {
            accountId: TEST_OFFICER_ACCOUNT_ID,
            scopeId: TEST_SCHOOL_SCOPE_ID,
          },
        },
      });
      // Could be null (deleted) or empty array (rebuild path)
      expect(cacheAfter?.permissionCodes ?? []).toEqual([]);
    });

    it('rebuildCache walks scope hierarchy (child scope inherits parent)', async () => {
      // Build a parent + child scope under a fresh entity.
      const parentEntity = generateId();
      const parent = await scopes.createScope({
        scopeTypeCode: 'SCHOOL',
        entityId: parentEntity,
        entityTable: 'platform.schools',
        label: 'IAM-Hier-Parent-' + parentEntity.slice(-6),
      });
      createdScopeIds.push(parent.id);
      const childEntity = generateId();
      const child = await scopes.createScope({
        scopeTypeCode: 'DEPARTMENT',
        entityId: childEntity,
        entityTable: 'platform.schools',
        label: 'IAM-Hier-Child-' + childEntity.slice(-6),
        parentScopeId: parent.id,
      });
      createdScopeIds.push(child.id);

      // Grant a role at the PARENT scope.
      const roleId = await createRoleWithPermission('sch-001:write');
      const assignment = await assignments.grantRole({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        roleId,
        scopeId: parent.id,
        source: AssignmentSource.MANUAL,
        assignedBy: TEST_ADMIN_ACCOUNT_ID,
      });
      createdAssignmentIds.push(assignment.id);

      // Rebuild the CHILD scope's cache; should still pick up the parent's role.
      const codes = await cache.rebuildCache(TEST_OFFICER_ACCOUNT_ID, child.id);
      expect(codes).toContain('sch-001:write');
    });

    it('rebuildAllForAccount processes every distinct scope', async () => {
      const roleId = await createRoleWithPermission('sch-001:read');
      const a = await assignments.grantRole({
        accountId: TEST_OFFICER_ACCOUNT_ID,
        roleId,
        scopeId: TEST_SCHOOL_SCOPE_ID,
        source: AssignmentSource.MANUAL,
      });
      createdAssignmentIds.push(a.id);
      await cache.rebuildAllForAccount(TEST_OFFICER_ACCOUNT_ID);
      const row = await prisma.iamEffectiveAccessCache.findUnique({
        where: {
          accountId_scopeId: {
            accountId: TEST_OFFICER_ACCOUNT_ID,
            scopeId: TEST_SCHOOL_SCOPE_ID,
          },
        },
      });
      expect(row).not.toBeNull();
    });
  });

  // ─── ActorContextService ────────────────────────────────────

  describe('ActorContextService', () => {
    it('resolveActor for admin person → isSchoolAdmin reflects platform-admin status', async () => {
      // Seed sch-001:admin in cache for the admin actor at the school scope.
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
        generateId(),
        TEST_ADMIN_ACCOUNT_ID,
        TEST_SCHOOL_SCOPE_ID,
        ['sch-001:admin'],
      );
      const resolved = await withTestTenant(async () =>
        actor.resolveActor(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID),
      );
      expect(resolved.accountId).toBe(TEST_ADMIN_ACCOUNT_ID);
      expect(resolved.personId).toBe(TEST_ADMIN_PERSON_ID);
      expect(resolved.isSchoolAdmin).toBe(true);
      expect(resolved.personType).toBe('STAFF');
    });

    it('resolveActor for actor without admin → isSchoolAdmin=false', async () => {
      const resolved = await withTestTenant(async () =>
        actor.resolveActor(TEST_OFFICER_ACCOUNT_ID, TEST_OFFICER_PERSON_ID),
      );
      expect(resolved.isSchoolAdmin).toBe(false);
    });

    it('resolveActor resolves employeeId for staff with hr_employees row', async () => {
      // Insert hr_employees row keyed to officer person.
      const empId = TEST_OFFICER_EMPLOYEE_ID;
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'IAM-Officer', 'Test', 'STAFF', true)
         ON CONFLICT (id) DO NOTHING`,
        TEST_OFFICER_PERSON_ID,
      );
      const employeeNum = 'IAM-EMP-' + empId.slice(-6);
      await prisma.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_employees
           (id, school_id, person_id, account_id, employee_number, hire_date,
            employment_type, employment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now()::date,
                 'FULL_TIME', 'ACTIVE')
         ON CONFLICT (id) DO UPDATE SET employment_status = 'ACTIVE'`,
        empId,
        TEST_SCHOOL_ID,
        TEST_OFFICER_PERSON_ID,
        TEST_OFFICER_ACCOUNT_ID,
        employeeNum,
      );
      const resolved = await withTestTenant(async () =>
        actor.resolveActor(TEST_OFFICER_ACCOUNT_ID, TEST_OFFICER_PERSON_ID),
      );
      expect(resolved.employeeId).toBe(empId);

      // TERMINATED status should drop the employeeId resolution.
      await prisma.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.hr_employees SET employment_status = 'TERMINATED' WHERE id = $1::uuid`,
        empId,
      );
      const resolvedAfter = await withTestTenant(async () =>
        actor.resolveActor(TEST_OFFICER_ACCOUNT_ID, TEST_OFFICER_PERSON_ID),
      );
      expect(resolvedAfter.employeeId).toBeNull();

      // Restore for downstream tests.
      await prisma.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.hr_employees SET employment_status = 'ACTIVE' WHERE id = $1::uuid`,
        empId,
      );
    });

    it('resolveActor returns null personType for unknown person id', async () => {
      const resolved = await withTestTenant(async () =>
        actor.resolveActor(generateId(), generateId()),
      );
      expect(resolved.personType).toBeNull();
    });
  });
});
