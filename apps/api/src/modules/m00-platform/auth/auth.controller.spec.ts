import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { STUDENT_OWNED_KEY, StudentOwned } from '@shared/auth';

/**
 * P2-H4 test coverage uplift — auth.controller.ts (245 LOC) +
 * student-owned.decorator.ts (61 LOC). Both critical-path Tier 2 ≥95%.
 *
 * AuthController exposes 6 endpoints:
 *   - GET /auth/login        → redirect to OIDC issuer
 *   - GET /auth/callback     → OIDC code exchange + IdP userinfo
 *   - POST /auth/refresh     → refresh token from HttpOnly cookie
 *   - POST /auth/logout      → clear cookie
 *   - POST /auth/dev-login   → dev-only email-direct login (refuses in prod)
 *   - GET /auth/me           → identity + persona + permission codes
 *
 * StudentOwned() is a SetMetadata wrapper validated via Reflect.
 */

interface ResStub {
  redirects: string[];
  cookies: Array<{ name: string; value: string; options: unknown }>;
  clearedCookies: Array<{ name: string; options: unknown }>;
  jsonPayloads: unknown[];
  redirect: (url: string) => void;
  cookie: (name: string, value: string, options: unknown) => ResStub;
  clearCookie: (name: string, options: unknown) => ResStub;
  json: (payload: unknown) => ResStub;
}

function makeRes(): ResStub {
  const r: Partial<ResStub> = {
    redirects: [],
    cookies: [],
    clearedCookies: [],
    jsonPayloads: [],
  };
  r.redirect = (url: string) => {
    r.redirects!.push(url);
  };
  r.cookie = (name: string, value: string, options: unknown) => {
    r.cookies!.push({ name, value, options });
    return r as ResStub;
  };
  r.clearCookie = (name: string, options: unknown) => {
    r.clearedCookies!.push({ name, options });
    return r as ResStub;
  };
  r.json = (payload: unknown) => {
    r.jsonPayloads!.push(payload);
    return r as ResStub;
  };
  return r as ResStub;
}

function makeReq(
  opts: { query?: Record<string, string>; cookies?: Record<string, string>; user?: unknown } = {},
) {
  return { query: opts.query ?? {}, cookies: opts.cookies ?? {}, user: opts.user };
}

function makeAuthService(
  impl: {
    authenticateByEmail?: (email: string) => Promise<unknown>;
    refreshAccessToken?: (token: string) => Promise<unknown>;
  } = {},
) {
  return {
    authenticateByEmail: impl.authenticateByEmail ?? (async () => null),
    refreshAccessToken: impl.refreshAccessToken ?? (async () => null),
  };
}

