import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { SavedPaymentMethodService } from './saved-payment-method.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/saved-payment-method.service.ts
 * (195 LOC, Tier 1 Financial; token-only Stripe pm_ + last-four + brand
 * storage with REVIEW-P2-6 MAJOR 3 school-scoped UPDATE/SELECT
 * everywhere + family-account row scope).
 *
 * Tests cover:
 *   - listForFamily admin sees own; parent must hold family account
 *   - listForFamily school-scoped SELECT (cross-school family UUID → 404)
 *   - create admin or family-member; school predicate on clear-default
 *     UPDATE and INSERT; UNIQUE catch translates to friendly 400;
 *     non-UNIQUE error rethrows; isDefault optional + defaults
 *   - getById 404 don't-leak-existence on cross-school + missing
 *   - remove via soft-delete UPDATE
 *   - assertCanAccessFamily admin bypass; missing personId 403;
 *     unlinked guardian 404
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
  rowsForFamilyCheck?: unknown[];
  insertFail?: { message?: string };
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('from pay_saved_payment_methods') && s.includes('and id =')) {
        return opts.rowsForGetById ?? [];
      }
      if (s.includes('from pay_saved_payment_methods')) {
        return opts.rowsForList ?? [];
      }
      if (s.includes('select 1 from pay_family_accounts')) {
        return opts.rowsForFamilyCheck ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      capture.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (opts.insertFail && s.includes('insert into pay_saved_payment_methods')) {
        throw new Error(opts.insertFail.message ?? 'insert fail');
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

const guardianNoPersonId: ResolvedActor = {
  accountId: 'acc-david',
  personId: null,
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
};

const samplePM = {
  id: 'pm-1',
  school_id: SCHOOL.schoolId,
  family_account_id: 'fa-1',
  stripe_payment_method_id: 'pm_test_1234567890',
  method_type: 'CARD',
  card_last_four: '4242',
  card_brand: 'Visa',
  card_exp_month: 12,
  card_exp_year: 2028,
  bank_last_four: null,
  is_default: true,
  added_at: '2026-04-28T10:00:00Z',
};

describe('SavedPaymentMethodService.listForFamily', () => {
  it('admin happy path school-scoped SELECT', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForList: [samplePM] });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    let rows: Array<{ id: string; cardLastFour: string | null; isDefault: boolean }> = [];
    await inTenant(async () => {
      rows = await svc.listForFamily('fa-1', adminActor);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cardLastFour).toBe('4242');
    expect(rows[0]!.isDefault).toBe(true);
    // Verify school-scoped predicate + removed_at IS NULL + ORDER BY
    const listQuery = capture.find((c) =>
      c.sql.toLowerCase().includes('from pay_saved_payment_methods'),
    );
    expect(listQuery).toBeTruthy();
    const sql = listQuery!.sql.toLowerCase();
    expect(sql).toContain('school_id = $1::uuid');
    expect(sql).toContain('family_account_id = $2::uuid');
    expect(sql).toContain('removed_at is null');
    expect(sql).toContain('order by is_default desc, added_at desc');
  });

  it('guardian must be linked to family (404 if not holder)', async () => {
    const { tenantPrisma } = makeFake({ rowsForFamilyCheck: [] });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listForFamily('fa-other', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('guardian linked happy path', async () => {
    const { tenantPrisma } = makeFake({
      rowsForFamilyCheck: [{}],
      rowsForList: [samplePM],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      const rows = await svc.listForFamily('fa-1', guardianActor);
      expect(rows).toHaveLength(1);
    });
  });
});

describe('SavedPaymentMethodService.create', () => {
  it('admin happy path inserts with school-scoped INSERT', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForGetById: [samplePM],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    let dto: { id: string } | undefined;
    await inTenant(async () => {
      dto = await svc.create(
        {
          familyAccountId: 'fa-1',
          stripePaymentMethodId: 'pm_test_1234567890',
          cardLastFour: '4242',
          cardBrand: 'Visa',
          cardExpMonth: 12,
          cardExpYear: 2028,
        } as never,
        adminActor,
      );
    });
    expect(dto?.id).toBe('pm-1');
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_saved_payment_methods'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('fa-1');
    expect(insert!.args).toContain('pm_test_1234567890');
    expect(insert!.args).toContain('CARD'); // default methodType
    expect(insert!.args).toContain('4242');
    expect(insert!.args).toContain('Visa');
    expect(insert!.args).toContain(12);
    expect(insert!.args).toContain(2028);
    expect(insert!.args).toContain(false); // default isDefault
  });

  it('isDefault=true clears existing default with school-scoped UPDATE first', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForGetById: [samplePM],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        {
          familyAccountId: 'fa-1',
          stripePaymentMethodId: 'pm_test_5678',
          isDefault: true,
        } as never,
        adminActor,
      );
    });
    const clearUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().startsWith('update pay_saved_payment_methods set is_default = false'),
    );
    expect(clearUpdate).toBeTruthy();
    expect(clearUpdate!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(clearUpdate!.args[0]).toBe(SCHOOL.schoolId);
    expect(clearUpdate!.args[1]).toBe('fa-1');
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_saved_payment_methods'),
    );
    expect(insert).toBeTruthy();
    // isDefault=true was passed
    expect(insert!.args).toContain(true);
  });

  it('isDefault=false skips clear-default UPDATE', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForGetById: [samplePM],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        {
          familyAccountId: 'fa-1',
          stripePaymentMethodId: 'pm_test_5678',
          isDefault: false,
        } as never,
        adminActor,
      );
    });
    const clearUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().startsWith('update pay_saved_payment_methods set is_default = false'),
    );
    expect(clearUpdate).toBeUndefined();
  });

  it('translates UNIQUE catch to friendly 400 (pay_saved_pm_stripe_id_uq)', async () => {
    const { tenantPrisma } = makeFake({
      insertFail: { message: 'violates unique constraint pay_saved_pm_stripe_id_uq' },
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            familyAccountId: 'fa-1',
            stripePaymentMethodId: 'pm_dup',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already saved for this school/);
    });
  });

  it('translates UNIQUE catch via 23505 message', async () => {
    const { tenantPrisma } = makeFake({
      insertFail: { message: 'duplicate key 23505' },
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            familyAccountId: 'fa-1',
            stripePaymentMethodId: 'pm_dup',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already saved/);
    });
  });

  it('non-UNIQUE insert errors rethrow', async () => {
    const { tenantPrisma } = makeFake({
      insertFail: { message: 'connection refused' },
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            familyAccountId: 'fa-1',
            stripePaymentMethodId: 'pm_x',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/connection refused/);
    });
  });

  it('guardian with no personId rejected with 403', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.create(
          {
            familyAccountId: 'fa-1',
            stripePaymentMethodId: 'pm_x',
          } as never,
          guardianNoPersonId,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('CARD methodType defaults to CARD when omitted; BANK_TRANSFER preserved', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForGetById: [{ ...samplePM, method_type: 'BANK_TRANSFER' }],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.create(
        {
          familyAccountId: 'fa-1',
          stripePaymentMethodId: 'pm_bt',
          methodType: 'BANK_TRANSFER',
          bankLastFour: '6789',
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_saved_payment_methods'),
    );
    expect(insert!.args).toContain('BANK_TRANSFER');
    expect(insert!.args).toContain('6789');
  });
});

