import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard, IS_PUBLIC_KEY } from '@shared/auth/auth.guard';
import { runWithTenantContext, getRequestContext, TenantInfo } from '@shared/tenant';

/**
 * P2-H4 test coverage uplift — auth.guard.ts (73 LOC, critical-path Tier 2 ≥95%).
 *
 * AuthGuard sits second in the guard chain
 * (TenantResolverMiddleware → AuthGuard → TenantGuard → PermissionGuard).
 * It enforces:
 *   - @Public bypass
 *   - "Authorization: Bearer <token>" extraction
 *   - JWT verification via AuthService
 *   - Attach decoded payload to request.user
 *   - Propagate userId/personId/sessionId into the tenant context (when present)
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

const VALID_PAYLOAD = {
  sub: 'acct-1',
  personId: 'person-1',
  email: 'a@b.c',
  displayName: 'A B',
  sessionId: 'sess-1',
};

function makeExecutionContext(opts: { authorization?: string; isPublic?: boolean }): {
  request: { headers: Record<string, string>; user?: unknown };
  ctx: unknown;
} {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'Class',
  };
  return { request, ctx };
}

function makeReflector(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: () => isPublic,
  } as unknown as Reflector;
}

function makeAuthService(verifier: (token: string) => unknown | null) {
  return {
    verifyToken: (token: string) => verifier(token),
  };
}

describe('AuthGuard.canActivate — @Public bypass', () => {
  it('returns true and skips token check when handler is @Public', async () => {
    let verifierCalled = false;
    const auth = makeAuthService(() => {
      verifierCalled = true;
      return null;
    });
    const guard = new AuthGuard(auth as never, makeReflector(true));
    const { ctx } = makeExecutionContext({});
    const result = await guard.canActivate(ctx as never);
    expect(result).toBe(true);
    expect(verifierCalled).toBe(false);
  });
});

describe('AuthGuard.canActivate — token extraction', () => {
  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const guard = new AuthGuard(makeAuthService(() => null) as never, makeReflector(false));
    const { ctx } = makeExecutionContext({});
    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx as never)).rejects.toThrow('No access token provided');
  });

  it('throws when Authorization header does not start with "Bearer "', async () => {
    const guard = new AuthGuard(makeAuthService(() => null) as never, makeReflector(false));
    const { ctx } = makeExecutionContext({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(ctx as never)).rejects.toThrow('No access token provided');
  });

  it('throws when Authorization header has the wrong number of parts', async () => {
    const guard = new AuthGuard(makeAuthService(() => null) as never, makeReflector(false));
    const { ctx: a } = makeExecutionContext({ authorization: 'Bearer' });
    await expect(guard.canActivate(a as never)).rejects.toThrow('No access token provided');
    const { ctx: b } = makeExecutionContext({ authorization: 'Bearer foo bar' });
    await expect(guard.canActivate(b as never)).rejects.toThrow('No access token provided');
  });

  it('throws when the Bearer token segment is empty', async () => {
    const guard = new AuthGuard(makeAuthService(() => null) as never, makeReflector(false));
    const { ctx } = makeExecutionContext({ authorization: 'Bearer ' });
    await expect(guard.canActivate(ctx as never)).rejects.toThrow('No access token provided');
  });
});

describe('AuthGuard.canActivate — token verification', () => {
  it('throws UnauthorizedException when AuthService.verifyToken returns null', async () => {
    const guard = new AuthGuard(makeAuthService(() => null) as never, makeReflector(false));
    const { ctx } = makeExecutionContext({ authorization: 'Bearer bogus' });
    await expect(guard.canActivate(ctx as never)).rejects.toThrow(
      'Invalid or expired access token',
    );
  });

  it('attaches the decoded payload to request.user on success', async () => {
    const guard = new AuthGuard(
      makeAuthService(() => VALID_PAYLOAD) as never,
      makeReflector(false),
    );
    const { request, ctx } = makeExecutionContext({ authorization: 'Bearer good' });
    const result = await guard.canActivate(ctx as never);
    expect(result).toBe(true);
    expect(request.user).toEqual(VALID_PAYLOAD);
  });

  it('forwards the exact token string to AuthService.verifyToken (not the header)', async () => {
    let captured: string | null = null;
    const auth = makeAuthService((token) => {
      captured = token;
      return VALID_PAYLOAD;
    });
    const guard = new AuthGuard(auth as never, makeReflector(false));
    const { ctx } = makeExecutionContext({ authorization: 'Bearer the-token-only' });
    await guard.canActivate(ctx as never);
    expect(captured).toBe('the-token-only');
  });
});

describe('AuthGuard.canActivate — tenant context propagation', () => {
  it('populates userId/personId/sessionId on the tenant context when present', async () => {
    const guard = new AuthGuard(
      makeAuthService(() => VALID_PAYLOAD) as never,
      makeReflector(false),
    );
    const { ctx: execCtx } = makeExecutionContext({ authorization: 'Bearer good' });

    await runWithTenantContext({ tenant: TENANT }, async () => {
      await guard.canActivate(execCtx as never);
      const reqCtx = getRequestContext();
      expect(reqCtx?.userId).toBe(VALID_PAYLOAD.sub);
      expect(reqCtx?.personId).toBe(VALID_PAYLOAD.personId);
      expect(reqCtx?.sessionId).toBe(VALID_PAYLOAD.sessionId);
    });
  });

  it('does NOT throw when there is no tenant context (e.g. @Public-tenant-exempt routes)', async () => {
    // The AuthGuard runs after the tenant resolver, but tenant-exempt routes
    // like /api/v1/auth/login don't have a tenant context. The guard should
    // still attach request.user without crashing on the optional ctx update.
    const guard = new AuthGuard(
      makeAuthService(() => VALID_PAYLOAD) as never,
      makeReflector(false),
    );
    const { request, ctx: execCtx } = makeExecutionContext({ authorization: 'Bearer good' });
    const result = await guard.canActivate(execCtx as never);
    expect(result).toBe(true);
    expect(request.user).toEqual(VALID_PAYLOAD);
  });
});
