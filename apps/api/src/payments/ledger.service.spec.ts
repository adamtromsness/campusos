import { describe, it, expect } from 'vitest';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { LedgerService } from './ledger.service';

/**
 * P2-H4 test coverage uplift — payments/ledger.service.ts (151 LOC, Tier 1
 * Financial; foundational IMMUTABLE ledger service backing every invoice
 * + payment + refund write).
 *
 * Tests cover:
 *   - recordEntry: INSERT shape + Redis cache invalidation
 *   - getBalance: Redis cache hit returns cached=true + skips DB
 *   - getBalance: cache miss → SUM(amount) over pay_ledger_entries
 *     + warms cache + returns cached=false
 *   - getBalance: zero rows defaults to '0'
 *   - listEntries: limit defaults to 50, caps at 200, honors override
 *   - listEntries: optional before cursor + referenceId filter
 *   - listEntries: ORDER BY created_at DESC keyset pagination
 *   - rowToDto coerces NUMERIC string + nullable fields
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

interface FakeOpts {
  cachedBalance?: string | null;
  sumRows?: Array<{ bal: string }>;
  rowsForList?: unknown[];
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const redisCalls: { kind: 'get' | 'set' | 'invalidate'; accountId: string; value?: string }[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('coalesce(sum(amount), 0)::text as bal')) {
        return opts.sumRows ?? [{ bal: '0' }];
      }
      if (s.includes('from pay_ledger_entries')) {
        return opts.rowsForList ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  const redis = {
    getLedgerBalance: async (accountId: string) => {
      redisCalls.push({ kind: 'get', accountId });
      return opts.cachedBalance ?? null;
    },
    setLedgerBalance: async (accountId: string, value: string) => {
      redisCalls.push({ kind: 'set', accountId, value });
    },
    invalidateLedgerBalance: async (accountId: string) => {
      redisCalls.push({ kind: 'invalidate', accountId });
    },
  };
  return { tenantPrisma, redis, capture, redisCalls, client };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, fn);
}

const sampleRow = {
  id: 'ent-1',
  family_account_id: 'fa-1',
  entry_type: 'CHARGE',
  amount: '400.00',
  reference_id: 'inv-1',
  description: 'Tech Fee 2026',
  created_by: 'acc-admin',
  created_at: '2026-04-28T10:00:00Z',
};

describe('LedgerService.recordEntry — internal-only writer', () => {
  it('issues INSERT with the right column order + invalidates cache', async () => {
    const { tenantPrisma, redis, capture, redisCalls } = makeFake();
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    const txClient = {
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    let id: string | undefined;
    await inTenant(async () => {
      id = await svc.recordEntry(txClient as never, {
        familyAccountId: 'fa-1',
        entryType: 'CHARGE',
        amount: 400,
        referenceId: 'inv-1',
        description: 'Tech Fee 2026',
        createdBy: 'acc-admin',
      });
    });
    expect(id).toBeDefined();
    expect(id!.length).toBeGreaterThan(0);
    const insert = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_ledger_entries'));
    expect(insert).toBeTruthy();
    expect(insert!.args[0]).toBe(id);
    expect(insert!.args[1]).toBe('fa-1');
    expect(insert!.args[2]).toBe('CHARGE');
    expect(insert!.args[3]).toBe('400.00');
    expect(insert!.args[4]).toBe('inv-1');
    expect(insert!.args[5]).toBe('Tech Fee 2026');
    expect(insert!.args[6]).toBe('acc-admin');
    // void-call so Redis call may be scheduled before recordEntry returns
    // but is not awaited; assert it eventually lands
    await new Promise((r) => setTimeout(r, 5));
    const invalidate = redisCalls.find((c) => c.kind === 'invalidate');
    expect(invalidate?.accountId).toBe('fa-1');
  });

  it('writes negative amounts (PAYMENT convention) verbatim', async () => {
    const { tenantPrisma, redis, capture } = makeFake();
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    const txClient = {
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    await inTenant(async () => {
      await svc.recordEntry(txClient as never, {
        familyAccountId: 'fa-1',
        entryType: 'PAYMENT',
        amount: -200,
        referenceId: 'pay-1',
        description: null,
        createdBy: null,
      });
    });
    const insert = capture.find((c) => c.fn === 'e');
    expect(insert!.args[2]).toBe('PAYMENT');
    expect(insert!.args[3]).toBe('-200.00');
    expect(insert!.args[5]).toBeNull();
    expect(insert!.args[6]).toBeNull();
  });

  it('rounds sub-cent residue to 2dp via toFixed(2)', async () => {
    const { tenantPrisma, redis, capture } = makeFake();
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    const txClient = {
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    await inTenant(async () => {
      await svc.recordEntry(txClient as never, {
        familyAccountId: 'fa-1',
        entryType: 'CHARGE',
        amount: 33.337,
        referenceId: null,
        description: null,
        createdBy: null,
      });
    });
    const insert = capture.find((c) => c.fn === 'e');
    expect(insert!.args[3]).toBe('33.34');
  });
});

describe('LedgerService.getBalance', () => {
  it('cache hit returns cached=true and skips DB SUM', async () => {
    const { tenantPrisma, redis, capture, redisCalls } = makeFake({
      cachedBalance: '400.00',
    });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    let result: { balance: number; cached: boolean; familyAccountId: string } | undefined;
    await inTenant(async () => {
      result = await svc.getBalance('fa-1');
    });
    expect(result?.balance).toBe(400);
    expect(result?.cached).toBe(true);
    expect(result?.familyAccountId).toBe('fa-1');
    // No SUM query should fire on cache hit
    const sumQuery = capture.find((c) => c.sql.toLowerCase().includes('sum(amount)'));
    expect(sumQuery).toBeUndefined();
    // setLedgerBalance not called on cache hit
    const setCall = redisCalls.find((c) => c.kind === 'set');
    expect(setCall).toBeUndefined();
  });

  it('cache miss falls back to SUM(amount) + warms cache + returns cached=false', async () => {
    const { tenantPrisma, redis, capture, redisCalls } = makeFake({
      cachedBalance: null,
      sumRows: [{ bal: '350.00' }],
    });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    let result: { balance: number; cached: boolean } | undefined;
    await inTenant(async () => {
      result = await svc.getBalance('fa-1');
    });
    expect(result?.balance).toBe(350);
    expect(result?.cached).toBe(false);
    expect(capture.length).toBe(1);
    expect(capture[0]!.sql.toLowerCase()).toContain('sum(amount)');
    const setCall = redisCalls.find((c) => c.kind === 'set');
    expect(setCall?.value).toBe('350.00');
  });

  it('zero rows defaults to balance=0', async () => {
    const { tenantPrisma, redis } = makeFake({
      cachedBalance: null,
      sumRows: [],
    });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    let result: { balance: number } | undefined;
    await inTenant(async () => {
      result = await svc.getBalance('fa-empty');
    });
    expect(result?.balance).toBe(0);
  });

  it('handles negative cached balance string', async () => {
    const { tenantPrisma, redis } = makeFake({ cachedBalance: '-50.00' });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    let result: { balance: number } | undefined;
    await inTenant(async () => {
      result = await svc.getBalance('fa-credit');
    });
    expect(result?.balance).toBe(-50);
  });
});

describe('LedgerService.listEntries', () => {
  it('default limit is 50 and ORDER BY created_at DESC', async () => {
    const { tenantPrisma, redis, capture } = makeFake({ rowsForList: [sampleRow] });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    await inTenant(async () => {
      await svc.listEntries('fa-1', {} as never);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('order by created_at desc');
    expect(sql).toContain('limit $');
    expect(capture[0]!.args[capture[0]!.args.length - 1]).toBe(50);
  });

  it('caps limit at 200', async () => {
    const { tenantPrisma, redis, capture } = makeFake({ rowsForList: [] });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    await inTenant(async () => {
      await svc.listEntries('fa-1', { limit: 500 } as never);
    });
    expect(capture[0]!.args[capture[0]!.args.length - 1]).toBe(200);
  });

  it('honors smaller limit override', async () => {
    const { tenantPrisma, redis, capture } = makeFake({ rowsForList: [] });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    await inTenant(async () => {
      await svc.listEntries('fa-1', { limit: 10 } as never);
    });
    expect(capture[0]!.args[capture[0]!.args.length - 1]).toBe(10);
  });

  it('appends before cursor when provided', async () => {
    const { tenantPrisma, redis, capture } = makeFake({ rowsForList: [] });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    await inTenant(async () => {
      await svc.listEntries('fa-1', { before: '2026-04-28T00:00:00Z' } as never);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('and created_at < $2::timestamptz');
    expect(capture[0]!.args[1]).toBe('2026-04-28T00:00:00Z');
  });

  it('appends referenceId filter when provided', async () => {
    const { tenantPrisma, redis, capture } = makeFake({ rowsForList: [] });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    await inTenant(async () => {
      await svc.listEntries('fa-1', { referenceId: 'inv-1' } as never);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('and reference_id = $2::uuid');
    expect(capture[0]!.args[1]).toBe('inv-1');
  });

  it('chains before AND referenceId filters with correct positional binding', async () => {
    const { tenantPrisma, redis, capture } = makeFake({ rowsForList: [] });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    await inTenant(async () => {
      await svc.listEntries('fa-1', {
        before: '2026-04-28T00:00:00Z',
        referenceId: 'inv-1',
      } as never);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('and created_at < $2::timestamptz');
    expect(sql).toContain('and reference_id = $3::uuid');
    expect(sql).toContain('limit $4::int');
    expect(capture[0]!.args).toEqual([
      'fa-1',
      '2026-04-28T00:00:00Z',
      'inv-1',
      50,
    ]);
  });

  it('rowToDto coerces NUMERIC string + preserves nullable fields', async () => {
    const { tenantPrisma, redis } = makeFake({
      rowsForList: [
        sampleRow,
        {
          id: 'ent-2',
          family_account_id: 'fa-1',
          entry_type: 'PAYMENT',
          amount: '-200.00',
          reference_id: null,
          description: null,
          created_by: null,
          created_at: '2026-04-29T10:00:00Z',
        },
      ],
    });
    const svc = new LedgerService(tenantPrisma as never, redis as never);
    let entries: Array<{
      amount: number;
      referenceId: string | null;
      description: string | null;
      createdBy: string | null;
    }> = [];
    await inTenant(async () => {
      entries = await svc.listEntries('fa-1', {} as never);
    });
    expect(entries[0]!.amount).toBe(400);
    expect(entries[0]!.referenceId).toBe('inv-1');
    expect(entries[1]!.amount).toBe(-200);
    expect(entries[1]!.referenceId).toBeNull();
    expect(entries[1]!.description).toBeNull();
    expect(entries[1]!.createdBy).toBeNull();
  });
});
