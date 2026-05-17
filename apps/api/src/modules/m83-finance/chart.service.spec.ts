import { describe, it, expect } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import {
  ChartOfAccountsService,
  FundService,
  PeriodService,
  isUniqueViolation,
} from './chart.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — chart.service.ts (636 LOC, Tier 1 Financial
 * critical path).
 *
 * Three @Injectable services + 1 shared helper:
 *   - FundService — fin_funds CRUD (school-admin only writes)
 *   - ChartOfAccountsService — fin_chart_of_accounts CRUD with is_system
 *     protection (REVIEW-CYCLE26 MAJOR 7), plus trialBalance aggregate
 *   - PeriodService — fin_accounting_periods lifecycle with the LOCKED-is-
 *     terminal invariant + multi-column lockstep stamping on
 *     closed_at/closed_by + locked_at/locked_by
 *   - isUniqueViolation — shared helper consumed by every finance + payments
 *     service that catches Prisma raw 23505 errors. Three shapes: P2002
 *     short-form, P2010+meta.code='23505' long-form, message-contains-'23505'
 *     last-resort fallback.
 *
 * Coverage target: ≥95% (Tier 1 Financial).
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
  rowsForFunds?: unknown[];
  rowsForAccounts?: unknown[];
  rowsForAccountSystemLookup?: Array<{ is_system: boolean }>;
  rowsForTrialBalance?: unknown[];
  rowsForPeriods?: unknown[];
  rowsForPeriodLock?: Array<{ status: string }>;
  insertFail?: { code?: string; meta?: { code?: string }; message?: string };
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // Period FOR UPDATE lock
      if (s.includes('select status from fin_accounting_periods') && s.includes('for update')) {
        return opts.rowsForPeriodLock ?? [];
      }
      if (s.includes('from fin_accounting_periods')) {
        return opts.rowsForPeriods ?? [];
      }
      if (s.includes('from fin_funds')) {
        return opts.rowsForFunds ?? [];
      }
      // is_system check before account patch
      if (s.includes('select is_system from fin_chart_of_accounts') && s.includes('limit 1')) {
        return opts.rowsForAccountSystemLookup ?? [{ is_system: false }];
      }
      // Trial balance aggregate
      if (s.includes('left join (') && s.includes('fin_gl_entries')) {
        return opts.rowsForTrialBalance ?? [];
      }
      // SELECT_ACCOUNT_BASE
      if (s.includes('from fin_chart_of_accounts a')) {
        return opts.rowsForAccounts ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      const lower = sql.toLowerCase();
      if (
        opts.insertFail &&
        (lower.includes('insert into fin_funds') ||
          lower.includes('insert into fin_chart_of_accounts') ||
          lower.includes('insert into fin_accounting_periods'))
      ) {
        const e = new Error(opts.insertFail.message ?? 'unique violation') as Error & {
          code?: string;
          meta?: { code?: string };
        };
        if (opts.insertFail.code) e.code = opts.insertFail.code;
        if (opts.insertFail.meta) e.meta = opts.insertFail.meta;
        throw e;
      }
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  return { tenantPrisma, client, capture };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, fn);
}

const adminActor: ResolvedActor = {
  accountId: 'acc-admin',
  personId: 'pers-admin',
  personType: 'STAFF',
  isSchoolAdmin: true,
  employeeId: 'emp-admin',
};

const adminNoEmp: ResolvedActor = { ...adminActor, employeeId: null };

const staffActor: ResolvedActor = {
  accountId: 'acc-staff',
  personId: 'pers-staff',
  personType: 'STAFF',
  isSchoolAdmin: false,
  employeeId: 'emp-staff',
};

const parentActor: ResolvedActor = {
  accountId: 'acc-parent',
  personId: 'pers-parent',
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
};

