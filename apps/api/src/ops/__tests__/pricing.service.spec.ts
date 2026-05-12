import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PricingService } from '../services/pricing.service';

/**
 * P2-21b — PricingService.updateBand keystone tests.
 *
 * The keystone behaviour: when monthly_price_cents or
 * annual_price_cents changes via update(), the service writes a
 * platform_pricing_history row inside the SAME tx as the band UPDATE
 * so the audit trail can never desync. changedBy is required for any
 * price change.
 */

interface BandState {
  id: string;
  name: string;
  student_range_min: number;
  student_range_max: number | null;
  monthly_price_cents: number;
  annual_price_cents: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function makeStub(initial: Partial<BandState>) {
  const band: BandState = {
    id: 'band-1',
    name: 'Standard',
    student_range_min: 0,
    student_range_max: 200,
    monthly_price_cents: 10000,
    annual_price_cents: 100000,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...initial,
  };
  const historyInserts: Array<{ sql: string; params: unknown[] }> = [];
  const bandUpdates: Array<{ sql: string; params: unknown[] }> = [];

  const tx = {
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INSERT INTO platform.platform_pricing_history')) {
        historyInserts.push({ sql, params });
        return 1;
      }
      if (sql.includes('UPDATE platform.platform_pricing_bands')) {
        bandUpdates.push({ sql, params });
        return 1;
      }
      return 0;
    },
  };

  const prisma = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM platform.platform_pricing_bands') && sql.includes('WHERE id')) {
        return [band];
      }
      return [];
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      return fn(tx);
    },
  };
  const employees = {
    loadOrFail: async (_id: string) => {
      // Allow the changedBy lookup.
      return { id: _id };
    },
  };
  return { prisma, employees, historyInserts, bandUpdates };
}

describe('PricingService.updateBand', () => {
  it('rejects price change without changedBy with 400', async () => {
    const stub = makeStub({});
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await expect(svc.updateBand('band-1', { monthlyPriceCents: 12000 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects studentRangeMax < studentRangeMin with 400', async () => {
    const stub = makeStub({ student_range_min: 100, student_range_max: 200 });
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await expect(svc.updateBand('band-1', { studentRangeMin: 300 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('writes history row + band UPDATE atomically when prices change', async () => {
    const stub = makeStub({ monthly_price_cents: 10000, annual_price_cents: 100000 });
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await svc.updateBand('band-1', {
      monthlyPriceCents: 12000,
      annualPriceCents: 120000,
      changedBy: 'emp-1',
      effectiveDate: '2026-06-01',
    });
    expect(stub.historyInserts.length).toBe(1);
    expect(stub.bandUpdates.length).toBe(1);
    const ins = stub.historyInserts[0]!;
    expect(ins.sql).toContain('INSERT INTO platform.platform_pricing_history');
    expect(ins.params[2]).toBe(10000); // previous_monthly_cents
    expect(ins.params[3]).toBe(12000); // new_monthly_cents
    expect(ins.params[4]).toBe(100000); // previous_annual_cents
    expect(ins.params[5]).toBe(120000); // new_annual_cents
    expect(ins.params[6]).toBe('2026-06-01');
  });

  it('does NOT write history row when only non-price fields change', async () => {
    const stub = makeStub({});
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await svc.updateBand('band-1', { name: 'Renamed' });
    expect(stub.historyInserts.length).toBe(0);
    expect(stub.bandUpdates.length).toBe(1);
  });

  it('writes history row on monthly-only change (annual unchanged)', async () => {
    const stub = makeStub({ monthly_price_cents: 10000, annual_price_cents: 100000 });
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await svc.updateBand('band-1', { monthlyPriceCents: 11500, changedBy: 'emp-1' });
    expect(stub.historyInserts.length).toBe(1);
    const ins = stub.historyInserts[0]!;
    // previous_monthly = old, new_monthly = new, previous_annual = old, new_annual = old (no change)
    expect(ins.params[2]).toBe(10000);
    expect(ins.params[3]).toBe(11500);
    expect(ins.params[4]).toBe(100000);
    expect(ins.params[5]).toBe(100000);
  });

  it('handles toggling isActive without writing history', async () => {
    const stub = makeStub({});
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await svc.updateBand('band-1', { isActive: false });
    expect(stub.historyInserts.length).toBe(0);
    expect(stub.bandUpdates.length).toBe(1);
    const upd = stub.bandUpdates[0]!;
    expect(upd.sql).toContain('is_active = $1');
  });
});

describe('PricingService.createBand', () => {
  it('rejects studentRangeMax < studentRangeMin', async () => {
    const stub = makeStub({});
    const svc = new PricingService(stub.prisma as any, stub.employees as any);
    await expect(
      svc.createBand({
        name: 'Bad',
        studentRangeMin: 500,
        studentRangeMax: 100,
        monthlyPriceCents: 1000,
        annualPriceCents: 10000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
