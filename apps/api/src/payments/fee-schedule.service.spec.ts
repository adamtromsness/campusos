import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { FeeScheduleService } from './fee-schedule.service';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/fee-schedule.service.ts
 * (257 LOC, Tier 1 Financial; the per-school admin fee catalogue +
 * recurring schedule CRUD that drives InvoiceService.generateFromSchedule).
 *
 * Tests cover:
 *   - listCategories returns all rows ordered by name
 *   - createCategory admin-only + INSERT shape + post-INSERT reload
 *   - listSchedules joins ay + fee_category for display fields +
 *     ORDER BY ay.start_date DESC, fc.name, s.name
 *   - getScheduleById 404 on miss
 *   - createSchedule admin-only + academic year 404 + category 404 +
 *     inactive category 400 + INSERT shape with defaults
 *   - updateSchedule admin-only + dynamic SET for all 7 mutable fields
 *     + empty body short-circuit (no UPDATE fires) + NotFound on miss
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
  rowsForCategories?: unknown[];
  rowsForCategoryById?: unknown[];
  rowsForSchedules?: unknown[];
  rowsForScheduleById?: unknown[];
  rowsForAcademicYear?: unknown[];
  rowsForCategoryLookup?: unknown[];
  updateRowCount?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      if (s.includes('from pay_fee_categories') && s.includes('where id =')) {
        if (opts.rowsForCategoryById !== undefined) return opts.rowsForCategoryById;
        if (opts.rowsForCategoryLookup !== undefined) return opts.rowsForCategoryLookup;
        return [];
      }
      if (s.includes('from pay_fee_categories')) {
        return opts.rowsForCategories ?? [];
      }
      if (s.includes('from sis_academic_years')) {
        return opts.rowsForAcademicYear ?? [];
      }
      if (s.includes('from pay_fee_schedules s') && s.includes('where s.id =')) {
        return opts.rowsForScheduleById ?? [];
      }
      if (s.includes('from pay_fee_schedules s')) {
        return opts.rowsForSchedules ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      capture.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (s.startsWith('update pay_fee_schedules')) {
        return opts.updateRowCount ?? 1;
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

const sampleCategory = {
  id: 'cat-1',
  school_id: SCHOOL.schoolId,
  name: 'Technology Fee',
  description: 'Annual tech',
  is_active: true,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const sampleSchedule = {
  id: 'sch-1',
  school_id: SCHOOL.schoolId,
  academic_year_id: 'ay-2026',
  academic_year_name: '2026-2027',
  fee_category_id: 'cat-1',
  fee_category_name: 'Technology Fee',
  name: 'Tech Fee 2026',
  description: 'Annual tech fee',
  grade_level: null,
  amount: '400.00',
  is_recurring: true,
  recurrence: 'ANNUAL',
  is_active: true,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('FeeScheduleService.listCategories', () => {
  it('returns all rows ordered by name', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForCategories: [sampleCategory] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    let rows: Array<{ id: string; name: string; isActive: boolean }> = [];
    await inTenant(async () => {
      rows = await svc.listCategories();
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Technology Fee');
    expect(rows[0]!.isActive).toBe(true);
    expect(capture[0]!.sql.toLowerCase()).toContain('order by name');
  });
});

describe('FeeScheduleService.createCategory', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createCategory({ name: 'X' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('admin happy path with optional description', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForCategoryById: [sampleCategory],
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    let dto: { id: string; name: string } | undefined;
    await inTenant(async () => {
      dto = await svc.createCategory(
        { name: 'Technology Fee', description: 'Annual tech' } as never,
        adminActor,
      );
    });
    expect(dto?.name).toBe('Technology Fee');
    const insert = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_fee_categories'));
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('Technology Fee');
    expect(insert!.args).toContain('Annual tech');
  });

  it('description defaults to null', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForCategoryById: [{ ...sampleCategory, description: null }],
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createCategory({ name: 'Lunch Fee' } as never, adminActor);
    });
    const insert = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_fee_categories'));
    expect(insert!.args).toContain('Lunch Fee');
    expect(insert!.args).toContain(null);
  });
});

describe('FeeScheduleService.listSchedules', () => {
  it('joins ay + fc and orders newest year first then category + name', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForSchedules: [sampleSchedule] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    let rows: Array<{ academicYearName: string; feeCategoryName: string; amount: number }> = [];
    await inTenant(async () => {
      rows = await svc.listSchedules();
    });
    expect(rows[0]!.academicYearName).toBe('2026-2027');
    expect(rows[0]!.feeCategoryName).toBe('Technology Fee');
    expect(rows[0]!.amount).toBe(400);
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('order by ay.start_date desc, fc.name, s.name');
    expect(sql).toContain('join sis_academic_years ay');
    expect(sql).toContain('join pay_fee_categories fc');
  });
});

describe('FeeScheduleService.getScheduleById', () => {
  it('happy path', async () => {
    const { tenantPrisma } = makeFake({ rowsForScheduleById: [sampleSchedule] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    let dto: { id: string; recurrence: string } | undefined;
    await inTenant(async () => {
      dto = await svc.getScheduleById('sch-1');
    });
    expect(dto?.id).toBe('sch-1');
    expect(dto?.recurrence).toBe('ANNUAL');
  });

  it('404 on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForScheduleById: [] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getScheduleById('sch-missing')).rejects.toThrow(NotFoundException);
    });
  });
});