describe('isUniqueViolation helper', () => {
  it('detects P2002 short-form', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('detects P2010 + meta.code=23505 long-form', () => {
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23505' } })).toBe(true);
  });

  it('detects 23505 in message as fallback', () => {
    expect(isUniqueViolation({ message: 'duplicate key value violates ... 23505' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isUniqueViolation({ message: 'connection refused' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('plain string')).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });

  it('rejects P2010 without meta.code=23505', () => {
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23503' } })).toBe(false);
    expect(isUniqueViolation({ code: 'P2010' })).toBe(false);
  });
});

const sampleFund = {
  id: 'f-1',
  school_id: SCHOOL.schoolId,
  fund_code: 'GENERAL',
  fund_name: 'General Fund',
  fund_type: 'GENERAL',
  description: 'Operating fund',
  is_active: true,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('FundService.list', () => {
  it('binds school_id and orders by fund_code', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForFunds: [sampleFund] });
    const svc = new FundService(tenantPrisma as never);
    let result: unknown[] = [];
    await inTenant(async () => {
      result = await svc.list();
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'f-1',
      fundCode: 'GENERAL',
      fundName: 'General Fund',
      fundType: 'GENERAL',
      isActive: true,
    });
    const read = capture.find((c) => c.fn === 'q');
    expect(read!.sql.toLowerCase()).toContain('order by fund_code');
    expect(read!.args).toEqual([SCHOOL.schoolId]);
  });
});

describe('FundService.getById', () => {
  it('returns NotFoundException when no row matches', async () => {
    const { tenantPrisma } = makeFake({ rowsForFunds: [] });
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('f-missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('returns DTO with school binding', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForFunds: [sampleFund] });
    const svc = new FundService(tenantPrisma as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.getById('f-1');
    });
    expect(result?.id).toBe('f-1');
    expect(capture[0]!.args).toEqual(['f-1', SCHOOL.schoolId]);
  });
});

describe('FundService.create', () => {
  it('rejects non-admin actor', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(staffActor, {
          fundCode: 'CAP',
          fundName: 'Capital',
          fundType: 'CAPITAL_PROJECTS',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('inserts fund row + reloads via getById', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForFunds: [sampleFund] });
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(adminActor, {
        fundCode: 'GENERAL',
        fundName: 'General Fund',
        fundType: 'GENERAL',
        description: 'Operating fund',
      });
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_funds'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('GENERAL');
    expect(insert!.args).toContain('General Fund');
  });

  it('translates UNIQUE violation into ConflictException with fund code', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'P2002' } });
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          fundCode: 'GENERAL',
          fundName: 'General',
          fundType: 'GENERAL',
        }),
      ).rejects.toThrow(/fund with code 'GENERAL' already exists/);
    });
  });

  it('rethrows non-UNIQUE errors unchanged', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'OTHER', message: 'db down' } });
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          fundCode: 'GENERAL',
          fundName: 'General',
          fundType: 'GENERAL',
        }),
      ).rejects.toThrow('db down');
    });
  });
});

describe('FundService.patch', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patch(staffActor, 'f-1', { fundName: 'New' })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('builds dynamic SET clause for partial updates', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForFunds: [sampleFund] });
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patch(adminActor, 'f-1', {
        fundName: 'Renamed',
        description: 'note',
        isActive: false,
      });
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update fin_funds'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('fund_name = $1');
    expect(update!.sql).toContain('description = $2');
    expect(update!.sql).toContain('is_active = $3');
    expect(update!.args).toEqual(['Renamed', 'note', false, 'f-1', SCHOOL.schoolId]);
  });

  it('skips UPDATE when no fields supplied + falls through to getById', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForFunds: [sampleFund] });
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patch(adminActor, 'f-1', {});
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update fin_funds'),
    );
    expect(update).toBeUndefined();
  });
});

