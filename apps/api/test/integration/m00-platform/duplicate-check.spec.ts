import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { DuplicateCheckService } from '@modules/m00-platform/iam/duplicate-check.service';
import { RedisService } from '@shared/cache';

/**
 * Account Creation spec, Step 3 — privacy-safe duplicate detection.
 *
 * Verifies the strong-match rules, the minimal-disclosure contract (no
 * email / DOB / contact in the payload), the managed-by-me flag, and the
 * per-caller rate limit.
 */
describe('integration:m00-platform/duplicate-check', () => {
  let prisma: PrismaClient;
  let redis: RedisService;
  let svc: DuplicateCheckService;

  const caller = generateId();
  const callerAccount = generateId();
  // An existing person the caller might be re-creating.
  const existing = generateId();
  const existingAccount = generateId();
  // A managed minor the caller already owns.
  const managed = generateId();
  const managedAccount = generateId();
  const ALL = [caller, existing, managed];

  const EXISTING_EMAIL = `alivia.t.${existing.slice(-6)}@example.invalid`;
  const EXISTING_DOB = '2010-05-04';

  async function seedPerson(
    id: string,
    first: string,
    last: string,
    personType: string,
    dob: string | null,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, date_of_birth, is_active)
       VALUES ($1::uuid, $2, $3, $4::"PersonType", $5::date, true)
       ON CONFLICT (id) DO NOTHING`,
      id,
      first,
      last,
      personType,
      dob,
    );
  }

  async function seedAccount(
    accountId: string,
    personId: string,
    email: string,
    managedBy: string | null,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled, managed_by_person_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false, $5::uuid)
       ON CONFLICT (id) DO NOTHING`,
      accountId,
      personId,
      email,
      'Seed',
      managedBy,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    svc = new DuplicateCheckService(prisma, redis);

    await seedPerson(caller, 'Caller', 'Test', 'GUARDIAN', null);
    await seedAccount(callerAccount, caller, `caller.${caller.slice(-6)}@example.invalid`, null);

    await seedPerson(existing, 'Alivia', 'Thompson', 'STUDENT', EXISTING_DOB);
    await seedAccount(existingAccount, existing, EXISTING_EMAIL, null);

    await seedPerson(managed, 'Mason', 'Test', 'STUDENT', '2015-09-09');
    await seedAccount(managedAccount, managed, `mason.${managed.slice(-6)}@minor.invalid`, caller);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE person_id = ANY($1::uuid[])`,
      ALL,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
      ALL,
    );
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await redis.cacheInvalidate(`dupcheck:${caller}`);
  });

  // ─── Strong match: email ──────────────────────────────────────

  it('exact email → match with minimal descriptor only (no PII)', async () => {
    const res = await svc.check(caller, { email: EXISTING_EMAIL });
    expect(res.exists).toBe(true);
    expect(res.displayName).toBe('Alivia T.');
    expect(res.context).toBe('Student');
    expect(res.alreadyManagedByCurrentUser).toBe(false);

    // The disclosure contract: only these four keys, never raw PII.
    expect(Object.keys(res).sort()).toEqual(
      ['alreadyManagedByCurrentUser', 'context', 'displayName', 'exists'].sort(),
    );
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(EXISTING_EMAIL);
    expect(serialized).not.toContain(EXISTING_DOB);
    expect(serialized).not.toContain('Thompson'); // full last name never leaks
  });

  // ─── Strong match: name + DOB ─────────────────────────────────

  it('exact name + DOB → match', async () => {
    const res = await svc.check(caller, {
      firstName: 'alivia',
      lastName: 'THOMPSON',
      dateOfBirth: EXISTING_DOB,
    });
    expect(res.exists).toBe(true);
    expect(res.displayName).toBe('Alivia T.');
  });

  // ─── Enumeration guard: name-only / partial ───────────────────

  it('name only (no DOB) → NO match (enumeration guard)', async () => {
    const res = await svc.check(caller, { firstName: 'Alivia', lastName: 'Thompson' });
    expect(res.exists).toBe(false);
    expect(res.displayName).toBeUndefined();
  });

  it('name + wrong DOB → NO match', async () => {
    const res = await svc.check(caller, {
      firstName: 'Alivia',
      lastName: 'Thompson',
      dateOfBirth: '1999-01-01',
    });
    expect(res.exists).toBe(false);
  });

  it('empty probe (nothing usable) → NO match', async () => {
    const res = await svc.check(caller, {});
    expect(res.exists).toBe(false);
  });

  // ─── managed-by-me flag ───────────────────────────────────────

  it('match on a caller-managed account → alreadyManagedByCurrentUser true', async () => {
    const res = await svc.check(caller, {
      firstName: 'Mason',
      lastName: 'Test',
      dateOfBirth: '2015-09-09',
    });
    expect(res.exists).toBe(true);
    expect(res.alreadyManagedByCurrentUser).toBe(true);
  });

  // ─── self-exclusion ───────────────────────────────────────────

  it('caller never matches themselves by email', async () => {
    const res = await svc.check(caller, {
      email: `caller.${caller.slice(-6)}@example.invalid`,
    });
    expect(res.exists).toBe(false);
  });

  // ─── rate limit ───────────────────────────────────────────────

  it('exceeding the per-caller limit → 429', async () => {
    // 30 allowed in the window; the 31st throws.
    let threw = false;
    for (let i = 0; i < 31; i++) {
      try {
        await svc.check(caller, { email: EXISTING_EMAIL });
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(429);
      }
    }
    expect(threw).toBe(true);
  });
});
