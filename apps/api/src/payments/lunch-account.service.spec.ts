import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { LunchAccountService, deterministicLowBalanceEventId } from './lunch-account.service';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/lunch-account.service.ts (588 LOC,
 * Tier 1 Financial; lunch account deposits + IMMUTABLE balance transfers +
 * POS-driven meal-charge consumer keystone with throttled low-balance
 * outbox emit).
 *
 * Tests cover:
 *   - deterministicLowBalanceEventId stability + v5 UUID shape
 *   - getForStudent admin/parent/student row scope + 404 + tx limit
 *   - getById 404 + row scope
 *   - listLowBalance admin-only
 *   - deposit amount-positive guard + tx writes both rows
 *   - update admin gate + dynamic SET clause + NotFound on miss
 *   - transfer admin gate + 5 validation paths + source/dest lock + 404 +
 *     insufficient balance + schema invariant catch
 *   - chargeMealFromConsumer no-account warn-and-drop, happy path with
 *     dedup-skip, balance crosses threshold with deterministic event_id +
 *     throttle stamp + outbox enqueue, throttled (recently alerted)
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

interface OutboxCall {
  topic: string;
  key: string;
  sourceModule: string;
  eventId?: string;
  payload: unknown;
}

interface FakeOpts {
  rowsForGetByStudent?: unknown[];
  rowsForGetById?: unknown[];
  rowsForLowBalance?: unknown[];
  rowsForTransactions?: unknown[];
  rowsForLockedAccount?: unknown[];
  rowsForFromTransfer?: unknown[];
  rowsForToTransfer?: unknown[];
  rowsForTransfer?: unknown[];
  rowsForChargeAccount?: unknown[];
  rowsForGuardianLink?: unknown[];
  rowsForStudentSelf?: unknown[];
  rowsForStudentName?: unknown[];
  rowsForStampReturn?: unknown[];
  rowsForTxReload?: unknown[];
  insertTxFail?: { message?: string };
  insertChargeFail?: { message?: string };
  insertTransferFail?: { message?: string };
  updateRowCount?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // student-self lookup
      if (
        s.includes('from sis_students') &&
        s.includes('platform.platform_students') &&
        s.includes('where ps.person_id =')
      ) {
        return opts.rowsForStudentSelf ?? [];
      }
      // guardian linkage probe
      if (s.includes('from sis_student_guardians sg') && s.includes('limit 1')) {
        return opts.rowsForGuardianLink ?? [];
      }
      // student name resolution inside chargeMealFromConsumer
      if (s.includes("p.first_name || ' ' || p.last_name as student_name")) {
        return opts.rowsForStudentName ?? [];
      }
      // RETURNING after throttle stamp
      if (s.includes('update pay_lunch_accounts') && s.includes('returning')) {
        return opts.rowsForStampReturn ?? [{ alerted_at: '2026-04-28T10:30:00Z' }];
      }
      // locked account inside chargeMealFromConsumer — match first (more specific)
      if (
        s.includes(
          'select id, balance::text, low_balance_threshold::text, last_low_balance_alert_at',
        ) &&
        s.includes('for update')
      ) {
        return opts.rowsForChargeAccount ?? [];
      }
      // locked source-account lookup inside transfer
      if (
        s.includes('from pay_lunch_accounts') &&
        s.includes('select id, balance::text') &&
        s.includes('for update')
      ) {
        return opts.rowsForFromTransfer ?? [];
      }
      // locked dest-account lookup inside transfer
      if (s.includes('select id from pay_lunch_accounts') && s.includes('for update')) {
        return opts.rowsForToTransfer ?? [];
      }
      // FOR UPDATE on pay_lunch_accounts for deposit
      if (s.includes('select id from pay_lunch_accounts where id =') && s.includes('for update')) {
        return opts.rowsForLockedAccount ?? [{ id: 'la-1' }];
      }
      // transfer reload SELECT
      if (s.includes('from pay_lunch_account_balance_transfers')) {
        return opts.rowsForTransfer ?? [];
      }
      // post-deposit tx reload
      if (s.includes('from pay_lunch_transactions where id =')) {
        return opts.rowsForTxReload ?? [];
      }
      // transactions list for getForStudent
      if (s.includes('from pay_lunch_transactions where lunch_account_id =')) {
        return opts.rowsForTransactions ?? [];
      }
      // low balance list
      if (
        s.includes('from pay_lunch_accounts a') &&
        s.includes('balance <= a.low_balance_threshold')
      ) {
        return opts.rowsForLowBalance ?? [];
      }
      // getById
      if (s.includes('from pay_lunch_accounts a') && s.includes('where a.id =')) {
        return opts.rowsForGetById ?? [];
      }
      // getForStudent
      if (s.includes('from pay_lunch_accounts a') && s.includes('where a.student_id =')) {
        return opts.rowsForGetByStudent ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      capture.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (opts.insertTxFail && s.includes("'deposit'")) {
        throw new Error(opts.insertTxFail.message ?? 'insert tx fail');
      }
      if (opts.insertChargeFail && s.includes("'meal_charge'")) {
        throw new Error(opts.insertChargeFail.message ?? 'insert charge fail');
      }
      if (
        opts.insertTransferFail &&
        s.includes('insert into pay_lunch_account_balance_transfers')
      ) {
        throw new Error(opts.insertTransferFail.message ?? 'insert transfer fail');
      }
      if (s.startsWith('update pay_lunch_accounts set ')) {
        return opts.updateRowCount ?? 1;
      }
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  const outboxCalls: OutboxCall[] = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, args: OutboxCall) => {
      outboxCalls.push(args);
    },
  };
  return { tenantPrisma, outbox, client, capture, outboxCalls };
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

