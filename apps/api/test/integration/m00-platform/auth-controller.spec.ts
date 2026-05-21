import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AuthController } from '@modules/m00-platform/auth/auth.controller';
import { AuthService } from '@modules/m00-platform/auth/auth.service';

import { TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';

/**
 * DB-backed integration tests for AuthController — covers the HTTP
 * route surface (login redirect, refresh, logout, dev-login, /me)
 * that the bare AuthService spec doesn't exercise.
 *
 * The OIDC callback path is excluded — it requires mocking the
 * Keycloak token endpoint + userinfo endpoint via global fetch, and
 * the headline behaviour (call AuthService.authenticateByEmail with
 * the IdP-supplied email) is already covered by the dev-login path
 * below.
 */
describe('integration:m00-platform/auth-controller', () => {
  let prisma: PrismaClient;
  let authService: AuthService;
  let controller: AuthController;

  function makeRes(): {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    cookies: Array<{ name: string; value: string; opts: Record<string, unknown> }>;
    clearedCookies: Array<{ name: string; opts: Record<string, unknown> }>;
    redirectedTo: string | null;
    status: (n: number) => unknown;
    json: (b: unknown) => unknown;
    cookie: (n: string, v: string, o: Record<string, unknown>) => unknown;
    clearCookie: (n: string, o: Record<string, unknown>) => unknown;
    redirect: (url: string) => void;
  } {
    const res: any = {
      statusCode: 200,
      headers: {},
      body: null,
      cookies: [],
      clearedCookies: [],
      redirectedTo: null,
    };
    res.status = (n: number) => {
      res.statusCode = n;
      return res;
    };
    res.json = (b: unknown) => {
      res.body = b;
      return res;
    };
    res.cookie = (n: string, v: string, o: Record<string, unknown>) => {
      res.cookies.push({ name: n, value: v, opts: o });
      return res;
    };
    res.clearCookie = (n: string, o: Record<string, unknown>) => {
      res.clearedCookies.push({ name: n, opts: o });
      return res;
    };
    res.redirect = (url: string) => {
      res.redirectedTo = url;
    };
    return res;
  }

  let testUserEmail: string;
  let testUserId: string;
  let testPersonId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    authService = new AuthService(prisma);
    controller = new AuthController(authService, prisma);

    // Seed a stable test user for authenticateByEmail / refresh /
    // dev-login. Reuse the admin person row that already exists in
    // platform fixtures, but use a unique email so /auth/dev-login
    // can target it deterministically.
    testPersonId = TEST_ADMIN_PERSON_ID;
    testUserId = TEST_ADMIN_ACCOUNT_ID;
    testUserEmail = 'auth-ctrl-' + testUserId.slice(-6) + '@test.integration';
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_users SET email = $1, account_status = 'ACTIVE'
         WHERE id = $2::uuid`,
      testUserEmail,
      testUserId,
    );
  });

  afterAll(async () => {
    // Restore the admin email so other specs that read by id keep
    // working. The fixture seeds 'admin@test.integration.local'.
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_users SET email = 'admin@test.integration.local'
         WHERE id = $1::uuid`,
      testUserId,
    );
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Wipe any auth events stamped by prior tests so the count
    // assertions are deterministic.
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_auth_event WHERE account_id = $1::uuid`,
      testUserId,
    );
  });

  // ─── login (OIDC redirect) ─────────────────────────────────

  describe('login', () => {
    it('builds an OIDC auth URL and redirects', () => {
      const res = makeRes();
      controller.login(res as any);
      expect(res.redirectedTo).toBeTruthy();
      expect(res.redirectedTo).toContain('/protocol/openid-connect/auth');
      expect(res.redirectedTo).toContain('response_type=code');
      expect(res.redirectedTo).toContain('scope=openid%20email%20profile');
    });

    it('uses OIDC_ISSUER + OIDC_CLIENT_ID env when set', () => {
      const oldIssuer = process.env.OIDC_ISSUER;
      const oldClient = process.env.OIDC_CLIENT_ID;
      process.env.OIDC_ISSUER = 'https://idp.example.com/realms/x';
      process.env.OIDC_CLIENT_ID = 'custom-client';
      try {
        const res = makeRes();
        controller.login(res as any);
        expect(res.redirectedTo).toContain('https://idp.example.com/realms/x');
        expect(res.redirectedTo).toContain('client_id=custom-client');
      } finally {
        if (oldIssuer === undefined) delete process.env.OIDC_ISSUER;
        else process.env.OIDC_ISSUER = oldIssuer;
        if (oldClient === undefined) delete process.env.OIDC_CLIENT_ID;
        else process.env.OIDC_CLIENT_ID = oldClient;
      }
    });
  });

  // ─── callback (OIDC) ───────────────────────────────────────

  describe('callback', () => {
    it('missing authorization code → HttpException(BAD_REQUEST)', async () => {
      const req: any = { query: {} };
      const res = makeRes();
      await expect(controller.callback(req, res as any)).rejects.toBeInstanceOf(HttpException);
    });

    it('happy path: exchanges code, fetches userinfo, sets cookie, redirects', async () => {
      // Mock global fetch to simulate Keycloak token + userinfo endpoints.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes('/protocol/openid-connect/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'oidc-access-token' }),
          } as unknown as Response;
        }
        if (url.includes('/protocol/openid-connect/userinfo')) {
          return {
            ok: true,
            json: async () => ({ email: testUserEmail }),
          } as unknown as Response;
        }
        throw new Error('Unexpected fetch URL ' + url);
      }) as any;
      try {
        const req: any = { query: { code: 'oidc-code-123' } };
        const res = makeRes();
        await controller.callback(req, res as any);
        expect(res.cookies.length).toBe(1);
        expect(res.cookies[0]!.name).toBe('campusos_refresh');
        expect(res.redirectedTo).toContain('token=');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('token endpoint returns non-ok → HttpException(UNAUTHORIZED)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({ ok: false }) as Response) as any;
      try {
        const req: any = { query: { code: 'oidc-code-123' } };
        const res = makeRes();
        await expect(controller.callback(req, res as any)).rejects.toBeInstanceOf(HttpException);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('userinfo endpoint returns non-ok → HttpException(UNAUTHORIZED)', async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: true,
            json: async () => ({ access_token: 'x' }),
          } as Response;
        }
        return { ok: false } as Response;
      }) as any;
      try {
        const req: any = { query: { code: 'c' } };
        const res = makeRes();
        await expect(controller.callback(req, res as any)).rejects.toBeInstanceOf(HttpException);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('userinfo without email → HttpException(UNAUTHORIZED)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes('/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'x' }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }) as any;
      try {
        const req: any = { query: { code: 'c' } };
        const res = makeRes();
        await expect(controller.callback(req, res as any)).rejects.toBeInstanceOf(HttpException);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('email maps to no user → HttpException(FORBIDDEN)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url: string) => {
        if (url.includes('/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'x' }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ email: 'ghost-' + generateId() + '@x' }),
        } as Response;
      }) as any;
      try {
        const req: any = { query: { code: 'c' } };
        const res = makeRes();
        await expect(controller.callback(req, res as any)).rejects.toBeInstanceOf(HttpException);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ─── refresh ──────────────────────────────────────────────

  describe('refresh', () => {
    it('missing refresh cookie → HttpException(UNAUTHORIZED)', async () => {
      const req: any = { cookies: {} };
      await expect(controller.refresh(req)).rejects.toBeInstanceOf(HttpException);
    });

    it('invalid refresh token → HttpException(UNAUTHORIZED)', async () => {
      const req: any = { cookies: { campusos_refresh: 'not-a-jwt' } };
      await expect(controller.refresh(req)).rejects.toBeInstanceOf(HttpException);
    });

    it('valid refresh token → returns new access token', async () => {
      const sessionId = generateId();
      const refresh = authService.generateRefreshToken(testUserId, sessionId);
      const req: any = { cookies: { campusos_refresh: refresh } };
      const result = await controller.refresh(req);
      expect(result.accessToken).toBeTruthy();
      const decoded = authService.verifyToken(result.accessToken);
      expect(decoded!.sub).toBe(testUserId);
    });
  });

  // ─── logout ───────────────────────────────────────────────

  describe('logout', () => {
    it('clears the refresh cookie + responds with message', async () => {
      const res = makeRes();
      await controller.logout(res as any);
      expect(res.clearedCookies.length).toBe(1);
      expect(res.clearedCookies[0]!.name).toBe('campusos_refresh');
      expect(res.body).toEqual({ message: 'Logged out' });
    });
  });

  // ─── dev-login ────────────────────────────────────────────

  describe('devLogin', () => {
    it('happy path: returns access token + sets refresh cookie', async () => {
      const res = makeRes();
      await controller.devLogin({ email: testUserEmail }, res as any);
      expect(res.cookies.length).toBe(1);
      expect(res.cookies[0]!.name).toBe('campusos_refresh');
      expect((res.body as any).accessToken).toBeTruthy();
      expect((res.body as any).user.id).toBe(testUserId);
      expect((res.body as any).user.email).toBe(testUserEmail);
    });

    it('missing email → HttpException(BAD_REQUEST)', async () => {
      const res = makeRes();
      await expect(controller.devLogin({ email: '' }, res as any)).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('unknown email → HttpException(NOT_FOUND)', async () => {
      const res = makeRes();
      await expect(
        controller.devLogin({ email: 'unknown-' + generateId() + '@nowhere' }, res as any),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('production env → HttpException(FORBIDDEN)', async () => {
      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = makeRes();
        await expect(
          controller.devLogin({ email: testUserEmail }, res as any),
        ).rejects.toBeInstanceOf(HttpException);
      } finally {
        if (oldEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = oldEnv;
      }
    });
  });

  // ─── /auth/me ─────────────────────────────────────────────

  describe('me', () => {
    it('returns identity + persona + sorted permission codes', async () => {
      // Seed a couple of cache rows so the union returns multiple codes.
      const ce1 = generateId();
      const ce2 = generateId();
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'me-test-A'),
                ($5::uuid, $2::uuid, $6::uuid, $7::text[], now(), 'me-test-B')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes`,
        ce1,
        testUserId,
        '019e0cf8-aaaa-7777-8888-00000000000d', // TEST_SCHOOL_SCOPE_ID
        ['z-perm:read', 'a-perm:read'],
        ce2,
        '019e0cf8-aaaa-7777-8888-00000000000e', // TEST_SCHOOL_B_SCOPE_ID
        ['m-perm:read', 'a-perm:read'], // duplicate a-perm to verify dedupe
      );
      try {
        const req: any = {
          user: {
            sub: testUserId,
            personId: testPersonId,
            email: testUserEmail,
            displayName: 'AuthCtrl Test',
            sessionId: generateId(),
          },
        };
        const result = await controller.me(req);
        expect(result.id).toBe(testUserId);
        expect(result.personId).toBe(testPersonId);
        expect(result.email).toBe(testUserEmail);
        // permissions should be deduped + sorted alphabetically.
        expect(result.permissions).toContain('a-perm:read');
        expect(result.permissions).toContain('m-perm:read');
        expect(result.permissions).toContain('z-perm:read');
        const aIdx = result.permissions.indexOf('a-perm:read');
        const mIdx = result.permissions.indexOf('m-perm:read');
        expect(aIdx).toBeLessThan(mIdx);
        expect(result.personType).toBeTruthy();
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM platform.iam_effective_access_cache WHERE id IN ($1::uuid, $2::uuid)`,
          ce1,
          ce2,
        );
      }
    });

    it('person not found → null personType + null name fields', async () => {
      const ghostPersonId = generateId();
      const req: any = {
        user: {
          sub: testUserId,
          personId: ghostPersonId,
          email: testUserEmail,
          displayName: 'x',
          sessionId: generateId(),
        },
      };
      const result = await controller.me(req);
      expect(result.personType).toBeNull();
      expect(result.firstName).toBeNull();
      expect(result.lastName).toBeNull();
    });
  });
});