const sampleAccount = {
  id: 'a-cash',
  school_id: SCHOOL.schoolId,
  account_code: '1000',
  account_name: 'Cash',
  account_type: 'ASSET',
  normal_balance: 'DEBIT',
  parent_account_id: null,
  parent_account_code: null,
  fund_id: 'f-1',
  fund_code: 'GENERAL',
  description: 'Operating cash',
  is_system: true,
  is_active: true,
  running_balance: '5000.50',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('ChartOfAccountsService.list', () => {
  it('filters inactive by default', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForAccounts: [sampleAccount] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list();
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('a.is_active = true');
  });

  it('includes inactive when flag set', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForAccounts: [sampleAccount] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list(true);
    });
    expect(capture[0]!.sql.toLowerCase()).not.toContain('a.is_active = true');
  });

  it('coerces running_balance to number', async () => {
    const { tenantPrisma } = makeFake({ rowsForAccounts: [sampleAccount] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    let result: Array<{ runningBalance: number }> = [];
    await inTenant(async () => {
      result = await svc.list();
    });
    expect(result[0]!.runningBalance).toBe(5000.5);
  });

  it('handles null running_balance', async () => {
    const { tenantPrisma } = makeFake({
      rowsForAccounts: [{ ...sampleAccount, running_balance: null }],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    let result: Array<{ runningBalance: number }> = [];
    await inTenant(async () => {
      result = await svc.list();
    });
    expect(result[0]!.runningBalance).toBe(0);
  });
});

describe('ChartOfAccountsService.getById', () => {
  it('returns NotFoundException when no row matches', async () => {
    const { tenantPrisma } = makeFake({ rowsForAccounts: [] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('a-missing')).rejects.toThrow(NotFoundException);
    });
  });
});

describe('ChartOfAccountsService.create', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(staffActor, {
          accountCode: '2000',
          accountName: 'AP',
          accountType: 'LIABILITY',
          normalBalance: 'CREDIT',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('inserts with optional fields defaulted to null/false', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForAccounts: [sampleAccount] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(adminActor, {
        accountCode: '5000',
        accountName: 'Supplies',
        accountType: 'EXPENSE',
        normalBalance: 'DEBIT',
      });
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_chart_of_accounts'),
    );
    expect(insert).toBeTruthy();
    // args: id, schoolId, code, name, type, normalBalance, parentId (null),
    // fundId (null), description (null), isSystem (false)
    expect(insert!.args[6]).toBeNull();
    expect(insert!.args[7]).toBeNull();
    expect(insert!.args[8]).toBeNull();
    expect(insert!.args[9]).toBe(false);
  });

  it('inserts with explicit isSystem flag + parent + fund', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForAccounts: [sampleAccount] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(adminActor, {
        accountCode: '1100',
        accountName: 'AR',
        accountType: 'ASSET',
        normalBalance: 'DEBIT',
        parentAccountId: 'a-cash',
        fundId: 'f-1',
        description: 'Receivable',
        isSystem: true,
      });
    });
    const insert = capture.find((c) => c.fn === 'e');
    expect(insert!.args[6]).toBe('a-cash');
    expect(insert!.args[7]).toBe('f-1');
    expect(insert!.args[8]).toBe('Receivable');
    expect(insert!.args[9]).toBe(true);
  });

  it('translates UNIQUE violation into Conflict with account code', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'P2002' } });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          accountCode: '1000',
          accountName: 'Cash',
          accountType: 'ASSET',
          normalBalance: 'DEBIT',
        }),
      ).rejects.toThrow(/account with code '1000' already exists/);
    });
  });

  it('rethrows non-UNIQUE errors unchanged', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'OTHER', message: 'broken' } });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          accountCode: '1',
          accountName: 'x',
          accountType: 'ASSET',
          normalBalance: 'DEBIT',
        }),
      ).rejects.toThrow('broken');
    });
  });
});

describe('ChartOfAccountsService.patch — is_system protection (REVIEW-CYCLE26 MAJOR 7)', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patch(staffActor, 'a-cash', { accountName: 'x' })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('NotFoundException when target row missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForAccountSystemLookup: [] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patch(adminActor, 'a-missing', { accountName: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('refuses accountName change on is_system row', async () => {
    const { tenantPrisma } = makeFake({
      rowsForAccountSystemLookup: [{ is_system: true }],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patch(adminActor, 'a-cash', { accountName: 'Renamed' })).rejects.toThrow(
        /System accounts.*accountName/,
      );
    });
  });

  it('refuses isActive change on is_system row', async () => {
    const { tenantPrisma } = makeFake({
      rowsForAccountSystemLookup: [{ is_system: true }],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patch(adminActor, 'a-cash', { isActive: false })).rejects.toThrow(
        /System accounts.*isActive/,
      );
    });
  });

  it('refuses parentAccountId + fundId changes on is_system row + lists ALL restricted in message', async () => {
    const { tenantPrisma } = makeFake({
      rowsForAccountSystemLookup: [{ is_system: true }],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.patch(adminActor, 'a-cash', {
          accountName: 'x',
          isActive: false,
          parentAccountId: 'p-1',
          fundId: 'f-2',
        }),
      ).rejects.toThrow(/accountName, isActive, parentAccountId, fundId/);
    });
  });

  it('allows description-only update on is_system row', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForAccountSystemLookup: [{ is_system: true }],
      rowsForAccounts: [sampleAccount],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patch(adminActor, 'a-cash', { description: 'updated note' });
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update fin_chart_of_accounts'),
    );
    expect(update).toBeTruthy();
    expect(update!.args).toContain('updated note');
  });

  it('allows all fields on non-system row', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForAccountSystemLookup: [{ is_system: false }],
      rowsForAccounts: [sampleAccount],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patch(adminActor, 'a-misc', {
        accountName: 'Renamed',
        description: 'note',
        isActive: false,
        parentAccountId: 'a-parent',
        fundId: 'f-2',
      });
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update fin_chart_of_accounts'),
    );
    expect(update!.sql).toContain('account_name = $1');
    expect(update!.sql).toContain('description = $2');
    expect(update!.sql).toContain('is_active = $3');
    expect(update!.sql).toContain('parent_account_id = $4::uuid');
    expect(update!.sql).toContain('fund_id = $5::uuid');
    expect(update!.args).toEqual([
      'Renamed',
      'note',
      false,
      'a-parent',
      'f-2',
      'a-misc',
      SCHOOL.schoolId,
    ]);
  });

  it('skips UPDATE when no fields supplied + falls through to getById', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForAccountSystemLookup: [{ is_system: false }],
      rowsForAccounts: [sampleAccount],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patch(adminActor, 'a-misc', {});
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update fin_chart_of_accounts'),
    );
    expect(update).toBeUndefined();
  });
});

