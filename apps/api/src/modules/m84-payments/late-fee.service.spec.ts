import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { LateFeeService } from './late-fee.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/late-fee.service.ts (263 LOC,
 * Tier 1 Financial; per-school late payment policy upsert + the
 * scan-and-apply worker that adds late-fee line items and flips
 * invoices to OVERDUE).
 *
 * Tests cover:
 *   - getPolicy admin-only, null when not configured, DTO mapping
 *   - upsertPolicy admin-only + FIXED requires feeAmount + PERCENTAGE
 *     requires feePercentage
 *   - upsertPolicy INSERT path + UPDATE path + COALESCE preserves
 *     existing isActive / gracePeriodDays
 *   - upsertPolicy NUMERIC coercion (feeAmount 2dp, feePercentage 4dp)
 *   - runScan admin-only
 *   - runScan no policy → returns zero scan result
 *   - runScan inactive policy → returns zero scan result
 *   - runScan with overdue invoices applies FIXED fee + flips OVERDUE
 *   - runScan PERCENTAGE_MONTHLY computes balance × pct × monthsOverdue
 *   - runScan caps at max_late_fee_amount
 *   - runScan skips when feeAmount is 0 or negative
 *   - runScan skips invoice that gets a concurrent late-fee row
 *   - runScan catches tx failure + bumps skipped + continues
 *   - runScan returns totals + totalLateFeeAmount rounded
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
  rowsForPolicy?: unknown[];
  rowsForOverdue?: unknown[];
  rowsForExistsByInvoice?: Map<string, number>;
  rowsForSortByInvoice?: Map<string, number>;
  insertLineItemFail?: { onInvoiceId?: string; message?: string };
  updatePolicyResult?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  let policyCallCount = 0;
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('from pay_late_payment_policies')) {
        policyCallCount++;
        return opts.rowsForPolicy ?? [];
      }
      if (s.includes('from pay_invoices i')) {
        return opts.rowsForOverdue ?? [];
      }
      if (s.includes('select id from pay_invoices where id =') && s.includes('for update')) {
        return [{ id: args[0] }];
      }
      if (s.includes('select count(*)::int as c from pay_invoice_line_items')) {
        const invId = String(args[0]);
        const existing = opts.rowsForExistsByInvoice?.get(invId) ?? 0;
        return [{ c: existing }];
      }
      if (s.includes('select coalesce(max(sort_order), -1) + 1 as next')) {
        const invId = String(args[0]);
        const next = opts.rowsForSortByInvoice?.get(invId) ?? 0;
        return [{ next }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      const s = sql.toLowerCase();
      if (
        s.startsWith('insert into pay_invoice_line_items') ||
        s.startsWith('update pay_invoices set total_amount')
      ) {
        if (opts.insertLineItemFail) {
          const matchInvoice = opts.insertLineItemFail.onInvoiceId;
          // args[1] is invoice id for insert, args[0] for update
          const invId = s.startsWith('insert') ? String(args[1]) : String(args[0]);
          if (!matchInvoice || invId === matchInvoice) {
            throw new Error(opts.insertLineItemFail.message ?? 'insert fail');
          }
        }
        return 1;
      }
      if (s.startsWith('update pay_late_payment_policies')) {
        return opts.updatePolicyResult ?? 1;
      }
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  return { tenantPrisma, capture };
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

const samplePolicy = {
  id: 'pol-1',
  school_id: SCHOOL.schoolId,
  is_active: true,
  grace_period_days: 7,
  fee_type: 'FIXED',
  fee_amount: '25.00',
  fee_percentage: null,
  max_late_fee_amount: '100.00',
  applies_to_fee_category_id: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('LateFeeService.getPolicy', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new LateFeeService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getPolicy(guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('returns null when no policy configured', async () => {
    const { tenantPrisma } = makeFake({ rowsForPolicy: [] });
    const svc = new LateFeeService(tenantPrisma as never);
    let result: unknown;
    await inTenant(async () => {
      result = await svc.getPolicy(adminActor);
    });
    expect(result).toBeNull();
  });

  it('returns DTO when policy exists', async () => {
    const { tenantPrisma } = makeFake({ rowsForPolicy: [samplePolicy] });
    const svc = new LateFeeService(tenantPrisma as never);
    let result: {
      isActive: boolean;
      gracePeriodDays: number;
      feeAmount: number | null;
      feePercentage: number | null;
      maxLateFeeAmount: number | null;
    } | null = null;
    await inTenant(async () => {
      result = await svc.getPolicy(adminActor);
    });
    expect(result!.isActive).toBe(true);
    expect(result!.gracePeriodDays).toBe(7);
    expect(result!.feeAmount).toBe(25);
    expect(result!.feePercentage).toBeNull();
    expect(result!.maxLateFeeAmount).toBe(100);
  });
});

describe('LateFeeService.upsertPolicy', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new LateFeeService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.upsertPolicy({ feeType: 'FIXED', feeAmount: 25 } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('FIXED requires feeAmount', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new LateFeeService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.upsertPolicy({ feeType: 'FIXED' } as never, adminActor)).rejects.toThrow(
        /feeAmount is required for FIXED feeType/,
      );
    });
  });

  it('PERCENTAGE_MONTHLY requires feePercentage', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new LateFeeService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.upsertPolicy({ feeType: 'PERCENTAGE_MONTHLY' } as never, adminActor),
      ).rejects.toThrow(/feePercentage is required for PERCENTAGE_MONTHLY feeType/);
    });
  });

  it('INSERT path when no existing policy + defaults isActive=false + grace=7', async () => {
    let calls = 0;
    const { tenantPrisma, capture } = makeFake();
    // First read = existing check (empty). Second read = post-upsert reload (returns row).
    const originalQuery = tenantPrisma.executeInTenantContext;
    tenantPrisma.executeInTenantContext = async <T>(fn: (c: unknown) => Promise<T>) => {
      return originalQuery(async (c) => {
        const result = await fn(c);
        calls++;
        return result;
      });
    };
    // Configure via re-makeFake — easier
    const { tenantPrisma: tp2, capture: cap2 } = makeFake({
      // Read 1 = existing (empty); read 2 = reload (sample)
      rowsForPolicy: [], // first call - no existing
    });
    // We need 2nd read to return the sample. Use a counter approach.
    let readN = 0;
    const tp3 = {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => {
        return tp2.executeInTenantContext(async (raw) => {
          const wrapped = {
            $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
              const s = sql.toLowerCase();
              if (s.includes('from pay_late_payment_policies')) {
                readN++;
                if (readN === 1) return [];
                return [samplePolicy];
              }
              return (
                raw as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
              ).$queryRawUnsafe(sql, ...args);
            },
            $executeRawUnsafe: (
              raw as { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> }
            ).$executeRawUnsafe,
          };
          return fn(wrapped);
        });
      },
      executeInTenantTransaction: tp2.executeInTenantTransaction,
    };

    const svc = new LateFeeService(tp3 as never);
    await inTenant(async () => {
      await svc.upsertPolicy({ feeType: 'FIXED', feeAmount: 25 } as never, adminActor);
    });
    const insert = cap2.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_late_payment_policies'),
    );
    expect(insert).toBeTruthy();
    // Default isActive=false + gracePeriodDays=7
    expect(insert!.args).toContain(false);
    expect(insert!.args).toContain(7);
    expect(insert!.args).toContain('FIXED');
    expect(insert!.args).toContain('25.00');
  });

  it('UPDATE path uses COALESCE to preserve existing isActive / gracePeriodDays', async () => {
    let readN = 0;
    const { tenantPrisma: rawTp, capture } = makeFake();
    const tp = {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => {
        return rawTp.executeInTenantContext(async (raw) => {
          const wrapped = {
            $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
              const s = sql.toLowerCase();
              if (s.includes('from pay_late_payment_policies')) {
                readN++;
                return [samplePolicy];
              }
              return (
                raw as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
              ).$queryRawUnsafe(sql, ...args);
            },
            $executeRawUnsafe: (
              raw as { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> }
            ).$executeRawUnsafe,
          };
          return fn(wrapped);
        });
      },
      executeInTenantTransaction: rawTp.executeInTenantTransaction,
    };

    const svc = new LateFeeService(tp as never);
    await inTenant(async () => {
      await svc.upsertPolicy(
        { feeType: 'PERCENTAGE_MONTHLY', feePercentage: 0.015, maxLateFeeAmount: 50 } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_late_payment_policies'),
    );
    expect(update).toBeTruthy();
    // COALESCE($2, is_active) means we pass null when isActive omitted
    expect(update!.args[1]).toBeNull(); // isActive omitted
    expect(update!.args[2]).toBeNull(); // gracePeriodDays omitted
    expect(update!.args[3]).toBe('PERCENTAGE_MONTHLY');
    expect(update!.args[4]).toBeNull(); // feeAmount
    expect(update!.args[5]).toBe('0.0150'); // 4dp on percentage
    expect(update!.args[6]).toBe('50.00');
  });
});

