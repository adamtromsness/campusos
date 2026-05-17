import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { AutoInvoiceService } from './auto-invoice.service';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/auto-invoice.service.ts (757 LOC,
 * Tier 1 Financial; rules CRUD + the keystone runGeneration engine that
 * walks eligible students, groups by family, applies SIBLING +
 * EARLY_PAYMENT discounts, and creates one DRAFT invoice per family).
 *
 * Tests cover:
 *   - onModuleInit (scaffolded poll log only)
 *   - listRules / getRuleById admin-only + school predicate + 404
 *   - createRule admin gate, DATE_OF_MONTH requires triggerDayOfMonth,
 *     UNIQUE catch translates to friendly 400, defaults isActive=true
 *   - updateRule admin gate + empty body short-circuit + dynamic SET
 *     for all 6 fields + school predicate on WHERE + NotFound when 0 rows
 *   - triggerRule admin-only + inactive rule rejected + runs runGeneration
 *     with AUTO_RULE_TRIGGERED type
 *   - generateFromFeeSchedule admin-only + runs FEE_SCHEDULE_BULK
 *   - listRuns admin-only + school predicate + optional status + autoRuleId
 *     filters + ORDER BY created_at DESC LIMIT 100
 *   - getRunById admin-only + 404 don't-leak-existence
 *   - runGeneration happy path: COMPLETED status + COUNTS + invoice INSERT
 *     + line items INSERT + autoRuleId stamps last_run_at
 *   - runGeneration fee schedule not found → FAILED status + error_summary
 *   - runGeneration grade filter applied when rule.appliesToGradeLevel
 *   - runGeneration applies_to_student_ids array branch
 *   - runGeneration skips when family already has invoice for this fee schedule
 *   - runGeneration skips when student has no family account
 *   - runGeneration SIBLING discount applied to 2nd+ children
 *   - runGeneration EARLY_PAYMENT percentage discount
 *   - runGeneration EARLY_PAYMENT fixed-amount discount (Math.min cap)
 *   - runGeneration minimum_invoice_amount gate
 *   - runGeneration fee_category_id mismatch skips discount
 *   - runGeneration per-family error caught + failed++
 *   - isUniqueViolation helper: P2002, meta.code 23505, message regex
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
  rowsForListRules?: unknown[];
  rowsForRuleById?: unknown[];
  rowsForRunList?: unknown[];
  rowsForRunById?: unknown[];
  rowsForRunByIdSeq?: unknown[][];
  rowsForFeeSchedule?: unknown[];
  rowsForStudents?: unknown[];
  rowsForFamilyAccountByStudent?: Map<string, unknown[]>;
  rowsForDiscountRules?: unknown[];
  rowsForExistingByFamily?: Map<string, number>;
  rowsForSiblingCount?: Map<string, number>;
  insertRuleFail?: { code?: string; meta?: { code?: string }; message?: string };
  updateRuleResult?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  let runByIdCallIdx = 0;
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // Rule list (SELECT_RULE_BASE + WHERE r.school_id)
      if (s.includes('from pay_auto_invoice_rules r') && s.includes('and r.id =')) {
        return opts.rowsForRuleById ?? [];
      }
      if (s.includes('from pay_auto_invoice_rules r')) {
        return opts.rowsForListRules ?? [];
      }
      // Run by id (SELECT_RUN_BASE + WHERE r.id)
      if (s.includes('from pay_invoice_generation_runs r') && s.includes('and r.id =')) {
        if (opts.rowsForRunByIdSeq) {
          const r = opts.rowsForRunByIdSeq[runByIdCallIdx] ?? [];
          runByIdCallIdx++;
          return r;
        }
        return opts.rowsForRunById ?? [];
      }
      if (s.includes('from pay_invoice_generation_runs r')) {
        return opts.rowsForRunList ?? [];
      }
      // Fee schedule lookup
      if (s.includes('from pay_fee_schedules where school_id')) {
        return opts.rowsForFeeSchedule ?? [];
      }
      // Students
      if (s.includes('from sis_students s')) {
        return opts.rowsForStudents ?? [];
      }
      // Family account by student
      if (s.includes('from pay_family_account_students fas') && s.includes('join pay_family_accounts')) {
        const studentId = String(args[0]);
        return opts.rowsForFamilyAccountByStudent?.get(studentId) ?? [];
      }
      // Discount rules
      if (s.includes('from pay_discount_rules')) {
        return opts.rowsForDiscountRules ?? [];
      }
      // Existing invoice check
      if (s.includes('from pay_invoices i join pay_invoice_line_items')) {
        const famId = String(args[1]);
        const count = opts.rowsForExistingByFamily?.get(famId) ?? 0;
        return [{ c: count }];
      }
      // Sibling count
      if (s.includes('count(*)::int as c from pay_family_account_students fas')) {
        const famId = String(args[0]);
        const count = opts.rowsForSiblingCount?.get(famId) ?? 1;
        return [{ c: count }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      capture.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (opts.insertRuleFail && s.includes('insert into pay_auto_invoice_rules')) {
        const err = new Error(opts.insertRuleFail.message ?? 'fail') as Error & {
          code?: string;
          meta?: { code?: string };
        };
        if (opts.insertRuleFail.code) err.code = opts.insertRuleFail.code;
        if (opts.insertRuleFail.meta) err.meta = opts.insertRuleFail.meta;
        throw err;
      }
      if (s.startsWith('update pay_auto_invoice_rules set ')) {
        return opts.updateRuleResult ?? 1;
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

const sampleRule = {
  id: 'rule-1',
  school_id: SCHOOL.schoolId,
  name: 'Monthly Tuition',
  description: 'Auto-bill on the 1st',
  trigger_type: 'DATE_OF_MONTH',
  fee_schedule_id: 'fs-1',
  fee_schedule_name: 'Tuition 2026',
  trigger_day_of_month: 1,
  trigger_term_offset_days: null,
  applies_to_grade_level: null,
  is_active: true,
  last_run_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const sampleRun = {
  id: 'run-1',
  school_id: SCHOOL.schoolId,
  run_type: 'AUTO_RULE_TRIGGERED',
  fee_schedule_id: 'fs-1',
  fee_schedule_name: 'Tuition 2026',
  auto_rule_id: 'rule-1',
  academic_year_id: 'ay-2026',
  initiated_by: 'acc-admin',
  total_families_targeted: 0,
  invoices_created: 0,
  invoices_skipped: 0,
  invoices_failed: 0,
  status: 'COMPLETED',
  error_summary: null,
  started_at: '2026-04-28T10:00:00Z',
  completed_at: '2026-04-28T10:00:01Z',
  created_at: '2026-04-28T10:00:00Z',
  updated_at: '2026-04-28T10:00:01Z',
};

const sampleFeeSchedule = {
  id: 'fs-1',
  name: 'Tuition 2026',
  amount: '500.00',
  grade_level: null,
  applies_to_student_ids: null,
  due_date: '2026-09-01',
  fee_category_id: 'cat-tuition',
};

describe('AutoInvoiceService.onModuleInit', () => {
  it('scaffolds the worker (log only)', () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    expect(() => svc.onModuleInit()).not.toThrow();
  });
});

describe('AutoInvoiceService.listRules / getRuleById', () => {
  it('listRules rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listRules(false, guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('listRules default filters is_active=true', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListRules: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listRules(false, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).toContain('and r.is_active = true');
  });

  it('listRules includeInactive=true omits the active filter', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListRules: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listRules(true, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).not.toContain('and r.is_active = true');
  });

  it('getRuleById 404 on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForRuleById: [] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getRuleById('missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('getRuleById rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getRuleById('rule-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('getRuleById happy path', async () => {
    const { tenantPrisma } = makeFake({ rowsForRuleById: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    let dto: { id: string; isActive: boolean } | undefined;
    await inTenant(async () => {
      dto = await svc.getRuleById('rule-1', adminActor);
    });
    expect(dto?.id).toBe('rule-1');
    expect(dto?.isActive).toBe(true);
  });
});

describe('AutoInvoiceService.createRule', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createRule(
          { name: 'X', triggerType: 'DATE_OF_MONTH', triggerDayOfMonth: 1, feeScheduleId: 'fs-1' } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects DATE_OF_MONTH without triggerDayOfMonth', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createRule(
          { name: 'X', triggerType: 'DATE_OF_MONTH', feeScheduleId: 'fs-1' } as never,
          adminActor,
        ),
      ).rejects.toThrow(/triggerDayOfMonth is required/);
    });
  });

  it('happy path inserts with defaults', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForRuleById: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createRule(
        {
          name: 'Monthly Tuition',
          triggerType: 'DATE_OF_MONTH',
          feeScheduleId: 'fs-1',
          triggerDayOfMonth: 1,
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_auto_invoice_rules'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('Monthly Tuition');
    expect(insert!.args).toContain('DATE_OF_MONTH');
    expect(insert!.args).toContain('fs-1');
    expect(insert!.args).toContain(1);
    expect(insert!.args).toContain(true); // default isActive
  });

  it('TERM_START trigger type accepted without triggerDayOfMonth', async () => {
    const { tenantPrisma } = makeFake({ rowsForRuleById: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createRule(
        {
          name: 'Term Start',
          triggerType: 'TERM_START',
          feeScheduleId: 'fs-1',
          triggerTermOffsetDays: -14,
        } as never,
        adminActor,
      );
    });
  });

  it('UNIQUE catch (P2002) translates to friendly 400', async () => {
    const { tenantPrisma } = makeFake({
      insertRuleFail: { code: 'P2002' },
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createRule(
          {
            name: 'Duplicate',
            triggerType: 'DATE_OF_MONTH',
            feeScheduleId: 'fs-1',
            triggerDayOfMonth: 1,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('UNIQUE catch via meta.code 23505', async () => {
    const { tenantPrisma } = makeFake({
      insertRuleFail: { meta: { code: '23505' } },
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createRule(
          {
            name: 'D',
            triggerType: 'DATE_OF_MONTH',
            feeScheduleId: 'fs-1',
            triggerDayOfMonth: 1,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('UNIQUE catch via message regex', async () => {
    const { tenantPrisma } = makeFake({
      insertRuleFail: { message: 'duplicate key value violates unique constraint' },
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createRule(
          {
            name: 'D',
            triggerType: 'DATE_OF_MONTH',
            feeScheduleId: 'fs-1',
            triggerDayOfMonth: 1,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('non-UNIQUE error rethrows', async () => {
    const { tenantPrisma } = makeFake({
      insertRuleFail: { message: 'connection refused' },
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createRule(
          {
            name: 'X',
            triggerType: 'DATE_OF_MONTH',
            feeScheduleId: 'fs-1',
            triggerDayOfMonth: 1,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/connection refused/);
    });
  });
});

describe('AutoInvoiceService.updateRule', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateRule('rule-1', { name: 'New' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('empty body short-circuits (no UPDATE)', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForRuleById: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateRule('rule-1', {}, adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_auto_invoice_rules set '),
    );
    expect(update).toBeUndefined();
  });

  it('dynamic SET for all 6 fields with school predicate', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForRuleById: [sampleRule] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateRule(
        'rule-1',
        {
          name: 'Renamed',
          description: 'New desc',
          isActive: false,
          triggerDayOfMonth: 15,
          triggerTermOffsetDays: -7,
          appliesToGradeLevel: '5',
        } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_auto_invoice_rules set '),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('name = $1');
    expect(update!.sql).toContain('description = $2');
    expect(update!.sql).toContain('is_active = $3');
    expect(update!.sql).toContain('trigger_day_of_month = $4');
    expect(update!.sql).toContain('trigger_term_offset_days = $5');
    expect(update!.sql).toContain('applies_to_grade_level = $6');
    expect(update!.sql).toContain('school_id = $7::uuid');
    expect(update!.sql).toContain('id = $8::uuid');
    expect(update!.args[6]).toBe(SCHOOL.schoolId);
    expect(update!.args[7]).toBe('rule-1');
  });

  it('NotFound when UPDATE returns 0 rows', async () => {
    const { tenantPrisma } = makeFake({ updateRuleResult: 0 });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateRule('rule-missing', { name: 'X' } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('AutoInvoiceService.triggerRule', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.triggerRule('rule-1', {} as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('rejects inactive rule', async () => {
    const { tenantPrisma } = makeFake({
      rowsForRuleById: [{ ...sampleRule, is_active: false }],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.triggerRule('rule-1', {} as never, adminActor)).rejects.toThrow(
        /Cannot trigger an inactive rule/,
      );
    });
  });

  it('happy path runs generation as AUTO_RULE_TRIGGERED', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForRuleById: [sampleRule],
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.triggerRule('rule-1', { academicYearId: 'ay-2026' } as never, adminActor);
    });
    const insertRun = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_generation_runs'),
    );
    expect(insertRun).toBeTruthy();
    expect(insertRun!.args).toContain('AUTO_RULE_TRIGGERED');
    expect(insertRun!.args).toContain('rule-1');
    expect(insertRun!.args).toContain('ay-2026');
  });
});

describe('AutoInvoiceService.generateFromFeeSchedule', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.generateFromFeeSchedule('fs-1', null, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('runs as FEE_SCHEDULE_BULK', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const insertRun = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_generation_runs'),
    );
    expect(insertRun).toBeTruthy();
    expect(insertRun!.args).toContain('FEE_SCHEDULE_BULK');
  });
});

describe('AutoInvoiceService.listRuns / getRunById', () => {
  it('listRuns rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listRuns({}, guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('listRuns school-scoped + status + autoRuleId filters', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForRunList: [sampleRun] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listRuns({ status: 'COMPLETED', autoRuleId: 'rule-1' } as never, adminActor);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('r.school_id = $1::uuid');
    expect(sql).toContain('r.status = $2');
    expect(sql).toContain('r.auto_rule_id = $3::uuid');
    expect(sql).toContain('order by r.created_at desc limit 100');
    expect(capture[0]!.args).toEqual([SCHOOL.schoolId, 'COMPLETED', 'rule-1']);
  });

  it('listRuns without filters returns all', async () => {
    const { tenantPrisma } = makeFake({ rowsForRunList: [sampleRun, { ...sampleRun, id: 'run-2' }] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    let rows: Array<{ id: string }> = [];
    await inTenant(async () => {
      rows = await svc.listRuns({}, adminActor);
    });
    expect(rows).toHaveLength(2);
  });

  it('getRunById rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getRunById('run-1', guardianActor)).rejects.toThrow(ForbiddenException);
    });
  });

  it('getRunById 404 on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForRunById: [] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getRunById('missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('getRunById happy path', async () => {
    const { tenantPrisma } = makeFake({ rowsForRunById: [sampleRun] });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    let dto: { id: string; status: string } | undefined;
    await inTenant(async () => {
      dto = await svc.getRunById('run-1', adminActor);
    });
    expect(dto?.id).toBe('run-1');
    expect(dto?.status).toBe('COMPLETED');
  });
});

describe('AutoInvoiceService.runGeneration (via generateFromFeeSchedule)', () => {
  it('happy path: 0 students → COMPLETED with all-zero counters', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [],
      rowsForRunByIdSeq: [[{ ...sampleRun, status: 'COMPLETED' }]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      const r = await svc.generateFromFeeSchedule('fs-1', null, adminActor);
      expect(r.status).toBe('COMPLETED');
    });
    const completedUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update pay_invoice_generation_runs set status = 'completed'"),
    );
    expect(completedUpdate).toBeTruthy();
  });

  it('FAILED status when fee schedule not found', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [],
      rowsForRunByIdSeq: [[{ ...sampleRun, status: 'FAILED' }]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-missing', null, adminActor);
    });
    const failedUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update pay_invoice_generation_runs set status = 'failed'"),
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate!.args.find((a) => typeof a === 'string' && /fee schedule.*not found/i.test(a))).toBeTruthy();
  });

  it('applies_to_student_ids array branch (filters by ANY)', async () => {
    const studentScopedFs = {
      ...sampleFeeSchedule,
      applies_to_student_ids: ['stu-maya', 'stu-ethan'],
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [studentScopedFs],
      rowsForStudents: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const studentQuery = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from sis_students s'),
    );
    expect(studentQuery!.sql.toLowerCase()).toContain('s.id = any($2::uuid[])');
  });

  it('grade filter applies from rule.appliesToGradeLevel', async () => {
    const ruleWithGrade = { ...sampleRule, applies_to_grade_level: '9' };
    const { tenantPrisma, capture } = makeFake({
      rowsForRuleById: [ruleWithGrade],
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.triggerRule('rule-1', {} as never, adminActor);
    });
    const studentQuery = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from sis_students s'),
    );
    expect(studentQuery!.sql.toLowerCase()).toContain('s.grade_level = $2');
    expect(studentQuery!.args).toContain('9');
  });

  it('schedule.grade_level used as fallback when rule has no grade filter', async () => {
    const fsWithGrade = { ...sampleFeeSchedule, grade_level: '10' };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [fsWithGrade],
      rowsForStudents: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const studentQuery = capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from sis_students s'),
    );
    expect(studentQuery!.args).toContain('10');
  });

  it('student without family account is skipped', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-orphan', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([['stu-orphan', []]]),
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const completedUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update pay_invoice_generation_runs set status = 'completed'"),
    );
    expect(completedUpdate).toBeTruthy();
    // $4 is invoices_skipped position
    expect(completedUpdate!.args[3]).toBe(1);
    // No invoice INSERT
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert).toBeUndefined();
  });

  it('family with existing invoice for this fee schedule is skipped', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 1]]),
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert).toBeUndefined();
    const completedUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes("update pay_invoice_generation_runs set status = 'completed'"),
    );
    // $4 invoices_skipped = 1
    expect(completedUpdate!.args[3]).toBe(1);
  });

  it('happy path: 1 family with 1 student creates 1 invoice + 1 line item, stamps last_run_at on rule', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForRuleById: [sampleRule],
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.triggerRule('rule-1', {} as never, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert).toBeTruthy();
    expect(invoiceInsert!.args).toContain('fa-1');
    expect(invoiceInsert!.args).toContain('500.00'); // 1 student × $500
    const lineInserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_line_items'),
    );
    expect(lineInserts.length).toBe(1);
    // Rule last_run_at UPDATE fires after COMPLETED status flip
    const ruleUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_auto_invoice_rules set last_run_at = now()'),
    );
    expect(ruleUpdate).toBeTruthy();
    expect(ruleUpdate!.args[0]).toBe('rule-1');
  });

  it('SIBLING discount applies when family has 2+ active students', async () => {
    const siblingRule = {
      id: 'disc-sib',
      discount_type: 'SIBLING',
      calculation_method: 'PERCENTAGE',
      value: '10',
      applies_to_fee_category_id: null,
      sibling_order: 2,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 2]]), // 2 siblings → discount applies
      rowsForDiscountRules: [siblingRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    // 2 line items total: 1 base + 1 discount
    const lineInserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_line_items'),
    );
    expect(lineInserts.length).toBe(2);
    // 500 * 10% = 50 reduction
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert!.args).toContain('450.00'); // 500 - 50
  });

  it('SIBLING discount skipped when family below sibling_order threshold', async () => {
    const siblingRule = {
      id: 'disc-sib',
      discount_type: 'SIBLING',
      calculation_method: 'PERCENTAGE',
      value: '10',
      applies_to_fee_category_id: null,
      sibling_order: 2,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]), // 1 student only → no discount
      rowsForDiscountRules: [siblingRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const lineInserts = capture.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoice_line_items'),
    );
    expect(lineInserts.length).toBe(1); // no discount line
  });

  it('SIBLING discount FIXED-amount calculation_method (Math.min cap to one-student price)', async () => {
    const siblingRule = {
      id: 'disc-sib',
      discount_type: 'SIBLING',
      calculation_method: 'FIXED_AMOUNT',
      value: '1000', // bigger than student price → capped at student price
      applies_to_fee_category_id: null,
      sibling_order: 2,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 2]]),
      rowsForDiscountRules: [siblingRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    // 500 - 500 (capped) = 0
    expect(invoiceInsert!.args).toContain('0.00');
  });

  it('EARLY_PAYMENT percentage discount applied', async () => {
    const epRule = {
      id: 'disc-ep',
      discount_type: 'EARLY_PAYMENT',
      calculation_method: 'PERCENTAGE',
      value: '5',
      applies_to_fee_category_id: null,
      sibling_order: null,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [epRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    // 500 * 5% = 25 reduction → 475
    expect(invoiceInsert!.args).toContain('475.00');
  });

  it('EARLY_PAYMENT FIXED_AMOUNT capped at baseAmount', async () => {
    const epRule = {
      id: 'disc-ep',
      discount_type: 'EARLY_PAYMENT',
      calculation_method: 'FIXED_AMOUNT',
      value: '10000', // bigger than base
      applies_to_fee_category_id: null,
      sibling_order: null,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [epRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    // Capped at 500 → invoice total = 0
    expect(invoiceInsert!.args).toContain('0.00');
  });

  it('minimum_invoice_amount gate skips discount when baseAmount below', async () => {
    const epRule = {
      id: 'disc-ep',
      discount_type: 'EARLY_PAYMENT',
      calculation_method: 'PERCENTAGE',
      value: '5',
      applies_to_fee_category_id: null,
      sibling_order: null,
      minimum_invoice_amount: '1000', // base 500 < 1000 → skip
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [epRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert!.args).toContain('500.00'); // unchanged
  });

  it('fee_category_id mismatch skips discount', async () => {
    const epRule = {
      id: 'disc-ep',
      discount_type: 'EARLY_PAYMENT',
      calculation_method: 'PERCENTAGE',
      value: '5',
      applies_to_fee_category_id: 'cat-supplies', // different from tuition
      sibling_order: null,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [epRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert!.args).toContain('500.00');
  });

  it('discount fee_category_id match applies discount', async () => {
    const matchRule = {
      id: 'disc-ep',
      discount_type: 'EARLY_PAYMENT',
      calculation_method: 'PERCENTAGE',
      value: '5',
      applies_to_fee_category_id: 'cat-tuition', // matches sampleFeeSchedule
      sibling_order: null,
      minimum_invoice_amount: null,
    };
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [matchRule],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    expect(invoiceInsert!.args).toContain('475.00');
  });

  it('multi-student family bills baseAmount = scheduleAmount × N', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [
        { id: 'stu-maya', grade_level: '9' },
        { id: 'stu-ethan', grade_level: '9' },
      ],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
        ['stu-ethan', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 2]]),
      rowsForDiscountRules: [],
      rowsForRunByIdSeq: [[sampleRun]],
    });
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const invoiceInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_invoices ('),
    );
    // 2 students × $500 = $1000
    expect(invoiceInsert!.args).toContain('1000.00');
  });

  it('per-family error caught + failed++ + COMPLETED status (overall scan continues)', async () => {
    // Configure makeFake to throw inside the family tx by failing the invoice INSERT
    const capture: CapturedCall[] = [];
    const opts = {
      rowsForFeeSchedule: [sampleFeeSchedule],
      rowsForStudents: [{ id: 'stu-maya', grade_level: '9' }],
      rowsForFamilyAccountByStudent: new Map([
        ['stu-maya', [{ family_account_id: 'fa-1' }]],
      ]),
      rowsForExistingByFamily: new Map([['fa-1', 0]]),
      rowsForSiblingCount: new Map([['fa-1', 1]]),
      rowsForDiscountRules: [],
      rowsForRunByIdSeq: [[{ ...sampleRun, status: 'COMPLETED' }]],
    };
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        const s = sql.toLowerCase();
        if (s.includes('from pay_fee_schedules where school_id')) return opts.rowsForFeeSchedule;
        if (s.includes('from sis_students s')) return opts.rowsForStudents;
        if (s.includes('from pay_family_account_students fas') && s.includes('join pay_family_accounts')) {
          return opts.rowsForFamilyAccountByStudent.get(String(args[0])) ?? [];
        }
        if (s.includes('from pay_discount_rules')) return opts.rowsForDiscountRules;
        if (s.includes('from pay_invoices i join pay_invoice_line_items')) return [{ c: 0 }];
        if (s.includes('count(*)::int as c from pay_family_account_students fas')) return [{ c: 1 }];
        if (s.includes('from pay_invoice_generation_runs r') && s.includes('and r.id =')) {
          return opts.rowsForRunByIdSeq[0] ?? [];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
        capture.push({ sql, args: _args, fn: 'e' });
        if (sql.toLowerCase().includes('insert into pay_invoices (')) {
          throw new Error('simulated per-family failure');
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
      executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    };
    const svc = new AutoInvoiceService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.generateFromFeeSchedule('fs-1', null, adminActor);
    });
    const completedUpdate = capture.find(
      (c) => c.sql.toLowerCase().includes("update pay_invoice_generation_runs set status = 'completed'"),
    );
    expect(completedUpdate).toBeTruthy();
    // $5 = invoices_failed
    expect(completedUpdate!.args[4]).toBe(1);
  });
});