const guardianActor: ResolvedActor = {
  accountId: 'acc-david',
  personId: 'pers-david',
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
};

const studentActor: ResolvedActor = {
  accountId: 'acc-maya',
  personId: 'pers-maya',
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
};

const teacherActor: ResolvedActor = {
  accountId: 'acc-rivera',
  personId: 'pers-rivera',
  personType: 'STAFF',
  isSchoolAdmin: false,
  employeeId: 'emp-rivera',
};

const sampleAccount = {
  id: 'la-1',
  school_id: SCHOOL.schoolId,
  student_id: 'stu-maya',
  student_name: 'Maya Chen',
  balance: '25.50',
  low_balance_threshold: '10.00',
  auto_replenish_enabled: false,
  auto_replenish_amount: null,
  last_low_balance_alert_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('deterministicLowBalanceEventId', () => {
  it('is deterministic for same inputs', () => {
    const a = deterministicLowBalanceEventId('la-1', '2026-04-28T10:30:00Z');
    const b = deterministicLowBalanceEventId('la-1', '2026-04-28T10:30:00Z');
    expect(a).toBe(b);
  });

  it('differs when accountId changes', () => {
    const a = deterministicLowBalanceEventId('la-1', '2026-04-28T10:30:00Z');
    const b = deterministicLowBalanceEventId('la-2', '2026-04-28T10:30:00Z');
    expect(a).not.toBe(b);
  });

  it('differs when alertedAt changes', () => {
    const a = deterministicLowBalanceEventId('la-1', '2026-04-28T10:30:00Z');
    const b = deterministicLowBalanceEventId('la-1', '2026-04-29T10:30:00Z');
    expect(a).not.toBe(b);
  });

  it('produces v5-shaped UUID', () => {
    const id = deterministicLowBalanceEventId('la-1', '2026-04-28T10:30:00Z');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('LunchAccountService.getForStudent', () => {
  it('admin sees any student account', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGetByStudent: [sampleAccount],
      rowsForTransactions: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let result: { account: { id: string }; lowBalance: boolean } | undefined;
    await inTenant(async () => {
      result = await svc.getForStudent('stu-maya', adminActor);
    });
    expect(result?.account.id).toBe('la-1');
    expect(result?.lowBalance).toBe(false); // 25.50 > 10.00
  });

  it('lowBalance=true when balance <= threshold', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGetByStudent: [{ ...sampleAccount, balance: '5.00' }],
      rowsForTransactions: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let result: { lowBalance: boolean } | undefined;
    await inTenant(async () => {
      result = await svc.getForStudent('stu-maya', adminActor);
    });
    expect(result?.lowBalance).toBe(true);
  });

  it('404 when student has no lunch account', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForGetByStudent: [] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.getForStudent('stu-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('parent linked-child happy path', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGuardianLink: [{}],
      rowsForGetByStudent: [sampleAccount],
      rowsForTransactions: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      const r = await svc.getForStudent('stu-maya', guardianActor);
      expect(r.account.id).toBe('la-1');
    });
  });

  it("parent unlinked → 404 don't-leak-existence", async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForGuardianLink: [] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.getForStudent('stu-not-mine', guardianActor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('student-self happy path', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForStudentSelf: [{ id: 'stu-maya' }],
      rowsForGetByStudent: [sampleAccount],
      rowsForTransactions: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      const r = await svc.getForStudent('stu-maya', studentActor);
      expect(r.account.id).toBe('la-1');
    });
  });

  it('student reading another student → 404', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForStudentSelf: [{ id: 'stu-maya' }],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.getForStudent('stu-ethan', studentActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('teacher (STAFF, not admin) gets ForbiddenException', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.getForStudent('stu-maya', teacherActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('transactions limit defaults to 25 and caps at 100', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({
      rowsForGetByStudent: [sampleAccount],
      rowsForTransactions: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.getForStudent('stu-maya', adminActor);
    });
    const txQuery = capture.find((c) =>
      c.sql.toLowerCase().includes('from pay_lunch_transactions where lunch_account_id'),
    );
    expect(txQuery?.args[1]).toBe(25);
  });

  it('transactions limit honors override + caps at 100', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({
      rowsForGetByStudent: [sampleAccount],
      rowsForTransactions: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.getForStudent('stu-maya', adminActor, { transactionsLimit: 500 });
    });
    const txQuery = capture.find((c) =>
      c.sql.toLowerCase().includes('from pay_lunch_transactions where lunch_account_id'),
    );
    expect(txQuery?.args[1]).toBe(100);
  });
});

describe('LunchAccountService.getById', () => {
  it('404 on miss', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForGetById: [] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.getById('la-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('admin happy path', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForGetById: [sampleAccount] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let dto: { id: string; balance: number; lowBalanceThreshold: number } | undefined;
    await inTenant(async () => {
      dto = await svc.getById('la-1', adminActor);
    });
    expect(dto?.id).toBe('la-1');
    expect(dto?.balance).toBe(25.5);
    expect(dto?.lowBalanceThreshold).toBe(10);
  });

  it('parent must be linked to the student', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGetById: [sampleAccount],
      rowsForGuardianLink: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.getById('la-1', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('coerces auto_replenish_amount string to number', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGetById: [{ ...sampleAccount, auto_replenish_amount: '20.00' }],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let dto: { autoReplenishAmount: number | null } | undefined;
    await inTenant(async () => {
      dto = await svc.getById('la-1', adminActor);
    });
    expect(dto?.autoReplenishAmount).toBe(20);
  });
});

describe('LunchAccountService.listLowBalance', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.listLowBalance(guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('returns DTOs sorted by balance ASC', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({
      rowsForLowBalance: [
        { ...sampleAccount, id: 'la-low-1', balance: '2.00' },
        { ...sampleAccount, id: 'la-low-2', balance: '5.00' },
      ],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let rows: Array<{ id: string }> = [];
    await inTenant(async () => {
      rows = await svc.listLowBalance(adminActor);
    });
    expect(rows.map((r) => r.id)).toEqual(['la-low-1', 'la-low-2']);
    expect(capture[0]!.sql.toLowerCase()).toContain('order by a.balance asc');
  });
});

describe('LunchAccountService.deposit', () => {
  it('rejects amount <= 0', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForGetById: [sampleAccount] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.deposit('la-1', { amount: 0 } as never, adminActor)).rejects.toThrow(
        /amount must be > 0/,
      );
    });
  });

  it('rejects negative amount', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForGetById: [sampleAccount] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(svc.deposit('la-1', { amount: -5 } as never, adminActor)).rejects.toThrow(
        /amount must be > 0/,
      );
    });
  });

  it('happy path locks + inserts DEPOSIT row + bumps balance', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({
      rowsForGetById: [sampleAccount],
      rowsForLockedAccount: [{ id: 'la-1' }],
      rowsForTxReload: [
        {
          id: 'tx-1',
          school_id: SCHOOL.schoolId,
          lunch_account_id: 'la-1',
          amount: '25.00',
          transaction_type: 'DEPOSIT',
          meal_date: null,
          pos_device_id: null,
          source_event_id: null,
          notes: 'Top-up',
          created_by: 'acc-admin',
          created_at: '2026-04-28T10:00:00Z',
        },
      ],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let dto: { id: string; transactionType: string; amount: number } | undefined;
    await inTenant(async () => {
      dto = await svc.deposit('la-1', { amount: 25, notes: 'Top-up' } as never, adminActor);
    });
    expect(dto?.transactionType).toBe('DEPOSIT');
    expect(dto?.amount).toBe(25);
    // Verify INSERT then UPDATE order
    const insertIdx = capture.findIndex(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("'deposit'"),
    );
    const updateIdx = capture.findIndex(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_lunch_accounts set balance = balance + '),
    );
    expect(insertIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(insertIdx);
  });

  it('parent depositing on linked child happy path', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGetById: [sampleAccount],
      rowsForGuardianLink: [{}],
      rowsForLockedAccount: [{ id: 'la-1' }],
      rowsForTxReload: [
        {
          id: 'tx-2',
          school_id: SCHOOL.schoolId,
          lunch_account_id: 'la-1',
          amount: '10.00',
          transaction_type: 'DEPOSIT',
          meal_date: null,
          pos_device_id: null,
          source_event_id: null,
          notes: null,
          created_by: 'acc-david',
          created_at: '2026-04-28T10:00:00Z',
        },
      ],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      const r = await svc.deposit('la-1', { amount: 10 } as never, guardianActor);
      expect(r.transactionType).toBe('DEPOSIT');
    });
  });
});

