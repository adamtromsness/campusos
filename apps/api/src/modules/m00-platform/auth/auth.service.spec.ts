import { describe, it, expect, beforeEach } from 'vitest';
import { sign, decode } from 'jsonwebtoken';
import { AuthService, JwtPayload } from './auth.service';

/**
 * P2-H4 test coverage uplift — auth.service.ts (154 LOC, critical-path Tier 2 ≥95%).
 *
 * AuthService is the JWT issuer/validator. CampusOS never stores passwords;
 * authentication is delegated to the external IdP. This spec covers:
 *   - generateAccessToken / generateRefreshToken — JWT signing shape
 *   - verifyToken — payload return / tampered + invalid + expired → null
 *   - authenticateByEmail — happy path, missing user, non-ACTIVE statuses,
 *     displayName fallback, lastSeenAt update, auth-event audit row
 *   - refreshAccessToken — happy path, invalid token, missing user,
 *     non-ACTIVE status, sessionId preservation
 */

const FIXED_SECRET = 'test-secret-fixed-for-deterministic-spec-runs';

interface FakeUser {
  id: string;
  personId: string;
  email: string;
  displayName: string | null;
  accountStatus: string;
  person: { firstName: string; lastName: string };
}

interface CapturedAuthEvent {
  id: string;
  accountId: string;
  eventType: string;
  sessionId: string;
  eventAt: Date;
}

function makePrisma(initial: { users?: FakeUser[] } = {}) {
  const users = new Map<string, FakeUser>();
  for (const u of initial.users ?? []) {
    users.set(u.id, u);
  }
  const usersByEmail = (email: string) => {
    for (const u of users.values()) {
      if (u.email === email) return u;
    }
    return null;
  };

  const lastSeenUpdates: Array<{ id: string; lastSeenAt: Date }> = [];
  const authEvents: CapturedAuthEvent[] = [];

  const prisma = {
    platformUser: {
      findUnique: async (args: { where: { id?: string; email?: string } }) => {
        const u = args.where.id
          ? (users.get(args.where.id) ?? null)
          : usersByEmail(args.where.email!);
        return u;
      },
      update: async (args: { where: { id: string }; data: { lastSeenAt: Date } }) => {
        const u = users.get(args.where.id);
        if (!u) throw new Error('user not found');
        lastSeenUpdates.push({ id: args.where.id, lastSeenAt: args.data.lastSeenAt });
        return u;
      },
    },
    iamAuthEvent: {
      create: async (args: { data: CapturedAuthEvent }) => {
        authEvents.push(args.data);
        return args.data;
      },
    },
  };

  return { prisma, users, lastSeenUpdates, authEvents };
}

function makeService(prisma: ReturnType<typeof makePrisma>['prisma']) {
  process.env.JWT_SECRET = FIXED_SECRET;
  return new AuthService(prisma as never);
}

const ACTIVE_USER: FakeUser = {
  id: '019e0cf8-bbb8-7556-8c81-000000000001',
  personId: '019e0cf8-bbb8-7556-8c81-000000000002',
  email: 'sarah@demo.example',
  displayName: 'Sarah Mitchell',
  accountStatus: 'ACTIVE',
  person: { firstName: 'Sarah', lastName: 'Mitchell' },
};

describe('AuthService.generateAccessToken', () => {
  it('signs a 15-minute access token with the supplied payload', () => {
    const svc = makeService(makePrisma().prisma);
    const payload: JwtPayload = {
      sub: 'user-1',
      personId: 'person-1',
      email: 'a@b.c',
      displayName: 'A B',
      sessionId: 'sess-1',
    };
    const token = svc.generateAccessToken(payload);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // JWT format

    const decoded = decode(token) as JwtPayload & { exp: number; iat: number };
    expect(decoded.sub).toBe('user-1');
    expect(decoded.personId).toBe('person-1');
    expect(decoded.email).toBe('a@b.c');
    expect(decoded.displayName).toBe('A B');
    expect(decoded.sessionId).toBe('sess-1');
    expect(decoded.exp - decoded.iat).toBe(15 * 60); // 15 minutes
  });
});

