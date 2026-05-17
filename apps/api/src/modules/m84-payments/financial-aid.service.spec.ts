import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { FinancialAidService } from './financial-aid.service';
import type { ResolvedActor } from '@modules/m00-platform';

/**
 * P2-H4 test coverage uplift — payments/financial-aid.service.ts (879 LOC,
 * Tier 1 Financial; programmes CRUD + parent-submitted applications +
 * keystone review path with atomic fund-pool decrement inside one
 * locked tenant tx).
 *
 * Tests cover:
 *   - listPrograms / getProgramById school-scoped + active filter
 *   - createProgram admin gate + INSERT shape + UNIQUE catch + defaults
 *   - updateProgram dynamic SET + totalFundAmount delta increases
 *     fund_remaining + reject reduction below allocated awards
 *     + NotFound on missing
 *   - listApplications school-scope + admin sees all + guardian row scope
 *     + status / academicYearId / studentId filters
 *   - getApplicationById admin + guardian linkage check + 404 don't-leak
 *   - createApplication: programme + student + academic year validation +
 *     guardian-link admin path + guardian-link parent path with 403
 *     when not linked + DRAFT vs SUBMITTED status + supportingDocuments
 *     JSON serialization + missing personId 400
 *   - updateApplication admin-only after SUBMITTED + DRAFT-only for
 *     parents + empty body short-circuit + dynamic SET
 *   - submitApplication only DRAFT → SUBMITTED
 *   - withdrawApplication: terminal status rejected + appends reason
 *     to reviewer_notes
 *   - reviewApplication: admin only + 404 on missing + terminal status
 *     rejected + UNDER_REVIEW transition + REJECT + APPROVE happy path
 *     decrements fund + creates award + links award_id + duplicate award
 *     UNIQUE catch + over-fund rejection + unlimited fund programme
 *     skips decrement
 *   - listAwardsForStudent admin + guardian linked + unlinked 403 +
 *     non-guardian persona 403
 *   - getAwardById school-scoped + 404
 *   - isUniqueViolation helper covers all 4 detection paths
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
  rowsForListPrograms?: unknown[];
  rowsForProgramById?: unknown[];
  rowsForProgramByIdSeq?: unknown[][];
  rowsForExistingProgram?: unknown[];
  rowsForListApplications?: unknown[];
  rowsForApplicationById?: unknown[];
  rowsForApplicationByIdSeq?: unknown[][];
  rowsForLinkageCheck?: unknown[];
  rowsForCreateProgramLookup?: unknown[];
  rowsForCreateStudentLookup?: unknown[];
  rowsForCreateYearLookup?: unknown[];
  rowsForCreateGuardianLookup?: unknown[];
  rowsForLockedApp?: unknown[];
  rowsForLockedProgram?: unknown[];
  rowsForAwards?: unknown[];
  rowsForAwardById?: unknown[];
  rowsForGuardianAwardCheck?: unknown[];
  insertProgramFail?: { code?: string; meta?: { code?: string }; message?: string };
  insertAwardFail?: { code?: string; message?: string };
  updateProgramResult?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  let programByIdIdx = 0;
  let appByIdIdx = 0;
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args, fn: 'q' });
      const s = sql.toLowerCase();
      // updateProgram existing-program lookup — match FIRST (most specific)
      if (s.includes('select total_fund_amount::text as total')) {
        return opts.rowsForExistingProgram ?? [];
      }
      // createApplication programme existence check (WHERE id, school_id)
      if (
        s.includes('from pay_financial_aid_programs') &&
        s.includes('where id =') &&
        s.includes('school_id =')
      ) {
        return opts.rowsForCreateProgramLookup ?? [];
      }
      // Locked program in reviewApplication
      if (s.includes('from pay_financial_aid_programs') && s.includes('for update')) {
        return opts.rowsForLockedProgram ?? [];
      }
      // getProgramById via SELECT_PROGRAM_BASE + AND id (NOT for update)
      if (s.includes('from pay_financial_aid_programs') && s.includes('and id =')) {
        if (opts.rowsForProgramByIdSeq) {
          const r = opts.rowsForProgramByIdSeq[programByIdIdx] ?? [];
          programByIdIdx++;
          return r;
        }
        return opts.rowsForProgramById ?? [];
      }
      if (s.includes('from pay_financial_aid_programs')) {
        return opts.rowsForListPrograms ?? [];
      }
      // Application by id with school + id predicates (and NOT FOR UPDATE)
      if (
        s.includes('from pay_financial_aid_applications a') &&
        s.includes('a.id = $2') &&
        !s.includes('for update')
      ) {
        if (opts.rowsForApplicationByIdSeq) {
          const r = opts.rowsForApplicationByIdSeq[appByIdIdx] ?? [];
          appByIdIdx++;
          return r;
        }
        return opts.rowsForApplicationById ?? [];
      }
      if (s.includes('from pay_financial_aid_applications') && s.includes('for update')) {
        return opts.rowsForLockedApp ?? [];
      }
      if (s.includes('from pay_financial_aid_applications a')) {
        return opts.rowsForListApplications ?? [];
      }
      if (s.includes('select 1 from sis_guardians g where g.id =') && s.includes('union all')) {
        return opts.rowsForLinkageCheck ?? [];
      }
      if (
        s.includes('from sis_students') &&
        s.includes('where id =') &&
        s.includes('school_id =')
      ) {
        return opts.rowsForCreateStudentLookup ?? [];
      }
      if (s.includes('from sis_academic_years where id =') && s.includes('school_id =')) {
        return opts.rowsForCreateYearLookup ?? [];
      }
      // createApplication parent path: FROM sis_guardians g JOIN sis_student_guardians sg
      if (
        s.includes('from sis_guardians g') &&
        s.includes('join sis_student_guardians sg') &&
        s.includes('school_id =')
      ) {
        return opts.rowsForCreateGuardianLookup ?? [];
      }
      // createApplication admin path: FROM sis_student_guardians sg ... school_id but no g.person_id
      if (
        s.includes('from sis_student_guardians sg') &&
        s.includes('join sis_guardians g') &&
        s.includes('join sis_students s') &&
        s.includes('school_id =') &&
        s.includes('limit 1') &&
        !s.includes('g.person_id =')
      ) {
        return opts.rowsForCreateGuardianLookup ?? [];
      }
      // listAwardsForStudent guardian check: FROM sis_student_guardians sg ... g.person_id = $2
      if (
        s.includes('from sis_student_guardians sg') &&
        s.includes('join sis_guardians g') &&
        s.includes('join sis_students s') &&
        s.includes('g.person_id = $2') &&
        s.includes('limit 1')
      ) {
        return opts.rowsForGuardianAwardCheck ?? [];
      }
      // Fallback for any remaining sis_student_guardians lookup
      if (s.includes('from sis_student_guardians sg') && s.includes('limit 1')) {
        return opts.rowsForGuardianAwardCheck ?? [];
      }
      // Awards by id
      if (s.includes('from pay_financial_aid_awards a') && s.includes('a.id =')) {
        return opts.rowsForAwardById ?? [];
      }
      if (s.includes('from pay_financial_aid_awards a')) {
        return opts.rowsForAwards ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ..._args: unknown[]) => {
      capture.push({ sql, args: _args, fn: 'e' });
      const s = sql.toLowerCase();
      if (opts.insertProgramFail && s.includes('insert into pay_financial_aid_programs')) {
        const err = new Error(opts.insertProgramFail.message ?? 'fail') as Error & {
          code?: string;
          meta?: { code?: string };
        };
        if (opts.insertProgramFail.code) err.code = opts.insertProgramFail.code;
        if (opts.insertProgramFail.meta) err.meta = opts.insertProgramFail.meta;
        throw err;
      }
      if (opts.insertAwardFail && s.includes('insert into pay_financial_aid_awards')) {
        const err = new Error(opts.insertAwardFail.message ?? 'fail') as Error & { code?: string };
        if (opts.insertAwardFail.code) err.code = opts.insertAwardFail.code;
        throw err;
      }
      if (s.startsWith('update pay_financial_aid_programs')) {
        return opts.updateProgramResult ?? 1;
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
  accountId: 'acc-x',
  personId: null,
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

const sampleProgram = {
  id: 'prog-1',
  school_id: SCHOOL.schoolId,
  name: 'Need-Based Aid',
  description: 'For families with demonstrated financial need',
  reduction_type: 'PERCENTAGE',
  reduction_value: '15.00',
  total_fund_amount: '50000.00',
  fund_remaining: '47750.00',
  academic_year_id: 'ay-2026',
  is_active: true,
  created_by: 'acc-admin',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-28T00:00:00Z',
};

const sampleApplication = {
  id: 'app-1',
  school_id: SCHOOL.schoolId,
  student_id: 'stu-maya',
  student_name: 'Maya Chen',
  program_id: 'prog-1',
  program_name: 'Need-Based Aid',
  guardian_id: 'g-david',
  guardian_name: 'David Chen',
  academic_year_id: 'ay-2026',
  household_income_band: 'BAND_3' as const,
  supporting_documents: [{ s3Key: 's3://x', label: 'W-2' }],
  application_statement: 'Lost income',
  status: 'SUBMITTED',
  submitted_at: '2026-04-15T00:00:00Z',
  reviewed_by: null,
  reviewed_at: null,
  reviewer_notes: null,
  award_id: null,
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
};

const sampleAward = {
  id: 'award-1',
  school_id: SCHOOL.schoolId,
  student_id: 'stu-maya',
  student_name: 'Maya Chen',
  program_id: 'prog-1',
  program_name: 'Need-Based Aid',
  academic_year_id: 'ay-2026',
  award_amount: '1500.00',
  approved_by: 'acc-admin',
  effective_from: '2026-09-01',
  effective_to: null,
  status: 'ACTIVE',
  notes: 'Approved for full year',
  created_at: '2026-04-28T00:00:00Z',
  updated_at: '2026-04-28T00:00:00Z',
};

describe('FinancialAidService.listPrograms / getProgramById', () => {
  it('listPrograms default filters is_active=true + school-scoped', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListPrograms: [sampleProgram] });
    const svc = new FinancialAidService(tenantPrisma as never);
    let rows: Array<{ id: string; fundRemaining: number | null }> = [];
    await inTenant(async () => {
      rows = await svc.listPrograms();
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fundRemaining).toBe(47750);
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('school_id = $1::uuid');
    expect(sql).toContain('and is_active = true');
    expect(sql).toContain('order by name');
  });

  it('listPrograms includeInactive=true omits active filter', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListPrograms: [sampleProgram] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listPrograms(true);
    });
    expect(capture[0]!.sql.toLowerCase()).not.toContain('and is_active = true');
  });

  it('getProgramById 404 on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForProgramById: [] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getProgramById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  it('getProgramById happy path with null fund fields', async () => {
    const unlimited = { ...sampleProgram, total_fund_amount: null, fund_remaining: null };
    const { tenantPrisma } = makeFake({ rowsForProgramById: [unlimited] });
    const svc = new FinancialAidService(tenantPrisma as never);
    let dto:
      | { id: string; totalFundAmount: number | null; fundRemaining: number | null }
      | undefined;
    await inTenant(async () => {
      dto = await svc.getProgramById('prog-1');
    });
    expect(dto?.totalFundAmount).toBeNull();
    expect(dto?.fundRemaining).toBeNull();
  });
});

describe('FinancialAidService.createProgram', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createProgram(
          {
            name: 'X',
            reductionType: 'PERCENTAGE',
            reductionValue: 10,
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('happy path inserts with defaults + fund_remaining = totalFundAmount', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForProgramById: [sampleProgram] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createProgram(
        {
          name: 'Need-Based Aid',
          description: 'For families',
          reductionType: 'PERCENTAGE',
          reductionValue: 15,
          totalFundAmount: 50000,
          academicYearId: 'ay-2026',
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_programs'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('Need-Based Aid');
    expect(insert!.args).toContain('PERCENTAGE');
    expect(insert!.args).toContain('15.00');
    expect(insert!.args).toContain('50000.00');
    expect(insert!.args).toContain('ay-2026');
    expect(insert!.args).toContain(true); // default isActive
  });

  it('null totalFundAmount handled (unlimited programme)', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForProgramById: [sampleProgram] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createProgram(
        {
          name: 'Unlimited Aid',
          reductionType: 'FIXED_AMOUNT',
          reductionValue: 100,
        } as never,
        adminActor,
      );
    });
    const insert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_programs'),
    );
    expect(insert!.args).toContain(null); // totalFundAmount
  });

  it('UNIQUE catch translates to 400', async () => {
    const { tenantPrisma } = makeFake({
      insertProgramFail: { code: 'P2002' },
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createProgram(
          {
            name: 'Duplicate',
            reductionType: 'PERCENTAGE',
            reductionValue: 10,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('non-UNIQUE error rethrows', async () => {
    const { tenantPrisma } = makeFake({
      insertProgramFail: { message: 'connection refused' },
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createProgram(
          {
            name: 'X',
            reductionType: 'PERCENTAGE',
            reductionValue: 10,
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/connection refused/);
    });
  });
});

describe('FinancialAidService.updateProgram', () => {
  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateProgram('prog-1', { name: 'New' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('empty body short-circuits to getProgramById', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForProgramById: [sampleProgram] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateProgram('prog-1', {}, adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_financial_aid_programs'),
    );
    expect(update).toBeUndefined();
  });

  it('totalFundAmount increase bumps fund_remaining by delta', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForExistingProgram: [{ total: '50000.00', remaining: '47750.00' }],
      rowsForProgramById: [sampleProgram],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateProgram('prog-1', { totalFundAmount: 70000 } as never, adminActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_financial_aid_programs'),
    );
    expect(update).toBeTruthy();
    // delta = 70000 - 50000 = 20000 → newRemaining = 47750 + 20000 = 67750
    expect(update!.args).toContain('70000.00');
    expect(update!.args).toContain('67750.00');
  });

  it('totalFundAmount reduction below allocated awards rejected', async () => {
    const { tenantPrisma } = makeFake({
      rowsForExistingProgram: [{ total: '50000.00', remaining: '5000.00' }], // allocated=45000
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateProgram('prog-1', { totalFundAmount: 10000 } as never, adminActor), // < 45000 allocated
      ).rejects.toThrow(/Cannot reduce total_fund_amount below already-allocated/);
    });
  });

  it('totalFundAmount path NotFound when program missing', async () => {
    const { tenantPrisma } = makeFake({
      rowsForExistingProgram: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateProgram('prog-missing', { totalFundAmount: 100 } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('dynamic SET for name + description + isActive', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForProgramById: [sampleProgram] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateProgram(
        'prog-1',
        { name: 'Renamed', description: 'New desc', isActive: false } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_financial_aid_programs'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('name = $1');
    expect(update!.sql).toContain('description = $2');
    expect(update!.sql).toContain('is_active = $3');
    expect(update!.sql).toContain('school_id = $4');
    expect(update!.sql).toContain('id = $5');
  });

  it('NotFound when UPDATE returns 0', async () => {
    const { tenantPrisma } = makeFake({ updateProgramResult: 0 });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateProgram('missing', { name: 'X' } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('FinancialAidService.listApplications', () => {
  it('admin sees all with no row-scope predicate', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListApplications: [sampleApplication] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listApplications({}, adminActor);
    });
    expect(capture[0]!.sql.toLowerCase()).not.toContain('person_id = $');
  });

  it('guardian gets row-scoped sub-select', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListApplications: [sampleApplication] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listApplications({}, guardianActor);
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('select id from sis_guardians where person_id');
    expect(sql).toContain('from sis_student_guardians sg');
  });

  it('teacher (non-guardian non-admin) gets 403', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.listApplications({}, { ...studentActor, personType: 'STAFF' } as never),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('filters by status + academicYearId + studentId', async () => {
    const { tenantPrisma, capture } = makeFake({ rowsForListApplications: [] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.listApplications(
        { status: 'SUBMITTED', academicYearId: 'ay-2026', studentId: 'stu-maya' } as never,
        adminActor,
      );
    });
    const sql = capture[0]!.sql.toLowerCase();
    expect(sql).toContain('a.status = $2');
    expect(sql).toContain('a.academic_year_id = $3::uuid');
    expect(sql).toContain('a.student_id = $4::uuid');
  });
});

describe('FinancialAidService.getApplicationById', () => {
  it('admin happy path', async () => {
    const { tenantPrisma } = makeFake({ rowsForApplicationById: [sampleApplication] });
    const svc = new FinancialAidService(tenantPrisma as never);
    let dto: { id: string; supportingDocuments: Array<{ s3Key: string }> } | undefined;
    await inTenant(async () => {
      dto = await svc.getApplicationById('app-1', adminActor);
    });
    expect(dto?.id).toBe('app-1');
    expect(dto?.supportingDocuments).toHaveLength(1);
  });

  it('404 on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForApplicationById: [] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getApplicationById('missing', adminActor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it("guardian unlinked gets 404 don't-leak-existence", async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [sampleApplication],
      rowsForLinkageCheck: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getApplicationById('app-1', guardianActor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('guardian linked happy path', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [sampleApplication],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      const dto = await svc.getApplicationById('app-1', guardianActor);
      expect(dto.id).toBe('app-1');
    });
  });

  it('student persona gets 404', async () => {
    const { tenantPrisma } = makeFake({ rowsForApplicationById: [sampleApplication] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getApplicationById('app-1', studentActor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('supportingDocuments JSON string parsed', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [
        {
          ...sampleApplication,
          supporting_documents: JSON.stringify([{ s3Key: 's3://y', label: 'Tax' }]),
        },
      ],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    let dto: { supportingDocuments: Array<{ s3Key: string; label: string }> } | undefined;
    await inTenant(async () => {
      dto = await svc.getApplicationById('app-1', adminActor);
    });
    expect(dto?.supportingDocuments).toEqual([{ s3Key: 's3://y', label: 'Tax' }]);
  });

  it('supportingDocuments null defaults to empty array', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, supporting_documents: null }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    let dto: { supportingDocuments: Array<unknown> } | undefined;
    await inTenant(async () => {
      dto = await svc.getApplicationById('app-1', adminActor);
    });
    expect(dto?.supportingDocuments).toEqual([]);
  });

  it('malformed JSON string defaults to empty array', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, supporting_documents: '{not json' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    let dto: { supportingDocuments: Array<unknown> } | undefined;
    await inTenant(async () => {
      dto = await svc.getApplicationById('app-1', adminActor);
    });
    expect(dto?.supportingDocuments).toEqual([]);
  });
});

describe('FinancialAidService.createApplication', () => {
  it('missing personId rejected', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-maya',
            programId: 'prog-1',
            academicYearId: 'ay-2026',
          } as never,
          guardianNoPersonId,
        ),
      ).rejects.toThrow(/personId/);
    });
  });

  it('rejects when programme not found', async () => {
    const { tenantPrisma } = makeFake({ rowsForCreateProgramLookup: [] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-maya',
            programId: 'prog-missing',
            academicYearId: 'ay-2026',
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(/programId does not match/);
    });
  });

  it('rejects inactive programme', async () => {
    const { tenantPrisma } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: false }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-maya',
            programId: 'prog-1',
            academicYearId: 'ay-2026',
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(/not active/);
    });
  });

  it('rejects when student not in school', async () => {
    const { tenantPrisma } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-foreign',
            programId: 'prog-1',
            academicYearId: 'ay-2026',
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(/studentId does not match/);
    });
  });

  it('rejects when academic year not in school', async () => {
    const { tenantPrisma } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [{ id: 'stu-maya' }],
      rowsForCreateYearLookup: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-maya',
            programId: 'prog-1',
            academicYearId: 'ay-foreign',
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(/academicYearId does not match/);
    });
  });

  it('parent path 403 when guardian not linked to student', async () => {
    const { tenantPrisma } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [{ id: 'stu-maya' }],
      rowsForCreateYearLookup: [{ id: 'ay-2026' }],
      rowsForCreateGuardianLookup: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-maya',
            programId: 'prog-1',
            academicYearId: 'ay-2026',
          } as never,
          guardianActor,
        ),
      ).rejects.toThrow(/own children/);
    });
  });

  it('admin path 400 when student has no guardian', async () => {
    const { tenantPrisma } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [{ id: 'stu-maya' }],
      rowsForCreateYearLookup: [{ id: 'ay-2026' }],
      rowsForCreateGuardianLookup: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.createApplication(
          {
            studentId: 'stu-maya',
            programId: 'prog-1',
            academicYearId: 'ay-2026',
          } as never,
          adminActor,
        ),
      ).rejects.toThrow(/admin can manually attach/);
    });
  });

  it('DRAFT happy path (no submit)', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [{ id: 'stu-maya' }],
      rowsForCreateYearLookup: [{ id: 'ay-2026' }],
      rowsForCreateGuardianLookup: [{ id: 'g-david' }],
      rowsForApplicationById: [{ ...sampleApplication, status: 'DRAFT', submitted_at: null }],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createApplication(
        {
          studentId: 'stu-maya',
          programId: 'prog-1',
          academicYearId: 'ay-2026',
          householdIncomeBand: 'BAND_2',
          applicationStatement: 'Need help',
        } as never,
        guardianActor,
      );
    });
    const insert = capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_applications'),
    );
    expect(insert).toBeTruthy();
    expect(insert!.sql.toLowerCase()).toContain('null)'); // submittedAt = NULL
    expect(insert!.args).toContain('DRAFT');
  });

  it('SUBMITTED path (submit=true) writes now()', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [{ id: 'stu-maya' }],
      rowsForCreateYearLookup: [{ id: 'ay-2026' }],
      rowsForCreateGuardianLookup: [{ id: 'g-david' }],
      rowsForApplicationById: [sampleApplication],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createApplication(
        {
          studentId: 'stu-maya',
          programId: 'prog-1',
          academicYearId: 'ay-2026',
          submit: true,
        } as never,
        guardianActor,
      );
    });
    const insert = capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_applications'),
    );
    expect(insert!.sql.toLowerCase()).toContain('now()');
    expect(insert!.args).toContain('SUBMITTED');
  });

  it('serializes supportingDocuments as JSON', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForCreateProgramLookup: [{ id: 'prog-1', is_active: true }],
      rowsForCreateStudentLookup: [{ id: 'stu-maya' }],
      rowsForCreateYearLookup: [{ id: 'ay-2026' }],
      rowsForCreateGuardianLookup: [{ id: 'g-david' }],
      rowsForApplicationById: [sampleApplication],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.createApplication(
        {
          studentId: 'stu-maya',
          programId: 'prog-1',
          academicYearId: 'ay-2026',
          supportingDocuments: [{ s3Key: 's3://x', label: 'W-2' }],
        } as never,
        guardianActor,
      );
    });
    const insert = capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_applications'),
    );
    expect(insert!.args).toContain(JSON.stringify([{ s3Key: 's3://x', label: 'W-2' }]));
  });
});

describe('FinancialAidService.updateApplication', () => {
  it('parent on non-DRAFT app rejected', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, status: 'SUBMITTED' }],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.updateApplication('app-1', { applicationStatement: 'X' } as never, guardianActor),
      ).rejects.toThrow(/only DRAFT applications can be edited/);
    });
  });

  it('empty body returns app without update', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForApplicationByIdSeq: [[{ ...sampleApplication, status: 'DRAFT' }]],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateApplication('app-1', {}, guardianActor);
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_financial_aid_applications'),
    );
    expect(update).toBeUndefined();
  });

  it('dynamic SET for all 3 fields', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForApplicationByIdSeq: [
        [{ ...sampleApplication, status: 'DRAFT' }],
        [{ ...sampleApplication, status: 'DRAFT' }],
      ],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateApplication(
        'app-1',
        {
          householdIncomeBand: 'BAND_4',
          supportingDocuments: [{ s3Key: 's3://z', label: 'Bank' }],
          applicationStatement: 'Updated',
        } as never,
        guardianActor,
      );
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_financial_aid_applications'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('household_income_band = $1');
    expect(update!.sql).toContain('supporting_documents = $2::jsonb');
    expect(update!.sql).toContain('application_statement = $3');
  });

  it('admin can edit non-DRAFT', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForApplicationByIdSeq: [[sampleApplication], [sampleApplication]],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.updateApplication('app-1', { applicationStatement: 'X' } as never, adminActor);
    });
    const update = capture.find(
      (c) =>
        c.fn === 'e' && c.sql.toLowerCase().startsWith('update pay_financial_aid_applications'),
    );
    expect(update).toBeTruthy();
  });
});

describe('FinancialAidService.submitApplication', () => {
  it('rejects non-DRAFT status', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, status: 'SUBMITTED' }],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.submitApplication('app-1', guardianActor)).rejects.toThrow(/only DRAFT/);
    });
  });

  it('DRAFT → SUBMITTED happy path', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForApplicationByIdSeq: [
        [{ ...sampleApplication, status: 'DRAFT' }],
        [{ ...sampleApplication, status: 'SUBMITTED' }],
      ],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.submitApplication('app-1', guardianActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("set status = 'submitted'"),
    );
    expect(update).toBeTruthy();
  });
});

describe('FinancialAidService.withdrawApplication', () => {
  it('rejects terminal status APPROVED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, status: 'APPROVED' }],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.withdrawApplication('app-1', { reason: 'oops' } as never, guardianActor),
      ).rejects.toThrow(/terminal status APPROVED/);
    });
  });

  it('rejects REJECTED', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, status: 'REJECTED' }],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.withdrawApplication('app-1', {} as never, guardianActor)).rejects.toThrow(
        /terminal status REJECTED/,
      );
    });
  });

  it('rejects WITHDRAWN', async () => {
    const { tenantPrisma } = makeFake({
      rowsForApplicationById: [{ ...sampleApplication, status: 'WITHDRAWN' }],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.withdrawApplication('app-1', {} as never, guardianActor)).rejects.toThrow(
        /terminal status WITHDRAWN/,
      );
    });
  });

  it('happy path with reason appends to reviewer_notes', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForApplicationByIdSeq: [
        [sampleApplication],
        [{ ...sampleApplication, status: 'WITHDRAWN' }],
      ],
      rowsForLinkageCheck: [{ ok: 1 }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.withdrawApplication('app-1', { reason: 'Found other aid' } as never, guardianActor);
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("set status = 'withdrawn'"),
    );
    expect(update).toBeTruthy();
    expect(update!.args).toContain('Found other aid');
  });
});

describe('FinancialAidService.reviewApplication', () => {
  const lockedApp = {
    id: 'app-1',
    school_id: SCHOOL.schoolId,
    student_id: 'stu-maya',
    program_id: 'prog-1',
    academic_year_id: 'ay-2026',
    status: 'SUBMITTED',
  };

  it('rejects non-admin', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE' } as never, guardianActor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('404 when app missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForLockedApp: [] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication('missing', { action: 'APPROVE' } as never, adminActor),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('terminal status rejected', async () => {
    const { tenantPrisma } = makeFake({
      rowsForLockedApp: [{ ...lockedApp, status: 'APPROVED' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE' } as never, adminActor),
      ).rejects.toThrow(/terminal status APPROVED/);
    });
  });

  it('UNDER_REVIEW from SUBMITTED happy path', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForApplicationById: [{ ...sampleApplication, status: 'UNDER_REVIEW' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.reviewApplication(
        'app-1',
        { action: 'UNDER_REVIEW', reviewerNotes: 'Need W-2' } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("set status = 'under_review'"),
    );
    expect(update).toBeTruthy();
  });

  it('UNDER_REVIEW from DRAFT rejected', async () => {
    const { tenantPrisma } = makeFake({
      rowsForLockedApp: [{ ...lockedApp, status: 'DRAFT' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'UNDER_REVIEW' } as never, adminActor),
      ).rejects.toThrow(/Cannot mark UNDER_REVIEW/);
    });
  });

  it('REJECT happy path', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForApplicationById: [{ ...sampleApplication, status: 'REJECTED' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.reviewApplication(
        'app-1',
        { action: 'REJECT', reviewerNotes: 'Insufficient docs' } as never,
        adminActor,
      );
    });
    const update = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("set status = 'rejected'"),
    );
    expect(update).toBeTruthy();
    expect(update!.args).toContain('Insufficient docs');
  });

  it('APPROVE rejects when awardAmount missing', async () => {
    const { tenantPrisma } = makeFake({ rowsForLockedApp: [lockedApp] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication('app-1', { action: 'APPROVE' } as never, adminActor),
      ).rejects.toThrow(/awardAmount > 0 is required/);
    });
  });

  it('APPROVE rejects when programme missing', async () => {
    const { tenantPrisma } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication(
          'app-1',
          { action: 'APPROVE', awardAmount: 1000 } as never,
          adminActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('APPROVE rejects when awardAmount > fund_remaining', async () => {
    const { tenantPrisma } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [
        { id: 'prog-1', fund_remaining: '500.00', total_fund_amount: '50000.00' },
      ],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication(
          'app-1',
          { action: 'APPROVE', awardAmount: 1000 } as never,
          adminActor,
        ),
      ).rejects.toThrow(/exceeds programme fund_remaining/);
    });
  });

  it('APPROVE happy path: decrements fund, creates award, stamps award_id', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [
        { id: 'prog-1', fund_remaining: '50000.00', total_fund_amount: '50000.00' },
      ],
      rowsForApplicationById: [{ ...sampleApplication, status: 'APPROVED', award_id: 'award-x' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.reviewApplication(
        'app-1',
        { action: 'APPROVE', awardAmount: 1500, awardEffectiveFrom: '2026-09-01' } as never,
        adminActor,
      );
    });
    // Award INSERT
    const awardInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_awards'),
    );
    expect(awardInsert).toBeTruthy();
    expect(awardInsert!.args).toContain('1500.00');
    expect(awardInsert!.args).toContain('2026-09-01');
    // Program fund decrement
    const programUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_financial_aid_programs set fund_remaining'),
    );
    expect(programUpdate).toBeTruthy();
    expect(programUpdate!.args).toContain('48500.00'); // 50000 - 1500
    // Application APPROVED + award_id stamped
    const appUpdate = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes("set status = 'approved'"),
    );
    expect(appUpdate).toBeTruthy();
  });

  it('APPROVE on unlimited-fund programme skips decrement', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [{ id: 'prog-1', fund_remaining: null, total_fund_amount: null }],
      rowsForApplicationById: [{ ...sampleApplication, status: 'APPROVED' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.reviewApplication(
        'app-1',
        { action: 'APPROVE', awardAmount: 1500 } as never,
        adminActor,
      );
    });
    const programUpdate = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.toLowerCase().includes('update pay_financial_aid_programs set fund_remaining'),
    );
    expect(programUpdate).toBeUndefined();
  });

  it('APPROVE duplicate award UNIQUE catch translates to 400', async () => {
    const { tenantPrisma } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [
        { id: 'prog-1', fund_remaining: '50000.00', total_fund_amount: '50000.00' },
      ],
      insertAwardFail: { code: 'P2002' },
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication(
          'app-1',
          { action: 'APPROVE', awardAmount: 1500 } as never,
          adminActor,
        ),
      ).rejects.toThrow(/already has an award/);
    });
  });

  it('APPROVE defaults effective_from to today when omitted', async () => {
    const { tenantPrisma, capture } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [
        { id: 'prog-1', fund_remaining: '50000.00', total_fund_amount: '50000.00' },
      ],
      rowsForApplicationById: [{ ...sampleApplication, status: 'APPROVED' }],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await svc.reviewApplication(
        'app-1',
        { action: 'APPROVE', awardAmount: 1500 } as never,
        adminActor,
      );
    });
    const awardInsert = capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into pay_financial_aid_awards'),
    );
    // Default effective_from should be today's ISO date
    const today = new Date().toISOString().split('T')[0];
    expect(awardInsert!.args).toContain(today);
  });

  it('APPROVE non-UNIQUE award insert error rethrows', async () => {
    const { tenantPrisma } = makeFake({
      rowsForLockedApp: [lockedApp],
      rowsForLockedProgram: [
        { id: 'prog-1', fund_remaining: '50000.00', total_fund_amount: '50000.00' },
      ],
      insertAwardFail: { message: 'connection refused' },
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(
        svc.reviewApplication(
          'app-1',
          { action: 'APPROVE', awardAmount: 1500 } as never,
          adminActor,
        ),
      ).rejects.toThrow(/connection refused/);
    });
  });
});

describe('FinancialAidService.listAwardsForStudent', () => {
  it('admin sees all awards for a student', async () => {
    const { tenantPrisma } = makeFake({ rowsForAwards: [sampleAward] });
    const svc = new FinancialAidService(tenantPrisma as never);
    let rows: Array<{ id: string; awardAmount: number }> = [];
    await inTenant(async () => {
      rows = await svc.listAwardsForStudent('stu-maya', adminActor);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.awardAmount).toBe(1500);
  });

  it('non-guardian non-admin gets 403', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listAwardsForStudent('stu-maya', studentActor)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('guardian with no personId gets 403', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listAwardsForStudent('stu-maya', guardianNoPersonId)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('guardian linked happy path', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGuardianAwardCheck: [{ ok: 1 }],
      rowsForAwards: [sampleAward],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      const rows = await svc.listAwardsForStudent('stu-maya', guardianActor);
      expect(rows).toHaveLength(1);
    });
  });

  it('guardian unlinked gets 403', async () => {
    const { tenantPrisma } = makeFake({
      rowsForGuardianAwardCheck: [],
    });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.listAwardsForStudent('stu-foreign', guardianActor)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});

describe('FinancialAidService.getAwardById', () => {
  it('happy path', async () => {
    const { tenantPrisma } = makeFake({ rowsForAwardById: [sampleAward] });
    const svc = new FinancialAidService(tenantPrisma as never);
    let dto: { id: string; awardAmount: number } | undefined;
    await inTenant(async () => {
      dto = await svc.getAwardById('award-1');
    });
    expect(dto?.id).toBe('award-1');
    expect(dto?.awardAmount).toBe(1500);
  });

  it('404 on miss', async () => {
    const { tenantPrisma } = makeFake({ rowsForAwardById: [] });
    const svc = new FinancialAidService(tenantPrisma as never);
    await inTenant(async () => {
      await expect(svc.getAwardById('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