describe('ChartOfAccountsService.trialBalance', () => {
  it('aggregates without period filter when periodId omitted', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForTrialBalance: [] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.trialBalance();
    });
    const read = capture[0]!;
    expect(read.sql.toLowerCase()).not.toContain('accounting_period_id');
    expect(read.args).toEqual([SCHOOL.schoolId]);
  });

  it('binds periodId when supplied', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForTrialBalance: [] });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.trialBalance('p-1');
    });
    const read = capture[0]!;
    expect(read.sql.toLowerCase()).toContain('b.accounting_period_id = $2::uuid');
    expect(read.args).toEqual([SCHOOL.schoolId, 'p-1']);
  });

  it('signs balance by normal_balance (DEBIT = debit-credit, CREDIT = credit-debit)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForTrialBalance: [
        {
          account_id: 'a-cash',
          account_code: '1000',
          account_name: 'Cash',
          account_type: 'ASSET',
          normal_balance: 'DEBIT',
          debit_total: '500',
          credit_total: '100',
        },
        {
          account_id: 'a-rev',
          account_code: '4000',
          account_name: 'Revenue',
          account_type: 'REVENUE',
          normal_balance: 'CREDIT',
          debit_total: '50',
          credit_total: '500',
        },
      ],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    let result:
      | {
          lines: Array<{ balance: number }>;
          totalDebit: number;
          totalCredit: number;
          balanced: boolean;
        }
      | undefined;
    await inTenant(async () => {
      result = await svc.trialBalance();
    });
    expect(result?.lines[0]!.balance).toBe(400); // 500 - 100
    expect(result?.lines[1]!.balance).toBe(450); // 500 - 50
    expect(result?.totalDebit).toBe(550);
    expect(result?.totalCredit).toBe(600);
    expect(result?.balanced).toBe(false);
  });

  it('flags balanced=true when totals match within tolerance', async () => {
    const { tenantPrisma } = makeFake({
      rowsForTrialBalance: [
        {
          account_id: 'a-1',
          account_code: '1000',
          account_name: 'Cash',
          account_type: 'ASSET',
          normal_balance: 'DEBIT',
          debit_total: '100',
          credit_total: '0',
        },
        {
          account_id: 'a-2',
          account_code: '4000',
          account_name: 'Rev',
          account_type: 'REVENUE',
          normal_balance: 'CREDIT',
          debit_total: '0',
          credit_total: '100',
        },
      ],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    let result: { balanced: boolean; totalDebit: number; totalCredit: number } | undefined;
    await inTenant(async () => {
      result = await svc.trialBalance();
    });
    expect(result?.balanced).toBe(true);
    expect(result?.totalDebit).toBe(100);
    expect(result?.totalCredit).toBe(100);
  });

  it('rounds totals to 2dp', async () => {
    const { tenantPrisma } = makeFake({
      rowsForTrialBalance: [
        {
          account_id: 'a-1',
          account_code: '1000',
          account_name: 'Cash',
          account_type: 'ASSET',
          normal_balance: 'DEBIT',
          debit_total: '100.001',
          credit_total: '0',
        },
      ],
    });
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    let result: { totalDebit: number } | undefined;
    await inTenant(async () => {
      result = await svc.trialBalance();
    });
    expect(result?.totalDebit).toBe(100);
  });
});