describe('AuthService.generateRefreshToken', () => {
  it('signs a 7-day refresh token with type=refresh', () => {
    const svc = makeService(makePrisma().prisma);
    const token = svc.generateRefreshToken('user-1', 'sess-1');
    const decoded = decode(token) as {
      sub: string;
      sessionId: string;
      type: string;
      exp: number;
      iat: number;
    };
    expect(decoded.sub).toBe('user-1');
    expect(decoded.sessionId).toBe('sess-1');
    expect(decoded.type).toBe('refresh');
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60); // 7 days
  });
});

describe('AuthService.verifyToken', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = FIXED_SECRET;
  });

  it('returns the decoded payload for a valid token', () => {
    const svc = makeService(makePrisma().prisma);
    const token = svc.generateAccessToken({
      sub: 'user-1',
      personId: 'person-1',
      email: 'a@b.c',
      displayName: 'A',
      sessionId: 'sess-1',
    });
    const decoded = svc.verifyToken(token);
    expect(decoded?.sub).toBe('user-1');
    expect(decoded?.sessionId).toBe('sess-1');
  });

  it('returns null for a tampered token (wrong signature)', () => {
    const svc = makeService(makePrisma().prisma);
    const validToken = svc.generateAccessToken({
      sub: 'user-1',
      personId: 'person-1',
      email: 'a@b.c',
      displayName: 'A',
      sessionId: 'sess-1',
    });
    // Flip the last char of the signature to corrupt it
    const parts = validToken.split('.');
    const lastChar = parts[2].slice(-1);
    parts[2] = parts[2].slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');
    expect(svc.verifyToken(tampered)).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    const svc = makeService(makePrisma().prisma);
    const foreignToken = sign({ sub: 'attacker' }, 'different-secret');
    expect(svc.verifyToken(foreignToken)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const svc = makeService(makePrisma().prisma);
    const expired = sign({ sub: 'user-1', sessionId: 'sess-1' }, FIXED_SECRET, {
      expiresIn: '-1s',
    });
    expect(svc.verifyToken(expired)).toBeNull();
  });

  it('returns null for garbage input', () => {
    const svc = makeService(makePrisma().prisma);
    expect(svc.verifyToken('not-a-jwt')).toBeNull();
    expect(svc.verifyToken('')).toBeNull();
  });
});

describe('AuthService.authenticateByEmail', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = FIXED_SECRET;
  });

  it('returns null when the user does not exist', async () => {
    const fakes = makePrisma();
    const svc = makeService(fakes.prisma);
    const result = await svc.authenticateByEmail('nobody@example.com');
    expect(result).toBeNull();
    expect(fakes.lastSeenUpdates).toHaveLength(0);
    expect(fakes.authEvents).toHaveLength(0);
  });

  it('returns null when the account_status is not ACTIVE', async () => {
    for (const status of ['SUSPENDED', 'INACTIVE', 'PENDING_VERIFICATION', 'CLOSED']) {
      const fakes = makePrisma({ users: [{ ...ACTIVE_USER, accountStatus: status }] });
      const svc = makeService(fakes.prisma);
      const result = await svc.authenticateByEmail(ACTIVE_USER.email);
      expect(result, `should reject ${status}`).toBeNull();
      expect(fakes.lastSeenUpdates).toHaveLength(0);
      expect(fakes.authEvents).toHaveLength(0);
    }
  });

  it('happy path: issues tokens, updates lastSeenAt, logs LOGIN_SUCCESS auth event', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER }] });
    const svc = makeService(fakes.prisma);
    const result = await svc.authenticateByEmail(ACTIVE_USER.email);
    expect(result).not.toBeNull();
    expect(result!.user.sub).toBe(ACTIVE_USER.id);
    expect(result!.user.personId).toBe(ACTIVE_USER.personId);
    expect(result!.user.email).toBe(ACTIVE_USER.email);
    expect(result!.user.displayName).toBe('Sarah Mitchell');

    // Tokens are valid JWTs that verify against the service
    expect(svc.verifyToken(result!.accessToken)?.sub).toBe(ACTIVE_USER.id);
    expect(svc.verifyToken(result!.refreshToken)?.sub).toBe(ACTIVE_USER.id);

    // Side effects landed
    expect(fakes.lastSeenUpdates).toHaveLength(1);
    expect(fakes.lastSeenUpdates[0].id).toBe(ACTIVE_USER.id);

    expect(fakes.authEvents).toHaveLength(1);
    expect(fakes.authEvents[0].accountId).toBe(ACTIVE_USER.id);
    expect(fakes.authEvents[0].eventType).toBe('LOGIN_SUCCESS');
    expect(fakes.authEvents[0].sessionId).toBe(result!.user.sessionId);
  });

  it('falls back to "firstName lastName" when displayName is null', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER, displayName: null }] });
    const svc = makeService(fakes.prisma);
    const result = await svc.authenticateByEmail(ACTIVE_USER.email);
    expect(result?.user.displayName).toBe('Sarah Mitchell');
  });

  it('mints a fresh sessionId per login (not reused across logins)', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER }] });
    const svc = makeService(fakes.prisma);
    const r1 = await svc.authenticateByEmail(ACTIVE_USER.email);
    const r2 = await svc.authenticateByEmail(ACTIVE_USER.email);
    expect(r1!.user.sessionId).not.toBe(r2!.user.sessionId);
    expect(fakes.authEvents).toHaveLength(2);
    expect(fakes.authEvents[0].sessionId).not.toBe(fakes.authEvents[1].sessionId);
  });
});

