import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { PermissionGuard } from './permission.guard';
import { PERMISSIONS_KEY } from './require-permission.decorator';
import { PLATFORM_SCOPED_KEY } from './platform-scoped.decorator';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';

/**
 * P2-H4 test coverage uplift — permission.guard.ts (115 LOC, critical-path Tier 2 ≥95%).
 *
 * PermissionGuard is the @RequirePermission enforcement point and the last
 * step of the guard chain (Tenant → Auth → Tenant → **Permission**).
 *
 * REVIEW-CYCLE31 BLOCKING 2: platform-scoped routes (/admin/platform,
 * /admin/dlq) resolve permissions against the PLATFORM IAM scope only — a
 * school admin holding sys-001:admin at SCHOOL scope cannot piggy-back the
 * school→platform inheritance chain.
 *
 * Pre-REVIEW-CYCLE2 BLOCKING: missing request.user used to fail OPEN, letting
 * any tenant-scoped request through @RequirePermission. Guard now throws.
 */

const TENANT: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const USER = { sub: 'acct-1', personId: 'person-1', sessionId: 'sess-1' };

function makeReflector(opts: {
  requiredPermissions?: string[] | undefined;
  isPlatformScoped?: boolean;
}): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === PERMISSIONS_KEY) return opts.requiredPermissions;
      if (key === PLATFORM_SCOPED_KEY) return opts.isPlatformScoped ?? false;
      return undefined;
    },
  } as unknown as Reflector;
}

interface PermissionCheckStub {
  resolvePlatformScope?: () => Promise<string | null>;
  resolveScopeChain?: (schoolId: string) => Promise<string[]>;
  hasAnyPermission?: (
    accountId: string,
    scopeId: string,
    permissions: string[],
  ) => Promise<boolean>;
  calls: {
    hasAnyPermission: Array<{ accountId: string; scopeId: string; permissions: string[] }>;
  };
}

function makePermissionCheck(
  overrides: {
    resolvePlatformScope?: () => Promise<string | null>;
    resolveScopeChain?: (schoolId: string) => Promise<string[]>;
    // Returns boolean; the spec wraps it so every invocation is also captured.
    hasAnyPermissionResult?: (
      accountId: string,
      scopeId: string,
      permissions: string[],
    ) => Promise<boolean>;
  } = {},
): PermissionCheckStub {
  const calls = {
    hasAnyPermission: [] as Array<{ accountId: string; scopeId: string; permissions: string[] }>,
  };
  const innerResult = overrides.hasAnyPermissionResult ?? (async () => false);
  return {
    calls,
    resolvePlatformScope: overrides.resolvePlatformScope ?? (async () => 'platform-scope-1'),
    resolveScopeChain:
      overrides.resolveScopeChain ??
      (async (_schoolId: string) => ['school-scope-1', 'platform-scope-1']),
    hasAnyPermission: async (accountId, scopeId, permissions) => {
      calls.hasAnyPermission.push({ accountId, scopeId, permissions });
      return innerResult(accountId, scopeId, permissions);
    },
  };
}

function makeContext(user: unknown): unknown {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => 'handler',
    getClass: () => 'Class',
  };
}

describe('PermissionGuard.canActivate — no @RequirePermission', () => {
  it('passes when no required permissions are declared', async () => {
    const perm = makePermissionCheck();
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: undefined }),
      perm as never,
    );
    const result = await guard.canActivate(makeContext(USER) as never);
    expect(result).toBe(true);
    expect(perm.calls.hasAnyPermission).toHaveLength(0);
  });

  it('passes when the required permissions array is empty', async () => {
    const perm = makePermissionCheck();
    const guard = new PermissionGuard(makeReflector({ requiredPermissions: [] }), perm as never);
    const result = await guard.canActivate(makeContext(USER) as never);
    expect(result).toBe(true);
    expect(perm.calls.hasAnyPermission).toHaveLength(0);
  });
});

describe('PermissionGuard.canActivate — request.user missing', () => {
  it('throws Forbidden when request.user is undefined (fails closed)', async () => {
    const perm = makePermissionCheck();
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(guard.canActivate(makeContext(undefined) as never)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(guard.canActivate(makeContext(undefined) as never)).rejects.toThrow(
        'Authentication context missing',
      );
    });
  });

  it('throws Forbidden when user.sub is missing', async () => {
    const perm = makePermissionCheck();
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(guard.canActivate(makeContext({}) as never)).rejects.toThrow(
        'Authentication context missing',
      );
    });
  });
});