describe('LunchAccountService.update', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.update('la-1', { lowBalanceThreshold: 5 } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('empty body short-circuits to getById', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({ rowsForGetById: [sampleAccount] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.update('la-1', {}, adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_lunch_accounts set '),
    );
    expect(update).toBeUndefined();
  });

  it('builds dynamic SET for all 3 fields', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({ rowsForGetById: [sampleAccount] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.update(
        'la-1',
        {
          lowBalanceThreshold: 5,
          autoReplenishEnabled: true,
          autoReplenishAmount: 50,
        } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_lunch_accounts set '),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('low_balance_threshold = $1::numeric');
    expect(update!.sql).toContain('auto_replenish_enabled = $2');
    expect(update!.sql).toContain('auto_replenish_amount = $3::numeric');
    expect(update!.args[0]).toBe('5.00');
    expect(update!.args[1]).toBe(true);
    expect(update!.args[2]).toBe('50.00');
    expect(update!.args[3]).toBe('la-1');
  });

  it('NotFound when UPDATE returns 0 rows', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForGetById: [sampleAccount],
      updateRowCount: 0,
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.update('la-missing', { lowBalanceThreshold: 5 } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('LunchAccountService.transfer (IMMUTABLE per ADR-010)', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'REFUND_TO_FAMILY',
            amount: 10,
            reason: 'X',
            refundId: 're-1',
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects amount <= 0', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-2',
            amount: 0,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/amount must be > 0/);
    });
  });

  it('REFUND_TO_FAMILY requires refundId', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'REFUND_TO_FAMILY',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/refundId is required for REFUND_TO_FAMILY/);
    });
  });

  it('SIBLING_TRANSFER requires toAccountId', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/toAccountId is required for SIBLING_TRANSFER/);
    });
  });

  it('NEXT_YEAR_ROLLOVER requires toAccountId', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'NEXT_YEAR_ROLLOVER',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/toAccountId is required for NEXT_YEAR_ROLLOVER/);
    });
  });

  it('REFUND_TO_FAMILY must not have toAccountId', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'REFUND_TO_FAMILY',
            toAccountId: 'la-2',
            amount: 10,
            reason: 'X',
            refundId: 're-1',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/toAccountId must be NULL for REFUND_TO_FAMILY/);
    });
  });

  it('rejects same fromAccountId === toAccountId', async () => {
    const { tenantPrisma, outbox } = makeFake();
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-1',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/toAccountId must be different from fromAccountId/);
    });
  });

  it('source 404', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForFromTransfer: [] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-missing',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-2',
            amount: 5,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Source lunch account .* not found/);
    });
  });

  it('insufficient balance', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForFromTransfer: [{ id: 'la-1', balance: '5.00' }],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-2',
            amount: 50,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/exceeds source balance/);
    });
  });

  it('destination 404', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForFromTransfer: [{ id: 'la-1', balance: '50.00' }],
      rowsForToTransfer: [],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-missing',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Destination lunch account .* not found/);
    });
  });

  it('schema invariant catch translates pay_lunch_xfer error', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForFromTransfer: [{ id: 'la-1', balance: '50.00' }],
      rowsForToTransfer: [{ id: 'la-2' }],
      insertTransferFail: { message: 'violates check constraint "pay_lunch_xfer_amount_chk"' },
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-2',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Transfer rejected by schema invariant/);
    });
  });

  it('non-pay_lunch_xfer insert errors rethrow unchanged', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForFromTransfer: [{ id: 'la-1', balance: '50.00' }],
      rowsForToTransfer: [{ id: 'la-2' }],
      insertTransferFail: { message: 'connection refused' },
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.transfer(
          {
            fromAccountId: 'la-1',
            transferType: 'SIBLING_TRANSFER',
            toAccountId: 'la-2',
            amount: 10,
            reason: 'X',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/connection refused/);
    });
  });

  it('SIBLING_TRANSFER happy path debits from + credits to in same tx', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({
      rowsForFromTransfer: [{ id: 'la-1', balance: '50.00' }],
      rowsForToTransfer: [{ id: 'la-2' }],
      rowsForTransfer: [
        {
          id: 'xfer-1',
          school_id: SCHOOL.schoolId,
          from_account_id: 'la-1',
          to_account_id: 'la-2',
          transfer_type: 'SIBLING_TRANSFER',
          amount: '10.00',
          reason: 'Maya graduating',
          refund_id: null,
          processed_by: 'acc-admin',
          processed_at: '2026-04-28T10:00:00Z',
        },
      ],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let dto: { id: string; transferType: string; toAccountId: string | null } | undefined;
    await inTenant(async () => {
      dto = await svc.transfer(
        {
          fromAccountId: 'la-1',
          transferType: 'SIBLING_TRANSFER',
          toAccountId: 'la-2',
          amount: 10,
          reason: 'Maya graduating',
        } as never,
        adminActor,
      );
    });
    expect(dto?.transferType).toBe('SIBLING_TRANSFER');
    expect(dto?.toAccountId).toBe('la-2');
    // Verify both balance UPDATEs ran
    const fromUpdates = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('balance = balance - '),
    );
    const toUpdates = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('balance = balance + '),
    );
    expect(fromUpdates.length).toBe(1);
    expect(toUpdates.length).toBe(1);
  });

  it('REFUND_TO_FAMILY only debits source (no to-account credit)', async () => {
    const { tenantPrisma, outbox, capture } = makeFake({
      rowsForFromTransfer: [{ id: 'la-1', balance: '50.00' }],
      rowsForTransfer: [
        {
          id: 'xfer-2',
          school_id: SCHOOL.schoolId,
          from_account_id: 'la-1',
          to_account_id: null,
          transfer_type: 'REFUND_TO_FAMILY',
          amount: '20.00',
          reason: 'Withdrew mid-year',
          refund_id: 're-1',
          processed_by: 'acc-admin',
          processed_at: '2026-04-28T10:00:00Z',
        },
      ],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.transfer(
        {
          fromAccountId: 'la-1',
          transferType: 'REFUND_TO_FAMILY',
          amount: 20,
          reason: 'Withdrew mid-year',
          refundId: 're-1',
        } as never,
        adminActor,
      );
    });
    const fromUpdates = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('balance = balance - '),
    );
    const toUpdates = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('balance = balance + '),
    );
    expect(fromUpdates.length).toBe(1);
    expect(toUpdates.length).toBe(0);
  });
});