function makePrisma(
  impl: {
    person?: {
      personType: string;
      firstName: string;
      lastName: string;
      preferredName: string | null;
    } | null;
    caches?: Array<{ permissionCodes: string[] }>;
  } = {},
) {
  return {
    iamPerson: {
      findUnique: async () => impl.person ?? null,
    },
    iamEffectiveAccessCache: {
      findMany: async () => impl.caches ?? [],
    },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('AuthController.login', () => {
  it('redirects to the OIDC issuer with the documented query string', () => {
    process.env.OIDC_ISSUER = 'https://idp.example.com/realms/test';
    process.env.OIDC_CLIENT_ID = 'campusos-api';
    process.env.API_BASE_URL = 'https://api.example.com';
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    ctrl.login(res as never);
    expect(res.redirects).toHaveLength(1);
    expect(res.redirects[0]).toContain(
      'https://idp.example.com/realms/test/protocol/openid-connect/auth',
    );
    expect(res.redirects[0]).toContain('client_id=campusos-api');
    expect(res.redirects[0]).toContain('response_type=code');
    expect(res.redirects[0]).toContain(
      'redirect_uri=' + encodeURIComponent('https://api.example.com/api/v1/auth/callback'),
    );
  });

  it('falls back to localhost defaults when env vars are unset', () => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.API_BASE_URL;
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    ctrl.login(res as never);
    expect(res.redirects[0]).toContain('http://localhost:8080/realms/campusos');
    expect(res.redirects[0]).toContain('client_id=campusos-api');
  });
});

describe('AuthController.callback (OIDC code exchange)', () => {
  it('throws BAD_REQUEST when no code is provided', async () => {
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    await expect(ctrl.callback(makeReq({}) as never, res as never)).rejects.toThrow(
      'No authorization code provided',
    );
  });

  it('throws UNAUTHORIZED when the token endpoint returns non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    await expect(
      ctrl.callback(makeReq({ query: { code: 'abc' } }) as never, res as never),
    ).rejects.toThrow('Failed to exchange authorization code');
  });

  it('throws UNAUTHORIZED when the userinfo endpoint returns non-OK', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at' }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: false } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    await expect(
      ctrl.callback(makeReq({ query: { code: 'abc' } }) as never, res as never),
    ).rejects.toThrow('Failed to get user info from IdP');
  });

  it('throws UNAUTHORIZED when IdP returns no email', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          /* no email */
        }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    await expect(
      ctrl.callback(makeReq({ query: { code: 'abc' } }) as never, res as never),
    ).rejects.toThrow('No email in IdP response');
  });

  it('throws FORBIDDEN when the email does not resolve to an ACTIVE CampusOS user', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: 'ghost@example.com' }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeAuthService({ authenticateByEmail: async () => null });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    const res = makeRes();
    await expect(
      ctrl.callback(makeReq({ query: { code: 'abc' } }) as never, res as never),
    ).rejects.toThrow('User not found or account inactive: ghost@example.com');
  });

  it('happy path: sets refresh cookie and redirects to frontend with access token', async () => {
    process.env.CORS_ORIGIN = 'https://app.example.com';
    process.env.NODE_ENV = 'development';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: 'sarah@example.com' }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeAuthService({
      authenticateByEmail: async () => ({
        accessToken: 'access-token-1',
        refreshToken: 'refresh-token-1',
        user: {
          sub: 'u1',
          personId: 'p1',
          email: 'sarah@example.com',
          displayName: 'Sarah',
          sessionId: 's1',
        },
      }),
    });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    const res = makeRes();
    await ctrl.callback(makeReq({ query: { code: 'abc' } }) as never, res as never);
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].name).toBe('campusos_refresh');
    expect(res.cookies[0].value).toBe('refresh-token-1');
    const cookieOpts = res.cookies[0].options as {
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    };
    expect(cookieOpts.httpOnly).toBe(true);
    expect(cookieOpts.secure).toBe(false); // NODE_ENV=development
    expect(cookieOpts.sameSite).toBe('strict');
    expect(res.redirects[0]).toBe('https://app.example.com?token=access-token-1');
  });

  it('sets secure=true on the refresh cookie when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'at' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: 'sarah@example.com' }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeAuthService({
      authenticateByEmail: async () => ({
        accessToken: 'a',
        refreshToken: 'r',
        user: { sub: 'u', personId: 'p', email: 'e', displayName: 'd', sessionId: 's' },
      }),
    });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    const res = makeRes();
    await ctrl.callback(makeReq({ query: { code: 'abc' } }) as never, res as never);
    expect((res.cookies[0].options as { secure: boolean }).secure).toBe(true);
  });
});

describe('AuthController.refresh', () => {
  it('throws UNAUTHORIZED when no refresh cookie is present', async () => {
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    await expect(ctrl.refresh(makeReq({}) as never)).rejects.toThrow('No refresh token');
  });

  it('throws UNAUTHORIZED when the service rejects the refresh token', async () => {
    const auth = makeAuthService({ refreshAccessToken: async () => null });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    await expect(
      ctrl.refresh(makeReq({ cookies: { campusos_refresh: 'expired' } }) as never),
    ).rejects.toThrow('Invalid or expired refresh token');
  });

  it('returns the fresh access token on success', async () => {
    const auth = makeAuthService({
      refreshAccessToken: async () => ({ accessToken: 'fresh-token' }),
    });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    const result = await ctrl.refresh(makeReq({ cookies: { campusos_refresh: 'valid' } }) as never);
    expect(result).toEqual({ accessToken: 'fresh-token' });
  });
});

describe('AuthController.logout', () => {
  it('clears the refresh cookie and returns a JSON acknowledgement', async () => {
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    const res = makeRes();
    await ctrl.logout(res as never);
    expect(res.clearedCookies).toHaveLength(1);
    expect(res.clearedCookies[0].name).toBe('campusos_refresh');
    expect((res.clearedCookies[0].options as { path: string }).path).toBe('/api/v1/auth');
    expect(res.jsonPayloads).toEqual([{ message: 'Logged out' }]);
  });
});

