import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PayGradeService } from './pay-grade.service';

/**
 * P2-H4 test coverage uplift — pay-grade.service.ts (362 LOC,
 * critical-path Tier 1 Financial ≥95%).
 *
 * PayGradeService owns hr_pay_grades + hr_salary_scales. Used by PayrollService
 * to resolve gross pay from a salary scale id (loadScaleForCompute). Every
 * mutation gates on assertAdmin (school admin OR hr-010:write/admin per
 * REVIEW-P2-4a BLOCKING #3).
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

const ADMIN_ACTOR = {
  accountId: 'acct-admin',
  personId: 'person-admin',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: 'emp-admin',
} as never;

const STAFF_ACTOR = {
  accountId: 'acct-staff',
  personId: 'person-staff',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: 'emp-staff',
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makePerm(holds: Record<string, boolean> = {}) {
  return {
    hasAnyPermissionInTenant: async (_a: string, _s: string, codes: string[]) =>
      codes.some((c) => holds[c]),
  };
}

const SAMPLE_GRADE = {
  id: 'grade-1',
  school_id: SCHOOL.schoolId,
  grade_name: 'Teacher I',
  description: 'Entry-level teacher',
  min_salary: '40000.00',
  max_salary: '60000.00',
  is_active: true,
};

const SAMPLE_SCALE = {
  id: 'scale-1',
  pay_grade_id: 'grade-1',
  step: 1,
  annual_salary: '42000.00',
  notes: 'Step 1 — first year',
};

describe('PayGradeService.list', () => {
  it('returns active grades by default with scales grouped', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM hr_pay_grades')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales')) return [SAMPLE_SCALE];
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.list());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('grade-1');
    expect(result[0].scales).toHaveLength(1);
    expect(result[0].scales[0].annualSalary).toBe(42000);
    // Default list excludes inactive
    expect(fake.capture[0].sql).toContain('is_active = true');
  });

  it('includes inactive grades when includeInactive=true', async () => {
    const fake = makeFake(() => [SAMPLE_GRADE]);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list(true));
    expect(fake.capture[0].sql).not.toContain('is_active = true');
  });

  it('returns empty array (no scales query) when no grades exist', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.list());
    expect(result).toEqual([]);
    // Only the grades query fired; the scales query is short-circuited
    expect(fake.capture).toHaveLength(1);
  });

  it('handles grades with null min/max salary', async () => {
    const fake = makeFake(() => [{ ...SAMPLE_GRADE, min_salary: null, max_salary: null }]);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.list());
    expect(result[0].minSalary).toBeNull();
    expect(result[0].maxSalary).toBeNull();
  });
});

describe('PayGradeService.getById', () => {
  it('returns the grade + scales when found', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM hr_pay_grades')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales')) return [SAMPLE_SCALE];
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.getById('grade-1'));
    expect(result.id).toBe('grade-1');
    expect(result.scales).toHaveLength(1);
  });

  it('throws NotFoundException when no row matches', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.getById('missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PayGradeService.create — admin gate (REVIEW-P2-4a BLOCKING #3)', () => {
  it('refuses non-admin actor without hr-010:write/admin', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm({}) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.create({ gradeName: 'X' }, STAFF_ACTOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows actor with hr-010:write', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      return 0;
    });
    const svc = new PayGradeService(
      fake.tenantPrisma as never,
      makePerm({ 'hr-010:write': true }) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create({ gradeName: 'Teacher I' }, STAFF_ACTOR),
    );
    expect(result.id).toBe('grade-1');
  });

  it('allows school admin bypass', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm({}) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ gradeName: 'Teacher I' }, ADMIN_ACTOR),
      ),
    ).resolves.toBeDefined();
  });
});

describe('PayGradeService.create — validation + insert path', () => {
  it('rejects min > max with BadRequest BEFORE any SQL fires', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ gradeName: 'X', minSalary: 60000, maxSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.capture).toHaveLength(0);
  });

  it('accepts equal min and max', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ gradeName: 'Flat', minSalary: 50000, maxSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).resolves.toBeDefined();
  });

  it('emits the documented INSERT shape with id + school_id + named fields', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create(
        { gradeName: 'Teacher I', description: 'Entry', minSalary: 40000, maxSalary: 60000 },
        ADMIN_ACTOR,
      ),
    );
    const insert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO hr_pay_grades'),
    );
    expect(insert).toBeDefined();
    expect(insert!.args[2]).toBe('Teacher I'); // grade_name
    expect(insert!.args[3]).toBe('Entry'); // description
    expect(insert!.args[4]).toBe(40000); // min_salary
    expect(insert!.args[5]).toBe(60000); // max_salary
  });

  it('translates UNIQUE violations to a friendly 400', async () => {
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.includes('INSERT INTO hr_pay_grades')) {
        const err: { code: string; meta: { code: string } } = {
          code: 'P2010',
          meta: { code: '23505' },
        };
        throw err;
      }
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.create({ gradeName: 'Dup' }, ADMIN_ACTOR)),
    ).rejects.toThrow('A pay grade with this name already exists');
  });

  it('rethrows non-UNIQUE errors as-is', async () => {
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.includes('INSERT INTO hr_pay_grades')) {
        throw new Error('connection lost');
      }
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.create({ gradeName: 'X' }, ADMIN_ACTOR)),
    ).rejects.toThrow('connection lost');
  });
});

describe('PayGradeService.patch', () => {
  it('returns current state when no fields are supplied (no UPDATE issued)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales')) return [];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.patch('grade-1', {}, ADMIN_ACTOR));
    expect(fake.capture.find((c) => c.fn === 'e')).toBeUndefined();
  });

  it('builds the documented dynamic SET clause when fields are supplied', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales')) return [];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch(
        'grade-1',
        { gradeName: 'Updated', minSalary: 45000, isActive: false },
        ADMIN_ACTOR,
      ),
    );
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_pay_grades'),
    );
    expect(update).toBeDefined();
    expect(update!.sql).toContain('grade_name = $1');
    expect(update!.sql).toContain('min_salary = $2');
    expect(update!.sql).toContain('is_active = $3');
    expect(update!.sql).toContain('updated_at = now()');
    expect(update!.sql).toContain('WHERE school_id = $4::uuid AND id = $5::uuid');
  });

  it('refuses non-admin', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm({}) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('grade-1', { gradeName: 'X' }, STAFF_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('translates UNIQUE violations on rename to friendly 400', async () => {
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.startsWith('UPDATE hr_pay_grades')) {
        throw { code: 'P2010', meta: { code: '23505' } };
      }
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('grade-1', { gradeName: 'CollidingName' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow('A pay grade with this name already exists');
  });

  it('rethrows non-UNIQUE patch errors', async () => {
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.startsWith('UPDATE hr_pay_grades')) {
        throw new Error('broken');
      }
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('grade-1', { gradeName: 'X' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow('broken');
  });
});

describe('PayGradeService.listScales', () => {
  it('throws NotFoundException when the parent pay grade does not exist', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id FROM hr_pay_grades')) return [];
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.listScales('missing-grade')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the scales ordered by step', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id FROM hr_pay_grades')) return [{ id: 'grade-1' }];
      if (call.sql.includes('FROM hr_salary_scales')) return [SAMPLE_SCALE];
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () => svc.listScales('grade-1'));
    expect(result).toHaveLength(1);
    expect(result[0].step).toBe(1);
    expect(fake.capture[1].sql).toContain('ORDER BY step');
  });
});

describe('PayGradeService.addScale', () => {
  it('refuses non-admin', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm({}) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.addScale('grade-1', { step: 1, annualSalary: 50000 }, STAFF_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('walks getById first (parent grade must exist)', async () => {
    const fake = makeFake(() => []); // parent not found → 404
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.addScale('missing-grade', { step: 1, annualSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('inserts the documented row when parent exists', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales WHERE id =')) return [SAMPLE_SCALE];
      if (call.sql.includes('FROM hr_salary_scales WHERE pay_grade_id =')) return [];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.addScale(
        'grade-1',
        { step: 1, annualSalary: 42000, notes: 'Step 1 — first year' },
        ADMIN_ACTOR,
      ),
    );
    expect(result.step).toBe(1);
    const insert = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO hr_salary_scales'),
    );
    expect(insert).toBeDefined();
    expect(insert!.args[1]).toBe('grade-1');
    expect(insert!.args[2]).toBe(1);
    expect(insert!.args[3]).toBe(42000);
  });

  it('translates duplicate-step UNIQUE violations to 400 carrying the step number', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales WHERE pay_grade_id =')) return [];
      if (call.fn === 'e' && call.sql.includes('INSERT INTO hr_salary_scales')) {
        throw { code: 'P2010', meta: { code: '23505' } };
      }
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.addScale('grade-1', { step: 3, annualSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow('Step 3 already exists for this pay grade.');
  });

  it('rethrows non-UNIQUE insert errors', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      if (call.sql.includes('FROM hr_salary_scales WHERE pay_grade_id =')) return [];
      if (call.fn === 'e' && call.sql.includes('INSERT INTO hr_salary_scales')) {
        throw new Error('disk full');
      }
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.addScale('grade-1', { step: 1, annualSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow('disk full');
  });
});

describe('PayGradeService.patchScale', () => {
  it('refuses non-admin', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm({}) as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patchScale('scale-1', { annualSalary: 50000 }, STAFF_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the existing row when no fields are supplied (no UPDATE)', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM hr_salary_scales s')) return [SAMPLE_SCALE];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patchScale('scale-1', {}, ADMIN_ACTOR),
    );
    expect(fake.capture.find((c) => c.fn === 'e')).toBeUndefined();
  });

  it('builds the UPDATE SQL with updated_at = now()', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM hr_salary_scales s')) return [SAMPLE_SCALE];
      return 0;
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patchScale('scale-1', { annualSalary: 45000, notes: 'updated' }, ADMIN_ACTOR),
    );
    const update = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('UPDATE hr_salary_scales'),
    );
    expect(update).toBeDefined();
    expect(update!.sql).toContain('annual_salary = $1');
    expect(update!.sql).toContain('notes = $2');
    expect(update!.sql).toContain('updated_at = now()');
  });

  it('translates UNIQUE violations to 400', async () => {
    const fake = makeFake((call) => {
      if (call.fn === 'e' && call.sql.startsWith('UPDATE hr_salary_scales')) {
        throw { code: 'P2010', meta: { code: '23505' } };
      }
      if (call.sql.includes('FROM hr_salary_scales s')) return [SAMPLE_SCALE];
      return [];
    });
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patchScale('scale-1', { step: 1 }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow('Step number already exists for this pay grade.');
  });

  it('throws NotFoundException when the scale does not exist', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patchScale('missing-scale', { annualSalary: 50000 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PayGradeService.loadScaleForCompute', () => {
  it('returns the camelCase shape PayrollService consumes', async () => {
    const fake = makeFake(() => [
      { id: 'scale-1', pay_grade_id: 'grade-1', step: 2, annual_salary: '52000.00' },
    ]);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.loadScaleForCompute('scale-1'),
    );
    expect(result).toEqual({
      id: 'scale-1',
      payGradeId: 'grade-1',
      step: 2,
      annualSalary: 52000,
    });
  });

  it('returns null when the scale id is not in the current tenant', async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.loadScaleForCompute('foreign-scale'),
    );
    expect(result).toBeNull();
  });

  it("JOINs hr_pay_grades on g.school_id = current tenant's schoolId", async () => {
    const fake = makeFake(() => []);
    const svc = new PayGradeService(fake.tenantPrisma as never, makePerm() as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.loadScaleForCompute('scale-1'));
    expect(fake.capture[0].sql).toContain('JOIN hr_pay_grades g ON g.id = s.pay_grade_id');
    expect(fake.capture[0].sql).toContain('g.school_id = $1::uuid');
    expect(fake.capture[0].args[0]).toBe(SCHOOL.schoolId);
  });
});

describe('PayGradeService.assertAdmin (via create)', () => {
  it('admits actors with hr-010:admin', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('SELECT id::text AS id, school_id::text')) return [SAMPLE_GRADE];
      return 0;
    });
    const svc = new PayGradeService(
      fake.tenantPrisma as never,
      makePerm({ 'hr-010:admin': true }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.create({ gradeName: 'X' }, STAFF_ACTOR)),
    ).resolves.toBeDefined();
  });
});