describe('FeeScheduleService.createSchedule', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSchedule(
          {
            academicYearId: 'ay-2026',
            feeCategoryId: 'cat-1',
            name: 'Tech Fee 2026',
            amount: 400,
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('404 when academic year not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForAcademicYear: [] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSchedule(
          {
            academicYearId: 'ay-missing',
            feeCategoryId: 'cat-1',
            name: 'Tech Fee 2026',
            amount: 400,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Academic year ay-missing not found/);
    });
  });

  it('404 when fee category not found', async () => {
    const { tenantPrisma } = makeFake({
      rowsForAcademicYear: [{ id: 'ay-2026' }],
      rowsForCategoryLookup: [],
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSchedule(
          {
            academicYearId: 'ay-2026',
            feeCategoryId: 'cat-missing',
            name: 'Tech Fee 2026',
            amount: 400,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Fee category cat-missing not found/);
    });
  });

  it('400 when fee category is inactive', async () => {
    const { tenantPrisma } = makeFake({
      rowsForAcademicYear: [{ id: 'ay-2026' }],
      rowsForCategoryLookup: [{ id: 'cat-1', is_active: false }],
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createSchedule(
          {
            academicYearId: 'ay-2026',
            feeCategoryId: 'cat-1',
            name: 'Tech Fee 2026',
            amount: 400,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/Fee category is inactive/);
    });
  });

  it('happy path inserts with all fields + defaults', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForAcademicYear: [{ id: 'ay-2026' }],
      rowsForCategoryLookup: [{ id: 'cat-1', is_active: true }],
      rowsForScheduleById: [sampleSchedule],
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createSchedule(
        {
          academicYearId: 'ay-2026',
          feeCategoryId: 'cat-1',
          name: 'Tech Fee 2026',
          description: 'Annual tech fee',
          gradeLevel: '5',
          amount: 400,
          isRecurring: true,
          recurrence: 'ANNUAL',
        } as never,
        adminActor,
      );
    });
    const insert = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_fee_schedules'));
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('ay-2026');
    expect(insert!.args).toContain('cat-1');
    expect(insert!.args).toContain('Tech Fee 2026');
    expect(insert!.args).toContain('Annual tech fee');
    expect(insert!.args).toContain('5');
    expect(insert!.args).toContain('400.00');
    expect(insert!.args).toContain(true);
    expect(insert!.args).toContain('ANNUAL');
  });

  it('defaults description / gradeLevel / isRecurring / recurrence when omitted', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForAcademicYear: [{ id: 'ay-2026' }],
      rowsForCategoryLookup: [{ id: 'cat-1', is_active: true }],
      rowsForScheduleById: [sampleSchedule],
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createSchedule(
        {
          academicYearId: 'ay-2026',
          feeCategoryId: 'cat-1',
          name: 'Tech Fee 2026',
          amount: 400,
        } as never,
        adminActor,
      );
    });
    const insert = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_fee_schedules'));
    expect(insert).toBeTruthy();
    // 2 explicit null args (description + gradeLevel) + isRecurring=false + recurrence=ANNUAL
    expect(insert!.args.filter((a) => a === null).length).toBeGreaterThanOrEqual(2);
    expect(insert!.args).toContain(false);
    expect(insert!.args).toContain('ANNUAL');
  });
});

describe('FeeScheduleService.updateSchedule', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateSchedule('sch-1', { name: 'New' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('empty body short-circuits (no UPDATE fires)', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForScheduleById: [sampleSchedule] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateSchedule('sch-1', {}, adminActor);
    });
    const update = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_fee_schedules'));
    expect(update).toBeUndefined();
  });

  it('dynamic SET for all 7 mutable fields', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForScheduleById: [sampleSchedule] });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateSchedule(
        'sch-1',
        {
          name: 'Renamed',
          description: 'New desc',
          gradeLevel: '9',
          amount: 450,
          isRecurring: false,
          recurrence: 'ANNUAL',
          isActive: false,
        } as never,
        adminActor,
      );
    });
    const update = capture.find((c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_fee_schedules'));
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('name = $1');
    expect(update!.sql).toContain('description = $2');
    expect(update!.sql).toContain('grade_level = $3');
    expect(update!.sql).toContain('amount = $4::numeric');
    expect(update!.sql).toContain('is_recurring = $5');
    expect(update!.sql).toContain('recurrence = $6');
    expect(update!.sql).toContain('is_active = $7');
    expect(update!.sql).toContain('updated_at = now()');
    expect(update!.args[0]).toBe('Renamed');
    expect(update!.args[1]).toBe('New desc');
    expect(update!.args[2]).toBe('9');
    expect(update!.args[3]).toBe('450.00');
    expect(update!.args[4]).toBe(false);
    expect(update!.args[5]).toBe('ANNUAL');
    expect(update!.args[6]).toBe(false);
    // Last positional is the id
    expect(update!.args[7]).toBe('sch-1');
  });

  it('NotFound when UPDATE affects 0 rows', async () => {
    const { tenantPrisma } = makeFake({
      rowsForScheduleById: [sampleSchedule],
      updateRowCount: 0,
    });
    const svc = new FeeScheduleService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateSchedule('sch-missing', { name: 'X' } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