describe('AuthController.devLogin', () => {
  it('refuses with FORBIDDEN when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    await expect(ctrl.devLogin({ email: 'sarah@example.com' }, makeRes() as never)).rejects.toThrow(
      'Dev login is not available in production',
    );
  });

  it('throws BAD_REQUEST when email is missing', async () => {
    process.env.NODE_ENV = 'development';
    const ctrl = new AuthController(makeAuthService() as never, makePrisma() as never);
    await expect(ctrl.devLogin({ email: '' }, makeRes() as never)).rejects.toThrow(
      'Email is required',
    );
  });

  it('throws NOT_FOUND when email does not resolve', async () => {
    process.env.NODE_ENV = 'development';
    const auth = makeAuthService({ authenticateByEmail: async () => null });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    await expect(ctrl.devLogin({ email: 'ghost@example.com' }, makeRes() as never)).rejects.toThrow(
      'User not found: ghost@example.com',
    );
  });

  it('happy path: sets cookie + returns access token + user shape', async () => {
    process.env.NODE_ENV = 'development';
    const auth = makeAuthService({
      authenticateByEmail: async () => ({
        accessToken: 'AT',
        refreshToken: 'RT',
        user: {
          sub: 'u1',
          personId: 'p1',
          email: 'sarah@example.com',
          displayName: 'Sarah',
          sessionId: 's1',
        },
      }),
    });
    const ctrl = new AuthController(auth as never, makePrisma() as never);
    const res = makeRes();
    await ctrl.devLogin({ email: 'sarah@example.com' }, res as never);
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].value).toBe('RT');
    expect(res.jsonPayloads).toEqual([
      {
        accessToken: 'AT',
        user: { id: 'u1', personId: 'p1', email: 'sarah@example.com', displayName: 'Sarah' },
      },
    ]);
  });
});

describe('AuthController.me', () => {
  it('returns identity + persona + sorted union of permission codes', async () => {
    const ctrl = new AuthController(
      makeAuthService() as never,
      makePrisma({
        person: {
          personType: 'STAFF',
          firstName: 'Sarah',
          lastName: 'Mitchell',
          preferredName: 'Sarah',
        },
        caches: [
          { permissionCodes: ['att-001:read', 'att-001:write'] },
          { permissionCodes: ['att-001:write', 'sch-001:admin'] }, // dup with first row
        ],
      }) as never,
    );
    const result = await ctrl.me(
      makeReq({
        user: { sub: 'u1', personId: 'p1', email: 'sarah@example.com', displayName: 'Sarah' },
      }) as never,
    );
    expect(result).toEqual({
      id: 'u1',
      personId: 'p1',
      email: 'sarah@example.com',
      displayName: 'Sarah',
      personType: 'STAFF',
      firstName: 'Sarah',
      lastName: 'Mitchell',
      preferredName: 'Sarah',
      permissions: ['att-001:read', 'att-001:write', 'sch-001:admin'], // sorted + deduped
    });
  });

  it('returns null persona/name fields when iam_person row is missing', async () => {
    const ctrl = new AuthController(
      makeAuthService() as never,
      makePrisma({ person: null, caches: [] }) as never,
    );
    const result = await ctrl.me(
      makeReq({ user: { sub: 'u1', personId: 'p1', email: 'e', displayName: 'd' } }) as never,
    );
    expect(result).toMatchObject({
      personType: null,
      firstName: null,
      lastName: null,
      preferredName: null,
      permissions: [],
    });
  });

  it('returns an empty permissions array when no effective-access-cache rows exist', async () => {
    const ctrl = new AuthController(
      makeAuthService() as never,
      makePrisma({
        person: { personType: 'STUDENT', firstName: 'Maya', lastName: 'Chen', preferredName: null },
        caches: [],
      }) as never,
    );
    const result = await ctrl.me(
      makeReq({ user: { sub: 'u1', personId: 'p1', email: 'e', displayName: 'd' } }) as never,
    );
    expect(result.permissions).toEqual([]);
    expect(result.personType).toBe('STUDENT');
    expect(result.preferredName).toBeNull();
  });
});

// student-owned.decorator.ts coverage — the marker SetMetadata decorator
describe('@StudentOwned() metadata decorator', () => {
  it('attaches STUDENT_OWNED_KEY metadata with the default options merged in', () => {
    class Sample {
      @StudentOwned({ studentIdBody: 'studentId' })
      create() {}
    }
    const meta = Reflect.getMetadata(STUDENT_OWNED_KEY, Sample.prototype.create);
    expect(meta).toEqual({
      allowAdminOverride: true,
      allowCoachDelegation: false,
      studentIdBody: 'studentId',
    });
  });

  it('allows callers to override allowAdminOverride and allowCoachDelegation', () => {
    class Sample {
      @StudentOwned({
        allowAdminOverride: false,
        allowCoachDelegation: true,
        studentIdParam: 'studentId',
      })
      mutate() {}
    }
    const meta = Reflect.getMetadata(STUDENT_OWNED_KEY, Sample.prototype.mutate);
    expect(meta).toEqual({
      allowAdminOverride: false,
      allowCoachDelegation: true,
      studentIdParam: 'studentId',
    });
  });

  it('supplies sane defaults when called with no options', () => {
    class Sample {
      @StudentOwned()
      bareMethod() {}
    }
    const meta = Reflect.getMetadata(STUDENT_OWNED_KEY, Sample.prototype.bareMethod);
    expect(meta).toEqual({ allowAdminOverride: true, allowCoachDelegation: false });
  });
});