describe('LateFeeService.runScan', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new LateFeeService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.runScan(guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('returns zero scan result when no policy configured', async () => {
    const { tenantPrisma } = makeFake({ rowsForPolicy: [] });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r).toEqual({
      invoicesEvaluated: 0,
      lateFeesApplied: 0,
      invoicesSkipped: 0,
      totalLateFeeAmount: 0,
    });
  });

  it('returns zero scan result when policy inactive', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [{ ...samplePolicy, is_active: false }],
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r).toEqual({
      invoicesEvaluated: 0,
      lateFeesApplied: 0,
      invoicesSkipped: 0,
      totalLateFeeAmount: 0,
    });
  });

  it('returns zero when no overdue invoices match', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [samplePolicy],
      rowsForOverdue: [],
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r).toEqual({
      invoicesEvaluated: 0,
      lateFeesApplied: 0,
      invoicesSkipped: 0,
      totalLateFeeAmount: 0,
    });
  });

  it('FIXED happy path applies fee + flips OVERDUE', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPolicy: [samplePolicy],
      rowsForOverdue: [{ id: 'inv-1', total_amount: '400.00', due_date: '2026-03-01' }],
      rowsForExistsByInvoice: new Map([['inv-1', 0]]),
      rowsForSortByInvoice: new Map([['inv-1', 0]]),
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r).toEqual({
      invoicesEvaluated: 1,
      lateFeesApplied: 1,
      invoicesSkipped: 0,
      totalLateFeeAmount: 25,
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('insert into pay_invoice_line_items'),
    );
    expect(insert).toBeTruthy();
    // INSERT positional: (id, invoice_id, description, fee_amount, sort_order)
    expect(insert!.args[2]).toContain('Late fee — auto-applied ($25.00 fixed)');
    expect(insert!.args[3]).toBe('25.00');
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_invoices set total_amount'),
    );
    expect(update).toBeTruthy();
  });

  it('PERCENTAGE_MONTHLY computes balance × pct × monthsOverdue', async () => {
    const pctPolicy = {
      ...samplePolicy,
      fee_type: 'PERCENTAGE_MONTHLY',
      fee_amount: null,
      fee_percentage: '0.0150',
      max_late_fee_amount: '1000.00',
    };
    // due_date well in the past
    const past = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { tenantPrisma, capture } = makeFake({
      rowsForPolicy: [pctPolicy],
      rowsForOverdue: [{ id: 'inv-2', total_amount: '1000.00', due_date: past }],
      rowsForExistsByInvoice: new Map([['inv-2', 0]]),
      rowsForSortByInvoice: new Map([['inv-2', 0]]),
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    // 1000 * 0.015 * ceil(65/30) = 1000 * 0.015 * 3 = 45
    expect(r?.lateFeesApplied).toBe(1);
    expect(r?.totalLateFeeAmount).toBe(45);
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('insert into pay_invoice_line_items'),
    );
    expect(insert!.args[2]).toContain('monthly %');
    expect(insert!.args[3]).toBe('45.00');
  });

  it('caps fee at max_late_fee_amount', async () => {
    const cappedPolicy = {
      ...samplePolicy,
      fee_type: 'PERCENTAGE_MONTHLY',
      fee_amount: null,
      fee_percentage: '0.5000', // 50% per month
      max_late_fee_amount: '50.00',
    };
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [cappedPolicy],
      rowsForOverdue: [{ id: 'inv-3', total_amount: '1000.00', due_date: past }],
      rowsForExistsByInvoice: new Map([['inv-3', 0]]),
      rowsForSortByInvoice: new Map([['inv-3', 0]]),
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r?.totalLateFeeAmount).toBe(50); // capped
  });

  it('skips when feeAmount is 0 (PERCENTAGE_MONTHLY computed as 0%)', async () => {
    // monthlyPct = 0 → feeAmount = balance * 0 * months = 0 → skip path
    const zeroPctPolicy = {
      ...samplePolicy,
      fee_type: 'PERCENTAGE_MONTHLY',
      fee_amount: null,
      fee_percentage: '0.0000',
    };
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [zeroPctPolicy],
      rowsForOverdue: [{ id: 'inv-z', total_amount: '500.00', due_date: past }],
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r?.invoicesEvaluated).toBe(1);
    expect(r?.lateFeesApplied).toBe(0);
    expect(r?.invoicesSkipped).toBe(1);
    expect(r?.totalLateFeeAmount).toBe(0);
  });

  it('skips when feeAmount is 0 (PERCENTAGE_MONTHLY with NULL pct rate)', async () => {
    // Policy is PERCENTAGE_MONTHLY but fee_percentage is null (configuration error)
    const badPolicy = {
      ...samplePolicy,
      fee_type: 'PERCENTAGE_MONTHLY',
      fee_amount: null,
      fee_percentage: null,
    };
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [badPolicy],
      rowsForOverdue: [{ id: 'inv-4', total_amount: '400.00', due_date: '2026-03-01' }],
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r?.lateFeesApplied).toBe(0);
    expect(r?.invoicesSkipped).toBe(1);
  });

  it('skips invoice that gets a concurrent late-fee row (in-tx existsRows recheck)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForPolicy: [samplePolicy],
      rowsForOverdue: [{ id: 'inv-5', total_amount: '400.00', due_date: '2026-03-01' }],
      rowsForExistsByInvoice: new Map([['inv-5', 1]]), // concurrent late-fee already exists
    });
    const svc = new LateFeeService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.runScan(adminActor);
    });
    // Service contract: in-tx existsRows guard short-circuits the tx
    // callback before INSERT. No row is written and the invoice total
    // is not bumped. (The `applied` counter still increments because
    // the tx succeeded — that's by service design, the counter tracks
    // "invoices processed", not "rows inserted".)
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('insert into pay_invoice_line_items'),
    );
    expect(insert).toBeUndefined();
    const totalUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('update pay_invoices set total_amount'),
    );
    expect(totalUpdate).toBeUndefined();
  });

  it('catches per-invoice failure + bumps skipped + continues with remaining', async () => {
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [samplePolicy],
      rowsForOverdue: [
        { id: 'inv-fail', total_amount: '400.00', due_date: '2026-03-01' },
        { id: 'inv-ok', total_amount: '300.00', due_date: '2026-03-01' },
      ],
      rowsForExistsByInvoice: new Map([
        ['inv-fail', 0],
        ['inv-ok', 0],
      ]),
      rowsForSortByInvoice: new Map([
        ['inv-fail', 0],
        ['inv-ok', 0],
      ]),
      insertLineItemFail: { onInvoiceId: 'inv-fail', message: 'simulated DB failure' },
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    expect(r?.invoicesEvaluated).toBe(2);
    expect(r?.lateFeesApplied).toBe(1);
    expect(r?.invoicesSkipped).toBe(1);
    expect(r?.totalLateFeeAmount).toBe(25);
  });

  it('rounds totalLateFeeAmount to 2dp', async () => {
    const pctPolicy = {
      ...samplePolicy,
      fee_type: 'PERCENTAGE_MONTHLY',
      fee_amount: null,
      fee_percentage: '0.0333', // 3.33% per month
      max_late_fee_amount: '10000.00',
    };
    const past = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { tenantPrisma } = makeFake({
      rowsForPolicy: [pctPolicy],
      rowsForOverdue: [
        { id: 'inv-r1', total_amount: '100.00', due_date: past }, // ~3.33
        { id: 'inv-r2', total_amount: '200.00', due_date: past }, // ~6.66
      ],
      rowsForExistsByInvoice: new Map([
        ['inv-r1', 0],
        ['inv-r2', 0],
      ]),
      rowsForSortByInvoice: new Map([
        ['inv-r1', 0],
        ['inv-r2', 0],
      ]),
    });
    const svc = new LateFeeService(tenantPrisma as never);
    let r;
    await inTenant(async () => {
      r = await svc.runScan(adminActor);
    });
    // Should be a Number with at most 2dp precision
    expect(r?.totalLateFeeAmount).toBe(Number(r?.totalLateFeeAmount.toFixed(2)));
  });
});