describe('AuthService.refreshAccessToken', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = FIXED_SECRET;
  });

  it('returns null for a tampered / invalid refresh token', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER }] });
    const svc = makeService(fakes.prisma);
    expect(await svc.refreshAccessToken('not-a-jwt')).toBeNull();
    expect(await svc.refreshAccessToken('')).toBeNull();
  });

  it('returns null for a refresh token signed by a different secret', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER }] });
    const svc = makeService(fakes.prisma);
    const foreignRefresh = sign(
      { sub: ACTIVE_USER.id, sessionId: 'sess-X', type: 'refresh' },
      'different-secret',
      { expiresIn: '7d' },
    );
    expect(await svc.refreshAccessToken(foreignRefresh)).toBeNull();
  });

  it('returns null when the user (sub) no longer exists', async () => {
    const fakes = makePrisma({ users: [] });
    const svc = makeService(fakes.prisma);
    const refresh = svc.generateRefreshToken('gone-user', 'sess-1');
    expect(await svc.refreshAccessToken(refresh)).toBeNull();
  });

  it('returns null when the user has been deactivated since the refresh was issued', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER, accountStatus: 'SUSPENDED' }] });
    const svc = makeService(fakes.prisma);
    const refresh = svc.generateRefreshToken(ACTIVE_USER.id, 'sess-1');
    expect(await svc.refreshAccessToken(refresh)).toBeNull();
  });

  it('happy path: returns a fresh access token with the preserved sessionId', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER }] });
    const svc = makeService(fakes.prisma);
    const refresh = svc.generateRefreshToken(ACTIVE_USER.id, 'sess-123');
    const result = await svc.refreshAccessToken(refresh);
    expect(result).not.toBeNull();
    const decoded = svc.verifyToken(result!.accessToken);
    expect(decoded?.sub).toBe(ACTIVE_USER.id);
    expect(decoded?.sessionId).toBe('sess-123');
  });

  it('falls back to "firstName lastName" on refresh when displayName is null', async () => {
    const fakes = makePrisma({ users: [{ ...ACTIVE_USER, displayName: null }] });
    const svc = makeService(fakes.prisma);
    const refresh = svc.generateRefreshToken(ACTIVE_USER.id, 'sess-1');
    const result = await svc.refreshAccessToken(refresh);
    expect(svc.verifyToken(result!.accessToken)?.displayName).toBe('Sarah Mitchell');
  });
});