const samplePeriod = {
  id: 'p-1',
  school_id: SCHOOL.schoolId,
  fiscal_year: '2026',
  period_number: 1,
  period_name: 'January 2026',
  start_date: '2026-01-01',
  end_date: '2026-01-31',
  status: 'OPEN',
  closed_at: null,
  closed_by: null,
  locked_at: null,
  locked_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('PeriodService.list', () => {
  it('binds school_id + orders DESC fiscal_year', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForPeriods: [samplePeriod] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list();
    });
    const read = capture[0]!;
    expect(read.sql.toLowerCase()).toContain('order by fiscal_year desc');
    expect(read.args).toEqual([SCHOOL.schoolId]);
  });

  it('filters by fiscalYear when supplied', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForPeriods: [samplePeriod] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list('2026');
    });
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, '2026']);
    expect(capture[0]!.sql.toLowerCase()).toContain('fiscal_year = $2');
  });
});

describe('PeriodService.getById', () => {
  it('NotFoundException on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForPeriods: [] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('p-missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('coerces period_number to JS number', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPeriods: [{ ...samplePeriod, period_number: '3' as unknown as number }],
    });
    const svc = new PeriodService(tenantPrisma as never);
    let result: { periodNumber: number } | undefined;
    await inTenant(async () => {
      result = await svc.getById('p-1');
    });
    expect(result?.periodNumber).toBe(3);
  });
});

describe('PeriodService.create', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(staffActor, {
          fiscalYear: '2026',
          periodNumber: 1,
          periodName: 'Jan',
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects endDate < startDate with friendly 400', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          fiscalYear: '2026',
          periodNumber: 1,
          periodName: 'Jan',
          startDate: '2026-01-31',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow(/endDate must be on or after startDate/);
    });
  });

  it('inserts period + reloads', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForPeriods: [samplePeriod] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(adminActor, {
        fiscalYear: '2026',
        periodNumber: 1,
        periodName: 'January 2026',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      });
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_accounting_periods'),
    );
    expect(insert!.args).toContain('2026');
    expect(insert!.args).toContain(1);
    expect(insert!.args).toContain('January 2026');
  });

  it('translates UNIQUE violation into Conflict with period number + year', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'P2002' } });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          fiscalYear: '2026',
          periodNumber: 1,
          periodName: 'Jan',
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        }),
      ).rejects.toThrow(/Period 1 for 2026 already exists/);
    });
  });

  it('rethrows non-UNIQUE errors', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'OTHER', message: 'failed' } });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(adminActor, {
          fiscalYear: '2026',
          periodNumber: 1,
          periodName: 'Jan',
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        }),
      ).rejects.toThrow('failed');
    });
  });
});

describe('PeriodService.createSeries (12 monthly periods)', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSeries(staffActor, { fiscalYear: '2026', yearStart: '2026-07-01' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects invalid yearStart', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSeries(adminActor, { fiscalYear: '2026', yearStart: 'not-a-date' }),
      ).rejects.toThrow(/yearStart must be a valid ISO date/);
    });
  });

  it('inserts 12 periods + walks month-by-month', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForPeriods: [samplePeriod] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createSeries(adminActor, { fiscalYear: '2026', yearStart: '2026-07-01' });
    });
    const inserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_accounting_periods'),
    );
    expect(inserts).toHaveLength(12);
    expect(inserts[0]!.args).toContain(1);
    expect(inserts[11]!.args).toContain(12);
  });

  it('skips UNIQUE-violating periods silently (re-run friendly)', async () => {
    // make every insert raise 23505 — service should swallow each
    const { tenantPrisma, capture } = makeFake({
      insertFail: { code: 'P2002' },
    });
    const svc = new PeriodService(tenantPrisma as never);
    let result: unknown[] = [];
    await inTenant(async () => {
      result = await svc.createSeries(adminActor, {
        fiscalYear: '2026',
        yearStart: '2026-07-01',
      });
    });
    expect(result).toHaveLength(0);
    const inserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_accounting_periods'),
    );
    expect(inserts).toHaveLength(12);
  });

  it('rethrows non-UNIQUE errors in series loop', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'OTHER', message: 'died' } });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSeries(adminActor, { fiscalYear: '2026', yearStart: '2026-07-01' }),
      ).rejects.toThrow('died');
    });
  });
});

