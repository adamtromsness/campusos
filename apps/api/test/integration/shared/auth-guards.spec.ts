import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AuthGuard, IS_PUBLIC_KEY } from '@shared/auth/auth.guard';
import { PermissionGuard } from '@shared/auth/permission.guard';
import { assertStudentOwnsRecord } from '@shared/auth/student-owned.guard';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { PLATFORM_SCOPED_KEY } from '@shared/auth/platform-scoped.decorator';
import { AuthService } from '@modules/m00-platform/auth/auth.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { runWithTenantContext, type TenantInfo } from '@shared/tenant/tenant.context';
import {
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
  TEST_SUBDOMAIN,
  TEST_ORG_ID,
  withTestTenant,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  adminActor,
  studentActor,
  teacherActor,
  parentActor,
} from '../helpers/actor';
import { ensureWorkflowsPlatformFixtures } from '../fixtures/workflows';

/**
 * Wave 8 — auth guards end-to-end.
 *
 * Drives the AuthGuard + PermissionGuard against the live
 * PermissionCheckService → iam_effective_access_cache hot path. Unit
 * coverage at apps/api/src/shared/auth/*.spec.ts already exercises every
 * branch with stubs; this integration suite confirms the contract holds
 * against the real DB-backed permission resolver.
 *
 * Also exercises assertStudentOwnsRecord against a seeded student row.
 */

const TENANT: TenantInfo = {
  schoolId: TEST_SCHOOL_ID,
  schemaName: TEST_SCHEMA,
  organisationId: TEST_ORG_ID,
  subdomain: TEST_SUBDOMAIN,
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

interface ReflectorMetadata {
  [PERMISSIONS_KEY]?: string[];
  [PLATFORM_SCOPED_KEY]?: boolean;
  [IS_PUBLIC_KEY]?: boolean;
}

function makeReflector(meta: ReflectorMetadata): Reflector {
  return {
    getAllAndOverride: (key: string) => (meta as any)[key],
  } as unknown as Reflector;
}

function makeCtx(opts: { authorization?: string; user?: any } = {}) {
  const request: any = {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  };
  if (opts.user) request.user = opts.user;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'h',
    getClass: () => 'C',
    request,
  };
}