describe('PermissionGuard.canActivate — tenant-scoped route', () => {
  it('throws Forbidden when no tenant context is available', async () => {
    const perm = makePermissionCheck();
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write'] }),
      perm as never,
    );
    // Run OUTSIDE runWithTenantContext
    await expect(guard.canActivate(makeContext(USER) as never)).rejects.toThrow(
      'No tenant scope for permission check',
    );
  });

  it('throws Forbidden when the tenant resolves to an empty scope chain', async () => {
    const perm = makePermissionCheck({
      resolveScopeChain: async () => [],
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(guard.canActivate(makeContext(USER) as never)).rejects.toThrow(
        'No IAM scope configured for this request',
      );
    });
  });

  it('throws INSUFFICIENT_PERMISSIONS when caller lacks the required permission at every scope', async () => {
    const perm = makePermissionCheck({
      hasAnyPermissionResult: async () => false,
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      try {
        await guard.canActivate(makeContext(USER) as never);
        throw new Error('expected ForbiddenException');
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        const body = (e as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(body.error).toBe('INSUFFICIENT_PERMISSIONS');
        expect(body.required).toEqual(['att-001:write']);
      }
    });
  });

  it('passes when caller has the permission at the first scope (SCHOOL)', async () => {
    const perm = makePermissionCheck({
      hasAnyPermissionResult: async (_a, scopeId) => scopeId === 'school-scope-1',
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      const result = await guard.canActivate(makeContext(USER) as never);
      expect(result).toBe(true);
    });
    // Short-circuits on first match — only one hasAnyPermission call.
    expect(perm.calls.hasAnyPermission).toHaveLength(1);
    expect(perm.calls.hasAnyPermission[0].scopeId).toBe('school-scope-1');
  });

  it('passes when caller has the permission at PLATFORM but not SCHOOL (admin inheritance)', async () => {
    const perm = makePermissionCheck({
      hasAnyPermissionResult: async (_a, scopeId) => scopeId === 'platform-scope-1',
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['sch-001:admin'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      const result = await guard.canActivate(makeContext(USER) as never);
      expect(result).toBe(true);
    });
    // Walked the full chain: school first, then platform.
    expect(perm.calls.hasAnyPermission).toHaveLength(2);
    expect(perm.calls.hasAnyPermission.map((c) => c.scopeId)).toEqual([
      'school-scope-1',
      'platform-scope-1',
    ]);
  });

  it('passes the required-permissions list straight through to hasAnyPermission (OR semantics)', async () => {
    const perm = makePermissionCheck({
      hasAnyPermissionResult: async () => true,
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['att-001:write', 'att-001:admin'] }),
      perm as never,
    );
    await runWithTenantContext({ tenant: TENANT }, async () => {
      const result = await guard.canActivate(makeContext(USER) as never);
      expect(result).toBe(true);
    });
    expect(perm.calls.hasAnyPermission[0].permissions).toEqual(['att-001:write', 'att-001:admin']);
  });
});

describe('PermissionGuard.canActivate — @PlatformScoped route', () => {
  it('throws Forbidden when no PLATFORM IAM scope is configured', async () => {
    const perm = makePermissionCheck({
      resolvePlatformScope: async () => null,
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['sys-001:admin'], isPlatformScoped: true }),
      perm as never,
    );
    // No tenant context — platform-scoped routes are tenant-exempt
    await expect(guard.canActivate(makeContext(USER) as never)).rejects.toThrow(
      'No PLATFORM IAM scope configured for this request',
    );
  });

  it('checks ONLY the platform scope (no school scope chain) when @PlatformScoped', async () => {
    const perm = makePermissionCheck({
      hasAnyPermissionResult: async () => true,
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['sys-001:admin'], isPlatformScoped: true }),
      perm as never,
    );
    // No tenant context needed
    const result = await guard.canActivate(makeContext(USER) as never);
    expect(result).toBe(true);
    expect(perm.calls.hasAnyPermission).toHaveLength(1);
    expect(perm.calls.hasAnyPermission[0].scopeId).toBe('platform-scope-1');
    expect(perm.calls.hasAnyPermission[0].permissions).toEqual(['sys-001:admin']);
  });

  it('throws INSUFFICIENT_PERMISSIONS when caller lacks perm at PLATFORM scope (no SCHOOL fallback)', async () => {
    const perm = makePermissionCheck({
      hasAnyPermissionResult: async () => false,
    });
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['sys-001:admin'], isPlatformScoped: true }),
      perm as never,
    );
    try {
      await guard.canActivate(makeContext(USER) as never);
      throw new Error('expected ForbiddenException');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      const body = (e as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(body.error).toBe('INSUFFICIENT_PERMISSIONS');
    }
    // Exactly one check — no school scope fallback for @PlatformScoped routes.
    expect(perm.calls.hasAnyPermission).toHaveLength(1);
    expect(perm.calls.hasAnyPermission[0].scopeId).toBe('platform-scope-1');
  });
});
