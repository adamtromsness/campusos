import { describe, it, expect } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PostingService } from './posting.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import type {
  CreateGLEntryLineDto,
  CreateJournalBatchDto,
  VoidJournalBatchDto,
} from './dto/finance.dto';

/**
 * P2-H4 test coverage uplift — posting.service.ts (608 LOC, the journal-posting
 * keystone called by GLConsumer + JournalBatchPostedConsumer + APPaymentService).
 *
 * PostingService owns the ADR-058 / ADR-059 double-entry contract: every batch
 * must net to SUM(debit) = SUM(credit) (±0.005), every line is one-sided, no
 * negative amounts, no zero-total batches, and posts must target an OPEN
 * accounting period. Validation runs inside the same tenant transaction that
 * writes the entries so an imbalance rolls everything back atomically.
 *
 * Tests cover:
 *   - createDraft / post / void public surface
 *   - createAndPost + createAndPostInTx (the consumer path)
 *   - source_event_id idempotency (fast-path + in-tx race + 23505 retry)
 *   - period resolution (auto-pick OPEN-today vs explicit periodId)
 *   - period status guards (CLOSED / LOCKED reject)
 *   - balance validation (line shape pre-flight + in-tx SUM aggregate)
 *   - actor gate (school admin or STAFF; rejection for parent/student;
 *     employeeId required to write posted_by)
 *   - void: school admin only, only POSTED batches voidable
 *   - budget actuals bump on post + reverse on void
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
  rowsForSelectByEvent?: Array<{ id: string }>;
  rowsForOpenPeriod?: Array<{ id: string }>;
  rowsForExplicitPeriod?: Array<{ status: string }>;
  rowsForFetchByIdHead?: { status: string; pid: string; period_status: string }[];
  rowsForFetchByIdEntry?: {
    total_debit: string | number;
    total_credit: string | number;
    line_count: string | number;
  }[];
  rowsForBatchBase?: unknown[];
  rowsForGetByIdEntries?: unknown[];
  rowsForVoidLock?: Array<{ status: string }>;
  insertFail?: { code?: string; meta?: { code?: string } };
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  let entryInsertCount = 0;
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('where source_event_id =')) {
        return opts.rowsForSelectByEvent ?? [];
      }
      if (s.includes('from fin_accounting_periods') && s.includes('current_date between')) {
        return opts.rowsForOpenPeriod ?? [];
      }
      if (s.includes('from fin_accounting_periods') && s.includes('where id =')) {
        return opts.rowsForExplicitPeriod ?? [];
      }
      // FOR UPDATE OF b — the post() lock
      if (s.includes('for update of b')) {
        return (
          opts.rowsForFetchByIdHead ?? [{ status: 'DRAFT', pid: 'p-1', period_status: 'OPEN' }]
        );
      }
      // void lock
      if (s.includes('select status from fin_journal_batches') && s.includes('for update')) {
        return opts.rowsForVoidLock ?? [];
      }
      // validateBalance aggregate
      if (s.includes('sum(debit)') && s.includes('sum(credit)') && s.includes('count(*)')) {
        return (
          opts.rowsForFetchByIdEntry ?? [
            { total_debit: '100', total_credit: '100', line_count: '2' },
          ]
        );
      }
      // SELECT_BATCH_BASE
      if (s.includes('from fin_journal_batches b') && s.includes('join fin_accounting_periods p')) {
        return (
          opts.rowsForBatchBase ?? [
            {
              id: 'b-new',
              school_id: SCHOOL.schoolId,
              batch_number: 'B-1',
              description: 'Test batch',
              batch_type: 'MANUAL',
              source_module: null,
              source_event_id: null,
              accounting_period_id: 'p-1',
              period_name: 'Apr 2026',
              posted_by: null,
              posted_by_name: null,
              posted_at: null,
              status: 'DRAFT',
              voided_at: null,
              voided_by: null,
              void_reason: null,
              total_debit: '100',
              total_credit: '100',
              created_at: '2026-04-01T00:00:00Z',
              updated_at: '2026-04-01T00:00:00Z',
            },
          ]
        );
      }
      // entries reload
      if (s.includes('from fin_gl_entries e') && s.includes('join fin_chart_of_accounts a')) {
        return opts.rowsForGetByIdEntries ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      if (opts.insertFail && sql.toLowerCase().includes('insert into fin_journal_batches')) {
        const e = new Error('unique violation') as Error & {
          code?: string;
          meta?: { code?: string };
        };
        // The chart.service.ts::isUniqueViolation contract expects
        // code='P2010' paired with meta.code='23505'. Tests pass either
        // a P2002 short-form OR the full P2010+23505 pair.
        if (opts.insertFail.code) e.code = opts.insertFail.code;
        if (opts.insertFail.meta) e.meta = opts.insertFail.meta;
        throw e;
      }
      if (sql.toLowerCase().includes('insert into fin_gl_entries')) {
        entryInsertCount++;
      }
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  return {
    tenantPrisma,
    client,
    capture,
    entryCount: () => entryInsertCount,
  };
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

const studentActor: ResolvedActor = {
  accountId: 'acc-student',
  personId: 'pers-student',
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
};

const staffNoEmp: ResolvedActor = {
  accountId: 'acc-staff-2',
  personId: 'pers-staff-2',
  personType: 'STAFF',
  isSchoolAdmin: false,
  employeeId: null,
};

const balancedEntries: CreateGLEntryLineDto[] = [
  {
    accountId: 'a-cash',
    fundId: 'f-1',
    debit: 100,
    credit: 0,
    description: 'cash',
    referenceType: null,
    referenceId: null,
  },
  {
    accountId: 'a-rev',
    fundId: 'f-1',
    debit: 0,
    credit: 100,
    description: 'rev',
    referenceType: null,
    referenceId: null,
  },
];

const baseInput: CreateJournalBatchDto = {
  batchNumber: 'B-1',
  description: 'Test batch',
  batchType: 'MANUAL',
  sourceModule: null,
  accountingPeriodId: 'p-1',
  entries: balancedEntries,
};

describe('PostingService — validateLineShape (pre-flight)', () => {
  it('rejects empty entries with friendly 400', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, { ...baseInput, entries: [] })).rejects.toThrow(
        BadRequestException,
      );
      await expect(svc.createDraft(adminActor, { ...baseInput, entries: [] })).rejects.toThrow(
        'must have at least one entry',
      );
    });
  });

  it('rejects entry with both debit and credit populated', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const entries: CreateGLEntryLineDto[] = [
      {
        accountId: 'a',
        fundId: 'f',
        debit: 50,
        credit: 50,
        description: null,
        referenceType: null,
        referenceId: null,
      },
    ];
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, { ...baseInput, entries })).rejects.toThrow(
        'one-sided',
      );
    });
  });

  it('rejects entry with both debit and credit zero', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const entries: CreateGLEntryLineDto[] = [
      {
        accountId: 'a',
        fundId: 'f',
        debit: 0,
        credit: 0,
        description: null,
        referenceType: null,
        referenceId: null,
      },
    ];
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, { ...baseInput, entries })).rejects.toThrow(
        'non-zero',
      );
    });
  });

  it('rejects negative debit', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const entries: CreateGLEntryLineDto[] = [
      {
        accountId: 'a',
        fundId: 'f',
        debit: -1,
        credit: 0,
        description: null,
        referenceType: null,
        referenceId: null,
      },
    ];
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, { ...baseInput, entries })).rejects.toThrow(
        'non-negative',
      );
    });
  });

  it('rejects unbalanced entries with debit/credit totals in the message', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const entries: CreateGLEntryLineDto[] = [
      {
        accountId: 'a',
        fundId: 'f',
        debit: 100,
        credit: 0,
        description: null,
        referenceType: null,
        referenceId: null,
      },
      {
        accountId: 'b',
        fundId: 'f',
        debit: 0,
        credit: 90,
        description: null,
        referenceType: null,
        referenceId: null,
      },
    ];
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, { ...baseInput, entries })).rejects.toThrow(
        /unbalanced.*100\.00.*90\.00/,
      );
    });
  });

  it('accepts balanced entries within ±0.005 tolerance', async () => {
    const { tenantPrisma, capture } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const entries: CreateGLEntryLineDto[] = [
      {
        accountId: 'a',
        fundId: 'f',
        debit: 100.001,
        credit: 0,
        description: null,
        referenceType: null,
        referenceId: null,
      },
      {
        accountId: 'b',
        fundId: 'f',
        debit: 0,
        credit: 100,
        description: null,
        referenceType: null,
        referenceId: null,
      },
    ];
    await inTenant(async () => {
      await svc.createDraft(adminActor, { ...baseInput, entries });
    });
    expect(
      capture.some((c) => c.sql.toLowerCase().includes('insert into fin_journal_batches')),
    ).toBe(true);
  });
});

describe('PostingService — assertCanPost', () => {
  it('allows school admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, baseInput)).resolves.toBeTruthy();
    });
  });

  it('allows STAFF actor', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(staffActor, baseInput)).resolves.toBeTruthy();
    });
  });

  it('rejects parent (GUARDIAN) with ForbiddenException', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(parentActor, baseInput)).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects student with ForbiddenException', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(studentActor, baseInput)).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('PostingService.createDraft', () => {
  it('inserts a batch row + entries inside one tx', async () => {
    const { tenantPrisma, capture, entryCount } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createDraft(adminActor, baseInput);
    });
    const batchInsert = capture.find((c) =>
      c.sql.toLowerCase().includes('insert into fin_journal_batches'),
    );
    expect(batchInsert).toBeTruthy();
    expect(batchInsert!.sql.toLowerCase()).toContain("'draft'");
    expect(entryCount()).toBe(2);
  });

  it('translates UNIQUE violation on batch_number into ConflictException', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'P2010', meta: { code: '23505' } } });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, baseInput)).rejects.toThrow(ConflictException);
      await expect(svc.createDraft(adminActor, baseInput)).rejects.toThrow(
        /number 'B-1' already exists/,
      );
    });
  });

  it('rethrows non-UNIQUE errors unchanged', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'OTHER' } });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createDraft(adminActor, baseInput)).rejects.toThrow('unique violation');
    });
  });
});

describe('PostingService — entries DTO mapping (loadEntries)', () => {
  it('maps entry rows into the full GLEntryDto shape with numeric coercion', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetByIdEntries: [
        {
          id: 'e-1',
          batch_id: 'b-1',
          account_id: 'a-cash',
          account_code: '1000',
          account_name: 'Cash',
          fund_id: 'f-1',
          fund_code: 'GENERAL',
          debit: '100.50',
          credit: '0',
          description: 'tuition payment',
          reference_type: 'pay_payments',
          reference_id: 'pmt-1',
          line_order: 0,
        },
        {
          id: 'e-2',
          batch_id: 'b-1',
          account_id: 'a-rev',
          account_code: '4000',
          account_name: 'Tuition Revenue',
          fund_id: 'f-1',
          fund_code: 'GENERAL',
          debit: '0',
          credit: '100.50',
          description: 'tuition revenue',
          reference_type: 'pay_payments',
          reference_id: 'pmt-1',
          line_order: 1,
        },
      ],
    });
    const svc = new PostingService(tenantPrisma as never);
    let result: { entries: unknown[] } | undefined;
    await inTenant(async () => {
      result = await svc.getById('b-1');
    });
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries[0]).toEqual({
      id: 'e-1',
      batchId: 'b-1',
      accountId: 'a-cash',
      accountCode: '1000',
      accountName: 'Cash',
      fundId: 'f-1',
      fundCode: 'GENERAL',
      debit: 100.5,
      credit: 0,
      description: 'tuition payment',
      referenceType: 'pay_payments',
      referenceId: 'pmt-1',
      lineOrder: 0,
    });
    expect(result?.entries[1]).toMatchObject({
      id: 'e-2',
      debit: 0,
      credit: 100.5,
      lineOrder: 1,
    });
  });
});

describe('PostingService.getById', () => {
  it('returns NotFoundException when no row matches', async () => {
    const { tenantPrisma } = makeFake({ rowsForBatchBase: [] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('binds the school predicate', async () => {
    const { tenantPrisma, capture } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.getById('b-1');
    });
    const reads = capture.filter(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from fin_journal_batches b') &&
        c.sql.toLowerCase().includes('where b.id'),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]!.args).toEqual(['b-1', SCHOOL.schoolId]);
  });
});

describe('PostingService.list', () => {
  it('binds the school_id predicate + LIMIT 200', async () => {
    const { tenantPrisma, capture } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list();
    });
    const listRead = capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from fin_journal_batches b') &&
        c.sql.toLowerCase().includes('limit 200'),
    );
    expect(listRead).toBeTruthy();
    expect(listRead!.args).toEqual([SCHOOL.schoolId]);
    expect(listRead!.sql.toLowerCase()).toContain('school_id = $1::uuid');
  });

  it('accepts status + periodId + sourceModule filters', async () => {
    const { tenantPrisma, capture } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list({ status: 'POSTED', periodId: 'p-2', sourceModule: 'payments' });
    });
    const listRead = capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from fin_journal_batches b') &&
        c.sql.toLowerCase().includes('limit 200'),
    );
    expect(listRead).toBeTruthy();
    expect(listRead!.args).toEqual([SCHOOL.schoolId, 'POSTED', 'p-2', 'payments']);
  });
});

describe('PostingService.post — lifecycle + period gates', () => {
  it('rejects when batch not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForFetchByIdHead: [] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects when batch already POSTED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdHead: [{ status: 'POSTED', pid: 'p-1', period_status: 'OPEN' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow('already POSTED');
    });
  });

  it('rejects when batch is VOIDED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdHead: [{ status: 'VOIDED', pid: 'p-1', period_status: 'OPEN' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow('VOIDED and cannot');
    });
  });

  it('rejects when period is CLOSED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdHead: [{ status: 'DRAFT', pid: 'p-1', period_status: 'CLOSED' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow(/Cannot post to a CLOSED period/);
    });
  });

  it('rejects when period is LOCKED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdHead: [{ status: 'DRAFT', pid: 'p-1', period_status: 'LOCKED' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow(/Cannot post to a LOCKED period/);
    });
  });

  it('rejects when actor.employeeId is null', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(staffNoEmp, 'b-1')).rejects.toThrow(
        'must be performed by an employee actor',
      );
    });
  });

  it('flips DRAFT → POSTED + bumps budget actuals on success', async () => {
    const { tenantPrisma, capture } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.post(adminActor, 'b-1');
    });
    const updateBatch = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update fin_journal_batches') &&
        c.sql.toLowerCase().includes("'posted'"),
    );
    expect(updateBatch).toBeTruthy();
    expect(updateBatch!.args).toContain(adminActor.employeeId);

    const budgetBump = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update fin_budget_lines') &&
        c.sql.toLowerCase().includes('actual_amount + sub.delta'),
    );
    expect(budgetBump).toBeTruthy();
  });
});

describe('PostingService.post — validateBalance (in-tx)', () => {
  it('rejects when in-tx aggregate is unbalanced', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdEntry: [{ total_debit: '100', total_credit: '50', line_count: '2' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow(/unbalanced.*100\.00.*50\.00/);
    });
  });

  it('rejects when batch has no entries (line_count = 0)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdEntry: [{ total_debit: '0', total_credit: '0', line_count: '0' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow('no entries');
    });
  });

  it('rejects zero-total batches even when lines balance', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFetchByIdEntry: [{ total_debit: '0', total_credit: '0', line_count: '2' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.post(adminActor, 'b-1')).rejects.toThrow('total is zero');
    });
  });
});

describe('PostingService.void', () => {
  it('rejects non-admin even with STAFF persona', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const input: VoidJournalBatchDto = { reason: 'misposted' };
    await inTenant(async () => {
      await expect(svc.void(staffActor, 'b-1', input)).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects admin actor without employeeId', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    const adminNoEmp: ResolvedActor = { ...adminActor, employeeId: null };
    await inTenant(async () => {
      await expect(svc.void(adminNoEmp, 'b-1', { reason: 'x' })).rejects.toThrow(
        'must be performed by an employee actor',
      );
    });
  });

  it('rejects when batch not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForVoidLock: [] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.void(adminActor, 'b-1', { reason: 'x' })).rejects.toThrow(NotFoundException);
    });
  });

  it('rejects non-POSTED batches with current status in the message', async () => {
    const { tenantPrisma } = makeFake({ rowsForVoidLock: [{ status: 'DRAFT' }] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.void(adminActor, 'b-1', { reason: 'x' })).rejects.toThrow(
        /Only POSTED batches can be voided.*DRAFT/,
      );
    });
  });

  it('flips POSTED → VOIDED + reverses budget actuals + stamps reason', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForVoidLock: [{ status: 'POSTED' }] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.void(adminActor, 'b-1', { reason: 'misposted entry' });
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update fin_journal_batches') &&
        c.sql.toLowerCase().includes("'voided'"),
    );
    expect(update).toBeTruthy();
    expect(update!.args).toContain('misposted entry');
    expect(update!.args).toContain(adminActor.employeeId);
    const reverse = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update fin_budget_lines') &&
        c.sql.toLowerCase().includes('greatest'),
    );
    expect(reverse).toBeTruthy();
  });
});

describe('PostingService.createAndPostInTx — consumer keystone', () => {
  it('rejects parent (forbidden via assertCanPost)', async () => {
    const { tenantPrisma, client } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createAndPostInTx(client as never, parentActor, baseInput)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('rejects actor without employeeId', async () => {
    const { tenantPrisma, client } = makeFake();
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createAndPostInTx(client as never, staffNoEmp, baseInput)).rejects.toThrow(
        'must be performed by an employee actor',
      );
    });
  });

  it('rejects when no OPEN period covers today', async () => {
    const { tenantPrisma, client } = makeFake({ rowsForOpenPeriod: [] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createAndPostInTx(client as never, adminActor, baseInput)).rejects.toThrow(
        /No OPEN accounting period covers today/,
      );
    });
  });

  it('returns existing batchId when source_event_id already maps', async () => {
    const { tenantPrisma, client, capture } = makeFake({
      rowsForSelectByEvent: [{ id: 'b-existing' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    let result: string | undefined;
    await inTenant(async () => {
      result = await svc.createAndPostInTx(client as never, adminActor, {
        ...baseInput,
        sourceEventId: '019dd186-eb3c-7666-80d3-75f432e0bc10',
      });
    });
    expect(result).toBe('b-existing');
    expect(
      capture.some(
        (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_journal_batches'),
      ),
    ).toBe(false);
  });

  it('uses explicit periodId when provided + rejects CLOSED', async () => {
    const { tenantPrisma, client } = makeFake({
      rowsForExplicitPeriod: [{ status: 'CLOSED' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createAndPostInTx(client as never, adminActor, {
          ...baseInput,
          periodId: 'p-explicit',
        }),
      ).rejects.toThrow(/Cannot post to a CLOSED period/);
    });
  });

  it('rejects LOCKED explicit period', async () => {
    const { tenantPrisma, client } = makeFake({
      rowsForExplicitPeriod: [{ status: 'LOCKED' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createAndPostInTx(client as never, adminActor, {
          ...baseInput,
          periodId: 'p-explicit',
        }),
      ).rejects.toThrow(/LOCKED/);
    });
  });

  it('rejects when explicit periodId not found', async () => {
    const { tenantPrisma, client } = makeFake({ rowsForExplicitPeriod: [] });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createAndPostInTx(client as never, adminActor, {
          ...baseInput,
          periodId: 'p-unknown',
        }),
      ).rejects.toThrow('Target period not found');
    });
  });

  it('happy path inserts batch as POSTED + auto-picks OPEN period', async () => {
    const { tenantPrisma, client, capture } = makeFake({
      rowsForOpenPeriod: [{ id: 'p-auto' }],
    });
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createAndPostInTx(client as never, adminActor, {
        ...baseInput,
        sourceEventId: '019dd186-eb3c-7666-80d3-75f432e0bc10',
        sourceModule: 'payments',
      });
    });
    const insert = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('insert into fin_journal_batches') &&
        c.sql.toLowerCase().includes("'posted'"),
    );
    expect(insert).toBeTruthy();
    // posted_by is the 9th positional arg (1-indexed). Args 1..9:
    // batchId, schoolId, batchNumber, description, batchType,
    // sourceModule, sourceEventId, periodId, employeeId
    expect(insert!.args[6]).toBe('019dd186-eb3c-7666-80d3-75f432e0bc10');
    expect(insert!.args[7]).toBe('p-auto');
    expect(insert!.args[8]).toBe(adminActor.employeeId);

    const budgetUp = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update fin_budget_lines') &&
        c.sql.toLowerCase().includes('actual_amount + sub.delta'),
    );
    expect(budgetUp).toBeTruthy();
  });
});

describe('PostingService.createAndPost — fast-path + 23505 race', () => {
  it('fast-path returns existing batch without opening tx', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForSelectByEvent: [{ id: 'b-existing' }],
      rowsForBatchBase: [
        {
          id: 'b-existing',
          school_id: SCHOOL.schoolId,
          batch_number: 'B-1',
          description: 'cached',
          batch_type: 'AUTO_PAYMENT',
          source_module: 'payments',
          source_event_id: '019dd186-eb3c-7666-80d3-75f432e0bc10',
          accounting_period_id: 'p-1',
          period_name: 'Apr 2026',
          posted_by: 'emp-admin',
          posted_by_name: 'Sarah Mitchell',
          posted_at: '2026-04-15T00:00:00Z',
          status: 'POSTED',
          voided_at: null,
          voided_by: null,
          void_reason: null,
          total_debit: '100',
          total_credit: '100',
          created_at: '2026-04-15T00:00:00Z',
          updated_at: '2026-04-15T00:00:00Z',
        },
      ],
    });
    const svc = new PostingService(tenantPrisma as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.createAndPost(adminActor, {
        ...baseInput,
        sourceEventId: '019dd186-eb3c-7666-80d3-75f432e0bc10',
      });
    });
    expect(result?.id).toBe('b-existing');
    expect(
      capture.some(
        (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into fin_journal_batches'),
      ),
    ).toBe(false);
  });

  it('translates source_event_id 23505 race into existing-batch return', async () => {
    // The classic race: fast-path SELECT (call 1) and in-tx idempotency
    // SELECT (call 2) both miss — the racing transaction has not yet
    // committed. INSERT then fires 23505 because the racer committed
    // mid-insert. Post-error recovery SELECT (call 3) finds the
    // canonical batch the racer wrote.
    let selectCount = 0;
    const capture: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'q' });
        const s = sql.toLowerCase();
        if (s.includes('from fin_journal_batches') && s.includes('source_event_id =')) {
          selectCount++;
          // calls 1 + 2 = pre-insert misses; call 3 = post-error race recovery
          if (selectCount < 3) return [];
          return [{ id: 'b-raced' }];
        }
        if (s.includes('from fin_accounting_periods') && s.includes('current_date between')) {
          return [{ id: 'p-auto' }];
        }
        if (
          s.includes('from fin_journal_batches b') &&
          s.includes('join fin_accounting_periods p')
        ) {
          return [
            {
              id: 'b-raced',
              school_id: SCHOOL.schoolId,
              batch_number: 'B-1',
              description: 'raced',
              batch_type: 'AUTO_PAYMENT',
              source_module: 'payments',
              source_event_id: '019dd186-eb3c-7666-80d3-75f432e0bc10',
              accounting_period_id: 'p-1',
              period_name: 'Apr 2026',
              posted_by: 'emp-admin',
              posted_by_name: 'Sarah Mitchell',
              posted_at: '2026-04-15T00:00:00Z',
              status: 'POSTED',
              voided_at: null,
              voided_by: null,
              void_reason: null,
              total_debit: '100',
              total_credit: '100',
              created_at: '2026-04-15T00:00:00Z',
              updated_at: '2026-04-15T00:00:00Z',
            },
          ];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'e' });
        if (sql.toLowerCase().includes('insert into fin_journal_batches')) {
          const e = new Error('unique violation') as Error & {
            code?: string;
            meta?: { code?: string };
          };
          e.code = 'P2010';
          e.meta = { code: '23505' };
          throw e;
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
      executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    };
    const svc = new PostingService(tenantPrisma as never);
    let result: { id: string } | undefined;
    await inTenant(async () => {
      result = await svc.createAndPost(adminActor, {
        ...baseInput,
        sourceEventId: '019dd186-eb3c-7666-80d3-75f432e0bc10',
      });
    });
    expect(result?.id).toBe('b-raced');
  });

  it('rethrows 23505 as ConflictException when sourceEventId is not set', async () => {
    const capture: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'q' });
        const s = sql.toLowerCase();
        if (s.includes('from fin_accounting_periods') && s.includes('current_date between')) {
          return [{ id: 'p-auto' }];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'e' });
        if (sql.toLowerCase().includes('insert into fin_journal_batches')) {
          const e = new Error('unique violation') as Error & {
            code?: string;
            meta?: { code?: string };
          };
          e.code = 'P2010';
          e.meta = { code: '23505' };
          throw e;
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
      executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    };
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createAndPost(adminActor, baseInput)).rejects.toThrow(ConflictException);
      await expect(svc.createAndPost(adminActor, baseInput)).rejects.toThrow(
        /number 'B-1' already exists/,
      );
    });
  });

  it('rethrows non-23505 errors unchanged', async () => {
    const capture: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'q' });
        const s = sql.toLowerCase();
        if (s.includes('from fin_accounting_periods') && s.includes('current_date between')) {
          return [{ id: 'p-auto' }];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args, fn: 'e' });
        if (sql.toLowerCase().includes('insert into fin_journal_batches')) {
          throw new Error('database is closed');
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
      executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    };
    const svc = new PostingService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.createAndPost(adminActor, baseInput)).rejects.toThrow('database is closed');
    });
  });
});