describe('PeriodService.patchStatus — lifecycle + LOCKED-is-terminal invariant', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(staffActor, 'p-1', { status: 'OPEN' })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('rejects admin without employeeId', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(adminNoEmp, 'p-1', { status: 'OPEN' })).rejects.toThrow(
        'must be performed by an employee actor',
      );
    });
  });

  it('rejects when period not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForPeriodLock: [] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(adminActor, 'missing', { status: 'OPEN' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('rejects ANY transition out of LOCKED (the invariant)', async () => {
    const { tenantPrisma } = makeFake({ rowsForPeriodLock: [{ status: 'LOCKED' }] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(adminActor, 'p-1', { status: 'OPEN' })).rejects.toThrow(
        /LOCKED periods are permanent/,
      );
    });
  });

  it('treats same-status transition as no-op (returns current)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPeriodLock: [{ status: 'OPEN' }],
      rowsForPeriods: [samplePeriod],
    });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patchStatus(adminActor, 'p-1', { status: 'OPEN' });
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update fin_accounting_periods'),
    );
    expect(update).toBeUndefined();
  });

  it('rejects FUTURE → CLOSED (must go FUTURE → OPEN first)', async () => {
    const { tenantPrisma } = makeFake({ rowsForPeriodLock: [{ status: 'FUTURE' }] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(adminActor, 'p-1', { status: 'CLOSED' })).rejects.toThrow(
        /Cannot transition period from FUTURE to CLOSED/,
      );
    });
  });

  it('accepts FUTURE → OPEN', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPeriodLock: [{ status: 'FUTURE' }],
      rowsForPeriods: [samplePeriod],
    });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patchStatus(adminActor, 'p-1', { status: 'OPEN' });
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().startsWith('update fin_accounting_periods') &&
        c.sql.toLowerCase().includes("'open'"),
    );
    expect(update).toBeTruthy();
    expect(update!.sql.toLowerCase()).toContain('closed_at=null');
    expect(update!.sql.toLowerCase()).toContain('closed_by=null');
  });

  it('OPEN → CLOSED stamps closed_at + closed_by atomically (multi-column lockstep)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPeriodLock: [{ status: 'OPEN' }],
      rowsForPeriods: [samplePeriod],
    });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patchStatus(adminActor, 'p-1', { status: 'CLOSED' });
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("status='closed'") &&
        c.sql.toLowerCase().includes('closed_at=now()'),
    );
    expect(update).toBeTruthy();
    expect(update!.args).toEqual([adminActor.employeeId, 'p-1', SCHOOL.schoolId]);
  });

  it('CLOSED → LOCKED stamps locked_at + locked_by + backfills closed_at via COALESCE', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPeriodLock: [{ status: 'CLOSED' }],
      rowsForPeriods: [samplePeriod],
    });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patchStatus(adminActor, 'p-1', { status: 'LOCKED' });
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("status='locked'") &&
        c.sql.toLowerCase().includes('locked_at=now()'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql.toLowerCase()).toContain('coalesce(closed_at');
  });

  it('CLOSED → OPEN clears closed_at + closed_by (reopen path)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPeriodLock: [{ status: 'CLOSED' }],
      rowsForPeriods: [samplePeriod],
    });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patchStatus(adminActor, 'p-1', { status: 'OPEN' });
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("status='open'") &&
        c.sql.toLowerCase().includes('closed_at=null'),
    );
    expect(update).toBeTruthy();
  });

  it('OPEN → FUTURE uses generic UPDATE path', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPeriodLock: [{ status: 'OPEN' }],
      rowsForPeriods: [samplePeriod],
    });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.patchStatus(adminActor, 'p-1', { status: 'FUTURE' });
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().startsWith('update fin_accounting_periods') &&
        // no specific closed_at/locked_at handling — generic SET status=$1 path
        !c.sql.toLowerCase().includes('closed_at=') &&
        !c.sql.toLowerCase().includes('locked_at=now'),
    );
    expect(update).toBeTruthy();
    expect(update!.args[0]).toBe('FUTURE');
  });

  it('rejects CLOSED → FUTURE (illegal transition)', async () => {
    const { tenantPrisma } = makeFake({ rowsForPeriodLock: [{ status: 'CLOSED' }] });
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(adminActor, 'p-1', { status: 'FUTURE' })).rejects.toThrow(
        /Cannot transition period from CLOSED to FUTURE/,
      );
    });
  });
});

describe('Service-layer parent/student persona rejection', () => {
  it('FundService.create — parent forbidden', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FundService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(parentActor, {
          fundCode: 'F',
          fundName: 'F',
          fundType: 'GENERAL',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('ChartOfAccountsService.create — parent forbidden', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new ChartOfAccountsService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(parentActor, {
          accountCode: '1',
          accountName: 'x',
          accountType: 'ASSET',
          normalBalance: 'DEBIT',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('PeriodService.patchStatus — parent forbidden', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PeriodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.patchStatus(parentActor, 'p-1', { status: 'OPEN' })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