describe('SavedPaymentMethodService.getById', () => {
  it('admin happy path', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [samplePM] });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    let dto: { id: string; familyAccountId: string } | undefined;
    await inTenant(async () => {
      dto = await svc.getById('pm-1', adminActor);
    });
    expect(dto?.id).toBe('pm-1');
    expect(dto?.familyAccountId).toBe('fa-1');
  });

  it('404 on cross-school / missing (school-scoped SELECT)', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('pm-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('guardian must be on the family account', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [samplePM],
      rowsForFamilyCheck: [],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getById('pm-1', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('guardian linked happy path', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGetById: [samplePM],
      rowsForFamilyCheck: [{}],
    });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      const dto = await svc.getById('pm-1', guardianActor);
      expect(dto.id).toBe('pm-1');
    });
  });
});

describe('SavedPaymentMethodService.remove (soft-delete)', () => {
  it('happy path UPDATE with school predicate', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForGetById: [samplePM] });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    let result: { id: string; removed: boolean } | undefined;
    await inTenant(async () => {
      result = await svc.remove('pm-1', adminActor);
    });
    expect(result).toEqual({ id: 'pm-1', removed: true });
    const update = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().startsWith('update pay_saved_payment_methods set removed_at = now()'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(update!.args).toEqual([SCHOOL.schoolId, 'pm-1']);
  });

  it('404 propagates from getById row scope', async () => {
    const { tenantPrisma } = makeFake({ rowsForGetById: [] });
    const svc = new SavedPaymentMethodService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.remove('pm-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });
});