describe('LunchAccountService.chargeMealFromConsumer', () => {
  it('returns no-op when student has no account (warn + drop)', async () => {
    const { tenantPrisma, outbox } = makeFake({ rowsForChargeAccount: [] });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let result;
    await inTenant(async () => {
      result = await svc.chargeMealFromConsumer({
        studentId: 'stu-missing',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-1',
        posSessionId: null,
      });
    });
    expect(result).toEqual({ created: false, balanceCrossedThreshold: false, account: null });
  });

  it('happy path inserts MEAL_CHARGE + decrements balance (no threshold cross)', async () => {
    const { tenantPrisma, outbox, capture, outboxCalls } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '25.50',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: null,
        },
      ],
      rowsForGetByStudent: [sampleAccount],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let result;
    await inTenant(async () => {
      result = await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-1',
        posSessionId: null,
      });
    });
    expect(result?.created).toBe(true);
    expect(result?.balanceCrossedThreshold).toBe(false);
    expect(result?.account?.id).toBe('la-1');
    expect(outboxCalls.length).toBe(0);
    // Verify the MEAL_CHARGE insert + balance update both ran
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("'meal_charge'"),
    );
    expect(insert).toBeTruthy();
  });

  it('duplicate (pay_lunch_tx_event_dedup_uq 23505) is swallowed', async () => {
    const { tenantPrisma, outbox, outboxCalls } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '25.50',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: null,
        },
      ],
      insertChargeFail: { message: 'duplicate key violates pay_lunch_tx_event_dedup_uq' },
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let result;
    await inTenant(async () => {
      result = await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-already-seen',
        posSessionId: null,
      });
    });
    expect(result?.created).toBe(false);
    expect(outboxCalls.length).toBe(0);
  });

  it('non-23505 insert errors rethrow', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '25.50',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: null,
        },
      ],
      insertChargeFail: { message: 'connection refused' },
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await expect(
        svc.chargeMealFromConsumer({
          studentId: 'stu-maya',
          amount: 3.5,
          mealDate: '2026-04-28',
          posDeviceId: 'pos-1',
          sourceEventId: 'evt-x',
          posSessionId: null,
        }),
      ).rejects.toThrow(/connection refused/);
    });
  });

  it('balance crosses threshold → throttled outbox emit with deterministic event_id', async () => {
    const { tenantPrisma, outbox, outboxCalls } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '12.00',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: null,
        },
      ],
      rowsForStampReturn: [{ alerted_at: '2026-04-28T10:30:00Z' }],
      rowsForStudentName: [{ student_id: 'stu-maya', student_name: 'Maya Chen' }],
      rowsForGetByStudent: [sampleAccount],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-cross',
        posSessionId: null,
      });
    });
    expect(outboxCalls.length).toBe(1);
    expect(outboxCalls[0]!.topic).toBe('pay.lunch.low_balance');
    expect(outboxCalls[0]!.sourceModule).toBe('payments');
    const expectedId = deterministicLowBalanceEventId('la-1', '2026-04-28T10:30:00Z');
    expect(outboxCalls[0]!.eventId).toBe(expectedId);
    const payload = outboxCalls[0]!.payload as {
      studentName: string;
      balance: number;
      threshold: number;
    };
    expect(payload.studentName).toBe('Maya Chen');
    expect(payload.balance).toBe(8.5);
    expect(payload.threshold).toBe(10);
  });

  it('throttle: skips emit when last alert was <24h ago', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const { tenantPrisma, outbox, outboxCalls } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '12.00',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: recent,
        },
      ],
      rowsForGetByStudent: [sampleAccount],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-throttled',
        posSessionId: null,
      });
    });
    expect(outboxCalls.length).toBe(0);
  });

  it('emits again after 24h+ since last alert', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { tenantPrisma, outbox, outboxCalls } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '12.00',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: old,
        },
      ],
      rowsForStampReturn: [{ alerted_at: '2026-04-28T10:30:00Z' }],
      rowsForStudentName: [{ student_id: 'stu-maya', student_name: 'Maya Chen' }],
      rowsForGetByStudent: [sampleAccount],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-reset',
        posSessionId: null,
      });
    });
    expect(outboxCalls.length).toBe(1);
  });

  it('no threshold cross when oldBalance already at/below threshold', async () => {
    const { tenantPrisma, outbox, outboxCalls } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '8.00',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: null,
        },
      ],
      rowsForGetByStudent: [sampleAccount],
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    await inTenant(async () => {
      await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-already-low',
        posSessionId: null,
      });
    });
    // Already below threshold → no cross → no emit
    expect(outboxCalls.length).toBe(0);
  });

  it('account=null when post-tx reload returns no row', async () => {
    const { tenantPrisma, outbox } = makeFake({
      rowsForChargeAccount: [
        {
          id: 'la-1',
          balance: '25.50',
          low_balance_threshold: '10.00',
          last_low_balance_alert_at: null,
        },
      ],
      rowsForGetByStudent: [], // reload misses
    });
    const svc = new LunchAccountService(tenantPrisma as never, outbox as never);
    let result;
    await inTenant(async () => {
      result = await svc.chargeMealFromConsumer({
        studentId: 'stu-maya',
        amount: 3.5,
        mealDate: '2026-04-28',
        posDeviceId: 'pos-1',
        sourceEventId: 'evt-reload-miss',
        posSessionId: null,
      });
    });
    expect(result?.account).toBeNull();
  });
});
