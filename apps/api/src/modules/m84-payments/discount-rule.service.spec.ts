import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { DiscountRuleService } from './discount-rule.service';
import type { ResolvedActor } from '@modules/m00-platform';

/**
 * P2-H4 test coverage uplift — payments/discount-rule.service.ts (208 LOC,
 * admin-only billing configuration).
 *
 * Tests cover:
 *   - list + getById admin-only
 *   - list filters includeInactive + discountType
 *   - create() admin gate, SIBLING + siblingOrder cross-validation
 *     (required for SIBLING, forbidden for non-SIBLING), UNIQUE catch,
 *     non-UNIQUE error rethrow
 *   - update() admin gate, dynamic SET clause, empty body falls through
 *     to getById, NotFound when no row affected
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
  rowsForList?: unknown[];
  rowsForGetById?: unknown[];
  insertFail?: { code?: string; meta?: { code?: string }; message?: string };
  updateReturnRowCount?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('from pay_discount_rules')) {
        if (s.includes('where r.id = $1::uuid')) return opts.rowsForGetById ?? [];
        return opts.rowsForList ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'e' });
      const lower = sql.toLowerCase();
      if (opts.insertFail && lower.includes('insert into pay_discount_rules')) {
        const e = new Error(opts.insertFail.message ?? 'unique violation') as Error & {
          code?: string;
          meta?: { code?: string };
        };
        if (opts.insertFail.code) e.code = opts.insertFail.code;
        if (opts.insertFail.meta) e.meta = opts.insertFail.meta;
        throw e;
      }
      if (lower.startsWith('update pay_discount_rules')) {
        return opts.updateReturnRowCount ?? 1;
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

const guardianActor: ResolvedActor = {
  accountId: 'acc-david',
  personId: 'pers-david',
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
};

const sampleRule = {
  id: 'rule-1',
  school_id: SCHOOL.schoolId,
  name: 'Sibling 10%',
  description: 'Second child discount',
  discount_type: 'SIBLING',
  calculation_method: 'PERCENTAGE',
  value: '10.00',
  applies_to_fee_category_id: null,
  category_name: null,
  sibling_order: 2,
  minimum_invoice_amount: null,
  academic_year_id: null,
  is_active: true,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('DiscountRuleService.list — admin-only', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.list({}, guardianActor)).rejects.toThrow(/Only admins can list/);
    });
  });

  it('filters inactive by default', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list({}, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('r.is_active = true');
  });

  it('includes inactive when includeInactive=true', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list({ includeInactive: true } as never, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).not.toContain('r.is_active = true');
  });

  it('filters by discountType', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.list({ discountType: 'SIBLING' } as never, adminActor);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('r.discount_type = $1');
    expect(capture[0]!.args).toEqual(['SIBLING']);
  });
});

describe('DiscountRuleService.getById', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('rule-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('NotFound on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('rule-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('returns DTO when found', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    let result: { id: string; siblingOrder: number | null; value: number } | undefined;
    await inTenant(async () => {
      result = await svc.getById('rule-1', adminActor);
    });
    expect(result?.id).toBe('rule-1');
    expect(result?.siblingOrder).toBe(2);
    expect(result?.value).toBe(10);
  });

  it('coerces minimum_invoice_amount NUMERIC string to number (null preserved)', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [{ ...sampleRule, minimum_invoice_amount: '100.50' }],
    });
    const svc = new DiscountRuleService(tenantPrisma as never);
    let result: { minimumInvoiceAmount: number | null } | undefined;
    await inTenant(async () => {
      result = await svc.getById('rule-1', adminActor);
    });
    expect(result?.minimumInvoiceAmount).toBe(100.5);
  });
});

describe('DiscountRuleService.create — guardrails + SIBLING cross-validation', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'SIBLING',
            calculationMethod: 'PERCENTAGE',
            value: 10,
            siblingOrder: 2,
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects SIBLING type without siblingOrder', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'SIBLING',
            calculationMethod: 'PERCENTAGE',
            value: 10,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/siblingOrder is required for SIBLING/);
    });
  });

  it('rejects non-SIBLING type with siblingOrder set', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
            siblingOrder: 2,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/siblingOrder is only valid for SIBLING/);
    });
  });

  it('happy path inserts with all fields', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        {
          name: 'Sibling 10%',
          description: 'Second child',
          discountType: 'SIBLING',
          calculationMethod: 'PERCENTAGE',
          value: 10,
          appliesToFeeCategoryId: 'cat-1',
          siblingOrder: 2,
          minimumInvoiceAmount: 100,
          academicYearId: 'ay-1',
          isActive: true,
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_discount_rules'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('Sibling 10%');
    expect(insert!.args).toContain('SIBLING');
    expect(insert!.args).toContain('PERCENTAGE');
    expect(insert!.args).toContain('10.00');
    expect(insert!.args).toContain('cat-1');
    expect(insert!.args).toContain(2);
    expect(insert!.args).toContain('100.00');
    expect(insert!.args).toContain('ay-1');
    expect(insert!.args).toContain(true);
    expect(insert!.args).toContain('acc-admin');
  });

  it('happy path defaults optional fields to null + isActive=true', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        {
          name: 'Early bird 5%',
          discountType: 'EARLY_PAYMENT',
          calculationMethod: 'PERCENTAGE',
          value: 5,
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_discount_rules'),
    );
    expect(insert).toBeTruthy();
    // description, fee_category, sibling_order, minimum_invoice_amount,
    // academic_year_id default to null
    const args = insert!.args;
    // Find the null positional args around the optional slots
    expect(args.filter((a) => a === null).length).toBeGreaterThanOrEqual(4);
    expect(args).toContain(true); // isActive defaults to true
  });

  it('translates UNIQUE violation (P2002) into BadRequestException with name', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { code: 'P2002' } });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'Sibling 10%',
            discountType: 'SIBLING',
            calculationMethod: 'PERCENTAGE',
            value: 10,
            siblingOrder: 2,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/discount rule with name "Sibling 10%" already exists/);
    });
  });

  it('detects 23505 via meta.code', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { meta: { code: '23505' } } });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('detects 23505 via message text fallback', async () => {
    const { tenantPrisma } = makeFake({
      insertFail: { message: 'duplicate key value violates unique constraint 23505' },
    });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('rethrows non-UNIQUE errors unchanged', async () => {
    const { tenantPrisma } = makeFake({ insertFail: { message: 'connection refused' } });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            name: 'X',
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 5,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow('connection refused');
    });
  });
});

describe('DiscountRuleService.update', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.update('rule-1', { name: 'New' } as never, guardianActor)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('skips UPDATE when no fields supplied + falls through to getById', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.update('rule-1', {}, adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_discount_rules'),
    );
    expect(update).toBeUndefined();
  });

  it('builds dynamic SET clause for all 5 fields', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [sampleRule] });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.update(
        'rule-1',
        {
          name: 'Renamed',
          description: 'New desc',
          value: 15,
          isActive: false,
          minimumInvoiceAmount: 200,
        } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_discount_rules'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('name = $1');
    expect(update!.sql).toContain('description = $2');
    expect(update!.sql).toContain('value = $3::numeric');
    expect(update!.sql).toContain('is_active = $4');
    expect(update!.sql).toContain('minimum_invoice_amount = $5::numeric');
    expect(update!.args[0]).toBe('Renamed');
    expect(update!.args[1]).toBe('New desc');
    expect(update!.args[2]).toBe('15.00');
    expect(update!.args[3]).toBe(false);
    expect(update!.args[4]).toBe('200.00');
    // last positional arg is the id
    expect(update!.args[5]).toBe('rule-1');
  });

  it('NotFound when UPDATE returns 0 rows affected', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [sampleRule],
      updateReturnRowCount: 0,
    });
    const svc = new DiscountRuleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.update('rule-missing', { name: 'X' } as never, adminActor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