describe('integration:shared/auth-guards', () => {
  let raw: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let permCheck: PermissionCheckService;
  let authService: AuthService;

  beforeAll(async () => {
    raw = new PrismaClient();
    await raw.$connect();
    tenantPrisma = new TenantPrismaService();
    permCheck = new PermissionCheckService(raw);
    authService = new AuthService(raw);
  });

  afterAll(async () => {
    // Restore the canonical admin iam_effective_access_cache rows that
    // this spec deletes between every test. Without this restore, any
    // subsequent integration spec that resolves the admin's school-scope
    // sees an empty cache → isSchoolAdmin=false → cascading auth
    // failures across m82-substitutes, m83-finance, etc.
    await raw.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await ensureWorkflowsPlatformFixtures(raw);
    await raw.$disconnect();
    await tenantPrisma.onModuleDestroy();
  });

  beforeEach(async () => {
    // Wipe any cache rows the prior test seeded for the test admin.
    await raw.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
  });

  async function lookupSchoolScopeId(schoolId: string): Promise<string> {
    const rows = await raw.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id::text AS id FROM platform.iam_scope s
         JOIN platform.iam_scope_type st ON st.id = s.scope_type_id
        WHERE s.entity_id = $1::uuid AND st.code = 'SCHOOL'`,
      schoolId,
    );
    return rows[0]!.id;
  }
  async function lookupPlatformScopeId(): Promise<string | null> {
    const rows = await raw.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id::text AS id FROM platform.iam_scope s
         JOIN platform.iam_scope_type st ON st.id = s.scope_type_id
        WHERE st.code = 'PLATFORM' AND s.is_active = true LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }
  async function seedCacheRow(args: { accountId: string; scopeId: string; codes: string[] }) {
    await raw.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      args.accountId,
      args.scopeId,
      args.codes,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // AuthGuard — JWT validation end-to-end through AuthService
  // ──────────────────────────────────────────────────────────────────
  describe('AuthGuard', () => {
    it('verifies a freshly-signed token + attaches request.user', async () => {
      const token = authService.generateAccessToken({
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Integration Admin',
        sessionId: 'sess-1',
      });
      const guard = new AuthGuard(authService, makeReflector({}));
      const ctx = makeCtx({ authorization: 'Bearer ' + token });
      const result = await guard.canActivate(ctx as any);
      expect(result).toBe(true);
      expect(ctx.request.user.sub).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('skips token check when @Public is set', async () => {
      const guard = new AuthGuard(authService, makeReflector({ [IS_PUBLIC_KEY]: true }));
      const ctx = makeCtx({});
      const result = await guard.canActivate(ctx as any);
      expect(result).toBe(true);
    });

    it('rejects when Authorization is missing', async () => {
      const guard = new AuthGuard(authService, makeReflector({}));
      await expect(guard.canActivate(makeCtx({}) as any)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects when the token signature is invalid', async () => {
      const guard = new AuthGuard(authService, makeReflector({}));
      await expect(
        guard.canActivate(makeCtx({ authorization: 'Bearer not-a-jwt' }) as any),
      ).rejects.toThrow(/Invalid or expired/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PermissionGuard — DB-backed permission resolution
  // ──────────────────────────────────────────────────────────────────
  describe('PermissionGuard (school scope)', () => {
    it('admits when the user holds the required code at the school scope', async () => {
      const schoolScope = await lookupSchoolScopeId(TEST_SCHOOL_ID);
      await seedCacheRow({
        accountId: TEST_ADMIN_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['stu-001:write'],
      });
      const guard = new PermissionGuard(
        makeReflector({ [PERMISSIONS_KEY]: ['stu-001:write'] }),
        permCheck,
      );
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      let result: boolean | undefined;
      await runWithTenantContext({ tenant: TENANT }, async () => {
        result = await guard.canActivate(ctx as any);
      });
      expect(result).toBe(true);
    });

    it('rejects with ForbiddenException when the user lacks the code in every resolved scope', async () => {
      const guard = new PermissionGuard(
        makeReflector({ [PERMISSIONS_KEY]: ['stu-001:write'] }),
        permCheck,
      );
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      let captured: any;
      await runWithTenantContext({ tenant: TENANT }, async () => {
        try {
          await guard.canActivate(ctx as any);
        } catch (e) {
          captured = e;
        }
      });
      expect(captured).toBeInstanceOf(ForbiddenException);
      expect(captured.getResponse()).toMatchObject({
        statusCode: 403,
        error: 'INSUFFICIENT_PERMISSIONS',
        required: ['stu-001:write'],
      });
    });

    it('passes when no required permissions are declared on the endpoint', async () => {
      const guard = new PermissionGuard(makeReflector({}), permCheck);
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      let result: boolean | undefined;
      await runWithTenantContext({ tenant: TENANT }, async () => {
        result = await guard.canActivate(ctx as any);
      });
      expect(result).toBe(true);
    });

    it('rejects when request.user.sub is missing', async () => {
      const guard = new PermissionGuard(
        makeReflector({ [PERMISSIONS_KEY]: ['stu-001:write'] }),
        permCheck,
      );
      let captured: any;
      await runWithTenantContext({ tenant: TENANT }, async () => {
        try {
          await guard.canActivate(makeCtx({ user: {} }) as any);
        } catch (e) {
          captured = e;
        }
      });
      expect(captured).toBeInstanceOf(ForbiddenException);
      expect(captured.message).toMatch(/Authentication context missing/);
    });

    it('rejects when no tenant context is available for a tenant-scoped route', async () => {
      const guard = new PermissionGuard(
        makeReflector({ [PERMISSIONS_KEY]: ['stu-001:write'] }),
        permCheck,
      );
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(/No tenant scope/);
    });

    it('admits via the platform scope chain when only PLATFORM cache row exists', async () => {
      const platformScope = await lookupPlatformScopeId();
      expect(platformScope).not.toBeNull();
      await seedCacheRow({
        accountId: TEST_ADMIN_ACCOUNT_ID,
        scopeId: platformScope!,
        codes: ['stu-001:write'],
      });
      const guard = new PermissionGuard(
        makeReflector({ [PERMISSIONS_KEY]: ['stu-001:write'] }),
        permCheck,
      );
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      let result: boolean | undefined;
      await runWithTenantContext({ tenant: TENANT }, async () => {
        result = await guard.canActivate(ctx as any);
      });
      expect(result).toBe(true);
    });
  });

  describe('PermissionGuard (@PlatformScoped)', () => {
    it('admits when the user holds the code at the PLATFORM scope only', async () => {
      const platformScope = await lookupPlatformScopeId();
      await seedCacheRow({
        accountId: TEST_ADMIN_ACCOUNT_ID,
        scopeId: platformScope!,
        codes: ['sys-001:admin'],
      });
      const guard = new PermissionGuard(
        makeReflector({
          [PERMISSIONS_KEY]: ['sys-001:admin'],
          [PLATFORM_SCOPED_KEY]: true,
        }),
        permCheck,
      );
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      const result = await guard.canActivate(ctx as any);
      expect(result).toBe(true);
    });

    it('rejects a school-scope-only assignment (no piggy-back via the school chain)', async () => {
      const schoolScope = await lookupSchoolScopeId(TEST_SCHOOL_ID);
      await seedCacheRow({
        accountId: TEST_ADMIN_ACCOUNT_ID,
        scopeId: schoolScope,
        codes: ['sys-001:admin'],
      });
      const guard = new PermissionGuard(
        makeReflector({
          [PERMISSIONS_KEY]: ['sys-001:admin'],
          [PLATFORM_SCOPED_KEY]: true,
        }),
        permCheck,
      );
      const ctx = makeCtx({ user: { sub: TEST_ADMIN_ACCOUNT_ID } });
      await expect(guard.canActivate(ctx as any)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // assertStudentOwnsRecord — service-side ownership check
  // ──────────────────────────────────────────────────────────────────
  describe('assertStudentOwnsRecord', () => {
    it('school admin bypasses the check by default', async () => {
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(adminActor(), 'irrelevant-student-id', tenantPrisma),
        ).resolves.toBeUndefined();
      });
    });

    it('STUDENT actor without a matching sis_students row → 403', async () => {
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(studentActor(), 'any-student-id', tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('STAFF non-admin actor → 403 (not the owning student)', async () => {
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(teacherActor(), 'any-student-id', tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('GUARDIAN actor without override → 403', async () => {
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(parentActor(), 'any-student-id', tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('coach delegation flag admits STAFF actors with employeeId', async () => {
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(teacherActor(), 'any-student-id', tenantPrisma, {
            allowCoachDelegation: true,
            allowAdminOverride: false,
          }),
        ).resolves.toBeUndefined();
      });
    });

    it('admin override disabled → admin still rejected when not owner', async () => {
      await withTestTenant(async () => {
        // admin actor is not a student, so should be denied when override is disabled.
        await expect(
          assertStudentOwnsRecord(adminActor(), 'any-student-id', tenantPrisma, {
            allowAdminOverride: false,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });
});
